import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {MODEL, sanitizeContext, mockGuidance, requestGuidance} from './provider.mjs';
import {createRecordStore, isRecordLimitError, RECORD_LIMIT} from './record-store.mjs';
import {createSheetClient} from './sheet-client.mjs';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {createTeacherSettings, sheetScope} from './teacher-settings.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_BODY = 800000;

// 區網模式限流：所有監聽器共用同一組計數器，以連線來源位址（req.socket.remoteAddress）為鍵，不讀任何標頭。
// 只在區網模式（或明確傳入 rateLimits）時啟用；未設定 TUTOR_LAN 的純本機模式行為不變。
export const RATE_WINDOW_MS = 60000;
export const ENTRY_LIMIT_PER_IP = 30; // (a) 入口桶：/api/tutor 與 POST /api/records 共用，讀本體之前計數。
export const LIVE_LIMIT_PER_IP = 6; // (b) 即時桶：每 IP 每分鐘真實模型請求數（模擬模式不計）。
export const LIVE_LIMIT_GLOBAL = 60; // (b) 即時桶：全部來源合計每分鐘真實模型請求數。
export const LIVE_CONCURRENCY = 8; // (c) 同時呼叫上游的名額：本體讀完、即將呼叫上游才佔用，finally 釋放。
// 連線層：Node 的 requestTimeout 只限制「收完整個請求（標頭＋本體）」的時間；
// 請求收完後，處理器等待上游（最長 90 秒）不受影響，見 lan-mode.test.mjs 的對照測試。
export const REQUEST_TIMEOUT_MS = 30000;
export const HEADERS_TIMEOUT_MS = 10000;
export const CONNECTIONS_CHECK_INTERVAL_MS = 1000;
export const MAX_CONNECTIONS = 200;
const DEFAULT_LIMITS = Object.freeze({entryPerIp: ENTRY_LIMIT_PER_IP, livePerIp: LIVE_LIMIT_PER_IP,
    liveGlobal: LIVE_LIMIT_GLOBAL, concurrency: LIVE_CONCURRENCY, windowMs: RATE_WINDOW_MS});

const messages = {
    NETWORK_BLOCKED: '本機導師服務的外連權限被限制；請以允許網路連線的終端機啟動服務。金鑰不需重輸。',
    UPSTREAM_NETWORK: '本機服務無法連上 NMKING，或接收途中斷線；請確認網路後自行重試。金鑰不需重輸。',
    INVALID_PROVIDER_RESPONSE: '已收到服務回應，但不是可讀取的 Responses 格式；請確認服務端點與相容性。本次不自動重試。',
    MODEL_INCOMPLETE: '模型回覆未完成，可能達到輸出上限；本次不自動重試。',
    TIMEOUT: '這次請求已停止或等待逾時；不會自動重試。',
    INTERNAL_ERROR: '本機導師處理失敗；請回報錯誤代碼 INTERNAL_ERROR。金鑰不需重輸。',
    AUTH_REJECTED: 'NMKING 未接受這次權杖，請確認金鑰與使用權限。',
    RATE_LIMITED: '服務目前忙碌或額度受限，請稍後自行重試。',
    PROVIDER_ERROR: '模型服務未完成請求，請確認模型與推理設定是否受支援。',
    INVALID_MODEL_OUTPUT: '模型沒有回傳可用的引導格式；本次不自動重試。'
};
const RECORD_LIMIT_MESSAGE = `紀錄已達上限（${RECORD_LIMIT} 筆），請教師處理。`;
const json = (res, status, data) => {
    if (res.destroyed || res.headersSent) return;
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'});
    res.end(JSON.stringify(data));
};
const tooMany = (res, error) => {
    if (!res.destroyed && !res.headersSent) res.setHeader('Retry-After', '60');
    return json(res, 429, {error, code: 'TOO_MANY_REQUESTS'});
};
async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw new Error('BODY_TOO_LARGE');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// 固定時間窗計數器；只存在記憶體，服務重啟即歸零。
function createWindowCounter(limit, windowMs) {
    const windows = new Map();
    const current = key => {
        const now = Date.now();
        let entry = windows.get(key);
        if (!entry || now >= entry.resetAt) {
            if (windows.size >= 4096) for (const [k, v] of windows) if (now >= v.resetAt) windows.delete(k);
            entry = {count: 0, resetAt: now + windowMs};
            windows.set(key, entry);
        }
        return entry;
    };
    return {available: key => current(key).count < limit, take: key => {current(key).count++;}};
}
const clientKey = req => String(req.socket.remoteAddress || 'unknown').replace(/^::ffff:/i, '');
const positiveInt = value => Number.isSafeInteger(value) && value > 0;

