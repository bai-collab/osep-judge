import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import vmModule from 'node:vm';
import {createRecordStore, cleanRecord, summarize} from './record-store.mjs';
import {createSheetClient} from './sheet-client.mjs';
import {createTutorServer} from './server.mjs';
const require = createRequire(import.meta.url);
const React = require('react');
const {create, act} = require('react-test-renderer');
const {captureProgram, safeProgram, validStudentId} = require('../../src/lib/learning-records.js');
const modelResponse = result => new Response(JSON.stringify({status: 'completed', output: [
    {type: 'message', content: [{type: 'output_text', text: JSON.stringify(result)}]}
]}));

test('useStudentIdentity 在訂閱前全域值改變時會同步最新值', () => {
    const {setStudentId, useStudentIdentity} = require('../../src/lib/learning-records.js');
    setStudentId('');
    const state = {changed: false};
    const Harness = () => {
        state.identity = useStudentIdentity();
        if (!state.changed) {
            state.changed = true;
            state.identity.setStudentId('S01');
        }
        return null;
    };
    try {
        act(() => {state.root = create(React.createElement(Harness));});
        assert.equal(state.identity.studentId, 'S01');
    } finally {
        act(() => state.root?.unmount());
        setStudentId('');
    }
});
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = path.resolve(root, '../../workspace/osep-judge/learning-records-01');
const program = {targets: [{name: '學生角色', blocks: {a: {opcode: 'looks_say', next: null, parent: null,
    inputs: {MESSAGE: [1, [10, '測試']]}, fields: {}, shadow: false, topLevel: true}}}]};
const grade = (id = 'event-12345678') => ({id, studentId: 'S01', type: 'grade', status: 'completed',
    task: {code: 'q1', title: '題目一'}, program, totalScore: 10, maxScore: 20, demoLoaded: false, programChanged: false});
