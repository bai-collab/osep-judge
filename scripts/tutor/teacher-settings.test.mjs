import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createTeacherSettings, sheetScope} from './teacher-settings.mjs';
import {createTutorServer} from './server.mjs';
import {createRecordStore} from './record-store.mjs';
const scratch = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../workspace/osep-judge/teacher-settings-01');
const password = 'test-only-teacher-password', aiKey = 'test-only-ai-key', sheetToken = 'test-only-sheet-token'.repeat(3);
const sheetUrl = 'https://script.google.com/macros/s/TEST/exec';
const context = {task: {code: 'q1', title: '測試題', description: '公開說明'}, blocks: []};
const modelResponse = result => new Response(JSON.stringify({status: 'completed', output: [
    {type: 'message', content: [{type: 'output_text', text: JSON.stringify(result)}]}
]}));
const grade = {id: 'event-12345678', studentId: 'S01', type: 'grade', status: 'completed', task: context.task,
    program: {targets: [{name: '角色', blocks: {}}]}, totalScore: 0, maxScore: 40, programChanged: false};
async function dirFor(t) {
    await fs.mkdir(scratch, {recursive: true});
    const dir = await fs.mkdtemp(path.join(scratch, 'settings-'));
    t.after(async () => {if (!dir.startsWith(scratch + path.sep)) throw new Error('OUTSIDE_SCRATCH'); await fs.rm(dir, {recursive: true, force: true});});
    return dir;
}
async function serverFor(t, dir, options = {}) {
    const teacherSettings = await createTeacherSettings(path.join(dir, 'teacher-settings.json'));
    const recordStore = createRecordStore(dir, {syncScope: 'offline'});
    const server = createTutorServer({recordStore, teacherSettings, ...options});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (endpoint, body, cookie = '', origin = base) => fetch(base + endpoint, {method: 'POST',
        headers: {Origin: origin, 'Content-Type': 'application/json', Cookie: cookie}, body: JSON.stringify(body)});
    return {teacherSettings, recordStore, server, base, post};
}
test('設定持久化、密碼雜湊、留白保留與明確清除；損壞設定拒絕載入', async t => {
    const dir = await dirFor(t), file = path.join(dir, 'teacher-settings.json');
    let settings = await createTeacherSettings(file);
    await assert.rejects(settings.save({password: 'short'}));
    assert.equal(settings.status().initialized, false);
    await settings.save({password, aiKey, sheetUrl, sheetToken});
    const raw = await fs.readFile(file, 'utf8');
    assert.ok(!raw.includes(password));
    assert.ok(raw.includes(aiKey)); // 承認本機檔案保護範圍，非加密保險箱。
    settings = await createTeacherSettings(file);
    assert.equal(settings.verify(password), true);
    assert.equal(settings.verify('bad'), false);
    assert.ok(!JSON.stringify(settings.status()).includes(aiKey));
    await settings.save({password: '', aiKey: '', sheetToken: '', sheetUrl: ''});
    assert.equal(settings.secrets().aiKey, aiKey);
    await assert.rejects(settings.save({sheetUrl: 'https://evil.invalid/exec'}));
    assert.equal(settings.secrets().sheetUrl, sheetUrl);
    await settings.save({clearAi: true, clearSheet: true});
    assert.deepEqual(settings.secrets(), {aiKey: '', sheetUrl: '', sheetToken: ''});
    await fs.writeFile(file, 'broken');
    await assert.rejects(createTeacherSettings(file), /SETTINGS_READ_FAILED/);
});
test('試算表只接受正式exec與32至200字密鑰；拒絕設定不改原值', async t => {
    const settings = await createTeacherSettings(path.join(await dirFor(t), 'teacher-settings.json'));
    for (const length of [0, 31, 201]) {
        await assert.rejects(settings.save({password, sheetUrl, sheetToken: 'x'.repeat(length)}));
        assert.equal(settings.status().initialized, false);
    }
    for (const length of [32, 200]) {
        await settings.save({password, sheetUrl, sheetToken: 'x'.repeat(length)});
        assert.equal(settings.secrets().sheetToken.length, length);
    }
    const original = settings.secrets();
    for (const url of [sheetUrl.replace('/exec', '/dev'), `${sheetUrl}?test=1`, `${sheetUrl}/`]) {
        await assert.rejects(settings.save({sheetUrl: url, sheetToken}));
        assert.deepEqual(settings.secrets(), original);
    }
});
test('首次同來源設定、教師登入更新與登出；學生狀態不回傳密鑰', async t => {
    const dir = await dirFor(t), {base, post, teacherSettings} = await serverFor(t, dir);
    assert.equal((await fetch(base + '/api/records')).status, 401);
    assert.equal((await post('/api/teacher/settings', {password, aiKey}, '', 'https://evil.invalid')).status, 403);
    const first = await post('/api/teacher/settings', {password, aiKey});
    assert.equal(first.status, 200);
    const cookie = first.headers.get('set-cookie').split(';')[0];
    assert.ok(!JSON.stringify(await first.json()).includes(aiKey));
    const student = await (await fetch(base + '/api/tutor/status')).json();
    assert.deepEqual(student, {managed: true, initialized: true, aiConfigured: true, sheetConfigured: false});
    assert.equal((await post('/api/teacher/settings', {clearAi: true})).status, 401);
    assert.equal((await post('/api/teacher/login', {password: 'bad'})).status, 401);
    assert.equal((await fetch(base + '/api/records', {headers: {Cookie: cookie}})).status, 200);
    const changed = await post('/api/teacher/settings', {password: 'new-test-only-password'}, cookie);
    assert.equal(changed.status, 200);
    assert.equal((await fetch(base + '/api/records', {headers: {Cookie: cookie}})).status, 401);
    const newCookie = changed.headers.get('set-cookie').split(';')[0];
    assert.equal((await post('/api/teacher/logout', {}, newCookie)).status, 200);
    assert.equal((await fetch(base + '/api/records', {headers: {Cookie: newCookie}})).status, 401);
    assert.equal(teacherSettings.verify('new-test-only-password'), true);
    const restarted = await serverFor(t, dir);
    assert.equal((await fetch(restarted.base + '/api/records', {headers: {Cookie: newCookie}})).status, 401);
    assert.equal((await restarted.post('/api/teacher/login', {password: 'new-test-only-password'})).status, 200);
});
test('managed求助由後端取key；學生不可覆寫；mock與評分也拒絕秘密落入紀錄', async t => {
    const dir = await dirFor(t);
    let calls = 0;
    const {post, base} = await serverFor(t, dir, {fetchImpl: async (url, options) => {
        calls++;
        assert.equal(options.headers.Authorization, `Bearer ${aiKey}`);
        assert.ok(!options.body.includes(aiKey));
        return modelResponse({guidance: '先觀察', question: '發現什麼？'});
    }});
    const setup = await post('/api/teacher/settings', {password, aiKey});
    assert.equal(setup.status, 200);
    const body = {mode: 'live', context, question: '如何開始？'};
    const response = await post('/api/tutor', body);
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes(aiKey));
    assert.equal((await post('/api/tutor', {...body, apiKey: 'student-override-key'})).status, 400);
    assert.equal((await post('/api/tutor', {...body, mode: 'mock', question: aiKey})).status, 400);
    assert.equal((await post('/api/records', {...grade, task: {...context.task, title: aiKey}})).status, 400);
    assert.equal(calls, 1);
    assert.equal((await fetch(base + '/local-data/teacher-settings.json')).status, 404);
});
test('失敗登入節流，不把多次嘗試變成無限制密碼運算', async t => {
    const {post} = await serverFor(t, await dirFor(t));
    await post('/api/teacher/settings', {password});
    for (let i = 0; i < 10; i++) assert.equal((await post('/api/teacher/login', {password: 'bad'})).status, 401);
    assert.equal((await post('/api/teacher/login', {password: 'bad'})).status, 429);
});
test('切換試算表不沿用舊同步收據，切回原表讀回自己的收據', async t => {
    const dir = await dirFor(t), callsA = [], callsB = [];
    const fake = calls => ({append: async record => calls.push(record.id), read: async () => ({records: [], nextOffset: 0, more: false})});
    const a = sheetScope(sheetUrl), b = sheetScope(sheetUrl.replace('TEST', 'OTHER'));
    const store = createRecordStore(dir, {sheetClient: fake(callsA), syncScope: a});
    await store.save(grade);
    await store.sync();
    assert.equal((await store.status()).pending, 0);
    await store.setSheetClient(fake(callsB), b);
    assert.equal((await store.status()).pending, 1);
    await store.sync();
    assert.deepEqual(callsB, [grade.id]);
    await store.setSheetClient(fake(callsA), a);
    assert.equal((await store.status()).pending, 0);
    await store.sync();
    assert.deepEqual(callsA, [grade.id]);
});
