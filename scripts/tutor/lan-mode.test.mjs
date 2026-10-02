// 區網模式（TUTOR_LAN=1）驗收測試：對應計畫書 planned/26-10-02-osep-tutor-lan-mode-plan.md 的 A1–A8。
// 不呼叫真實模型（全部使用假的 fetchImpl），不使用真實金鑰，不綁定任何非回送位址。
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createTutorServer, startTutor, selectLanAddress, isPrivateLanIPv4, lanReadiness, classifyLanIPv4,
    resolveLanAddress, lanBanner, readLaunchMode, LAN_COUNTDOWN_MS,
    ENTRY_LIMIT_PER_IP, LIVE_LIMIT_PER_IP, LIVE_LIMIT_GLOBAL, LIVE_CONCURRENCY, RATE_WINDOW_MS,
    REQUEST_TIMEOUT_MS, HEADERS_TIMEOUT_MS, MAX_CONNECTIONS} from './server.mjs';
import {createTeacherSettings} from './teacher-settings.mjs';
import {createRecordStore, RECORD_LIMIT} from './record-store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'fixtures');
const scratch = path.resolve(here, '../../../../workspace/osep-judge/lan-mode-01');
const password = 'test-only-teacher-password', aiKey = 'test-only-ai-key-lan';
const LAN_ADDRESS = '127.0.0.1'; // 測試以回送位址扮演區網監聽器；種類判斷依監聽器實體，不依位址。
const context = {task: {code: 'q1', title: '測試題', description: '公開說明'}, blocks: []};
const program = {targets: [{name: '角色', blocks: {}}]};
let serial = 0;
const nextId = prefix => `${prefix}-${String(++serial).padStart(8, '0')}`;
const grade = () => ({id: nextId('grade'), studentId: 'A_S01', type: 'grade', status: 'completed', task: context.task,
    program, totalScore: 10, maxScore: 40, programChanged: false});
const learning = () => ({id: nextId('ai'), studentId: 'A_S01', program});
const modelResponse = () => new Response(JSON.stringify({status: 'completed', output: [
    {type: 'message', content: [{type: 'output_text', text: JSON.stringify({guidance: '先觀察', question: '發現什麼？'})}]}
]}), {headers: {'Content-Type': 'application/json'}});
const until = async (condition, ms = 5000) => {
    const end = Date.now() + ms;
    while (!condition()) {
        if (Date.now() > end) throw new Error('WAIT_TIMEOUT');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
};

async function directory(t) {
    await fs.mkdir(scratch, {recursive: true});
    const dir = await fs.mkdtemp(path.join(scratch, 'lan-'));
    t.after(async () => {
        if (!path.resolve(dir).startsWith(scratch + path.sep)) throw new Error('OUTSIDE_SCRATCH');
        await fs.rm(dir, {recursive: true, force: true});
    });
    return dir;
}
// 每次 startTutor 都注入暫存的選擇檔、釘選檔與輸出，絕不碰真正的 local-data。
async function isolated(t) {
    const dir = await directory(t);
    return {launchModeFile: path.join(dir, 'launch-mode.json'), lanPinFile: path.join(dir, 'lan-address.json'),
        output: {write: () => true}, interactive: false};
}
async function settingsFor(dir, {initialize = true, key = aiKey} = {}) {
    const teacherSettings = await createTeacherSettings(path.join(dir, 'teacher-settings.json'));
    if (initialize) await teacherSettings.save({password, ...(key ? {aiKey: key} : {})});
    return teacherSettings;
}
const listen = (server, port = 0) => new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const closeServer = server => new Promise(resolve => {
    if (!server.listening) return resolve();
    server.closeAllConnections();
    server.close(() => resolve());
});
function request(port, {method = 'GET', path: target = '/', headers = {}, body} = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({host: '127.0.0.1', port, method, path: target, headers, agent: false}, res => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {data += chunk;});
            res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: data}));
        });
        req.on('error', reject);
        req.end(body);
    });
}
// 同一次 createTutorServer 呼叫建立兩個監聽器（本機＋區網）。
async function pair(t, {fetchImpl = async () => modelResponse(), recordLimit, rateLimits, serverOptions,
    initialize = true} = {}) {
    const dir = await directory(t);
    const teacherSettings = await settingsFor(dir, {initialize});
    const recordStore = createRecordStore(dir, {syncScope: 'offline', ...(recordLimit ? {recordLimit} : {})});
    const server = createTutorServer({buildDir: fixtureDir, teacherSettings, recordStore, fetchImpl,
        lan: {address: LAN_ADDRESS}, rateLimits, serverOptions});
    const lanServer = server.lanServer;
    await listen(server);
    await listen(lanServer);
    t.after(async () => {await closeServer(server); await closeServer(lanServer);});
    const localPort = server.address().port, lanPort = lanServer.address().port;
    const localBase = `http://127.0.0.1:${localPort}`, lanBase = `http://${LAN_ADDRESS}:${lanPort}`;
    const post = (base, route, body, extra = {}) => fetch(base + route, {method: 'POST',
        headers: {Origin: base, 'Content-Type': 'application/json', ...extra.headers}, body: JSON.stringify(body),
        signal: extra.signal});
    return {dir, teacherSettings, recordStore, server, lanServer, localPort, lanPort, localBase, lanBase, post};
}

test('A1 區網監聽器偽造 Host／Origin／X-Forwarded-For 打教師路由與教師檔案，全部 403', async t => {
    const p = await pair(t);
    const teacherPage = await fs.readFile(path.join(here, 'teacher', 'teacher.html'), 'utf8');
    const forgeries = [
        {Host: `127.0.0.1:${p.localPort}`, Origin: `http://127.0.0.1:${p.localPort}`, 'X-Forwarded-For': '127.0.0.1'},
        {Host: '127.0.0.1', Origin: `http://127.0.0.1:${p.localPort}`, 'X-Forwarded-For': '127.0.0.1'},
        {Host: `localhost:${p.localPort}`, Origin: `http://localhost:${p.localPort}`, 'X-Forwarded-For': '127.0.0.1'},
        // 即使 Host／Origin 是正確的區網值，教師路由仍 403（依監聽器實體判斷）。
        {Host: `${LAN_ADDRESS}:${p.lanPort}`, Origin: p.lanBase, 'X-Forwarded-For': '127.0.0.1'}
    ];
    const routes = [
        ['POST', '/api/teacher/settings', JSON.stringify({clearAi: true})],
        ['POST', '/api/teacher/login', JSON.stringify({password})],
        ['POST', '/api/teacher/logout', '{}'],
        ['GET', '/api/records'], ['POST', '/api/records/sync', '{}'],
        ['GET', '/teacher.html'], ['GET', '/teacher.js'], ['GET', '/teacher.css'],
        ['HEAD', '/teacher.html'], ['GET', '/TEACHER.HTML'], ['GET', '/teacher%2Ehtml'], ['GET', '/teacher%2ejs'],
        ['GET', `http://127.0.0.1:${p.localPort}/teacher.html`], ['GET', '/api%2Fteacher%2Fsettings'],
        ['GET', '/api/tutor'], ['GET', '/api/unknown'], ['POST', '/api/unknown', '{}'], ['PUT', '/api/records', '{}']
    ];
    for (const headers of forgeries) {
        for (const [method, route, body] of routes) {
            const res = await request(p.lanPort, {method, path: route, body,
                headers: {...headers, 'Content-Type': 'application/json', Cookie: `osepTeacher=${'a'.repeat(48)}`}});
            assert.equal(res.status, 403, `${method} ${route} via Host ${headers.Host}`);
            assert.equal(res.headers['set-cookie'], undefined);
            assert.ok(!res.body.includes('<html') && !res.body.includes(teacherPage.slice(0, 40)));
        }
    }
    // 偽造的 clearAi 沒有生效；教師工作階段沒有被建立。
    assert.equal(p.teacherSettings.secrets().aiKey, aiKey);
    assert.equal(p.teacherSettings.status().aiConfigured, true);
});

test('A1 區網 Host 白名單只接受 <LAN_IP>:PORT；Origin 必須等於區網來源', async t => {
    const p = await pair(t);
    for (const host of [`127.0.0.1:${p.localPort}`, `localhost:${p.lanPort}`, 'evil.invalid', `${LAN_ADDRESS}:1`]) {
        assert.equal((await request(p.lanPort, {path: '/api/tutor/status', headers: {Host: host}})).status, 403, host);
        assert.equal((await request(p.lanPort, {path: '/editor.html', headers: {Host: host}})).status, 403, host);
    }
    assert.equal((await request(p.lanPort, {path: '/api/tutor/status', headers: {Host: `${LAN_ADDRESS}:${p.lanPort}`}})).status, 200);
    const body = {mode: 'mock', context, question: '怎麼開始？'};
    assert.equal((await p.post(p.lanBase, '/api/tutor', body, {headers: {Origin: p.localBase}})).status, 403);
    assert.equal((await p.post(p.lanBase, '/api/tutor', body, {headers: {Origin: 'http://evil.invalid'}})).status, 403);
    assert.equal((await p.post(p.lanBase, '/api/tutor', body)).status, 200);
    // 學生靜態檔可取得；區網 POST /api/records 只收 grade。
    const page = await fetch(p.lanBase + '/editor.html');
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('導師伺服器測試頁'));
    assert.equal((await p.post(p.lanBase, '/api/records', {...grade(), type: 'ai'})).status, 400);
    assert.equal((await p.post(p.lanBase, '/api/records', grade())).status, 200);
});

