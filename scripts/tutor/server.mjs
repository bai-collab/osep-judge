import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {MODEL, sanitizeContext, mockGuidance, requestGuidance} from './provider.mjs';
import {createRecordStore} from './record-store.mjs';
import {createSheetClient} from './sheet-client.mjs';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {createTeacherSettings, sheetScope} from './teacher-settings.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_BODY = 800000;
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
const json = (res, status, data) => {
    if (res.destroyed) return;
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'});
    res.end(JSON.stringify(data));
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

export function createTutorServer({buildDir = path.join(root, 'build'), fetchImpl = fetch, timeoutMs = 90000,
    recordStore = null, teacherPassword = '', teacherSettings = null} = {}) {
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
        if (!teacherSettings && !teacherPassword) return true; // 舊版測試／未管理的本機試用。
        const token = /(?:^|;\s*)osepTeacher=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
        const expires = sessions.get(token);
        if (expires > Date.now()) return true;
        sessions.delete(token);
        return false;
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
        } catch { return {status: 'failed'}; }
    };
    return http.createServer(async (req, res) => {
        const port = req.socket.localPort;
        const host = req.headers.host;
        if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) return json(res, 403, {error: '不接受此來源。'});
        const url = new URL(req.url, `http://${host}`);
        if (url.pathname === '/api/tutor/status') {
            if (req.method !== 'GET' || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, {error: '只接受本機來源。'});
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
            } catch { return json(res, 400, {error: '紀錄無法保存，請確認代號、程式格式與資料目錄。'}); }
        }
        if (url.pathname === '/api/tutor') {
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
            }
            return;
        }
        if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, {error: '不支援此操作。'});
        let relative;
        try { relative = decodeURIComponent(url.pathname); } catch { return json(res, 400, {error: '路徑格式錯誤。'}); }
        if (relative === '/') relative = '/editor.html';
        const pieces = relative.slice(1).split('/');
        if (pieces.some(p => !p || p.startsWith('.') || /[\\:\x00]/.test(p))) return json(res, 404, {error: '找不到檔案。'});
        const teacherFiles = new Set(['teacher.html', 'teacher.js', 'teacher.css']);
        const teacherAsset = pieces.length === 1 && teacherFiles.has(pieces[0]);
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
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const port = Number(process.env.TUTOR_PORT || 8612);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('TUTOR_PORT 必須介於 1024 與 65535。');
    const teacherSettings = await createTeacherSettings(path.join(root, 'local-data', 'teacher-settings.json'));
    const secret = teacherSettings.secrets();
    const sheetClient = createSheetClient({url: secret.sheetUrl, token: secret.sheetToken});
    const recordStore = createRecordStore(path.join(root, 'local-data'), {sheetClient, syncScope: sheetScope(secret.sheetUrl)});
    const server = createTutorServer({recordStore, teacherSettings});
    server.on('error', error => {
        console.error(error.code === 'EADDRINUSE' ? '連接埠已使用；請設定另一個 TUTOR_PORT。' : '本機服務啟動失敗。');
        process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => console.log(`本機解題導師：http://127.0.0.1:${port}/editor.html`));
}