/**
 * 建立導師服務。一律回傳本機（127.0.0.1）監聽器；傳入 lan 時，同一次呼叫另建區網監聽器（server.lanServer）。
 * 兩者共用同一個處理閉包、同一組限流器與 updatingSettings 狀態，唯一差異是監聽器種類（local／lan）。
 * 區網監聽器只提供學生路由白名單，教師路由與教師檔案一律 403；依監聽器實體判斷，不讀 Host、Origin 或轉送標頭。
 * rateLimits／serverOptions 只供測試縮小數值；正式啟動（startTutor）不傳，使用上方具名常數。
 */
export function createTutorServer({buildDir = path.join(root, 'build'), fetchImpl = fetch, timeoutMs = 90000,
    recordStore = null, teacherPassword = '', teacherSettings = null, lan = null, rateLimits = null,
    serverOptions = {}} = {}) {
    if (lan) {
        if (typeof lan.address !== 'string' || !lan.address) throw new Error('LAN_ADDRESS_REQUIRED');
        // 區網不可走「沒有 teacherSettings 即視為教師」的舊版本機試用路徑。
        if (!teacherSettings) throw new Error('LAN_REQUIRES_TEACHER_SETTINGS');
    }
    const limitsOn = Boolean(lan) || Boolean(rateLimits);
    const limits = {...DEFAULT_LIMITS};
    if (rateLimits && typeof rateLimits === 'object') {
        for (const key of Object.keys(DEFAULT_LIMITS)) if (positiveInt(rateLimits[key])) limits[key] = rateLimits[key];
    }
    const entryBucket = createWindowCounter(limits.entryPerIp, limits.windowMs);
    const liveIpBucket = createWindowCounter(limits.livePerIp, limits.windowMs);
    const liveGlobalBucket = createWindowCounter(limits.liveGlobal, limits.windowMs);
    let activeLive = 0;
    const takeEntry = req => {
        if (!limitsOn) return true;
        const key = clientKey(req);
        if (!entryBucket.available(key)) return false;
        entryBucket.take(key);
        return true;
    };
    const sessions = new Map();
    let updatingSettings = false, failedLogins = 0, loginWindow = Date.now();
    const issueSession = res => {
        const token = randomBytes(24).toString('hex');
        sessions.set(token, Date.now() + 3600000);
        res.setHeader('Set-Cookie', `osepTeacher=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=3600`);
    };
    const includesSecret = value => teacherSettings && Object.values(teacherSettings.secrets()).some(
        secret => secret && JSON.stringify(value).includes(secret));
    const authorizedTeacher = req => {
        if (!teacherSettings && !teacherPassword) return true; // 舊版測試／未管理的本機試用（區網監聽器不會到這裡）。
        const token = /(?:^|;\s*)osepTeacher=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
        const expires = sessions.get(token);
        if (expires > Date.now()) return true;
        sessions.delete(token);
        return false;
    };
    const recordsFull = async () => {
        if (!recordStore || typeof recordStore.full !== 'function') return false;
        try { return await recordStore.full(); } catch { return false; }
    };
    const recordTutor = async (learning, context, question, source, result, errorCode = '') => {
        if (!learning) return undefined;
        if (!recordStore) return {status: 'failed'};
        try {
            const recording = await recordStore.save({id: learning.id, studentId: learning.studentId,
                program: learning.program, task: {code: context.task.code, title: context.task.title}, type: 'ai',
                status: errorCode ? 'failed' : 'completed', source, question,
                guidance: result?.guidance || '', followup: result?.question || '', errorCode});
            recordStore.autoSync();
            return recording;
        } catch (error) { return {status: isRecordLimitError(error) ? 'limit' : 'failed'}; }
    };
    const teacherFiles = new Set(['teacher.html', 'teacher.js', 'teacher.css']);
    // 區網監聽器的學生路由白名單；其餘一律 403。
    const lanStudentRoute = (method, pathname) =>
        (pathname === '/api/tutor/status' && method === 'GET') ||
        (pathname === '/api/tutor' && method === 'POST') ||
        (pathname === '/api/records' && method === 'POST') ||
        (['GET', 'HEAD'].includes(method) && !/^\/api(?:\/|$)/i.test(pathname));

    const handle = async (kind, req, res) => {
        const port = req.socket.localPort;
        const host = req.headers.host;
        let url;
        try { url = new URL(req.url, 'http://tutor.invalid'); } catch { return json(res, 400, {error: '路徑格式錯誤。'}); }
        if (kind === 'lan') {
            // 先依監聽器種類擋教師路由，與 Host／Origin／X-Forwarded-For 是否偽造無關。
            if (!lanStudentRoute(req.method, url.pathname)) return json(res, 403, {error: '此功能只在教師機本機提供。'});
            if (host !== `${lan.address}:${port}`) return json(res, 403, {error: '不接受此來源。'});
        } else if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) return json(res, 403, {error: '不接受此來源。'});
        if (url.pathname === '/api/tutor/status') {
            if (req.method !== 'GET' || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, {error: '只接受本機來源。'});
            if (kind === 'lan') {
                const status = teacherSettings.status();
                return json(res, 200, {managed: status.managed === true, aiConfigured: status.aiConfigured === true});
            }
            return json(res, 200, teacherSettings ? teacherSettings.status() : {managed: false});
        }
        if (url.pathname === '/api/teacher/settings' || url.pathname === '/api/teacher/logout') {
            if (!teacherSettings) return json(res, 503, {error: '教師設定尚未啟用。'});
            if (req.method !== 'POST' || req.headers.origin !== `http://${host}` ||
                !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return json(res, 403, {error: '只接受本機教師設定。'});
            if (teacherSettings.status().initialized && !authorizedTeacher(req)) return json(res, 401, {error: '請先登入教師頁。'});
            if (url.pathname.endsWith('/logout')) {
                const token = /(?:^|;\s*)osepTeacher=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
                sessions.delete(token);
                res.setHeader('Set-Cookie', 'osepTeacher=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0');
                return json(res, 200, {ok: true});
            }
            if (updatingSettings) return json(res, 409, {error: '設定保存中，請稍後再試。'});
            updatingSettings = true;
            try {
                const body = await readBody(req);
                const status = await teacherSettings.save(body);
                const secret = teacherSettings.secrets();
                if (recordStore) await recordStore.setSheetClient(createSheetClient({url: secret.sheetUrl, token: secret.sheetToken}), sheetScope(secret.sheetUrl));
                sessions.clear();
                issueSession(res);
                return json(res, 200, {ok: true, ...status});
            } catch { return json(res, 400, {error: '設定未完整套用；請確認密碼至少12字、金鑰與試算表網址格式及本機資料目錄。'}); }
            finally { updatingSettings = false; }
        }
        if (url.pathname === '/api/teacher/login') {
            if (req.method !== 'POST' || req.headers.origin !== `http://${host}` ||
                !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
                return json(res, 403, {error: '只接受本機教師登入。'});
            }
            let body;
            try { body = await readBody(req); } catch { return json(res, 400, {error: '登入格式錯誤。'}); }
            if (Date.now() - loginWindow > 60000) {failedLogins = 0; loginWindow = Date.now();}
            if (failedLogins >= 10) return json(res, 429, {error: '登入嘗試過多，請一分鐘後再試。'});
            const entered = typeof body?.password === 'string' ? Buffer.from(body.password) : Buffer.alloc(0);
            const expected = Buffer.from(teacherPassword);
            const accepted = teacherSettings ? teacherSettings.verify(body?.password) :
                teacherPassword && entered.length === expected.length && timingSafeEqual(entered, expected);
            if (!accepted) {
                failedLogins++;
                return json(res, 401, {error: '教師密碼不正確。'});
            }
            for (const [token, expires] of sessions) if (expires <= Date.now()) sessions.delete(token);
            if (sessions.size >= 100) return json(res, 429, {error: '登入工作階段過多，請稍後再試。'});
            failedLogins = 0;
            issueSession(res);
            return json(res, 200, {ok: true});
        }
        if (url.pathname === '/api/records' || url.pathname === '/api/records/sync') {
            if (req.method === 'POST' && url.pathname === '/api/records' && !takeEntry(req)) {
                return tooMany(res, '送出次數過多，請一分鐘後再試。');
            }
            if (updatingSettings) return json(res, 409, {error: '教師設定套用中，請稍後再試。'});
            if (!recordStore) return json(res, 503, {error: '記錄服務尚未啟用。'});
            if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, {error: '只接受本機來源。'});
            if ((req.method === 'GET' || url.pathname.endsWith('/sync')) && !authorizedTeacher(req)) {
                return json(res, 401, {error: '請輸入教師密碼後查看紀錄。', code: 'TEACHER_LOGIN_REQUIRED'});
            }
            if (req.method === 'GET' && url.pathname === '/api/records') {
                try {
                    const records = await recordStore.list();
                    return json(res, 200, {records, sync: await recordStore.status()});
                } catch { return json(res, 503, {error: '無法讀取本機記錄，請確認資料目錄。'}); }
            }
            if (req.method !== 'POST') return json(res, 405, {error: '不支援此記錄操作。'});
            if (req.headers.origin !== `http://${host}`) return json(res, 403, {error: '只接受同來源本機網頁。'});
            if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return json(res, 415, {error: '需要 JSON 請求。'});
            let body;
            try { body = await readBody(req); } catch { return json(res, 400, {error: '記錄格式錯誤或內容過大。'}); }
            if (url.pathname.endsWith('/sync')) {
                try { return json(res, 200, {sync: await recordStore.sync()}); }
                catch { return json(res, 503, {error: '同步失敗，本機紀錄仍保留。'}); }
            }
            if (body?.type !== 'grade') return json(res, 400, {error: '此入口只接收評分紀錄。'});
            if (includesSecret(body)) return json(res, 400, {error: '請勿把連線密鑰放在程式或學生代號中。'});
            try {
                const recording = await recordStore.save(body);
                recordStore.autoSync();
                return json(res, 200, {recording});
            } catch (error) {
                if (isRecordLimitError(error)) return json(res, 507, {error: RECORD_LIMIT_MESSAGE, code: 'RECORD_LIMIT'});
                return json(res, 400, {error: '紀錄無法保存，請確認代號、程式格式與資料目錄。'});
            }
        }
        if (url.pathname === '/api/tutor') {
            if (!takeEntry(req)) return tooMany(res, '求助次數過多，請一分鐘後再試。');
            if (updatingSettings) return json(res, 409, {error: '教師設定套用中，請稍後再試。'});
            if (req.method !== 'POST') return json(res, 405, {error: '請使用本機網頁送出求助。'});
            if (req.headers.origin !== `http://${host}`) return json(res, 403, {error: '只接受同來源本機網頁。'});
            if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return json(res, 415, {error: '需要 JSON 請求。'});
            let body;
            try { body = await readBody(req); } catch { return json(res, 400, {error: '請求格式錯誤或內容過大。'}); }
            if (!body || !['mock', 'live'].includes(body.mode)) return json(res, 400, {error: '請選擇導師模式。'});
            let context;
            try { context = sanitizeContext(body.context); } catch { return json(res, 400, {error: '題目或積木摘要格式錯誤。'}); }
            const question = typeof body.question === 'string' ? body.question.trim() : '';
            if (!question || question.length > 1500) return json(res, 400, {error: '請用 1500 字內說明卡住的地方。'});
            const history = (Array.isArray(body.history) ? body.history : []).slice(-6)
                .filter(t => t && ['user', 'assistant'].includes(t.role) && typeof t.text === 'string')
                .map(t => ({role: t.role, text: t.text.slice(0, 2000)}));
            if (includesSecret({context, question, history, learning: body.learning})) return json(res, 400, {error: '請勿把連線密鑰放在提問或程式中。'});
            if (body.mode === 'mock') {
                const result = mockGuidance(context, question);
                const recording = await recordTutor(body.learning, context, question, 'mock', result);
                return json(res, 200, {...result, source: 'mock', model: null, ...(recording ? {recording} : {})});
            }
            if (teacherSettings && body.apiKey) return json(res, 400, {error: '此電腦由教師設定金鑰，學生頁不能覆寫。'});
            const apiKey = teacherSettings ? teacherSettings.secrets().aiKey : typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
            if (apiKey.length < 8 || apiKey.length > 512 || /[^\x21-\x7e]/.test(apiKey)) return json(res, 400, {error: '請由教師在教師頁設定有效金鑰。'});
            // 避免使用者不小心在提問／積木文字／歷史貼上同一秘密，送出前即拒絕。
            if (JSON.stringify({context, question, history, learning: body.learning}).includes(apiKey)) return json(res, 400, {error: '請勿把金鑰放在提問或程式文字中。'});
            // 紀錄已滿時不呼叫上游，避免產生費用卻無法保存。
            if (body.learning && await recordsFull()) return json(res, 507, {error: RECORD_LIMIT_MESSAGE, code: 'RECORD_LIMIT'});
            let slot = false;
            if (limitsOn) {
                const key = clientKey(req);
                if (!liveIpBucket.available(key) || !liveGlobalBucket.available('all')) {
                    return tooMany(res, '真實模型求助太頻繁，請一分鐘後再試，或先用模擬練習。');
                }
                liveIpBucket.take(key);
                liveGlobalBucket.take('all');
                if (activeLive >= limits.concurrency) return tooMany(res, '目前同時求助的人太多，請稍後再試。');
                activeLive++;
                slot = true;
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            const cancel = () => controller.abort();
            res.on('close', cancel);
            try {
                const result = await requestGuidance({apiKey, context, question, history, signal: controller.signal, fetchImpl});
                if (includesSecret(result)) throw Object.assign(new Error('SECRET_ECHO'), {code: 'INVALID_MODEL_OUTPUT'});
                const recording = await recordTutor(body.learning, context, question, 'nmking', result);
                json(res, 200, {...result, source: 'nmking', model: MODEL, ...(recording ? {recording} : {})});
            } catch (error) {
                const code = controller.signal.aborted ? 'TIMEOUT' :
                    Object.hasOwn(messages, error?.code) ? error.code : 'INTERNAL_ERROR';
                const status = code === 'TIMEOUT' ? 504 :
                    ['NETWORK_BLOCKED', 'UPSTREAM_NETWORK'].includes(code) ? 503 : 502;
                const providerStatus = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ?
                    error.status : null;
                const recording = await recordTutor(body.learning, context, question, 'nmking', null, code);
                json(res, status, {error: `${messages[code]}（${code}）`, code, providerStatus,
                    ...(recording ? {recording} : {})});
            } finally {
                clearTimeout(timer);
                res.off('close', cancel);
                if (slot) activeLive--;
            }
            return;
        }
        if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, {error: '不支援此操作。'});
        let relative;
        try { relative = decodeURIComponent(url.pathname); } catch { return json(res, 400, {error: '路徑格式錯誤。'}); }
        if (relative === '/') relative = '/editor.html';
        const pieces = relative.slice(1).split('/');
        if (pieces.some(p => !p || p.startsWith('.') || /[\\:\x00]/.test(p))) return json(res, 404, {error: '找不到檔案。'});
        // 區網：解碼後仍是教師檔或 api 路徑時一律 403（含大小寫與百分比編碼變形）。
        if (kind === 'lan' && ((pieces.length === 1 && teacherFiles.has(pieces[0].toLowerCase())) ||
            pieces[0].toLowerCase() === 'api')) return json(res, 403, {error: '此功能只在教師機本機提供。'});
        const teacherAsset = kind === 'local' && pieces.length === 1 && teacherFiles.has(pieces[0]);
        const directory = teacherAsset ? path.join(root, 'scripts/tutor/teacher') : buildDir;
        const file = path.join(directory, ...pieces);
        try {
            // 正規化及 realpath 雙重確認，避免以連結或編碼路徑讀取 build 以外檔案。
            const base = fs.realpathSync(directory);
            const resolved = fs.realpathSync(file);
            if (!resolved.startsWith(base + path.sep) || !fs.statSync(resolved).isFile()) throw new Error('OUTSIDE_BUILD');
            const types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
                '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.sb3': 'application/octet-stream'};
            res.writeHead(200, {'Content-Type': types[path.extname(file)] || 'application/octet-stream',
                'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'});
            if (req.method === 'HEAD') return res.end();
            const stream = fs.createReadStream(resolved);
            stream.on('error', () => res.destroy());
            stream.pipe(res);
        } catch { json(res, 404, {error: '找不到檔案，請先執行 npm run build。'}); }
    };
    // 兩個監聽器只差 kind；處理器例外一律收斂成安全錯誤，不讓單一請求造成未處理的 Promise 拒絕。
    const listener = kind => (req, res) => {
        handle(kind, req, res).catch(() => {
            if (!res.headersSent) json(res, 500, {error: messages.INTERNAL_ERROR, code: 'INTERNAL_ERROR'});
            else res.destroy();
        });
    };
    const httpOptions = {requestTimeout: REQUEST_TIMEOUT_MS, headersTimeout: HEADERS_TIMEOUT_MS,
        connectionsCheckingInterval: CONNECTIONS_CHECK_INTERVAL_MS};
    for (const key of Object.keys(httpOptions)) if (positiveInt(serverOptions[key])) httpOptions[key] = serverOptions[key];
    const makeServer = kind => {
        const server = http.createServer(httpOptions, listener(kind));
        server.maxConnections = positiveInt(serverOptions.maxConnections) ? serverOptions.maxConnections : MAX_CONNECTIONS;
        return server;
    };
    const server = makeServer('local');
    if (lan) server.lanServer = makeServer('lan');
    return server;
}

