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
import {createTutorServer, startTutor, selectLanAddress, isPrivateLanIPv4, lanReadiness,
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
    await new Promise(resolve => setTimeout(resolve, 100));
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
    await assert.rejects(startTutor({env, interfaces: oneLan, teacherSettings: uninitialized, buildDir: fixtureDir}),
        error => error.code === 'TUTOR_START_REFUSED' && error.reasons.some(r => r.includes('尚未完成教師設定')));
    const noKey = await settingsFor(await directory(t), {key: ''});
    assert.equal(noKey.status().initialized, true);
    await assert.rejects(startTutor({env, interfaces: oneLan, teacherSettings: noKey, buildDir: fixtureDir}),
        error => error.code === 'TUTOR_START_REFUSED' && error.reasons.some(r => r.includes('尚未設定 AI 金鑰')));
    await assert.rejects(startTutor({env, interfaces: oneLan, teacherSettings: null, buildDir: fixtureDir}),
        error => error.code === 'TUTOR_START_REFUSED');
    assert.deepEqual(lanReadiness(null).length, 1);
    assert.equal(await portIsFree(port), true);
    // 不可走「沒有 teacherSettings」的舊後門建立區網監聽器。
    assert.throws(() => createTutorServer({lan: {address: '192.168.1.23'}}), /LAN_REQUIRES_TEACHER_SETTINGS/);
    // 條件齊全但區網位址無法綁定（本機沒有此位址）時同樣拒絕，並關閉已開的本機監聽。
    const ready = await settingsFor(await directory(t));
    await assert.rejects(startTutor({env: {...env, TUTOR_LAN_IP: '192.168.250.251'},
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
    const local = await startTutor({env: {TUTOR_PORT: String(port)}, teacherSettings: uninitialized, buildDir: fixtureDir});
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

test('A7 IP 選擇：只接受唯一的 RFC1918 候選；多候選、零候選、公網、100.64、指定非私有都拒絕並列原因', () => {
    for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.0.1']) assert.equal(isPrivateLanIPv4(ip), true, ip);
    for (const ip of ['8.8.8.8', '100.64.0.1', '100.127.1.1', '169.254.1.1', '127.0.0.1', '172.15.0.1', '172.32.0.1',
        '192.169.0.1', '0.0.0.0', '192.168.1.256', '192.168.01.1', 'fe80::1', '::ffff:192.168.1.1', '']) {
        assert.equal(isPrivateLanIPv4(ip), false, ip);
    }
    const multi = selectLanAddress({interfaces: {
        '乙太網路': [{address: '192.168.1.23', family: 'IPv4', internal: false}],
        'Wi-Fi': [{address: '10.0.0.5', family: 'IPv4', internal: false}]}});
    assert.equal(multi.ok, false);
    assert.ok(multi.reasons.join('\n').includes('192.168.1.23') && multi.reasons.join('\n').includes('10.0.0.5'));
    assert.ok(multi.reasons.some(r => r.includes('TUTOR_LAN_IP')));
    const zero = selectLanAddress({interfaces: {}});
    assert.equal(zero.ok, false);
    assert.ok(zero.reasons.some(r => r.includes('找不到')));
    const publicOnly = selectLanAddress({interfaces: {'乙太網路': [{address: '203.0.113.5', family: 'IPv4', internal: false}]}});
    assert.equal(publicOnly.ok, false);
    assert.ok(publicOnly.reasons.some(r => r.includes('203.0.113.5') && r.includes('公網')));
    const cgnatOnly = selectLanAddress({interfaces: {'乙太網路 2': [{address: '100.100.1.2', family: 'IPv4', internal: false}]}});
    assert.equal(cgnatOnly.ok, false);
    assert.ok(cgnatOnly.reasons.some(r => r.includes('100.100.1.2') && r.includes('100.64/10')));
    for (const requested of ['8.8.8.8', '100.64.1.2', '169.254.3.4', '127.0.0.1', 'fe80::1', '172.32.0.1']) {
        const result = selectLanAddress({requested, interfaces: {'乙太網路': [{address: requested, family: 'IPv4', internal: false}]}});
        assert.equal(result.ok, false, requested);
        assert.ok(result.reasons[0].includes(requested));
    }
    assert.equal(selectLanAddress({requested: '192.168.9.9', interfaces: oneLan}).ok, false); // 介面上不存在
    assert.deepEqual(selectLanAddress({requested: '192.168.1.23', interfaces: oneLan}),
        {ok: true, address: '192.168.1.23', reasons: []});
    // 只有一個 192.168 候選：虛擬／通道／回送／IPv6 介面全部被排除並列出原因。
    const single = selectLanAddress({interfaces: {
        'Wi-Fi': [{address: 'fe80::1234', family: 'IPv6', internal: false}, {address: '192.168.1.23', family: 'IPv4', internal: false}],
        'vEthernet (WSL)': [{address: '172.20.48.1', family: 'IPv4', internal: false}],
        'VMware Network Adapter VMnet8': [{address: '192.168.56.1', family: 'IPv4', internal: false}],
        'VirtualBox Host-Only Network': [{address: '192.168.99.1', family: 'IPv4', internal: false}],
        'Tailscale': [{address: '100.101.102.103', family: 'IPv4', internal: false}],
        'ZeroTier One': [{address: '10.147.17.5', family: 'IPv4', internal: false}],
        'OpenVPN TAP-Windows6': [{address: '10.8.0.6', family: 'IPv4', internal: false}],
        'Bluetooth Network Connection': [{address: '192.168.44.1', family: 'IPv4', internal: false}],
        'Loopback Pseudo-Interface 1': [{address: '127.0.0.1', family: 'IPv4', internal: true}]
    }});
    assert.equal(single.ok, true);
    assert.equal(single.address, '192.168.1.23');
    assert.equal(single.interfaceName, 'Wi-Fi');
    assert.equal(single.reasons.length, 9);
    for (const name of ['vEthernet', 'VMware', 'VirtualBox', 'Tailscale', 'ZeroTier', 'VPN', 'Bluetooth']) {
        assert.ok(single.reasons.some(r => r.includes(name)), name);
    }
});

test('A7 startTutor 在多候選時拒絕啟動並帶出原因', async t => {
    const port = await freePort();
    const ready = await settingsFor(await directory(t));
    await assert.rejects(startTutor({env: {TUTOR_LAN: '1', TUTOR_PORT: String(port)}, teacherSettings: ready, buildDir: fixtureDir,
        interfaces: {'乙太網路': [{address: '192.168.1.23', family: 'IPv4', internal: false}],
            'Wi-Fi': [{address: '192.168.2.40', family: 'IPv4', internal: false}]}}),
    error => error.code === 'TUTOR_START_REFUSED' && error.reasons.some(r => r.includes('192.168.2.40')));
    assert.equal(await portIsFree(port), true);
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