test('A1 迴歸：畸形請求目標不會讓服務崩潰（區網與本機都回 400 後仍可用）', async t => {
    const p = await pair(t);
    for (const port of [p.lanPort, p.localPort]) {
        const reply = await new Promise((resolve, reject) => {
            const socket = net.connect(port, '127.0.0.1');
            let data = '';
            socket.on('data', chunk => {data += chunk;});
            socket.on('error', reject);
            socket.on('close', () => resolve(data));
            socket.write(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
        });
        assert.match(reply, /^HTTP\/1\.1 400/);
    }
    assert.equal((await fetch(p.lanBase + '/api/tutor/status')).status, 200);
    assert.equal((await fetch(p.localBase + '/api/tutor/status')).status, 200);
});

test('A2 本機監聽器的教師流程照常可用（登入、讀紀錄、同步、設定、登出、教師檔案）', async t => {
    const p = await pair(t);
    for (const file of ['teacher.html', 'teacher.js', 'teacher.css']) {
        assert.equal((await fetch(`${p.localBase}/${file}`)).status, 200, file);
    }
    assert.equal((await fetch(p.localBase + '/api/records')).status, 401);
    const login = await p.post(p.localBase, '/api/teacher/login', {password});
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(p.localBase + '/api/records', {headers: {Cookie: cookie}})).status, 200);
    assert.equal((await p.post(p.localBase, '/api/records/sync', {}, {headers: {Cookie: cookie}})).status, 200);
    const status = await (await fetch(p.localBase + '/api/tutor/status')).json();
    assert.deepEqual(status, {managed: true, initialized: true, aiConfigured: true, sheetConfigured: false});
    const changed = await p.post(p.localBase, '/api/teacher/settings', {aiKey: 'test-only-ai-key-rotated'}, {headers: {Cookie: cookie}});
    assert.equal(changed.status, 200);
    assert.equal(p.teacherSettings.secrets().aiKey, 'test-only-ai-key-rotated');
    const newCookie = changed.headers.get('set-cookie').split(';')[0];
    assert.equal((await p.post(p.localBase, '/api/teacher/logout', {}, {headers: {Cookie: newCookie}})).status, 200);
    assert.equal((await fetch(p.localBase + '/api/records', {headers: {Cookie: newCookie}})).status, 401);
});

test('兩個監聽器共用同一個 updatingSettings：本機保存設定期間，區網求助回 409', async t => {
    const p = await pair(t);
    const login = await p.post(p.localBase, '/api/teacher/login', {password});
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const payload = JSON.stringify({aiKey: 'test-only-ai-key-later'});
    const socket = net.connect(p.localPort, '127.0.0.1');
    let reply = '';
    socket.on('data', chunk => {reply += chunk;});
    const closed = new Promise(resolve => socket.on('close', resolve));
    // 只送標頭與一半本體，讓本機的設定保存停在讀本體階段（updatingSettings=true）。
    socket.write(`POST /api/teacher/settings HTTP/1.1\r\nHost: 127.0.0.1:${p.localPort}\r\nOrigin: ${p.localBase}\r\n` +
        `Content-Type: application/json\r\nCookie: ${cookie}\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n` +
        payload.slice(0, 5));
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await p.post(p.lanBase, '/api/tutor', {mode: 'mock', context, question: '可以嗎？'})).status, 409);
    socket.write(payload.slice(5));
    await closed;
    assert.match(reply, /^HTTP\/1\.1 200/);
    assert.equal((await p.post(p.lanBase, '/api/tutor', {mode: 'mock', context, question: '現在可以嗎？'})).status, 200);
});

test('A3 即時模式：每 IP 第 7 次回 429，上游只被呼叫 6 次（預設常數）', async t => {
    let calls = 0;
    const p = await pair(t, {fetchImpl: async () => {calls++; return modelResponse();}});
    assert.equal(LIVE_LIMIT_PER_IP, 6);
    for (let i = 0; i < LIVE_LIMIT_PER_IP; i++) {
        assert.equal((await p.post(p.lanBase, '/api/tutor', {mode: 'live', context, question: `第${i + 1}次`})).status, 200);
    }
    const seventh = await p.post(p.lanBase, '/api/tutor', {mode: 'live', context, question: '第7次'});
    assert.equal(seventh.status, 429);
    assert.equal(seventh.headers.get('retry-after'), '60');
    assert.equal((await seventh.json()).code, 'TOO_MANY_REQUESTS');
    // 同一來源位址在本機監聽器上也共用同一個每 IP 桶。
    assert.equal((await p.post(p.localBase, '/api/tutor', {mode: 'live', context, question: '換監聽器'})).status, 429);
    assert.equal(calls, LIVE_LIMIT_PER_IP);
});

test('A3 同時名額：第 9 個同時即時請求回 429；名額在完成、中斷時於 finally 釋放', async t => {
    let calls = 0, aborted = 0;
    const releases = [];
    const p = await pair(t, {rateLimits: {livePerIp: 1000, entryPerIp: 1000}, fetchImpl: (url, options) => {
        calls++;
        return new Promise((resolve, reject) => {
            releases.push(() => resolve(modelResponse()));
            options.signal.addEventListener('abort', () => {aborted++; reject(new Error('aborted'));}, {once: true});
        });
    }});
    assert.equal(LIVE_CONCURRENCY, 8);
    const ask = (base, extra) => p.post(base, '/api/tutor', {mode: 'live', context, question: '同時求助'}, extra);
    // 本機與區網混合送出 8 個，全部進入上游等待。
    const first = Array.from({length: LIVE_CONCURRENCY}, (_, i) => ask(i % 2 ? p.lanBase : p.localBase));
    await until(() => calls === LIVE_CONCURRENCY);
    const ninth = await ask(p.lanBase);
    assert.equal(ninth.status, 429);
    assert.equal(calls, LIVE_CONCURRENCY);
    releases.splice(0).forEach(release => release());
    for (const response of await Promise.all(first)) assert.equal(response.status, 200);
    // 完成後名額已釋放。
    const after = ask(p.lanBase);
    await until(() => releases.length === 1);
    releases.splice(0).forEach(release => release());
    assert.equal((await after).status, 200);
    // 學生端中斷連線：上游被中止，名額同樣在 finally 釋放。
    const controllers = Array.from({length: LIVE_CONCURRENCY}, () => new AbortController());
    const dropped = controllers.map(controller => ask(p.lanBase, {signal: controller.signal}).catch(() => null));
    await until(() => releases.length === LIVE_CONCURRENCY);
    controllers.forEach(controller => controller.abort());
    await Promise.all(dropped);
    await until(() => aborted === LIVE_CONCURRENCY);
    releases.splice(0);
    await new Promise(resolve => setTimeout(resolve, 50));
    const recovered = ask(p.localBase);
    await until(() => releases.length === 1);
    releases.splice(0).forEach(release => release());
    assert.equal((await recovered).status, 200);
    assert.equal(calls, LIVE_CONCURRENCY * 2 + 2);
});

test('A3a 模擬模式連續 7 次不被即時上限擋；入口桶（求助＋評分紀錄共用）第 31 次回 429', async t => {
    let calls = 0;
    const p = await pair(t, {fetchImpl: async () => {calls++; return modelResponse();}});
    assert.equal(ENTRY_LIMIT_PER_IP, 30);
    for (let i = 0; i < 7; i++) {
        const res = await p.post(p.lanBase, '/api/tutor', {mode: 'mock', context, question: `模擬${i + 1}`});
        assert.equal(res.status, 200, `mock ${i + 1}`);
    }
    for (let i = 7; i < ENTRY_LIMIT_PER_IP - 1; i++) {
        assert.equal((await p.post(p.lanBase, '/api/tutor', {mode: 'mock', context, question: `模擬${i + 1}`})).status, 200);
    }
    assert.equal((await p.post(p.lanBase, '/api/records', grade())).status, 200); // 第 30 次
    const over = await p.post(p.lanBase, '/api/tutor', {mode: 'mock', context, question: '第31次'});
    assert.equal(over.status, 429);
    assert.equal((await p.post(p.lanBase, '/api/records', grade())).status, 429);
    assert.equal((await p.post(p.localBase, '/api/tutor', {mode: 'live', context, question: '即時'})).status, 429);
    assert.equal(calls, 0);
});

