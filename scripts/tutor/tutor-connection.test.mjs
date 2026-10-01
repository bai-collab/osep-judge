import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const React = require('react');
const {create, act} = require('react-test-renderer');
const {useTutorConnection} = require('../../src/lib/tutor-connection.js');
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    '../../src/components/judge-panel/tutor-tab.jsx');
// 載入真正元件，僅替換樣式與延遲Blockly依賴；不用安裝測試環境。
const code = require('@babel/core').transformFileSync(source, {
    babelrc: false, configFile: false,
    presets: [require.resolve('@babel/preset-react')],
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
}).code;
const sourceRequire = createRequire(source);
const subject = {exports: {}};
new Function('require', 'module', 'exports', code)(name => {
    if (name === './tutor.css') return {};
    if (name === '../../lib/tw-lazy-scratch-blocks') return {isLoaded: () => false};
    return sourceRequire(name);
}, subject, subject.exports);
const {TutorTab} = subject.exports;
const task = {code: 'fixture', title: '測試題', description: '讀取輸入。', examples: []};
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const fixtures = [];

const fixture = (initialConnection = {managed: true, aiConfigured: true}) => {
    globalThis.window = {location: {protocol: 'http:', hostname: '127.0.0.1'}};
    globalThis.fetch = async () => new Response(JSON.stringify({managed: true, aiConfigured: true}),
        {headers: {'Content-Type': 'application/json'}});
    const state = {reads: 0, blocks: {}, task};
    const vm = {toJSON: () => {
        state.reads++;
        return JSON.stringify({targets: [{name: '角色', blocks: state.blocks}]});
    }};
    const Harness = () => {
        const connection = useTutorConnection();
        state.api = connection;
        return React.createElement(TutorTab, {key: state.task.code, task: state.task, vm, apiKey: connection.apiKey,
            connection: {...initialConnection, statusReady: true}, mode: connection.mode});
    };
    state.mount = () => act(() => {state.root = create(React.createElement(Harness));});
    state.mount();
    act(() => {state.api.setApiKey(''); state.api.setMode('mock');});
    state.button = text => state.root.root.findAllByType('button')
        .find(node => node.props.children === text);
    state.question = () => state.root.root.findByProps({id: 'tutor-question'});
    state.status = () => state.root.root.findByProps({role: 'status'}).children.join('');
    state.enter = () => act(() => state.api.setMode('live'));
    state.switchTask = nextTask => act(() => {
        state.task = nextTask;
        state.root.update(React.createElement(Harness));
    });
    fixtures.push(state);
    return state;
};

test('教師管理的學生介面不顯示key欄，真模型求助不把key送到API', async () => {
    const f = fixture({managed: true, aiConfigured: true});
    assert.equal(f.root.root.findAllByProps({id: 'tutor-api-key'}).length, 0);
    act(() => {f.api.setMode('live'); f.question().props.onChange({target: {value: '如何开始？'}});});
    let calls = 0;
    globalThis.fetch = async (url, options) => {
        calls++;
        const body = JSON.parse(options.body);
        assert.equal(url, './api/tutor');
        assert.equal(Object.hasOwn(body, 'apiKey'), false);
        return new Response(JSON.stringify({source: 'nmking', guidance: '先觀察', question: '發現什麼？'}),
            {headers: {'Content-Type': 'application/json'}});
    };
    await act(async () => f.root.root.findByType('form').props.onSubmit({preventDefault() {}}));
    assert.equal(calls, 1);
    assert.equal(f.root.root.findByProps({role: 'log'}).findAllByType('article').length, 1);
});

afterEach(() => {
    for (const state of fixtures.splice(0)) act(() => {
        state.api.setApiKey('');
        state.api.setMode('mock');
        state.root.unmount();
    });
    if (typeof originalWindow === 'undefined') delete globalThis.window;
    else globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
});

test('真元件不再提供連線控制或金鑰欄；模式由共用連線狀態提供', async () => {
    const f = fixture();
    assert.equal(f.root.root.findAllByProps({id: 'tutor-api-key'}).length, 0);
    assert.equal(f.root.root.findAllByProps({id: 'tutor-settings'}).length, 0);
    assert.equal(f.root.root.findAllByProps({id: 'tutor-mode'}).length, 0);
    assert.equal(f.root.root.findAllByType('button').some(button => button.props.children === '連線設定'), false);
    f.enter();
    assert.equal(f.api.mode, 'live');
});

test('觀察預設收合；展開及收合不求助、不清模式或草稿', () => {
    const f = fixture();
    let calls = 0;
    globalThis.fetch = async () => {calls++; return new Response('{}');};
    act(() => f.question().props.onChange({target: {value: '保留草稿'}}));
    const details = () => f.root.root.findByProps({id: 'tutor-observation'});
    assert.equal(details().props.hidden, true);
    const reads = f.reads;
    act(() => f.button('積木觀察（求助時自動更新）').props.onClick());
    assert.equal(details().props.hidden, false);
    act(() => f.button('收合積木觀察').props.onClick());
    assert.equal(details().props.hidden, true);
    assert.equal(f.reads, reads);
    assert.equal(f.status(), '連線由教師設定；更新觀察不影響設定。');
    assert.equal(f.question().props.value, '保留草稿');
    assert.equal(calls, 0);
});

