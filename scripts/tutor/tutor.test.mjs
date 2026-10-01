import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createTutorServer} from './server.mjs';
import {ENDPOINT, MODEL, sanitizeContext, requestGuidance} from './provider.mjs';
const require = createRequire(import.meta.url);
const {buildTutorContext} = require('../../src/lib/tutor-context.js');
const {readTutorEditor} = require('../../src/lib/tutor-editor.js');
const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const context = {task: {code: 'test-task', title: '練習', description: '讀取數字並觀察結果。', examples: []},
    blocks: [], omittedBlocks: 0, grading: null};
const harmlessKey = 'harmless-test-token-123';
const answer = {guidance: '先觀察一次變數變化。', question: '哪一步和預期不同？'};
const modelResponse = () => new Response(JSON.stringify({status: 'completed', output: [
    {type: 'message', content: [{type: 'output_text', text: JSON.stringify(answer)}]}
]}), {headers: {'Content-Type': 'application/json'}});

async function serverFor(t, options = {}) {
    const server = createTutorServer({buildDir: fixtureDir, ...options});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => {
        server.closeAllConnections();
        server.close(resolve);
    }));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (body, extraHeaders = {}) => fetch(base + '/api/tutor', {method: 'POST',
        headers: {'Content-Type': 'application/json', Origin: base, ...extraHeaders}, body: JSON.stringify(body)});
    return {base, post};
}

test('積木快照與評分摘要排除答案、測資和資產', () => {
    const task = {...context.task, testCases: [{input: 'HIDDEN_INPUT', expectedOutput: 'GOLD_SECRET'}],
        answerProjectUrl: 'ANSWER_SB3', sb3Path: 'ANSWER_PATH'};
    const vm = {toJSON: () => JSON.stringify({targets: [{costumes: ['COSTUME_SECRET'], sounds: ['SOUND_SECRET'],
        blocks: {a: {opcode: 'event_whenflagclicked', next: 'b', fields: {}, inputs: {}}}}]})};
    const snapshot = buildTutorContext(task, vm, {results: [{pass: true, expectedOutput: 'GOLD_SECRET', actualOutput: 'ACTUAL_SECRET'}]});
    const raw = JSON.stringify(snapshot);
    for (const secret of ['HIDDEN_INPUT', 'GOLD_SECRET', 'ANSWER_SB3', 'ANSWER_PATH', 'COSTUME_SECRET', 'SOUND_SECRET', 'ACTUAL_SECRET']) {
        assert.ok(!raw.includes(secret));
    }
    assert.equal(snapshot.blocks[0].next, 'b');
    assert.deepEqual(snapshot.grading, {passed: 1, total: 1});
});

test('積木摘要限制數量並明列省略，後端再次選取白名單', () => {
    const blocks = Object.fromEntries(Array.from({length: 100}, (_, i) => [String(i), {opcode: 'looks_say'}]));
    const snapshot = buildTutorContext(context.task, {toJSON: () => JSON.stringify({targets: [{blocks}]})});
    assert.equal(snapshot.blocks.length, 80);
    assert.equal(snapshot.omittedBlocks, 20);
    const clean = sanitizeContext({...snapshot, testCases: ['GOLD'], task: {...snapshot.task, answerProjectUrl: 'GOLD'}});
    assert.ok(!JSON.stringify(clean).includes('GOLD'));
});

test('模擬模式不呼叫模型，也不回顯測試金鑰', async t => {
    let calls = 0;
    const {post} = await serverFor(t, {fetchImpl: () => {calls++; throw new Error('UNEXPECTED');}});
    const res = await post({mode: 'mock', apiKey: harmlessKey, context, question: '不知道怎麼開始'});
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.equal(JSON.parse(raw).source, 'mock');
    assert.ok(!raw.includes(harmlessKey));
    assert.equal(calls, 0);
});