test('A3b 8 條只送標頭、本體不送的連線存在時，正常即時請求仍成功', async t => {
    let calls = 0;
    const p = await pair(t, {fetchImpl: async () => {calls++; return modelResponse();}});
    const sockets = [];
    t.after(() => sockets.forEach(socket => socket.destroy()));
    for (let i = 0; i < LIVE_CONCURRENCY; i++) {
        const socket = net.connect(p.lanPort, '127.0.0.1');
        socket.on('error', () => {});
        socket.write(`POST /api/tutor HTTP/1.1\r\nHost: ${LAN_ADDRESS}:${p.lanPort}\r\nOrigin: ${p.lanBase}\r\n` +
            'Content-Type: application/json\r\nContent-Length: 4096\r\n\r\n{"mode":"live"');
        sockets.push(socket);
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    const res = await p.post(p.lanBase, '/api/tutor', {mode: 'live', context, question: '慢速連線還在'});
    assert.equal(res.status, 200);
    assert.equal(calls, 1);
});

test('A3c 本機與區網監聽器的即時請求加總，受同一個全域每分鐘上限', async t => {
    let calls = 0;
    const p = await pair(t, {rateLimits: {livePerIp: 1000, entryPerIp: 1000},
        fetchImpl: async () => {calls++; return modelResponse();}});
    assert.equal(LIVE_LIMIT_GLOBAL, 60);
    assert.equal(RATE_WINDOW_MS, 60000);
    for (let i = 0; i < LIVE_LIMIT_GLOBAL; i++) {
        const base = i % 2 ? p.lanBase : p.localBase;
        assert.equal((await p.post(base, '/api/tutor', {mode: 'live', context, question: `全域${i}`})).status, 200);
    }
    assert.equal((await p.post(p.localBase, '/api/tutor', {mode: 'live', context, question: '本機第61'})).status, 429);
    assert.equal((await p.post(p.lanBase, '/api/tutor', {mode: 'live', context, question: '區網第62'})).status, 429);
    assert.equal(calls, LIVE_LIMIT_GLOBAL);
});

test('A4 紀錄總數達上限：評分 507、模擬附 limit 且事件檔不增、即時 507 且不呼叫上游', async t => {
    assert.equal(RECORD_LIMIT, 50000);
    let calls = 0;
    const p = await pair(t, {recordLimit: 2, fetchImpl: async () => {calls++; return modelResponse();}});
    const first = grade();
    assert.equal((await p.post(p.lanBase, '/api/records', first)).status, 200);
    assert.equal((await p.post(p.localBase, '/api/records', grade())).status, 200);
    const events = path.join(p.dir, 'events.jsonl');
    const lines = async () => (await fs.readFile(events, 'utf8')).trim().split('\n').length;
    assert.equal(await lines(), 2);
    const full = await p.post(p.lanBase, '/api/records', grade());
    assert.equal(full.status, 507);
    const fullBody = await full.json();
    assert.equal(fullBody.code, 'RECORD_LIMIT');
    assert.ok(fullBody.error.includes('紀錄已達上限'));
    assert.equal((await p.post(p.localBase, '/api/records', grade())).status, 507);
    // 重送既有事件屬於去重，不新增，仍可接受。
    assert.equal((await p.post(p.lanBase, '/api/records', first)).status, 200);
    const mock = await p.post(p.lanBase, '/api/tutor', {mode: 'mock', context, question: '還能提示嗎？', learning: learning()});
    assert.equal(mock.status, 200);
    const mockBody = await mock.json();
    assert.equal(mockBody.source, 'mock');
    assert.equal(mockBody.recording.status, 'limit');
    assert.equal(typeof mockBody.guidance, 'string');
    const live = await p.post(p.lanBase, '/api/tutor', {mode: 'live', context, question: '真模型？', learning: learning()});
    assert.equal(live.status, 507);
    assert.equal((await live.json()).code, 'RECORD_LIMIT');
    assert.equal(calls, 0);
    assert.equal(await lines(), 2);
    assert.equal((await p.recordStore.list()).length, 2);
    assert.equal(await p.recordStore.full(), true);
    await assert.rejects(p.recordStore.save(grade()), error => error.code === 'RECORD_LIMIT');
    assert.equal((await p.recordStore.list()).length, 2);
    // 沒有帶 learning 的即時求助不寫紀錄，照常可用。
    assert.equal((await p.post(p.lanBase, '/api/tutor', {mode: 'live', context, question: '不記錄'})).status, 200);
    assert.equal(calls, 1);
});

async function freePort() {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const {port} = probe.address();
    await new Promise(resolve => probe.close(resolve));
    return port;
}
const portIsFree = async port => {
    const probe = net.createServer();
    const ok = await new Promise(resolve => {
        probe.once('error', () => resolve(false));
        probe.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) await new Promise(resolve => probe.close(resolve));
    return ok;
};
const oneLan = {'Wi-Fi': [{address: '192.168.1.23', family: 'IPv4', internal: false}]};

test('A5 未初始化或未設 AI 金鑰時，區網啟動被拒且沒有任何監聽', async t => {
    const port = await freePort();
    const env = {TUTOR_LAN: '1', TUTOR_PORT: String(port)};
    const uninitialized = await settingsFor(await directory(t), {initialize: false});
    await assert.rejects(startTutor({...await isolated(t), env, interfaces: oneLan, teacherSettings: uninitialized, buildDir: fixtureDir}),
        error => error.code === 'TUTOR_START_REFUSED' && error.reasons.some(r => r.includes('尚未完成教師設定')));
    const noKey = await settingsFor(await directory(t), {key: ''});
    assert.equal(noKey.status().initialized, true);
    await assert.rejects(startTutor({...await isolated(t), env, interfaces: oneLan, teacherSettings: noKey, buildDir: fixtureDir}),
        error => error.code === 'TUTOR_START_REFUSED' && error.reasons.some(r => r.includes('尚未設定 AI 金鑰')));
    await assert.rejects(startTutor({...await isolated(t), env, interfaces: oneLan, teacherSettings: null, buildDir: fixtureDir}),
        error => error.code === 'TUTOR_START_REFUSED');
    assert.deepEqual(lanReadiness(null).length, 1);
    assert.equal(await portIsFree(port), true);
    // 不可走「沒有 teacherSettings」的舊後門建立區網監聽器。
    assert.throws(() => createTutorServer({lan: {address: '192.168.1.23'}}), /LAN_REQUIRES_TEACHER_SETTINGS/);
    // 條件齊全但區網位址無法綁定（本機沒有此位址）時同樣拒絕，並關閉已開的本機監聽。
    const ready = await settingsFor(await directory(t));
    await assert.rejects(startTutor({...await isolated(t), env: {...env, TUTOR_LAN_IP: '192.168.250.251'},
        interfaces: {'乙太網路': [{address: '192.168.250.251', family: 'IPv4', internal: false}]},
        teacherSettings: ready, buildDir: fixtureDir}),
    error => error.code === 'TUTOR_START_REFUSED' && error.message.includes('192.168.250.251'));
    let freed = false;
    for (let i = 0; i < 50 && !freed; i++) {
        freed = await portIsFree(port);
        if (!freed) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(freed, true);
    // 未設 TUTOR_LAN：只開本機監聽器，行為同現狀。
    const local = await startTutor({...await isolated(t), env: {TUTOR_PORT: String(port)}, teacherSettings: uninitialized, buildDir: fixtureDir});
    t.after(() => closeServer(local.server));
    assert.equal(local.lanServer, null);
    assert.equal(local.server.address().address, '127.0.0.1');
});

test('A6 區網 /api/tutor/status 只回 managed 與 aiConfigured 兩欄', async t => {
    const p = await pair(t);
    const lanStatus = await (await fetch(p.lanBase + '/api/tutor/status')).json();
    assert.deepEqual(lanStatus, {managed: true, aiConfigured: true});
    assert.deepEqual(Object.keys(lanStatus).sort(), ['aiConfigured', 'managed']);
    const localStatus = await (await fetch(p.localBase + '/api/tutor/status')).json();
    assert.deepEqual(localStatus, {managed: true, initialized: true, aiConfigured: true, sheetConfigured: false});
});

// ---- A7'（v3）：區網位址選擇；自動偵測與 TUTOR_LAN_IP 共用 classifyLanIPv4 ----
const nic = (name, address, family = 'IPv4', internal = false) => ({[name]: [{address, family, internal}]});
const promptSpy = answer => {
    const spy = {calls: 0, questions: []};
    spy.fn = async question => {spy.calls++; spy.questions.push(question); return answer;};
    return spy;
};
const fileExists = async file => fs.access(file).then(() => true, () => false);
async function pinFileFor(t) {
    return path.join(await directory(t), 'lan-address.json');
}
const SCHOOL_IP = '163.27.45.21';
const EXCLUDED_SAMPLES = [
    ['0.1.2.3', '0.0.0.0/8'], ['0.0.0.0', '0.0.0.0/8'], ['127.0.0.2', '127.0.0.0/8'], ['169.254.10.20', '169.254.0.0/16'],
    ['100.64.0.9', '100.64.0.0/10'], ['100.127.255.254', '100.64.0.0/10'], ['224.0.0.1', '224.0.0.0/4'],
    ['239.255.255.250', '224.0.0.0/4'], ['240.1.2.3', '240.0.0.0/4'], ['255.255.255.255', '255.255.255.255'],
    ['192.0.0.9', '192.0.0.0/24'], ['192.0.2.9', '192.0.2.0/24'], ['198.18.5.5', '198.18.0.0/15'],
    ['198.19.255.1', '198.18.0.0/15'], ['198.51.100.9', '198.51.100.0/24'], ['203.0.113.9', '203.0.113.0/24']
];
const BLACKLISTED_NICS = ['OpenVPN TAP-Windows6', 'Tailscale', 'ZeroTier One', 'vEthernet (Default Switch)',
    'VMware Network Adapter VMnet1', 'VirtualBox Host-Only Network', 'Cisco AnyConnect VPN', 'tun0', 'Bluetooth 網路連線'];

test('classifyLanIPv4：共用判斷式的邊界，自動偵測與 TUTOR_LAN_IP 對同一位址結論一致', () => {
    for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.0.1']) assert.equal(classifyLanIPv4(ip).kind, 'private', ip);
    for (const ip of [SCHOOL_IP, '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.0.1.1',
        '192.169.0.1', '198.17.255.255', '198.20.0.1', '198.51.101.1', '203.0.114.1', '223.255.255.255']) {
        assert.equal(classifyLanIPv4(ip).kind, 'public', ip);
    }
    for (const [ip] of EXCLUDED_SAMPLES) assert.equal(classifyLanIPv4(ip).kind, 'excluded', ip);
    for (const ip of ['fe80::1', '::1', '::ffff:192.168.1.1', '192.168.1.256', '192.168.01.1', '1.2.3', '', 'abc']) {
        assert.equal(classifyLanIPv4(ip).kind, 'excluded', ip);
    }
    assert.equal(isPrivateLanIPv4('192.168.1.23'), true);
    assert.equal(isPrivateLanIPv4(SCHOOL_IP), false);
    for (const ip of ['192.168.1.23', SCHOOL_IP, ...EXCLUDED_SAMPLES.map(([address]) => address)]) {
        const verdict = classifyLanIPv4(ip);
        const auto = selectLanAddress({interfaces: nic('乙太網路', ip)});
        const explicit = selectLanAddress({requested: ip, interfaces: nic('乙太網路', ip)});
        if (verdict.kind === 'excluded') {
            assert.equal(auto.ok, false, ip);
            assert.equal(auto.needsConfirmation, undefined, ip);
            assert.equal(explicit.ok, false, ip);
            assert.ok(auto.reasons.some(r => r.includes(ip) && r.includes(verdict.reason)), ip);
            assert.ok(explicit.reasons.some(r => r.includes(ip) && r.includes(verdict.reason)), ip);
        } else if (verdict.kind === 'private') {
            assert.equal(auto.ok, true);
            assert.equal(explicit.ok, true);
        } else {
            assert.equal(auto.needsConfirmation, true);
            assert.equal(explicit.ok, true);
            assert.equal(explicit.kind, 'public');
        }
        for (const result of [auto, explicit]) assert.ok(!(result.reasons || []).join('').includes('只接受 RFC1918'));
    }
});

test('A7\'1 自動偵測：私人單一候選綁定；公開位址須確認並釘選；已釘選／離校／多候選依規則處理', async t => {
    // 單一 RFC1918（其他虛擬／通道／回送／IPv6 介面全部排除）→ 直接綁定，不詢問、不寫檔。
    let pinFile = await pinFileFor(t);
    let spy = promptSpy('Y');
    const privateOnly = await resolveLanAddress({pinFile, interactive: true, prompt: spy.fn, interfaces: {
        'Wi-Fi': [{address: 'fe80::1234', family: 'IPv6', internal: false}, {address: '192.168.1.23', family: 'IPv4', internal: false}],
        'vEthernet (WSL)': [{address: '172.20.48.1', family: 'IPv4', internal: false}],
        'VMware Network Adapter VMnet8': [{address: '192.168.56.1', family: 'IPv4', internal: false}],
        'Tailscale': [{address: '100.101.102.103', family: 'IPv4', internal: false}],
        'Loopback Pseudo-Interface 1': [{address: '127.0.0.1', family: 'IPv4', internal: true}]}});
    assert.equal(privateOnly.ok, true);
    assert.equal(privateOnly.address, '192.168.1.23');
    assert.equal(privateOnly.interfaceName, 'Wi-Fi');
    assert.equal(privateOnly.kind, 'private');
    assert.equal(spy.calls, 0);
    assert.equal(await fileExists(pinFile), false);
    // 單一公開位址、未釘選、非互動 → 拒絕並提示，不詢問。
    const school = nic('乙太網路', SCHOOL_IP);
    spy = promptSpy('Y');
    const nonInteractive = await resolveLanAddress({pinFile, interactive: false, prompt: spy.fn, interfaces: school});
    assert.equal(nonInteractive.ok, false);
    assert.ok(nonInteractive.reasons.some(r => r.includes(SCHOOL_IP) && r.includes('乙太網路')));
    assert.ok(nonInteractive.reasons.some(r => r.includes('start-tutor-lan.cmd') && r.includes('TUTOR_LAN_IP')));
    assert.equal(spy.calls, 0);
    assert.equal(await fileExists(pinFile), false);
    // 回答 N → 拒絕，不寫檔。
    spy = promptSpy('N');
    const declined = await resolveLanAddress({pinFile, interactive: true, prompt: spy.fn, interfaces: school});
    assert.equal(declined.ok, false);
    assert.equal(spy.calls, 1);
    assert.equal(await fileExists(pinFile), false);
    // 回答 Y → 寫入釘選檔並綁定；詢問句含位址與介面名。
    spy = promptSpy('y');
    const confirmed = await resolveLanAddress({pinFile, interactive: true, prompt: spy.fn, interfaces: school});
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.address, SCHOOL_IP);
    assert.equal(confirmed.kind, 'public');
    assert.equal(confirmed.confirmation, 'prompted');
    assert.equal(spy.calls, 1);
    assert.ok(spy.questions[0].includes(SCHOOL_IP) && spy.questions[0].includes('乙太網路') && spy.questions[0].includes('(Y/N)'));
    const pinned = JSON.parse(await fs.readFile(pinFile, 'utf8'));
    assert.equal(pinned.version, 1);
    assert.equal(pinned.address, SCHOOL_IP);
    assert.deepEqual((await fs.readdir(path.dirname(pinFile))).filter(name => name.endsWith('.tmp')), []);
    // 已釘選且網卡上仍有 → 綁定，不再詢問（非互動也可）。
    spy = promptSpy('N');
    const reuse = await resolveLanAddress({pinFile, interactive: false, prompt: spy.fn, interfaces: school});
    assert.equal(reuse.ok, true);
    assert.equal(reuse.confirmation, 'pinned');
    assert.equal(spy.calls, 0);
    // 已釘選但網卡上已無（換到另一個公開位址或沒有網路）→ 拒絕，不詢問、不改寫釘選檔。
    const pinBefore = await fs.readFile(pinFile, 'utf8');
    for (const interfaces of [nic('乙太網路', '163.27.45.99'), {}]) {
        spy = promptSpy('Y');
        const moved = await resolveLanAddress({pinFile, interactive: true, prompt: spy.fn, interfaces});
        assert.equal(moved.ok, false);
        assert.equal(spy.calls, 0);
        assert.equal(await fs.readFile(pinFile, 'utf8'), pinBefore);
    }
    const moved = await resolveLanAddress({pinFile, interactive: true, prompt: promptSpy('Y').fn, interfaces: nic('乙太網路', '163.27.45.99')});
    assert.ok(moved.reasons.some(r => r.includes(SCHOOL_IP) && r.includes('163.27.45.99')));
    // 公開＋私人各一（同卡或不同卡）→ 多候選拒絕，不詢問、不寫檔。
    pinFile = await pinFileFor(t);
    for (const interfaces of [
        {'乙太網路': [{address: SCHOOL_IP, family: 'IPv4', internal: false}, {address: '192.168.1.23', family: 'IPv4', internal: false}]},
        {...nic('乙太網路', SCHOOL_IP), ...nic('Wi-Fi', '192.168.1.23')}
    ]) {
        spy = promptSpy('Y');
        const multi = await resolveLanAddress({pinFile, interactive: true, prompt: spy.fn, interfaces});
        assert.equal(multi.ok, false);
        assert.ok(multi.reasons.join('\n').includes(SCHOOL_IP) && multi.reasons.join('\n').includes('192.168.1.23'));
        assert.equal(spy.calls, 0);
        assert.equal(await fileExists(pinFile), false);
    }
    // 損壞的釘選檔視同未釘選：非互動拒絕、不詢問。
    await fs.writeFile(pinFile, '{broken');
    spy = promptSpy('Y');
    assert.equal((await resolveLanAddress({pinFile, interactive: false, prompt: spy.fn, interfaces: school})).ok, false);
    assert.equal(spy.calls, 0);
});

test('A7\'2 指定 TUTOR_LAN_IP：本機存在的公開位址接受；不存在、特殊網段、IPv6、黑名單介面一律拒絕', async t => {
    const pinFile = await pinFileFor(t);
    let spy = promptSpy('Y');
    const explicit = await resolveLanAddress({requested: SCHOOL_IP, pinFile, interactive: true, prompt: spy.fn,
        interfaces: nic('乙太網路', SCHOOL_IP)});
    assert.equal(explicit.ok, true);
    assert.equal(explicit.kind, 'public');
    assert.equal(explicit.confirmation, 'explicit');
    assert.equal(explicit.interfaceName, '乙太網路');
    assert.equal(spy.calls, 0);
    assert.equal(await fileExists(pinFile), false); // 明確指定不寫釘選檔
    const missing = selectLanAddress({requested: SCHOOL_IP, interfaces: nic('乙太網路', '163.27.45.22')});
    assert.equal(missing.ok, false);
    assert.ok(missing.reasons[0].includes(SCHOOL_IP) && missing.reasons[0].includes('沒有這個位址'));
    assert.equal(selectLanAddress({requested: '192.168.9.9', interfaces: oneLan}).ok, false);
    assert.equal(selectLanAddress({requested: '192.168.1.23', interfaces: oneLan}).ok, true);
    for (const [ip, range] of [...EXCLUDED_SAMPLES, ['fe80::1', 'IPv6'], ['::1', 'IPv6']]) {
        spy = promptSpy('Y');
        const result = await resolveLanAddress({requested: ip, pinFile, interactive: true, prompt: spy.fn,
            interfaces: nic('乙太網路', ip, ip.includes(':') ? 'IPv6' : 'IPv4')});
        assert.equal(result.ok, false, ip);
        assert.ok(result.reasons[0].includes(ip) && result.reasons[0].includes(range), `${ip}: ${result.reasons[0]}`);
        assert.ok(!result.reasons[0].includes('只接受 RFC1918'));
        assert.equal(spy.calls, 0);
        assert.equal(await fileExists(pinFile), false);
    }
    for (const name of BLACKLISTED_NICS) {
        for (const ip of [SCHOOL_IP, '10.8.0.6']) {
            const result = selectLanAddress({requested: ip, interfaces: nic(name, ip)});
            assert.equal(result.ok, false, `${name} ${ip}`);
            assert.ok(result.reasons[0].includes(name), result.reasons[0]);
        }
    }
});

test('A7\'2a 自動偵測反例：特殊網段或黑名單介面上的位址一律排除，不詢問、不寫釘選檔', async t => {
    const pinFile = await pinFileFor(t);
    const cases = [...EXCLUDED_SAMPLES.map(([ip, range]) => ({interfaces: nic('乙太網路', ip), ip, expect: range})),
        ...BLACKLISTED_NICS.map(name => ({interfaces: nic(name, '163.27.10.20'), ip: '163.27.10.20', expect: name}))];
    for (const {interfaces, ip, expect} of cases) {
        const spy = promptSpy('Y');
        const result = await resolveLanAddress({pinFile, interactive: true, prompt: spy.fn, interfaces});
        assert.equal(result.ok, false, ip);
        assert.equal(spy.calls, 0, `${ip} 不可詢問`);
        assert.equal(await fileExists(pinFile), false, `${ip} 不可寫釘選檔`);
        assert.ok(result.reasons.some(r => r.includes(ip) && r.includes(expect)), `${ip}: ${result.reasons.join(' | ')}`);
    }
});

test('A7\'3 永不綁 0.0.0.0：監聽位址只有 127.0.0.1 與選定位址；公開位址確認後顯示學校警語', async t => {
    const originalListen = http.Server.prototype.listen;
    const hosts = [];
    // 記錄實際要求的監聽位址；測試中把區網監聽器改綁回送位址的隨機埠，避免真的開放網路。
    http.Server.prototype.listen = function (port, host, ...rest) {
        hosts.push(host);
        return originalListen.call(this, host === '127.0.0.1' ? port : 0, '127.0.0.1', ...rest);
    };
    t.after(() => {http.Server.prototype.listen = originalListen;});
    const ready = await settingsFor(await directory(t));
    const pinFile = await pinFileFor(t);
    const privatePort = await freePort();
    const privateRun = await startTutor({...await isolated(t), env: {TUTOR_LAN: '1', TUTOR_PORT: String(privatePort), TUTOR_LAN_IP: '192.168.1.23'},
        interfaces: oneLan, teacherSettings: ready, buildDir: fixtureDir, lanPinFile: pinFile, interactive: false});
    t.after(async () => {await closeServer(privateRun.server); await closeServer(privateRun.lanServer);});
    assert.deepEqual(hosts, ['127.0.0.1', '192.168.1.23']);
    assert.equal(privateRun.lanKind, 'private');
    const spy = promptSpy('Y');
    const publicRun = await startTutor({...await isolated(t), env: {TUTOR_LAN: '1', TUTOR_PORT: String(await freePort())},
        interfaces: nic('乙太網路', SCHOOL_IP), teacherSettings: ready, buildDir: fixtureDir, lanPinFile: pinFile,
        interactive: true, prompt: spy.fn});
    t.after(async () => {await closeServer(publicRun.server); await closeServer(publicRun.lanServer);});
    assert.deepEqual(hosts, ['127.0.0.1', '192.168.1.23', '127.0.0.1', SCHOOL_IP]);
    assert.ok(hosts.every(host => typeof host === 'string' && host !== '0.0.0.0' && !host.includes(':')));
    assert.equal(publicRun.address, SCHOOL_IP);
    assert.equal(publicRun.lanKind, 'public');
    assert.equal(spy.calls, 1);
    assert.equal(JSON.parse(await fs.readFile(pinFile, 'utf8')).address, SCHOOL_IP);
    // 選擇結果不可能是 0.0.0.0：即使網卡或指定值是 0.0.0.0 也被排除。
    assert.equal(selectLanAddress({requested: '0.0.0.0', interfaces: nic('乙太網路', '0.0.0.0')}).ok, false);
    assert.equal(selectLanAddress({interfaces: nic('乙太網路', '0.0.0.0')}).ok, false);
    // 說明文字依綁定類型不同。
    const publicText = lanBanner({kind: 'public', address: SCHOOL_IP, interfaceName: '乙太網路', port: 8612}).join('\n');
    const privateText = lanBanner({kind: 'private', address: '192.168.1.23', interfaceName: 'Wi-Fi', port: 8612}).join('\n');
    for (const phrase of ['學校公開網段', '學校防火牆', '「私人網路」或「網域」', '公用', '行動數據', '下課', `http://${SCHOOL_IP}:8612/editor.html`]) {
        assert.ok(publicText.includes(phrase), phrase);
    }
    assert.ok(privateText.includes('私人網段') && privateText.includes('http://192.168.1.23:8612/editor.html'));
    assert.ok(!privateText.includes('行動數據') && !privateText.includes('學校防火牆'));
    assert.ok(!`${publicText}\n${privateText}`.includes('RFC1918'));
});

test('連線層：預設 requestTimeout 30 秒、headersTimeout 10 秒、maxConnections 200（兩個監聽器）', async t => {
    const dir = await directory(t);
    const server = createTutorServer({buildDir: fixtureDir, teacherSettings: await settingsFor(dir), lan: {address: LAN_ADDRESS}});
    for (const instance of [server, server.lanServer]) {
        assert.equal(instance.requestTimeout, REQUEST_TIMEOUT_MS);
        assert.equal(instance.headersTimeout, HEADERS_TIMEOUT_MS);
        assert.equal(instance.maxConnections, MAX_CONNECTIONS);
    }
    assert.deepEqual([REQUEST_TIMEOUT_MS, HEADERS_TIMEOUT_MS, MAX_CONNECTIONS], [30000, 10000, 200]);
});

test('連線層：requestTimeout 只截斷慢速上傳，不截斷本體已收完、等待上游較久的請求', async t => {
    // 縮小比例：requestTimeout 400ms 對應正式的 30 秒，上游延遲 1200ms 對應正式最長 90 秒。
    let calls = 0;
    const p = await pair(t, {serverOptions: {requestTimeout: 400, headersTimeout: 300, connectionsCheckingInterval: 50},
        fetchImpl: async () => {calls++; await new Promise(resolve => setTimeout(resolve, 1200)); return modelResponse();}});
    const started = Date.now();
    const slowUpstream = await p.post(p.lanBase, '/api/tutor', {mode: 'live', context, question: '等久一點'});
    assert.equal(slowUpstream.status, 200);
    assert.ok(Date.now() - started >= 1100);
    assert.equal(calls, 1);
    const reply = await new Promise(resolve => {
        const socket = net.connect(p.lanPort, '127.0.0.1');
        let data = '';
        socket.on('data', chunk => {data += chunk;});
        socket.on('error', () => {});
        socket.on('close', () => resolve(data));
        socket.write(`POST /api/tutor HTTP/1.1\r\nHost: ${LAN_ADDRESS}:${p.lanPort}\r\nOrigin: ${p.lanBase}\r\n` +
            'Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{"mode":');
    });
    assert.match(reply, /^HTTP\/1\.1 408/);
    assert.equal(calls, 1);
});

// ---- 前端：http: 同來源（本機或區網位址）視為導師服務；https（GitHub Pages）不呼叫 API ----
const require = createRequire(import.meta.url);
const React = require('react');
const {create, act} = require('react-test-renderer');
const {useTutorConnection, isTutorServicePage} = require('../../src/lib/tutor-connection.js');
const tabSource = path.resolve(here, '../../src/components/judge-panel/tutor-tab.jsx');
const tabCode = require('@babel/core').transformFileSync(tabSource, {
    babelrc: false, configFile: false,
    presets: [require.resolve('@babel/preset-react')],
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
}).code;
const tabRequire = createRequire(tabSource);
const tabModule = {exports: {}};
new Function('require', 'module', 'exports', tabCode)(name => {
    if (name === './tutor.css') return {};
    if (name === '../../lib/tw-lazy-scratch-blocks') return {isLoaded: () => false};
    return tabRequire(name);
}, tabModule, tabModule.exports);
const {TutorTab} = tabModule.exports;
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const roots = [];
afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    if (typeof originalWindow === 'undefined') delete globalThis.window;
    else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
});
const lanLocation = {protocol: 'http:', hostname: '192.168.1.23', host: '192.168.1.23:8612'};