// ---- 區網位址選擇：只接受 RFC1918 私有 IPv4；無法唯一確定時拒絕啟動並列出原因 ----
const parseIPv4 = text => {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
    if (!match) return null;
    const parts = match.slice(1);
    if (parts.some(p => (p.length > 1 && p.startsWith('0')) || Number(p) > 255)) return null;
    return parts.map(Number);
};
export const isPrivateLanIPv4 = text => {
    const p = parseIPv4(String(text || ''));
    return Boolean(p) && (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168));
};
const describeAddress = text => {
    const p = parseIPv4(String(text || ''));
    if (!p) return String(text || '').includes(':') ? 'IPv6 不支援' : '不是有效的 IPv4 位址';
    if (p[0] === 127) return '回送位址';
    if (p[0] === 169 && p[1] === 254) return '鏈路本機位址（169.254，通常代表沒有取得網路位址）';
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return 'CGNAT／Tailscale 類通道位址（100.64/10）';
    if (p[0] === 0 || p[0] >= 224) return '保留或多播位址';
    return '公網或非私有位址';
};
export const EXCLUDED_INTERFACE_PATTERNS = Object.freeze(['vEthernet', 'WSL', 'VMware', 'VirtualBox', 'Hyper-V',
    'Loopback', 'Bluetooth', 'Tailscale', 'ZeroTier', 'tun', 'tap', 'VPN']);