test('全專案種類統計涵蓋省略細節；未使用不是題目必需，後端不信任客戶端差集', () => {
    const blocks = Object.fromEntries(Array.from({length: 100}, (_, i) => [String(i), {opcode: 'looks_say'}]));
    blocks.ask = {opcode: 'sensing_askandwait', topLevel: true, next: null};
    blocks.variable = [12, '名字', 'variable-id', 100, 200];
    const editor = {workspaceStatus: 'complete', availableStatus: 'complete', availableBlocks: [
        {opcode: 'sensing_askandwait', category: '專用', label: '詢問 □ 並等待', hiddenAnswer: 'GOLD'},
        {opcode: 'event_whenflagclicked', category: '專用', label: '當綠旗被點擊'}
    ], renderedBlocks: [{id: 'ask', opcode: 'sensing_askandwait', label: '詢問名字並等待',
        topLevel: true, hiddenAnswer: 'GOLD'}], password: 'GOLD', wholeDOM: 'GOLD'};
    const snapshot = buildTutorContext(context.task, {editingTarget: {getName: () => '學生角色'},
        toJSON: () => JSON.stringify({targets: [{name: '學生角色', blocks}]})}, null, editor);
    assert.equal(snapshot.blocks.length, 80);
    assert.equal(snapshot.totalBlocks, 102);
    assert.equal(snapshot.omittedBlocks, 22);
    assert.ok(snapshot.blockTypes.some(b => b.opcode === 'sensing_askandwait' && b.count === 1));
    assert.ok(snapshot.blockTypes.some(b => b.opcode === 'data_variable' && b.count === 1));
    const clean = sanitizeContext({...snapshot, notUsedAvailable: [{opcode: 'sensing_askandwait'}]});
    assert.deepEqual(clean.notUsedAvailable.map(b => b.opcode), ['event_whenflagclicked']);
    assert.equal(clean.selectedTarget, '學生角色');
    assert.equal(clean.editor.renderedBlocks[0].topLevel, true);
    assert.ok(!JSON.stringify(clean).includes('GOLD'));
    assert.deepEqual(sanitizeContext({...snapshot, omittedBlockTypes: 1}).notUsedAvailable, []);
});

test('畫布未知與讀取失敗保留未知；只讀限定工作區API', () => {
    assert.equal(readTutorEditor(null, null).workspaceStatus, 'unavailable');
    const block = {id: 'one', type: 'sensing_askandwait', disabled: true,
        toString: () => '詢問你的名字並等待', getParent: () => null};
    const observed = readTutorEditor(null, {getMainWorkspace: () => ({getAllBlocks: () => [block],
        getFlyout: () => {throw new Error('not ready');}})});
    assert.equal(observed.workspaceStatus, 'complete');
    assert.equal(observed.renderedBlocks[0].disabled, true);
    assert.equal(observed.renderedBlocks[0].label, '詢問你的名字並等待');
    assert.equal(observed.availableStatus, 'unavailable');
    const failed = readTutorEditor(null, {getMainWorkspace: () => ({getAllBlocks: () => [{...block,
        toString: () => {throw new Error('disposed');}}]})});
    assert.equal(failed.workspaceStatus, 'unavailable');
});