test('前端：區網 http: 頁面視為導師服務；https 與 file: 不是', () => {
    for (const [location, expected] of [[lanLocation, true], [{protocol: 'http:', hostname: '127.0.0.1'}, true],
        [{protocol: 'https:', hostname: 'bai-collab.github.io'}, false], [{protocol: 'file:', hostname: ''}, false]]) {
        globalThis.window = {location};
        assert.equal(isTutorServicePage(), expected, JSON.stringify(location));
    }
});

test('前端：區網頁面讀取教師設定狀態；https 頁面完全不呼叫 API', async () => {
    const calls = [];
    const Harness = ({state}) => {
        state.api = useTutorConnection();
        return null;
    };
    globalThis.window = {location: {protocol: 'https:', hostname: 'bai-collab.github.io'}};
    globalThis.fetch = async url => {calls.push(url); throw new Error('UNEXPECTED');};
    const httpsState = {};
    await act(async () => {roots.push(create(React.createElement(Harness, {state: httpsState})));});
    assert.equal(calls.length, 0);
    assert.equal(httpsState.api.aiConfigured, false);
    globalThis.window = {location: lanLocation};
    globalThis.fetch = async url => {
        calls.push(url);
        return new Response(JSON.stringify({managed: true, aiConfigured: true}), {headers: {'Content-Type': 'application/json'}});
    };
    const lanState = {};
    await act(async () => {roots.push(create(React.createElement(Harness, {state: lanState})));});
    assert.deepEqual(calls, ['./api/tutor/status']);
    assert.equal(lanState.api.aiConfigured, true);
    assert.equal(lanState.api.managed, true);
});

