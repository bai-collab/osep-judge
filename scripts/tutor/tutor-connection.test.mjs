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
const harmlessKey = 'observation-regression-invalid-key';
const task = {code: 'fixture', title: '測試題', description: '讀取輸入。', examples: []};
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const fixtures = [];

const fixture = (initialConnection = {managed: false}) => {
    globalThis.window = {location: {protocol: 'http:', hostname: '127.0.0.1'}};
    const state = {reads: 0, blocks: {}};
    const vm = {toJSON: () => {
        state.reads++;
        return JSON.stringify({targets: [{name: '角色', blocks: state.blocks}]});
    }};
    const Harness = () => {
        const connection = useTutorConnection();
        state.api = connection;
        return React.createElement(TutorTab, {task, vm, apiKey: connection.apiKey, initialConnection,
            mode: connection.mode, onKeyChange: connection.setApiKey, onModeChange: connection.setMode});
    };
    state.mount = () => act(() => {state.root = create(React.createElement(Harness));});
    state.mount();
    act(() => {state.api.setApiKey(''); state.api.setMode('mock');});
    state.button = text => state.root.root.findAllByType('button')
        .find(node => node.props.children === text);
    state.keyInput = () => state.root.root.findByProps({id: 'tutor-api-key'});
    state.question = () => state.root.root.findByProps({id: 'tutor-question'});
    state.status = () => state.root.root.findByProps({role: 'status'}).children.join('');
    state.enter = () => act(() => {
        state.keyInput().props.onInput({currentTarget: {value: harmlessKey}});
        state.root.root.findByProps({id: 'tutor-mode'}).props.onChange({target: {value: 'live'}});
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

test('真元件連續更新觀察保留金鑰、模式與草稿，下一次求助只送一次', async () => {
    const f = fixture();
    let calls = 0;
    globalThis.fetch = async (url, options) => {
        calls++;
        assert.equal(url, './api/tutor');
        const body = JSON.parse(options.body);
        assert.equal(body.apiKey, harmlessKey);
        assert.equal(body.mode, 'live');
        assert.equal(body.context.blocks[0].opcode, 'sensing_askandwait');
        assert.ok(!JSON.stringify(body.context).includes(harmlessKey));
        return new Response(JSON.stringify({source: 'nmking', guidance: '測試回覆', question: '測試追問'}),
            {headers: {'Content-Type': 'application/json'}});
    };
    f.enter();
    act(() => f.question().props.onChange({target: {value: '這個草稿要保留'}}));
    const before = f.reads;
    f.blocks.ask = {opcode: 'sensing_askandwait', fields: {}, inputs: {}};
    for (let i = 0; i < 6; i++) act(() => f.button('更新觀察').props.onClick());
    assert.equal(f.reads, before + 6);
    assert.equal(f.status(), '金鑰已輸入。更新觀察不需重貼。');
    assert.equal(f.root.root.findByProps({id: 'tutor-mode'}).props.value, 'live');
    assert.equal(f.question().props.value, '這個草稿要保留');
    assert.equal(calls, 0);
    await act(async () => f.root.root.findByType('form').props.onSubmit({preventDefault() {}}));
    assert.equal(calls, 1);
    assert.equal(f.question().props.value, '');
    assert.equal(f.root.root.findByProps({role: 'log'}).findAllByType('article').length, 1);
});

test('整個面板卸載重建仍保留連線；明確清除後再次重建維持空白', () => {
    const f = fixture();
    f.enter();
    act(() => f.root.unmount());
    f.mount();
    assert.equal(f.status(), '金鑰已輸入。更新觀察不需重貼。');
    assert.equal(f.root.root.findByProps({id: 'tutor-mode'}).props.value, 'live');
    act(() => f.button('清除金鑰').props.onClick());
    assert.ok(f.status().startsWith('尚未輸入金鑰'));
    act(() => f.root.unmount());
    f.mount();
    assert.ok(f.status().startsWith('尚未輸入金鑰'));
});

test('瀏覽器填入只在離開欄位時通知，也能在更新前接住金鑰', () => {
    const f = fixture();
    act(() => f.keyInput().props.onBlur({currentTarget: {value: harmlessKey}}));
    act(() => f.button('更新觀察').props.onClick());
    assert.equal(f.status(), '金鑰已輸入。更新觀察不需重貼。');
    act(() => f.root.unmount());
    f.mount();
    assert.equal(f.status(), '金鑰已輸入。更新觀察不需重貼。');
});

test('觀察預設收合；展開及收合不求助、不清金鑰或草稿', () => {
    const f = fixture();
    let calls = 0;
    globalThis.fetch = () => {calls++;};
    f.enter();
    act(() => f.question().props.onChange({target: {value: '保留草稿'}}));
    const details = () => f.root.root.findByProps({id: 'tutor-observation'});
    assert.equal(details().props.hidden, true);
    const reads = f.reads;
    act(() => f.button('積木觀察（求助時自動更新）').props.onClick());
    assert.equal(details().props.hidden, false);
    act(() => f.button('收合積木觀察').props.onClick());
    assert.equal(details().props.hidden, true);
    assert.equal(f.reads, reads);
    assert.equal(f.status(), '金鑰已輸入。更新觀察不需重貼。');
    assert.equal(f.question().props.value, '保留草稿');
    assert.equal(calls, 0);
});

test('清除金鑰中止進行中請求，遲到的結果不重新加入對話', async () => {
    const f = fixture();
    let signal;
    let resolveResponse;
    globalThis.fetch = async (url, options) => {
        signal = options.signal;
        return new Promise(resolve => {resolveResponse = resolve;});
    };
    f.enter();
    act(() => f.question().props.onChange({target: {value: '等待測試'}}));
    let pending;
    act(() => {pending = f.root.root.findByType('form').props.onSubmit({preventDefault() {}});});
    assert.equal(signal.aborted, false);
    act(() => f.button('清除金鑰').props.onClick());
    assert.equal(signal.aborted, true);
    assert.ok(f.status().startsWith('尚未輸入金鑰'));
    await act(async () => {
        resolveResponse(new Response(JSON.stringify({source: 'nmking', guidance: '遲到回覆', question: '追問'}),
            {headers: {'Content-Type': 'application/json'}}));
        await pending;
    });
    assert.equal(f.root.root.findByProps({role: 'log'}).findAllByType('article').length, 0);
    assert.equal(f.question().props.disabled, false);
});

test('真正導師元件顯示後端安全錯誤，保留金鑰與草稿，下一次人工求助可成功', async () => {
    const f = fixture();
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
        assert.equal(f.status(), '金鑰已輸入。更新觀察不需重貼。');
        assert.equal(f.question().props.value, draft);
        assert.equal(f.question().props.disabled, false);
        assert.equal(f.root.root.findByProps({role: 'log'}).findAllByType('article').length, 0);
        act(() => f.button('更新觀察').props.onClick());
        assert.equal(calls, before + 1);
    }
    responseBody = {source: 'nmking', guidance: '假回覆', question: '追問'};
    await act(async () => f.root.root.findByType('form').props.onSubmit({preventDefault() {}}));
    assert.equal(calls, 4);
    assert.equal(f.root.root.findAllByProps({role: 'alert'}).length, 0);
    assert.equal(f.root.root.findByProps({role: 'log'}).findAllByType('article').length, 1);
    assert.equal(f.status(), '金鑰已輸入。更新觀察不需重貼。');
});