test('真正VM序列化保留畫布識別碼與連線，快照可與畫布對照', async () => {
    const VM = require('scratch-vm');
    const vm = new VM();
    const fixture = {targets: [{isStage: true, name: 'Stage', variables: {}, lists: {}, broadcasts: {},
        blocks: {
            'original-flag-id': {opcode: 'event_whenflagclicked', next: 'original-ask-id', parent: null,
                inputs: {}, fields: {}, shadow: false, topLevel: true, x: 10, y: 10},
            'original-ask-id': {opcode: 'sensing_askandwait', next: null, parent: 'original-flag-id',
                inputs: {QUESTION: [1, [10, '你的名字是？']]}, fields: {}, shadow: false, topLevel: false}
        }, comments: {}, currentCostume: 0, costumes: [], sounds: [], volume: 100, layerOrder: 0,
        tempo: 60, videoTransparency: 50, videoState: 'on', textToSpeechLanguage: null}],
    monitors: [], extensions: [], meta: {semver: '3.0.0', vm: '0.2.0', agent: ''}};
    await vm.loadProject(JSON.stringify(fixture));
    try {
        const snapshot = buildTutorContext(context.task, vm, null);
        const flag = snapshot.blocks.find(b => b.opcode === 'event_whenflagclicked');
        const ask = snapshot.blocks.find(b => b.opcode === 'sensing_askandwait');
        assert.equal(flag.id, 'original-flag-id');
        assert.equal(flag.next, ask.id);
        assert.equal(ask.id, 'original-ask-id');
        assert.equal(ask.parent, flag.id);
        assert.ok(ask.inputs.includes('你的名字是？'));
    } finally { vm.quit(); }
});

test('真正選單及已用種類進入模型，提示契約不套用標準偵測分類', async t => {
    let recorded;
    const {post} = await serverFor(t, {fetchImpl: async (url, options) => {
        recorded = JSON.parse(options.body); return modelResponse();
    }});
    const enriched = {...context, blockTypes: [{opcode: 'sensing_answer', count: 1}], editor: {
        availableStatus: 'complete', availableBlocks: [
            {opcode: 'sensing_askandwait', category: '專用', label: '詢問 □ 並等待'},
            {opcode: 'sensing_answer', category: '專用', label: '詢問的答案'}
        ], renderedBlocks: [{id: 'x', opcode: 'sensing_answer', label: '詢問的答案'}]
    }};
    assert.equal((await post({mode: 'live', apiKey: harmlessKey, context: enriched, question: '找不到輸入積木'})).status, 200);
    const forwarded = JSON.parse(recorded.input.at(-1).content).context;
    assert.equal(forwarded.editor.availableBlocks[0].category, '專用');
    assert.deepEqual(forwarded.notUsedAvailable.map(b => b.opcode), ['sensing_askandwait']);
    assert.ok(recorded.input[0].content.includes('不是標準 Scratch 選單'));
    assert.ok(recorded.input[0].content.includes('並非題目必需'));
    assert.ok(recorded.input[0].content.includes('guidance 與 question 只能用畫面上的積木文字'));
    assert.ok(!JSON.stringify(recorded).includes(harmlessKey));
});

test('跨來源、偽造 Host、缺少 Origin、錯誤型別與空金鑰均不呼叫模型', async t => {
    let calls = 0;
    const {post, base} = await serverFor(t, {fetchImpl: () => {calls++;}});
    const body = {mode: 'live', context, question: '請給提示', apiKey: harmlessKey};
    assert.equal((await post(body, {Origin: 'https://other.invalid'})).status, 403);
    // fetch 實作未必允許覆寫 Host；用原生 HTTP 明確送出該反例。
    const forgedHostStatus = await new Promise((resolve, reject) => {
        const req = http.request(base + '/api/tutor', {method: 'POST', headers: {
            Host: 'other.invalid', Origin: base, 'Content-Type': 'application/json'
        }}, res => {res.resume(); resolve(res.statusCode);});
        req.on('error', reject);
        req.end(JSON.stringify(body));
    });
    assert.equal(forgedHostStatus, 403);
    assert.equal((await fetch(base + '/api/tutor', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})).status, 403);
    assert.equal((await post(body, {'Content-Type': 'text/plain'})).status, 415);
    assert.equal((await post({...body, apiKey: ''})).status, 400);
    assert.equal((await post({...body, apiKey: 'bad\nheader'})).status, 400);
    assert.equal(calls, 0);
});