const vmStub = {toJSON: () => JSON.stringify({targets: [{name: '角色', blocks: {}}]})};
const renderTab = () => {
    let root;
    act(() => {
        root = create(React.createElement(TutorTab, {task: {code: 'fixture', title: '測試題', description: '讀取輸入。', examples: []},
            vm: vmStub, apiKey: '', mode: 'mock', connection: {managed: true, aiConfigured: true, statusReady: true}}));
    });
    roots.push(root);
    return root;
};
const textOf = node => (node.children || []).map(child => (typeof child === 'string' ? child : textOf(child))).join('');

test('前端：區網頁面可求助並顯示「紀錄已達上限」；https 頁面不送出', async () => {
    globalThis.window = {location: lanLocation};
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push(url);
        if (url === './api/tutor/status') {
            return new Response(JSON.stringify({managed: true, aiConfigured: true}), {headers: {'Content-Type': 'application/json'}});
        }
        assert.equal(JSON.parse(options.body).mode, 'mock');
        return new Response(JSON.stringify({source: 'mock', guidance: '先觀察', question: '發現什麼？',
            recording: {status: 'limit'}}), {headers: {'Content-Type': 'application/json'}});
    };
    const root = renderTab();
    assert.equal(root.root.findAllByProps({role: 'alert'}).length, 0);
    act(() => root.root.findByProps({id: 'tutor-question'}).props.onChange({target: {value: '怎麼開始？'}}));
    await act(async () => root.root.findByType('form').props.onSubmit({preventDefault() {}}));
    assert.ok(calls.includes('./api/tutor'));
    assert.ok(root.root.findAll(node => node.type === 'p').some(node => textOf(node) === '紀錄已達上限，請教師處理。'));

    globalThis.window = {location: {protocol: 'https:', hostname: 'bai-collab.github.io'}};
    calls.length = 0;
    const pages = renderTab();
    act(() => pages.root.findByProps({id: 'tutor-question'}).props.onChange({target: {value: '怎麼開始？'}}));
    await act(async () => pages.root.findByType('form').props.onSubmit({preventDefault() {}}));
    assert.ok(!calls.includes('./api/tutor'));
    assert.ok(pages.root.findAllByProps({role: 'alert'}).length >= 1);
});