test('real TutorTab refreshes observation repeatedly without losing mode, draft, or conversation', async () => {
    const f = fixture({managed: true, aiConfigured: true});
    let calls = 0;
    globalThis.fetch = async (url, options) => {
        calls++;
        assert.equal(url, './api/tutor');
        const body = JSON.parse(options.body);
        assert.equal(body.mode, 'live');
        assert.equal(body.context.blocks[0].opcode, 'sensing_askandwait');
        return new Response(JSON.stringify({source: 'nmking', guidance: '測試回覆', question: '測試追問'}),
            {headers: {'Content-Type': 'application/json'}});
    };
    f.enter();
    act(() => f.question().props.onChange({target: {value: '這個草稿要保留'}}));
    const before = f.reads;
    f.blocks.ask = {opcode: 'sensing_askandwait', fields: {}, inputs: {}};
    const refresh = () => f.root.root.findByProps({id: 'tutor-observation'}).findAllByType('button')[0];
    for (let i = 0; i < 6; i++) act(() => refresh().props.onClick());
    assert.equal(f.reads, before + 6);
    assert.equal(f.api.mode, 'live');
    assert.equal(f.question().props.value, '這個草稿要保留');
    assert.equal(calls, 0);
    await act(async () => f.root.root.findByType('form').props.onSubmit({preventDefault() {}}));
    assert.equal(calls, 1);
    assert.equal(f.question().props.value, '');
    assert.equal(f.root.root.findByProps({role: 'log'}).findAllByType('article').length, 1);
});

test('shared tutor connection survives real TutorTab unmount and remount', () => {
    const f = fixture({managed: true, aiConfigured: true});
    act(() => {f.api.setApiKey('shared-state-key'); f.api.setMode('live');});
    act(() => f.root.unmount());
    f.mount();
    assert.equal(f.api.apiKey, 'shared-state-key');
    assert.equal(f.api.mode, 'live');
    act(() => f.api.setApiKey(''));
    assert.equal(f.api.apiKey, '');
});

test('real TutorTab aborts an in-flight request on task unmount and ignores its late response', async () => {
    const f = fixture({managed: true, aiConfigured: true});
    f.enter();
    act(() => f.question().props.onChange({target: {value: '等待題目切換'}}));
    let signal;
    let resolveResponse;
    globalThis.fetch = async (url, options) => {
        assert.equal(url, './api/tutor');
        signal = options.signal;
        return new Promise(resolve => {resolveResponse = resolve;});
    };
    let pending;
    act(() => {pending = f.root.root.findByType('form').props.onSubmit({preventDefault() {}});});
    assert.equal(signal.aborted, false);
    f.switchTask({...task, code: 'next-task', title: '下一題'});
    assert.equal(signal.aborted, true);
    await act(async () => {
        resolveResponse(new Response(JSON.stringify({source: 'nmking', guidance: '遲到回覆', question: '不應出現'}),
            {headers: {'Content-Type': 'application/json'}}));
        await pending;
    });
    assert.equal(f.root.root.findByProps({role: 'log'}).findAllByType('article').length, 0);
    assert.equal(f.question().props.disabled, false);
});

test('real TutorTab displays safe server errors and preserves draft for a later retry', async () => {
    const f = fixture({managed: true, aiConfigured: true});
    let calls = 0;
    let responseBody;
    globalThis.fetch = async () => {
        calls++;
        return new Response(JSON.stringify(responseBody), {status: responseBody.error ? 503 : 200,
            headers: {'Content-Type': 'application/json'}});
    };
    f.enter();
    const draft = '錯誤後保留的提問';
    act(() => f.question().props.onChange({target: {value: draft}}));
    for (const code of ['NETWORK_BLOCKED', 'INVALID_PROVIDER_RESPONSE', 'INVALID_MODEL_OUTPUT']) {
        const before = calls;
        responseBody = {error: `測試安全訊息（${code}）`, code, providerStatus: null};
        await act(async () => f.root.root.findByType('form').props.onSubmit({preventDefault() {}}));
        assert.equal(calls, before + 1);
        assert.equal(f.root.root.findByProps({role: 'alert'}).children.join(''), responseBody.error);
        assert.equal(f.api.mode, 'live');
        assert.equal(f.question().props.value, draft);
        assert.equal(f.question().props.disabled, false);
        assert.equal(f.root.root.findByProps({role: 'log'}).findAllByType('article').length, 0);
        const refresh = () => f.root.root.findByProps({id: 'tutor-observation'}).findAllByType('button')[0];
        act(() => refresh().props.onClick());
        assert.equal(calls, before + 1);
    }
    responseBody = {source: 'nmking', guidance: '假回覆', question: '追問'};
    await act(async () => f.root.root.findByType('form').props.onSubmit({preventDefault() {}}));
    assert.equal(calls, 4);
    assert.equal(f.root.root.findAllByProps({role: 'alert'}).length, 0);
    assert.equal(f.root.root.findByProps({role: 'log'}).findAllByType('article').length, 1);
});