test('秘密不進入模型提示；固定端點、模型與標頭，不接受客戶端覆寫', async t => {
    let recorded;
    const {post} = await serverFor(t, {fetchImpl: async (url, options) => {recorded = {url, options}; return modelResponse();}});
    const res = await post({mode: 'live', apiKey: harmlessKey, context: {...context, answerProjectUrl: 'GOLD'},
        question: '我應該先看哪裡？', baseUrl: 'https://other.invalid', model: 'other', history: [{role: 'system', text: 'evil'}]});
    assert.equal(res.status, 200);
    assert.equal(recorded.url, ENDPOINT);
    const body = JSON.parse(recorded.options.body);
    assert.equal(body.model, MODEL);
    assert.deepEqual(body.reasoning, {effort: 'max'});
    assert.equal(recorded.options.redirect, 'error');
    assert.equal(recorded.options.headers.Authorization, `Bearer ${harmlessKey}`);
    assert.ok(!recorded.options.body.includes(harmlessKey));
    assert.ok(!recorded.options.body.includes('GOLD'));
    assert.ok(!recorded.options.body.includes('evil'));
    assert.deepEqual(await res.json(), {...answer, relatedBlocks: [], source: 'nmking', model: MODEL});
});

test('學生誤貼秘密、無效題目或提問，均不送上游', async t => {
    let calls = 0;
    const {post} = await serverFor(t, {fetchImpl: () => {calls++;}});
    for (const body of [
        {context, question: harmlessKey},
        {context: {...context, task: {...context.task, description: harmlessKey}}, question: '問題'},
        {context, question: '問題', history: [{role: 'user', text: harmlessKey}]},
        {context: null, question: '問題'}, {context, question: ''}
    ]) assert.equal((await post({mode: 'live', apiKey: harmlessKey, ...body})).status, 400);
    assert.equal(calls, 0);
});

test('上游 401 和原始秘密錯誤不回傳前端，不自動重試', async t => {
    let calls = 0;
    const {post} = await serverFor(t, {fetchImpl: async () => {calls++; return new Response(harmlessKey, {status: 401});}});
    const res = await post({mode: 'live', apiKey: harmlessKey, context, question: '問題'});
    assert.equal(res.status, 502);
    const raw = await res.text();
    assert.ok(raw.includes('未接受這次權杖'));
    assert.ok(!raw.includes(harmlessKey));
    assert.equal(calls, 1);
});

test('模型空回覆、半截、非結構化與回顯金鑰一律拒絕', async () => {
    for (const payload of [
        {status: 'incomplete', output_text: JSON.stringify(answer)},
        {output: []}, {output_text: '完整答案在這裡'},
        {output_text: JSON.stringify({guidance: harmlessKey, question: '問句'})}
    ]) await assert.rejects(requestGuidance({apiKey: harmlessKey, context, question: '問題', history: [],
        fetchImpl: async () => new Response(JSON.stringify(payload))}));
});

test('逾時會中止模型請求並提供可讀訊息', async t => {
    let aborted = false;
    const {post} = await serverFor(t, {timeoutMs: 25, fetchImpl: (url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {aborted = true; reject(new Error('aborted'));}, {once: true});
    })});
    const res = await post({mode: 'live', apiKey: harmlessKey, context, question: '問題'});
    assert.equal(res.status, 504);
    assert.equal(aborted, true);
    assert.ok((await res.json()).error.includes('逾時'));
});

test('連線阻擋、一般斷線與接收失敗各回安全代碼，不洩漏例外或重試', async t => {
    for (const [fetchImpl, expected] of [
        [async () => {throw Object.assign(new TypeError(harmlessKey), {cause: {code: 'EACCES'}});}, 'NETWORK_BLOCKED'],
        [async () => {throw new Error(harmlessKey);}, 'UPSTREAM_NETWORK'],
        [async () => ({ok: true, text: async () => {throw new Error(harmlessKey);}}), 'UPSTREAM_NETWORK']
    ]) {
        let calls = 0;
        const {post} = await serverFor(t, {fetchImpl: (...args) => {calls++; return fetchImpl(...args);}});
        const response = await post({mode: 'live', apiKey: harmlessKey, context, question: '問題'});
        assert.equal(response.status, 503);
        const raw = await response.text();
        const result = JSON.parse(raw);
        assert.equal(result.code, expected);
        assert.equal(result.providerStatus, null);
        assert.ok(result.error.includes(expected));
        assert.ok(!raw.includes(harmlessKey));
        assert.equal(calls, 1);
    }
});