export function selectLanAddress({requested = '', interfaces = {}} = {}) {
    const entries = [];
    for (const [name, list] of Object.entries(interfaces || {})) {
        for (const item of Array.isArray(list) ? list : []) {
            const family = item?.family === 4 || item?.family === 'IPv4' ? 'IPv4' : 'IPv6';
            entries.push({name, address: String(item?.address || ''), family, internal: item?.internal === true});
        }
    }
    const wanted = String(requested || '').trim();
    if (wanted) {
        if (!isPrivateLanIPv4(wanted)) {
            return {ok: false, reasons: [`TUTOR_LAN_IP=${wanted}：${describeAddress(wanted)}；只接受 RFC1918 私有 IPv4（10.x、172.16～31.x、192.168.x）。`]};
        }
        if (!entries.some(e => e.family === 'IPv4' && e.address === wanted)) {
            return {ok: false, reasons: [`TUTOR_LAN_IP=${wanted}：這台電腦的網路介面沒有這個位址，請用 ipconfig 確認。`]};
        }
        return {ok: true, address: wanted, reasons: []};
    }
    const excluded = [], candidates = [];
    for (const e of entries) {
        const hit = EXCLUDED_INTERFACE_PATTERNS.find(p => e.name.toLowerCase().includes(p.toLowerCase()));
        const reason = e.family !== 'IPv4' ? 'IPv6 不支援' : e.internal ? '系統內部回送介面' :
            !isPrivateLanIPv4(e.address) ? `${describeAddress(e.address)}，不是 RFC1918 私有位址` :
                hit ? `介面名稱含「${hit}」（虛擬機、通道或 VPN 介面）` : '';
        if (reason) excluded.push(`${e.name} ${e.address}：排除，${reason}`);
        else if (!candidates.some(c => c.address === e.address)) candidates.push(e);
    }
    if (candidates.length === 1) return {ok: true, address: candidates[0].address, interfaceName: candidates[0].name, reasons: excluded};
    const head = candidates.length ? `找到 ${candidates.length} 個可能的區網位址，無法自動判斷要用哪一個：` :
        '找不到可用的 RFC1918 私有區網位址：';
    return {ok: false, reasons: [head, ...candidates.map(c => `${c.name} ${c.address}：符合條件`), ...excluded,
        '請以 TUTOR_LAN_IP=<教師機區網 IPv4> 指定後再啟動。']};
}