async function directory(t) {
    await fs.mkdir(scratch, {recursive: true});
    const dir = await fs.mkdtemp(path.join(scratch, 'records-'));
    t.after(async () => {
        if (!path.resolve(dir).startsWith(scratch + path.sep)) throw new Error('OUTSIDE_SCRATCH');
        await fs.rm(dir, {recursive: true, force: true});
    });
    return dir;
}
async function server(t, store, options = {}) {
    const server = createTutorServer({recordStore: store, ...options});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (route, body, headers = {}) => fetch(base + route, {method: 'POST',
        headers: {Origin: base, 'Content-Type': 'application/json', ...headers}, body: JSON.stringify(body)});
    return {base, post};
}
test('完整程式超過80個積木仍保存；資產、執行值、題庫、已知金鑰排除', () => {
    const targets = [{...program.targets[0], blocks: Object.fromEntries(Array.from({length: 120}, (_, i) =>
        [String(i), {opcode: 'looks_say', inputs: {}, fields: {}, hiddenAnswer: 'GOLD'}])),
        variables: {v: ['分數', 'RUN_VALUE']}, lists: {l: ['名單', ['RUN_VALUE']]}, costumes: ['ASSET'], sounds: ['ASSET']}];
    const result = captureProgram({toJSON: () => JSON.stringify({targets, hiddenTests: 'GOLD'})});
    assert.equal(Object.keys(result.targets[0].blocks).length, 120);
    for (const secret of ['RUN_VALUE', 'ASSET', 'GOLD']) assert.ok(!JSON.stringify(result).includes(secret));
    assert.throws(() => safeProgram({toJSON: () => JSON.stringify(program)}, '測試'));
    assert.throws(() => captureProgram({toJSON: () => JSON.stringify({targets: [{name: 'x'.repeat(130000)}]})}));
    const clean = cleanRecord({...grade(), apiKey: 'SECRET', expectedOutput: 'GOLD'});
    assert.ok(!JSON.stringify(clean).includes('SECRET'));
    for (const bad of [{studentId: '=1+1'}, {totalScore: 21}, {maxScore: NaN}, {program: null}, {id: 'short'}]) {
        assert.throws(() => cleanRecord({...grade(), ...bad}));
    }
});
test('學生代號前後端一致：1至40字，拒絕空白與錯誤字元', () => {
    for (const studentId of ['S', 'S'.repeat(40), '學生01', 'A_S01-2']) {
        assert.equal(validStudentId(studentId), true);
        assert.equal(cleanRecord({...grade(), studentId}).studentId, studentId);
    }
    for (const studentId of ['', 'S'.repeat(41), 'S 01', ' S01', 'S01 ', 'S\t01', 'S\n01', 'S.01']) {
        assert.equal(validStudentId(studentId), false);
        assert.throws(() => cleanRecord({...grade(), studentId}));
    }
});
test('序列化寫入、事件去重、衝突拒絕及重啟後完整讀回', async t => {
    const dir = await directory(t), store = createRecordStore(dir);
    await Promise.all([store.save(grade()), store.save(grade()), store.save(grade('event-87654321'))]);
    assert.equal((await store.list()).length, 2);
    await assert.rejects(store.save({...grade(), totalScore: 0}), /RECORD_ID_CONFLICT/);
    assert.equal((await createRecordStore(dir).list()).length, 2);
    assert.equal((await createRecordStore(dir).status()).pending, 2);
    assert.equal((await fs.readFile(path.join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').length, 2);
});
test('同步失敗保留本機；人工重試與雲端讀回不重複、不重跑評分', async t => {
    const dir = await directory(t);
    let fail = true, calls = 0;
    const store = createRecordStore(dir, {sheetClient: {
        append: async () => {calls++; if (fail) throw new Error('SECRET upstream error');},
        read: async () => ({records: [{...grade('cloud-12345678'), timestamp: '2026-10-01T00:00:00.000Z'}], nextOffset: 1, more: false})
    }});
    await store.save(grade());
    const failed = await store.sync();
    assert.equal(failed.lastSyncError, 'SHEET_SYNC_FAILED');
    assert.equal(failed.pending, 1);
    fail = false;
    assert.equal((await store.sync()).pending, 0);
    await store.sync();
    assert.equal(calls, 2);
    assert.equal((await store.list()).length, 2);
    assert.equal((await createRecordStore(dir).status()).pending, 0);
});
test('最新成績取最後有效評分；較高舊分、範例、變更及失敗不覆蓋', () => {
    const record = (id, minute, changes = {}) => ({...grade(id), timestamp: `2026-10-01T00:0${minute}:00Z`, ...changes});
    const rows = summarize([record('old-score', 0, {totalScore: 20}), record('new-score', 1, {totalScore: 0}),
        record('demo-score', 2, {demoLoaded: true}), record('changed-score', 3, {programChanged: true}),
        record('failed-score', 4, {status: 'failed', totalScore: null})]);
    assert.equal(rows[0].latestGrade.id, 'new-score');
    assert.equal(rows[0].latestGrade.totalScore, 0);
    assert.equal(rows[0].latestProgram, 'failed-score');
});
test('真HTTP求助與評分保存，秘密不落地；無代號不保存、跨站拒絕', async t => {
    const store = createRecordStore(await directory(t));
    const {base, post} = await server(t, store,
        {fetchImpl: async () => modelResponse({guidance: '先觀察', question: '結果如何？'})});
    const context = {task: {code: 'q1', title: '題目一', description: '公開說明', hiddenTests: 'GOLD'}, blocks: []};
    assert.equal((await post('/api/records', grade())).status, 200);
    const body = {mode: 'live', apiKey: 'harmless-test-key', context, question: '怎麼做',
        learning: {id: 'ai-123456789', studentId: 'S01', program}};
    assert.equal((await (await post('/api/tutor', body)).json()).recording.status, 'saved_local');
    await post('/api/tutor', {mode: 'mock', context, question: '怎麼做'});
    const raw = await (await fetch(base + '/api/records')).text();
    assert.equal(JSON.parse(raw).records.length, 2);
    for (const secret of ['GOLD', 'harmless-test-key']) assert.ok(!raw.includes(secret));
    assert.equal((await post('/api/tutor', {...body, learning: {...body.learning, studentId: body.apiKey}})).status, 400);
    assert.equal((await post('/api/records', {...grade('evil-12345678'), type: 'ai'})).status, 400);
    assert.equal((await post('/api/records', grade(), {Origin: 'https://evil.invalid'})).status, 403);
    assert.equal((await fetch(base + '/api/records', {headers: {'Sec-Fetch-Site': 'cross-site'}})).status, 403);
});
test('記錄失敗仍交付導師結果，錯誤原文不回前端', async t => {
    const {post} = await server(t, {save: async () => {throw new Error('SECRET');}, autoSync: () => {}},
        {fetchImpl: async () => modelResponse({guidance: '引導', question: '追問'})});
    const response = await post('/api/tutor', {mode: 'live', apiKey: 'harmless-test-key',
        context: {task: {code: 'q1', description: '公開'}, blocks: []}, question: '問題',
        learning: {id: 'event-12345678', studentId: 'S01', program}});
    assert.equal(response.status, 200);
    const raw = await response.text();
    assert.equal(JSON.parse(raw).recording.status, 'failed');
    assert.equal(JSON.parse(raw).guidance, '引導');
    assert.ok(!raw.includes('SECRET'));
});
test('教師密碼保護讀取與同步，學生寫入不取得教師工作階段', async t => {
    const {base, post} = await server(t, createRecordStore(await directory(t)), {teacherPassword: 'fake-teacher-password'});
    assert.equal((await fetch(base + '/api/records')).status, 401);
    assert.equal((await post('/api/records/sync', {})).status, 401);
    assert.equal((await post('/api/records', grade())).status, 200);
    assert.equal((await post('/api/teacher/login', {password: 'bad'})).status, 401);
    assert.equal((await post('/api/teacher/login', {password: 'fake-teacher-password'}, {Origin: 'https://other.invalid'})).status, 403);
    const login = await post('/api/teacher/login', {password: 'fake-teacher-password'});
    const cookie = login.headers.get('set-cookie');
    assert.ok(cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict'));
    assert.equal((await fetch(base + '/api/records', {headers: {Cookie: cookie.split(';')[0]}})).status, 200);
    assert.equal((await fetch(base + '/api/records', {headers: {Cookie: 'osepTeacher=' + '0'.repeat(48)}})).status, 401);
});
test('Apps Script 轉址只允許Google回應GET，不傳密鑰，錯誤收據拒絕', async () => {
    const token = 'test-only-token-'.repeat(3), url = 'https://script.google.com/macros/s/TEST/exec', calls = [];
    const client = createSheetClient({url, token, fetchImpl: async (url, options) => {
        calls.push({url, options});
        if (calls.length === 1) return new Response('', {status: 302,
            headers: {Location: 'https://script.googleusercontent.com/macros/echo?fixture=1'}});
        return new Response(JSON.stringify({ok: true, id: grade().id}));
    }});
    await client.append(grade());
    assert.equal(JSON.parse(calls[0].options.body).token, token);
    assert.equal(calls[1].options.method, 'GET');
    assert.equal(calls[1].options.body, undefined);
    assert.equal(calls[1].options.headers, undefined);
    assert.ok(!calls[1].url.includes(token));
    await assert.rejects(createSheetClient({url, token, fetchImpl: async () => new Response('', {status: 302,
        headers: {Location: 'https://evil.invalid'}})}).append(grade()), /INVALID_SHEET_REDIRECT/);
    await assert.rejects(createSheetClient({url, token, fetchImpl: async () =>
        new Response(JSON.stringify({ok: true, id: 'other-event'}))}).append(grade()), /SHEET_WRONG_RECEIPT/);
    assert.throws(() => createSheetClient({url: 'http://localhost', token}));
    assert.equal(createSheetClient(), null);
});
test('真正Apps Script程式：認證、去重、公式文字、大紀錄分段及分頁讀回', async () => {
    const rows = [], properties = {SHEET_ID: 'TEST', RECORD_TOKEN: 'token-'.repeat(8)};
    let made = false;
    const sheet = {appendRow: row => rows.push(row), setFrozenRows() {}, setColumnWidths() {}, getLastRow: () => rows.length,
        getRange: (row, column, height = 1, width = 1) => ({getValue: () => rows[row - 1]?.[column - 1],
            getValues: () => Array.from({length: height}, (_, i) => rows[row - 1 + i].slice(column - 1, column - 1 + width)),
            setValues: values => values.forEach((value, i) => {rows[row - 1 + i] = value;}),
            setBackground() {return this;}, setFontColor() {return this;}, setFontWeight() {return this;}})};
    const sandbox = {PropertiesService: {getScriptProperties: () => ({getProperty: key => properties[key]})},
        ContentService: {MimeType: {JSON: 'json'}, createTextOutput: text => ({text, setMimeType() {return this;}})},
        LockService: {getScriptLock: () => ({waitLock() {}, hasLock: () => true, releaseLock() {}})},
        SpreadsheetApp: {openById: () => ({getSheetByName: () => made ? sheet : null,
            insertSheet: () => {made = true; return sheet;}}), flush() {}}};
    vmModule.createContext(sandbox);
    vmModule.runInContext(await fs.readFile(path.join(root, 'scripts/tutor/sheets/Code.gs'), 'utf8'), sandbox);
    const call = body => JSON.parse(sandbox.doPost({postData: {contents: JSON.stringify(body)}}).text);
    assert.equal(call({action: 'read', token: 'wrong', offset: 0}).ok, false);
    assert.equal(rows.length, 0);
    const record = {...grade(), timestamp: '2026-10-01T00:00:00Z', task: {code: 'q1', title: '=IMPORTXML("evil")'},
        program: {targets: [{...program.targets[0], blocks: {long: {opcode: 'looks_say', fields: {TEXT: ['😀'.repeat(40000), null]}}}}]},
        apiKey: 'SECRET'};
    assert.equal(call({action: 'append', token: properties.RECORD_TOKEN, record}).ok, true);
    assert.equal(call({action: 'append', token: properties.RECORD_TOKEN, record}).duplicate, true);
    assert.equal(rows.length, 2);
    assert.ok(rows[1][4].startsWith('\u200B='));
    assert.ok(rows[1].slice(16).every(cell => cell.length <= 39901));
    assert.ok(!rows[1].join('').includes('SECRET'));
    const read = call({action: 'read', token: properties.RECORD_TOKEN, offset: 0});
    assert.equal(read.records[0].program.targets[0].blocks.long.fields.TEXT[0], '😀'.repeat(40000));
    assert.equal(read.nextOffset, 1);
    assert.equal(read.more, false);
    assert.equal(call({action: 'read', token: properties.RECORD_TOKEN, offset: 1}).records.length, 0);
});