test('服務封包與模型文字的解析失敗分開；畸形回覆不再落入含糊錯誤', async t => {
    const cases = [
        ['<html>服務錯誤 ' + harmlessKey + '</html>', 'INVALID_PROVIDER_RESPONSE'],
        [JSON.stringify(null), 'INVALID_PROVIDER_RESPONSE'],
        [JSON.stringify([]), 'INVALID_PROVIDER_RESPONSE'],
        [JSON.stringify({output_text: 12}), 'INVALID_PROVIDER_RESPONSE'],
        [JSON.stringify({output: {}}), 'INVALID_PROVIDER_RESPONSE'],
        [JSON.stringify({output: [null]}), 'INVALID_PROVIDER_RESPONSE'],
        [JSON.stringify({output: [{type: 'message', content: {}}]}), 'INVALID_PROVIDER_RESPONSE'],
        [JSON.stringify({output: [{type: 'message', content: [null]}]}), 'INVALID_PROVIDER_RESPONSE'],
        [JSON.stringify({output: [{type: 'message', content: [{type: 'output_text', text: 12}]}]}), 'INVALID_PROVIDER_RESPONSE'],
        [JSON.stringify({status: 'incomplete', output_text: JSON.stringify(answer)}), 'MODEL_INCOMPLETE'],
        [JSON.stringify({error: {message: harmlessKey}}), 'PROVIDER_ERROR'],
        [JSON.stringify({output_text: '模型只回傳一般文字 ' + harmlessKey}), 'INVALID_MODEL_OUTPUT'],
        [JSON.stringify({output_text: JSON.stringify([answer])}), 'INVALID_MODEL_OUTPUT'],
        [JSON.stringify({output: []}), 'INVALID_MODEL_OUTPUT'],
        [JSON.stringify({output_text: '{"guidance":"半截'}), 'INVALID_MODEL_OUTPUT']
    ];
    for (const [body, expected] of cases) {
        let calls = 0;
        const {post} = await serverFor(t, {fetchImpl: async () => {calls++; return new Response(body);}});
        const response = await post({mode: 'live', apiKey: harmlessKey, context, question: '問題'});
        assert.equal(response.status, 502);
        const raw = await response.text();
        assert.equal(JSON.parse(raw).code, expected);
        assert.ok(!raw.includes(harmlessKey));
        assert.ok(!raw.includes('連線或回覆解析失敗'));
        assert.equal(calls, 1);
    }
});

test('合法 Responses 回覆支援 BOM、分段及 JSON 圍欄，仍保留原格式驗證', async () => {
    const serialized = JSON.stringify(answer);
    for (const envelope of [
        {output_text: '```json\n' + serialized + '\n```'},
        {status: 'completed', output: [{type: 'reasoning'}, {type: 'message', content: [
            {type: 'output_text', text: serialized.slice(0, 10)},
            {type: 'output_text', text: serialized.slice(10)}]}]}
    ]) {
        const result = await requestGuidance({apiKey: harmlessKey, context, question: '問題', history: [],
            fetchImpl: async () => new Response('\uFEFF' + JSON.stringify(envelope))});
        assert.deepEqual(result, {...answer, relatedBlocks: []});
    }
});