// ---- 非安全來源（區網 http）沒有 crypto.randomUUID：紀錄編號改用 getRandomValues，仍可保存 ----
const {createRecordId, newRecordId, setStudentId} = require('../../src/lib/learning-records.js');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const withoutRandomUUID = async run => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const webcrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {configurable: true, writable: true,
        value: {getRandomValues: array => webcrypto.getRandomValues(array)}});
    try {
        assert.equal(typeof globalThis.crypto.randomUUID, 'undefined');
        return await run();
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
        else delete globalThis.crypto;
    }
};

test('非安全來源：沒有 crypto.randomUUID 時仍產生 v4 UUID，且被 recordStore 接受', async t => {
    const ids = new Set();
    for (let i = 0; i < 200; i++) {
        const id = createRecordId({getRandomValues: array => globalThis.crypto.getRandomValues(array)});
        assert.match(id, UUID_V4);
        assert.match(id, /^[a-zA-Z0-9_-]{8,80}$/); // record-store 的 id 驗證
        ids.add(id);
    }
    assert.equal(ids.size, 200);
    assert.match(createRecordId({randomUUID: () => '11111111-2222-4333-8444-555555555555'}), UUID_V4);
    assert.throws(() => createRecordId(null), /無法產生紀錄編號/);
    const dir = await directory(t);
    const store = createRecordStore(dir, {syncScope: 'offline'});
    await withoutRandomUUID(async () => {
        const id = newRecordId();
        assert.match(id, UUID_V4);
        assert.deepEqual(await store.save({...grade(), id}), {status: 'saved_local', id});
    });
});

test('非安全來源：區網學生頁真實模型求助會帶有效紀錄編號並寫入教師機紀錄', async t => {
    const p = await pair(t);
    globalThis.window = {location: lanLocation};
    setStudentId('A_S01');
    t.after(() => setStudentId(''));
    let forwarded;
    globalThis.fetch = async (url, options) => {
        if (url === './api/tutor/status') {
            return new Response(JSON.stringify({managed: true, aiConfigured: true}), {headers: {'Content-Type': 'application/json'}});
        }
        // 轉送到真正的區網監聽器（同一次 createTutorServer 建立）。
        forwarded = JSON.parse(options.body);
        return originalFetch(p.lanBase + '/api/tutor', {method: 'POST', body: options.body,
            headers: {'Content-Type': 'application/json', Origin: p.lanBase}});
    };
    await withoutRandomUUID(async () => {
        let root;
        act(() => {
            root = create(React.createElement(TutorTab, {task: {code: 'fixture', title: '測試題', description: '讀取輸入。', examples: []},
                vm: vmStub, apiKey: '', mode: 'live', connection: {managed: true, aiConfigured: true, statusReady: true}}));
        });
        roots.push(root);
        act(() => root.root.findByProps({id: 'tutor-question'}).props.onChange({target: {value: '怎麼開始？'}}));
        await act(async () => root.root.findByType('form').props.onSubmit({preventDefault() {}}));
        const texts = root.root.findAll(node => node.type === 'p').map(textOf);
        assert.ok(!texts.some(text => text.includes('randomUUID')), texts.join('|'));
        assert.equal(root.root.findAllByProps({role: 'alert'}).length, 0);
        assert.ok(texts.includes('已保存本機紀錄；試算表同步狀態請看教師頁。'), texts.join('|'));
    });
    assert.match(forwarded.learning.id, UUID_V4);
    const saved = await p.recordStore.list();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, forwarded.learning.id);
    assert.equal(saved[0].studentId, 'A_S01');
    assert.equal(saved[0].source, 'nmking');
});

// ---- v4：單一啟動檔 start-tutor.cmd＋記住上次選擇（C1–C14 與 v4.3 寫入時機） ----
const NO_STUDENTS = '學生無法連線，只有這台電腦可用。';
const lanNic = {'Wi-Fi': [{address: '192.168.1.23', family: 'IPv4', internal: false, cidr: '192.168.1.23/24'}]};
const homeNic = {'Wi-Fi': [{address: '192.168.1.10', family: 'IPv4', internal: false, cidr: '192.168.1.10/24'}]};
const schoolNic = {'乙太網路': [{address: SCHOOL_IP, family: 'IPv4', internal: false, cidr: '163.27.45.21/24'}]};
const REMEMBERED_PRIVATE = {version: 1, mode: 'lan', address: '192.168.1.23', interfaceName: 'Wi-Fi',
    cidr: '192.168.1.23/24', kind: 'private'};
const REMEMBERED_SCHOOL = {version: 1, mode: 'lan', address: SCHOOL_IP, interfaceName: '乙太網路',
    cidr: '163.27.45.21/24', kind: 'public'};
const PIN_SCHOOL = {version: 1, address: SCHOOL_IP, interfaceName: '乙太網路', confirmedAt: '2026-10-02T00:00:00.000Z'};
const LOCAL_ONLY = {version: 1, mode: 'local'};
function fakeClock() {
    let now = 0, seq = 0;
    const timers = new Map();
    return {
        setTimeout: (fn, ms) => {
            const id = ++seq;
            timers.set(id, {fn, at: now + ms});
            return id;
        },
        clearTimeout: id => {timers.delete(id);},
        advance(ms) {
            now += ms;
            for (const [id, timer] of [...timers]) if (timer.at <= now) {timers.delete(id); timer.fn();}
        },
        pending: () => timers.size
    };
}
// 記錄每次監聽要求的位址；非回送位址改綁回送隨機埠（測試不開放網路）。failHost 模擬該位址監聽失敗。
function spyListen(t, {failHost = null} = {}) {
    const originalListen = http.Server.prototype.listen;
    const hosts = [];
    http.Server.prototype.listen = function (port, host, ...rest) {
        hosts.push(host);
        if (host === failHost) {
            process.nextTick(() => this.emit('error', Object.assign(new Error('模擬監聽失敗'), {code: 'EADDRNOTAVAIL'})));
            return this;
        }
        return originalListen.call(this, host === '127.0.0.1' ? port : 0, '127.0.0.1', ...rest);
    };
    t.after(() => {http.Server.prototype.listen = originalListen;});
    return hosts;
}
async function launch(t, {interfaces = lanNic, remembered, pin, env = {}, interactive = true, ready = true,
    launchModeIsDirectory = false} = {}) {
    const dir = await directory(t);
    const launchModeFile = path.join(dir, 'launch-mode.json');
    const lanPinFile = path.join(dir, 'lan-address.json');
    if (launchModeIsDirectory) await fs.mkdir(launchModeFile);
    else if (remembered !== undefined) {
        await fs.writeFile(launchModeFile, typeof remembered === 'string' ? remembered : JSON.stringify(remembered));
    }
    if (pin) await fs.writeFile(lanPinFile, JSON.stringify(pin));
    const teacherSettings = await settingsFor(dir, {initialize: ready});
    const input = new PassThrough();
    const signals = new EventEmitter();
    const clock = fakeClock();
    let text = '';
    const output = {write: chunk => {text += chunk; return true;}};
    const port = await freePort();
    const promise = startTutor({env: {TUTOR_PORT: String(port), ...env}, interfaces, teacherSettings, buildDir: fixtureDir,
        launchModeFile, lanPinFile, interactive, input, output, signals, clock});
    const h = {dir, launchModeFile, lanPinFile, input, signals, clock, port, text: () => text,
        waitFor: needle => until(() => text.includes(needle)),
        type: line => input.write(`${line}\n`),
        file: () => fs.readFile(launchModeFile, 'utf8').catch(() => null),
        json: async () => JSON.parse(await fs.readFile(launchModeFile, 'utf8')),
        done: async () => {
            const result = await promise;
            if (result.server) t.after(() => closeServer(result.server));
            if (result.lanServer) t.after(() => closeServer(result.lanServer));
            return result;
        }};
    return h;
}
const questionFirst = '要開放給教室學生連線嗎';
const countdownLan = '秒內輸入 N 並按 Enter';
const countdownLocal = '秒內輸入 Y 並按 Enter';

test('C1 教師設定未完成：只開本機、不詢問、不讀也不寫選擇檔', async t => {
    const hosts = spyListen(t);
    for (const remembered of [undefined, REMEMBERED_PRIVATE]) {
        hosts.length = 0;
        const h = await launch(t, {ready: false, remembered});
        const before = await h.file();
        const result = await h.done();
        assert.equal(result.lanServer, null);
        assert.deepEqual(hosts, ['127.0.0.1']);
        assert.ok(h.text().includes('完成教師頁設定後重新啟動，就能選擇開放給教室'));
        assert.ok(h.text().includes(NO_STUDENTS));
        assert.ok(!h.text().includes('(Y/N)') && !h.text().includes('秒內'));
        assert.equal(await h.file(), before);
        assert.equal(h.clock.pending(), 0);
    }
});