export function lanReadiness(teacherSettings) {
    const status = teacherSettings?.status?.();
    if (!status?.managed || !status.initialized) {
        return ['尚未完成教師設定：請先用 start-tutor.cmd 啟動，在本機開 teacher.html 設定教師密碼與 AI 金鑰，再改用區網模式。'];
    }
    if (!status.aiConfigured || !teacherSettings.secrets().aiKey) {
        return ['尚未設定 AI 金鑰：請先在本機教師頁保存 AI 金鑰，再改用區網模式。'];
    }
    return [];
}

const startError = (message, reasons = []) => Object.assign(new Error(message), {code: 'TUTOR_START_REFUSED', reasons});
const listenOn = (server, port, address) => new Promise((resolve, reject) => {
    const onError = error => {server.off('listening', onListening); reject(error);};
    const onListening = () => {server.off('error', onError); resolve();};
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, address);
});

/** 依環境變數啟動；TUTOR_LAN=1 時另開區網監聽器，條件不符一律拒絕啟動（不降級成部分開放）。 */
export async function startTutor({env = process.env, interfaces = null, teacherSettings, recordStore, ...options} = {}) {
    const port = Number(env.TUTOR_PORT || 8612);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw startError('TUTOR_PORT 必須介於 1024 與 65535。');
    let lan = null;
    if (env.TUTOR_LAN === '1') {
        const reasons = lanReadiness(teacherSettings);
        if (reasons.length) throw startError('區網模式拒絕啟動。', reasons);
        const selected = selectLanAddress({requested: env.TUTOR_LAN_IP, interfaces: interfaces || os.networkInterfaces()});
        if (!selected.ok) throw startError('區網模式拒絕啟動：無法確定教師機的區網位址。', selected.reasons);
        lan = {address: selected.address};
    }
    const server = createTutorServer({...options, recordStore, teacherSettings, lan});
    await listenOn(server, port, '127.0.0.1');
    if (server.lanServer) {
        try { await listenOn(server.lanServer, port, lan.address); } catch (error) {
            server.close();
            throw startError(`區網模式拒絕啟動：無法監聽 ${lan.address}:${port}（${error.code || '未知錯誤'}）。`);
        }
    }
    return {server, lanServer: server.lanServer || null, port, address: lan?.address || null};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const teacherSettings = await createTeacherSettings(path.join(root, 'local-data', 'teacher-settings.json'));
        const secret = teacherSettings.secrets();
        const sheetClient = createSheetClient({url: secret.sheetUrl, token: secret.sheetToken});
        const recordStore = createRecordStore(path.join(root, 'local-data'), {sheetClient, syncScope: sheetScope(secret.sheetUrl)});
        const {server, lanServer, port, address} = await startTutor({teacherSettings, recordStore});
        for (const listening of [server, lanServer].filter(Boolean)) {
            listening.on('error', () => {
                console.error('本機服務發生連線錯誤。');
                process.exitCode = 1;
            });
        }
        console.log(`本機解題導師：http://127.0.0.1:${port}/editor.html`);
        if (lanServer) {
            console.log(`區網模式已啟動，綁定位址：${address}`);
            console.log(`學生網址：http://${address}:${port}/editor.html?turbo`);
            console.log(`教師頁只能在這台電腦開：http://127.0.0.1:${port}/teacher.html`);
            console.log('只在校內私人網路使用；Windows 防火牆只勾「私人網路」；勿同時開連接埠轉送或通道工具。');
            console.log('緊急停止：關閉這個視窗，或在教師頁清除 AI 金鑰（學生只剩模擬練習）。');
        }
    } catch (error) {
        console.error(error.code === 'EADDRINUSE' ? '連接埠已使用；請設定另一個 TUTOR_PORT。' :
            error.code === 'TUTOR_START_REFUSED' ? error.message : '本機服務啟動失敗。');
        for (const reason of error.reasons || []) console.error(`  - ${reason}`);
        process.exitCode = 1;
    }
}