test('模型回覆不顯示畫布積木 id／opcode，但 relatedBlocks 仍正確', async () => {
    const tutorContext = sanitizeContext({task: context.task,
        blocks: [{id: 'vm-b6', opcode: 'looks_say'}], editor: {
            availableStatus: 'complete', availableBlocks: [{opcode: 'looks_say', category: '外觀', label: '字串組合'}],
            renderedBlocks: [{id: 'b6', opcode: 'looks_say', label: '字串組合'}]
        }});
    const result = await requestGuidance({apiKey: harmlessKey, context: tutorContext, question: '問題', history: [],
        fetchImpl: async () => new Response(JSON.stringify({status: 'completed', output_text: JSON.stringify({
            guidance: '先點選 b6「字串組合」積木，檢查 looks_say。',
            question: '你能看見 b6「字串組合」嗎？', relatedBlocks: [{id: 'b6'}, {opcode: 'looks_say'}]
        })}))});
    assert.equal(result.guidance, '先點選「字串組合」積木，檢查。');
    assert.equal(result.question, '你能看見「字串組合」嗎？');
    assert.deepEqual(result.relatedBlocks, [
        {kind: 'workspace', id: 'b6', opcode: 'looks_say', label: '字串組合'},
        {kind: 'toolbox', opcode: 'looks_say', category: '外觀', label: '字串組合'}
    ]);
});

test('清除積木識別碼不誤刪一般英文或單字母 id', async () => {
    const tutorContext = sanitizeContext({task: context.task,
        blocks: [{id: 'a', opcode: 'looks_say'}], editor: {
            renderedBlocks: [{id: 'a', opcode: 'looks_say', label: '說'}]
        }});
    const result = await requestGuidance({apiKey: harmlessKey, context: tutorContext, question: '問題', history: [],
        fetchImpl: async () => new Response(JSON.stringify({output_text: JSON.stringify({
            guidance: '輸入 Hello, a，再檢查 looks_say。', question: '請輸入 Hello, a。', relatedBlocks: [{id: 'a'}]
        })}))});
    assert.equal(result.guidance, '輸入 Hello, a，再檢查。');
    assert.equal(result.question, '請輸入 Hello, a。');
    assert.deepEqual(result.relatedBlocks, [{kind: 'workspace', id: 'a', opcode: 'looks_say', label: '說'}]);
});

test('含特殊字元的積木 id 可安全清除並保留高亮目標', async () => {
    const specialId = 'slot`|@1';
    const tutorContext = sanitizeContext({task: context.task,
        blocks: [{id: specialId, opcode: 'looks_say'}], editor: {
            renderedBlocks: [{id: specialId, opcode: 'looks_say', label: '特殊積木'}]
        }});
    const result = await requestGuidance({apiKey: harmlessKey, context: tutorContext, question: '問題', history: [],
        fetchImpl: async () => new Response(JSON.stringify({output_text: JSON.stringify({
            guidance: `請查看 ${specialId}「特殊積木」與 looks_say。`, question: `再確認 ${specialId}。`,
            relatedBlocks: [{id: specialId}]
        })}))});
    assert.equal(result.guidance, '請查看「特殊積木」與。');
    assert.equal(result.question, '再確認。');
    assert.deepEqual(result.relatedBlocks, [{kind: 'workspace', id: specialId, opcode: 'looks_say', label: '特殊積木'}]);
});

test('含識別碼的 guidance 保留換行與原本的 CRLF', async () => {
    const tutorContext = sanitizeContext({task: context.task,
        blocks: [{id: 'vm-b6', opcode: 'looks_say'}], editor: {
            renderedBlocks: [{id: 'b6', opcode: 'looks_say', label: '字串組合'}]
        }});
    for (const [lineBreak, expectedLineBreak] of [['\n', '\n'], ['\r\n', '\r\n']]) {
        const result = await requestGuidance({apiKey: harmlessKey, context: tutorContext, question: '問題', history: [],
            fetchImpl: async () => new Response(JSON.stringify({output_text: JSON.stringify({
                guidance: `第一步：拖入積木${lineBreak}b6${lineBreak}第二步：檢查「Hello, 」`,
                question: '請繼續操作', relatedBlocks: [{id: 'b6'}]
            })}))});
        assert.equal(result.guidance, `第一步：拖入積木${expectedLineBreak}第二步：檢查「Hello, 」`);
    }
});