test('C2 沒有紀錄：Y 開放並記 lan；N 或空白只開本機並記 local；非互動只開本機不寫檔', async t => {
    const hosts = spyListen(t);
    let h = await launch(t);
    await h.waitFor(questionFirst);
    h.type('Y');
    let result = await h.done();
    assert.equal(result.address, '192.168.1.23');
    assert.deepEqual(hosts, ['127.0.0.1', '192.168.1.23']);
    assert.deepEqual(await h.json(), REMEMBERED_PRIVATE);
    assert.ok(h.text().includes('區網模式已啟動：私人網段位址 192.168.1.23'));
    assert.ok(h.text().includes(`學生網址：http://192.168.1.23:${h.port}/editor.html?turbo`));
    for (const answer of ['n', '', 'NO']) {
        hosts.length = 0;
        h = await launch(t);
        await h.waitFor(questionFirst);
        h.type(answer);
        result = await h.done();
        assert.equal(result.lanServer, null, answer);
        assert.deepEqual(hosts, ['127.0.0.1']);
        assert.deepEqual(await h.json(), LOCAL_ONLY, `首次選「${answer}」後記 local`);
        assert.ok(h.text().includes(NO_STUDENTS));
    }
    hosts.length = 0;
    h = await launch(t, {interactive: false});
    result = await h.done();
    assert.equal(result.lanServer, null);
    assert.deepEqual(hosts, ['127.0.0.1']);
    assert.equal(await h.file(), null);
    assert.ok(!h.text().includes(questionFirst));
    assert.ok(h.text().includes('不是互動視窗') && h.text().includes(NO_STUDENTS));
});

test('C3 記住 lan（同位置）：逾時開放、n 改記 local；記住 local：逾時只開本機、y 開放並記 lan', async t => {
    const hosts = spyListen(t);
    let h = await launch(t, {remembered: REMEMBERED_PRIVATE});
    await h.waitFor(countdownLan);
    assert.ok(h.text().includes('已記住：開放給教室（192.168.1.23，Wi-Fi）'));
    h.clock.advance(LAN_COUNTDOWN_MS);
    let result = await h.done();
    assert.equal(result.address, '192.168.1.23');
    assert.deepEqual(hosts, ['127.0.0.1', '192.168.1.23']);
    assert.deepEqual(await h.json(), REMEMBERED_PRIVATE);
    assert.ok(h.text().includes('學生網址：http://192.168.1.23:'));
    hosts.length = 0;
    h = await launch(t, {remembered: REMEMBERED_PRIVATE});
    await h.waitFor(countdownLan);
    h.type('n');
    result = await h.done();
    assert.equal(result.lanServer, null);
    assert.deepEqual(hosts, ['127.0.0.1']);
    assert.deepEqual(await h.json(), LOCAL_ONLY);
    assert.ok(h.text().includes(NO_STUDENTS));
    hosts.length = 0;
    h = await launch(t, {remembered: LOCAL_ONLY});
    await h.waitFor(countdownLocal);
    const localBefore = await h.file();
    h.clock.advance(LAN_COUNTDOWN_MS);
    result = await h.done();
    assert.equal(result.lanServer, null);
    assert.deepEqual(hosts, ['127.0.0.1']);
    assert.equal(await h.file(), localBefore);
    hosts.length = 0;
    h = await launch(t, {remembered: LOCAL_ONLY});
    await h.waitFor(countdownLocal);
    h.type('y');
    result = await h.done();
    assert.equal(result.address, '192.168.1.23');
    assert.deepEqual(await h.json(), REMEMBERED_PRIVATE);
    assert.ok(h.text().includes('學生網址：http://192.168.1.23:'));
});

test('C3 倒數結束後，緊接著的 v3 公開位址確認讀得到 Y 並完成釘選；已釘選的學校位址不按鍵即自動開放', async t => {
    const hosts = spyListen(t);
    let h = await launch(t, {interfaces: schoolNic, remembered: REMEMBERED_SCHOOL});
    await h.waitFor(countdownLan);
    h.clock.advance(LAN_COUNTDOWN_MS);
    await h.waitFor('確認目前在學校網路內並記住這個位址？(Y/N)');
    h.type('Y');
    let result = await h.done();
    assert.equal(result.address, SCHOOL_IP);
    assert.equal(JSON.parse(await fs.readFile(h.lanPinFile, 'utf8')).address, SCHOOL_IP);
    assert.deepEqual(await h.json(), REMEMBERED_SCHOOL);
    assert.ok(h.text().includes('學校公開網段位址 163.27.45.21') && h.text().includes('行動數據'));
    // 使用者學校現況：已釘選＋記住 lan → 倒數逾時直接開放，不再詢問。
    hosts.length = 0;
    h = await launch(t, {interfaces: schoolNic, remembered: REMEMBERED_SCHOOL, pin: PIN_SCHOOL});
    await h.waitFor(countdownLan);
    h.clock.advance(LAN_COUNTDOWN_MS);
    result = await h.done();
    assert.equal(result.address, SCHOOL_IP);
    assert.deepEqual(hosts, ['127.0.0.1', SCHOOL_IP]);
    assert.ok(!h.text().includes('確認目前在學校網路內'));
});

test('C4 記住學校位址但網卡只有家用 192.168.1.10：非互動／空白只開本機；y 才開放並記新位址', async t => {
    const hosts = spyListen(t);
    let h = await launch(t, {interfaces: homeNic, remembered: REMEMBERED_SCHOOL, pin: PIN_SCHOOL, interactive: false});
    let before = await h.file();
    let result = await h.done();
    assert.equal(result.lanServer, null);
    assert.deepEqual(hosts, ['127.0.0.1']);
    assert.equal(await h.file(), before);
    assert.ok(h.text().includes(NO_STUDENTS));
    hosts.length = 0;
    h = await launch(t, {interfaces: homeNic, remembered: REMEMBERED_SCHOOL, pin: PIN_SCHOOL});
    await h.waitFor('偵測到新位址 192.168.1.10（Wi-Fi）');
    assert.equal(h.clock.pending(), 0); // 新位址詢問不倒數，不會自動開放
    before = await h.file();
    h.type('');
    result = await h.done();
    assert.equal(result.lanServer, null);
    assert.deepEqual(hosts, ['127.0.0.1']);
    assert.equal(await h.file(), before);
    assert.ok(h.text().includes(NO_STUDENTS));
    hosts.length = 0;
    h = await launch(t, {interfaces: homeNic, remembered: REMEMBERED_SCHOOL, pin: PIN_SCHOOL});
    await h.waitFor('偵測到新位址 192.168.1.10');
    h.type('y');
    result = await h.done();
    assert.equal(result.address, '192.168.1.10');
    assert.deepEqual(hosts, ['127.0.0.1', '192.168.1.10']);
    assert.deepEqual(await h.json(), {version: 1, mode: 'lan', address: '192.168.1.10', interfaceName: 'Wi-Fi',
        cidr: '192.168.1.10/24', kind: 'private'});
});

test('C4 記住 lan 但區網無法使用（多候選、只有排除網段、釘選位址不在網卡）：只開本機、選擇檔位元組不變', async t => {
    const hosts = spyListen(t);
    for (const interfaces of [{...lanNic, ...nic('乙太網路', SCHOOL_IP)}, nic('乙太網路', '169.254.3.4')]) {
        hosts.length = 0;
        const h = await launch(t, {interfaces, remembered: REMEMBERED_SCHOOL, pin: PIN_SCHOOL});
        const before = await h.file();
        const result = await h.done();
        assert.equal(result.lanServer, null);
        assert.deepEqual(hosts, ['127.0.0.1']);
        assert.equal(await h.file(), before);
        assert.ok(!h.text().includes('(Y/N)') && !h.text().includes('秒內'));
        assert.ok(h.text().includes('無法開放給教室') && h.text().includes(NO_STUDENTS));
    }
    hosts.length = 0;
    const moved = {'乙太網路': [{address: '163.27.45.99', family: 'IPv4', internal: false, cidr: '163.27.45.99/24'}]};
    const h = await launch(t, {interfaces: moved, remembered: REMEMBERED_SCHOOL, pin: PIN_SCHOOL});
    const before = await h.file();
    await h.waitFor('偵測到新位址 163.27.45.99');
    h.type('y');
    const result = await h.done();
    assert.equal(result.lanServer, null);
    assert.deepEqual(hosts, ['127.0.0.1']);
    assert.equal(await h.file(), before);
    assert.ok(h.text().includes(`已記住的學校位址 ${SCHOOL_IP}`) && h.text().includes(NO_STUDENTS));
});

test('C5 TUTOR_LAN=1：區網無法使用仍拒絕啟動且不寫檔；成功時記 lan；監聽失敗拒絕且不寫 lan', async t => {
    spyListen(t, {failHost: '192.168.1.99'});
    let h = await launch(t, {interfaces: schoolNic, env: {TUTOR_LAN: '1'}, interactive: false});
    await assert.rejects(h.done(), error => error.code === 'TUTOR_START_REFUSED');
    assert.equal(await h.file(), null);
    h = await launch(t, {env: {TUTOR_LAN: '1'}, interactive: false});
    const result = await h.done();
    assert.equal(result.address, '192.168.1.23');
    assert.deepEqual(await h.json(), REMEMBERED_PRIVATE);
    assert.ok(h.text().includes('學生網址：http://192.168.1.23:'));
    const failNic = {'Wi-Fi': [{address: '192.168.1.99', family: 'IPv4', internal: false, cidr: '192.168.1.99/24'}]};
    h = await launch(t, {interfaces: failNic, env: {TUTOR_LAN: '1'}, interactive: false});
    await assert.rejects(h.done(), error => error.code === 'TUTOR_START_REFUSED' && error.message.includes('192.168.1.99'));
    assert.equal(await h.file(), null);
});