test('含識別碼時依標點與一般空白清除，不產生多餘空格', async () => {
    const tutorContext = sanitizeContext({task: context.task,
        blocks: [{id: 'b6', opcode: 'looks_say'}], editor: {
            renderedBlocks: [{id: 'b6', opcode: 'looks_say', label: '字串組合'}]
        }});
    const result = await requestGuidance({apiKey: harmlessKey, context: tutorContext, question: '問題', history: [],
        fetchImpl: async () => new Response(JSON.stringify({output_text: JSON.stringify({
            guidance: '先點選 b6「字串組合」；使用 looks_say 積木',
            question: '請檢查 b6。', relatedBlocks: [{id: 'b6'}]
        })}))});
    assert.equal(result.guidance, '先點選「字串組合」；使用 積木');
    assert.ok(!result.guidance.includes('  '));
    assert.equal(result.question, '請檢查。');
});

test('識別碼清除後的空 guidance 仍拒絕為 INVALID_MODEL_OUTPUT', async () => {
    const tutorContext = sanitizeContext({task: context.task,
        blocks: [{id: 'b6', opcode: 'looks_say'}], editor: {renderedBlocks: [{id: 'b6', opcode: 'looks_say'}]}});
    await assert.rejects(requestGuidance({apiKey: harmlessKey, context: tutorContext, question: '問題', history: [],
        fetchImpl: async () => new Response(JSON.stringify({output_text: JSON.stringify({
            guidance: 'b6', question: '還有問題嗎？', relatedBlocks: [{id: 'b6'}]
        })}))}), error => error.code === 'INVALID_MODEL_OUTPUT');
});

test('HTTP 上游狀態只回數字與白名單代碼，不回傳原始錯誤', async t => {
    for (const [status, code] of [[401, 'AUTH_REJECTED'], [403, 'AUTH_REJECTED'], [429, 'RATE_LIMITED'], [500, 'PROVIDER_ERROR']]) {
        const {post} = await serverFor(t, {fetchImpl: async () => new Response(harmlessKey, {status})});
        const response = await post({mode: 'live', apiKey: harmlessKey, context, question: '問題'});
        const raw = await response.text();
        const result = JSON.parse(raw);
        assert.equal(response.status, 502);
        assert.equal(result.code, code);
        assert.equal(result.providerStatus, status);
        assert.ok(!raw.includes(harmlessKey));
    }
});

test('只提供 build 內檔案，API 不接受 GET', async t => {
    const {base} = await serverFor(t);
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes('導師伺服器測試頁'));
    assert.equal((await fetch(base + '/.git/config')).status, 404);
    assert.equal((await fetch(base + '/%2e%2e%2fpackage.json')).status, 404);
    assert.equal((await fetch(base + '/%5c..%5cpackage.json')).status, 404);
    assert.equal((await fetch(base + '/api/tutor')).status, 405);
});

test('沒有識別碼時保留引號內 Hello, 後的空白', async () => {
    const result = await requestGuidance({apiKey: harmlessKey, context, question: '問題', history: [],
        fetchImpl: async () => new Response(JSON.stringify({output_text: JSON.stringify({
            guidance: '檢查第一個欄位是否是「Hello, 」', question: '逗號後面有保留空白嗎？', relatedBlocks: []
        })}))});
    assert.equal(result.guidance, '檢查第一個欄位是否是「Hello, 」');
});

test('沒有識別碼時保留 question 的換行', async () => {
    const result = await requestGuidance({apiKey: harmlessKey, context, question: '問題', history: [],
        fetchImpl: async () => new Response(JSON.stringify({output_text: JSON.stringify({
            guidance: '先觀察結果', question: '第一行\n第二行', relatedBlocks: []
        })}))});
    assert.equal(result.question, '第一行\n第二行');
});