test('v4.3 一般路線區網監聽失敗：保留本機、印出原因、不改綁其他位址、不寫 lan', async t => {
    const hosts = spyListen(t, {failHost: '192.168.1.23'});
    const h = await launch(t);
    await h.waitFor(questionFirst);
    h.type('y');
    const result = await h.done();
    assert.equal(result.lanServer, null);
    assert.ok(result.server.listening);
    assert.deepEqual(hosts, ['127.0.0.1', '192.168.1.23']);
    assert.equal(await h.file(), null);
    assert.ok(h.text().includes('無法監聽 192.168.1.23') && h.text().includes(NO_STUDENTS));
});

test('C6 選擇檔損壞視同沒有紀錄；寫入為原子操作（不留暫存檔）', async t => {
    spyListen(t);
    const h = await launch(t, {remembered: '{broken'});
    await h.waitFor(questionFirst);
    h.type('y');
    await h.done();
    assert.deepEqual(await h.json(), REMEMBERED_PRIVATE);
    assert.deepEqual((await fs.readdir(h.dir)).filter(name => name.endsWith('.tmp')), []);
});

test('C9 倒數中 Ctrl+C（注入的 SIGINT）或輸入串流關閉：中止、沒有任何監聽器、選擇檔不變', async t => {
    const hosts = spyListen(t);
    for (const abort of [h => h.signals.emit('SIGINT'), h => h.input.end(), h => h.input.destroy()]) {
        hosts.length = 0;
        const h = await launch(t, {remembered: REMEMBERED_PRIVATE});
        const before = await h.file();
        await h.waitFor(countdownLan);
        assert.equal(h.clock.pending(), 1);
        abort(h);
        const result = await h.done();
        assert.deepEqual(result, {aborted: true});
        h.clock.advance(LAN_COUNTDOWN_MS * 2);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.deepEqual(hosts, []);
        assert.equal(h.clock.pending(), 0);
        assert.equal(await h.file(), before);
        assert.equal(h.signals.listenerCount('SIGINT'), 0);
    }
    // v3 公開位址確認時按 Ctrl+C 同樣中止，不寫釘選檔。
    hosts.length = 0;
    const h = await launch(t, {interfaces: schoolNic, remembered: REMEMBERED_SCHOOL});
    await h.waitFor(countdownLan);
    h.clock.advance(LAN_COUNTDOWN_MS);
    await h.waitFor('確認目前在學校網路內');
    h.signals.emit('SIGINT');
    assert.deepEqual(await h.done(), {aborted: true});
    assert.deepEqual(hosts, []);
    assert.equal(await fileExists(h.lanPinFile), false);
});

test('C10 非互動＋記住 lan：只開本機，選擇檔不變', async t => {
    const hosts = spyListen(t);
    for (const [interfaces, remembered, pin] of [[lanNic, REMEMBERED_PRIVATE], [schoolNic, REMEMBERED_SCHOOL, PIN_SCHOOL]]) {
        hosts.length = 0;
        const h = await launch(t, {interfaces, remembered, pin, interactive: false});
        const before = await h.file();
        const result = await h.done();
        assert.equal(result.lanServer, null);
        assert.deepEqual(hosts, ['127.0.0.1']);
        assert.equal(await h.file(), before);
    }
});

test('C11 選擇檔反例一律視同沒有紀錄，不用檔案裡的位址監聽', async t => {
    const hosts = spyListen(t);
    const bad = [
        {...REMEMBERED_PRIVATE, address: '0.0.0.0', kind: 'private'}, {...REMEMBERED_PRIVATE, address: '127.0.0.1'},
        {...REMEMBERED_PRIVATE, address: 'fe80::1'}, {...REMEMBERED_PRIVATE, mode: 'public'}, {...REMEMBERED_PRIVATE, mode: 'LAN'},
        {...REMEMBERED_PRIVATE, kind: 'public'}, {...REMEMBERED_PRIVATE, version: 2},
        {...REMEMBERED_PRIVATE, interfaceName: 'x'.repeat(129)}, {...REMEMBERED_PRIVATE, interfaceName: 7},
        (({cidr, ...rest}) => rest)(REMEMBERED_PRIVATE), [REMEMBERED_PRIVATE], 'null', '"lan"'
    ];
    const dir = await directory(t);
    for (const [index, content] of bad.entries()) {
        const file = path.join(dir, `bad-${index}.json`);
        await fs.writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
        assert.equal(await readLaunchMode(file), null, JSON.stringify(content));
    }
    assert.equal(await readLaunchMode(dir), null); // 路徑是資料夾
    for (const options of [{remembered: bad[0]}, {remembered: bad[1]}, {remembered: bad[2]}, {remembered: bad[3]},
        {launchModeIsDirectory: true}]) {
        hosts.length = 0;
        const h = await launch(t, options);
        const before = await h.file();
        await h.waitFor(questionFirst); // 視同沒有紀錄：首次詢問，不倒數
        assert.equal(h.clock.pending(), 0);
        h.type('ㄙ');
        const result = await h.done();
        assert.equal(result.lanServer, null);
        assert.deepEqual(hosts, ['127.0.0.1']);
        assert.equal(await h.file(), before);
    }
    // 合法但不同的記住位址：監聽位址只來自本次選位（192.168.1.23），不是檔案裡的 192.168.1.50。
    hosts.length = 0;
    const h = await launch(t, {remembered: {...REMEMBERED_PRIVATE, address: '192.168.1.50', cidr: '192.168.1.50/24'}});
    await h.waitFor('偵測到新位址 192.168.1.23');
    h.type('y');
    await h.done();
    assert.deepEqual(hosts, ['127.0.0.1', '192.168.1.23']);
});

test('C12 輸入「ㄙ」或全形「ｎ」：只開本機，紀錄不變（NFKC 後保守解讀）', async t => {
    const hosts = spyListen(t);
    for (const [remembered, prompt] of [[REMEMBERED_PRIVATE, countdownLan], [LOCAL_ONLY, countdownLocal], [undefined, questionFirst]]) {
        for (const answer of ['ㄙ', 'ｎ', 'ｎｏ', 'maybe']) {
            hosts.length = 0;
            const h = await launch(t, {remembered});
            const before = await h.file();
            await h.waitFor(prompt);
            h.type(answer);
            const result = await h.done();
            assert.equal(result.lanServer, null, `${prompt} ${answer}`);
            assert.deepEqual(hosts, ['127.0.0.1']);
            assert.equal(await h.file(), before, `${prompt} ${answer}`);
        }
    }
    // NFKC：全形「Ｙ」視同 y。
    const h = await launch(t, {remembered: LOCAL_ONLY});
    await h.waitFor(countdownLocal);
    h.type(' Ｙ ');
    assert.equal((await h.done()).address, '192.168.1.23');
});

test('C13 記住 lan 但介面名稱或 cidr 不同：改為詢問，不倒數、不自動開放', async t => {
    const hosts = spyListen(t);
    for (const remembered of [{...REMEMBERED_PRIVATE, interfaceName: '乙太網路 2'}, {...REMEMBERED_PRIVATE, cidr: '192.168.1.23/16'}]) {
        hosts.length = 0;
        const h = await launch(t, {remembered});
        const before = await h.file();
        await h.waitFor('偵測到新位址 192.168.1.23（Wi-Fi）');
        assert.ok(!h.text().includes('秒內'));
        assert.equal(h.clock.pending(), 0);
        h.type('');
        const result = await h.done();
        assert.equal(result.lanServer, null);
        assert.deepEqual(hosts, ['127.0.0.1']);
        assert.equal(await h.file(), before);
    }
    // v3 釘選檔：同位址但介面名稱不同，視同未釘選，需重新確認。
    hosts.length = 0;
    const h = await launch(t, {interfaces: schoolNic, remembered: REMEMBERED_SCHOOL,
        pin: {...PIN_SCHOOL, interfaceName: '乙太網路 2'}});
    await h.waitFor(countdownLan);
    h.clock.advance(LAN_COUNTDOWN_MS);
    await h.waitFor('確認目前在學校網路內');
    h.type('N');
    const result = await h.done();
    assert.equal(result.lanServer, null);
    assert.deepEqual(hosts, ['127.0.0.1']);
});

test('C14 一般路線忽略 TUTOR_LAN_IP 並提示；監聽位址來自自動選位', async t => {
    const hosts = spyListen(t);
    let h = await launch(t, {env: {TUTOR_LAN_IP: '10.0.0.99'}, interactive: false});
    await h.done();
    assert.ok(h.text().includes('TUTOR_LAN_IP 只在 start-tutor-lan.cmd（TUTOR_LAN=1）時有效，這次忽略'));
    assert.deepEqual(hosts, ['127.0.0.1']);
    hosts.length = 0;
    h = await launch(t, {env: {TUTOR_LAN_IP: '10.0.0.99'}});
    await h.waitFor(questionFirst);
    h.type('y');
    await h.done();
    assert.deepEqual(hosts, ['127.0.0.1', '192.168.1.23']);
});

test('v4 提問前多打的行不算回答（避免殘留的 Enter 誤觸）', async t => {
    const hosts = spyListen(t);
    const h = await launch(t, {remembered: LOCAL_ONLY});
    h.type('y'); // 在提問之前送出
    await h.waitFor(countdownLocal);
    await new Promise(resolve => setTimeout(resolve, 30));
    h.clock.advance(LAN_COUNTDOWN_MS);
    const result = await h.done();
    assert.equal(result.lanServer, null);
    assert.deepEqual(hosts, ['127.0.0.1']);
});
