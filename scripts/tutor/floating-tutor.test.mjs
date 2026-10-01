import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const React = require('react');
const {create, act} = require('react-test-renderer');
const {clampTutorRect, initialTutorRect, resizeTutorRect} = require('../../src/lib/tutor-window-geometry.js');
const {useTutorConnection} = require('../../src/lib/tutor-connection.js');
const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// 載入實際浮窗與導師元件；只替換DOM出口、樣式、未載入的Blockly。
const load = relative => {
    const source = path.join(rootPath, relative);
    const sourceRequire = createRequire(source);
    const module = {exports: {}};
    const code = require('@babel/core').transformFileSync(source, {
        babelrc: false, configFile: false,
        presets: [require.resolve('@babel/preset-react')],
        plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
    }).code;
    new Function('require', 'module', 'exports', code)(name => {
        if (name.endsWith('.css')) return {};
        if (name === 'react-dom') return {createPortal: (children, target) => {
            assert.equal(target, globalThis.document.body);
            return children;
        }};
        if (name === '../../lib/tw-lazy-scratch-blocks') return {isLoaded: () => false};
        return sourceRequire(name);
    }, module, module.exports);
    return module.exports;
};
const FloatingTutor = load('src/components/judge-panel/floating-tutor.jsx').default;
const {TutorTab} = load('src/components/judge-panel/tutor-tab.jsx');
const originals = {window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch};
const fixtures = [];

const fixture = () => {
    const events = new Map();
    globalThis.window = {innerWidth: 1280, innerHeight: 720,
        location: {protocol: 'http:', hostname: '127.0.0.1'},
        addEventListener: (name, fn) => events.set(name, fn),
        removeEventListener: (name, fn) => { if (events.get(name) === fn) events.delete(name); }};
    globalThis.document = {body: {}};
    globalThis.fetch = async () => new Response(JSON.stringify({
        source: 'mock', guidance: '保留的提示', question: '保留的追問'
    }), {headers: {'Content-Type': 'application/json'}});
    const state = {events, focus: [], reads: 0};
    const task = {code: 'floating-fixture', title: '浮窗測試題', description: '讀取輸入。', examples: []};
    const vm = {toJSON: () => {
        state.reads++;
        return JSON.stringify({targets: []});
    }};
    const Harness = () => {
        const [open, setOpen] = React.useState(false);
        const [minimized, setMinimized] = React.useState(false);
        const api = useTutorConnection();
        state.api = api;
        state.open = () => {setOpen(true); setMinimized(false);};
        return React.createElement(FloatingTutor, {open, minimized, mode: api.mode,
            onClose: () => {setOpen(false); setMinimized(false);},
            onMinimize: () => setMinimized(true), onRestore: state.open},
        React.createElement(TutorTab, {task, vm, apiKey: api.apiKey, mode: api.mode}));
    };
    act(() => {state.root = create(React.createElement(Harness), {createNodeMock: element => ({
        focus: () => state.focus.push(element.props['aria-label'] || element.props.children)
    })});});
    state.dialog = () => state.root.root.findByProps({id: 'floating-tutor-window'});
    state.control = label => state.root.root.findByProps({'aria-label': label});
    state.button = text => state.root.root.findAllByType('button').find(node => node.props.children === text);
    state.question = () => state.root.root.findByProps({id: 'tutor-question'});
    fixtures.push(state);
    return state;
};

afterEach(() => {
    for (const f of fixtures.splice(0)) {
        act(() => {f.api.setApiKey(''); f.api.setMode('mock'); f.root.unmount();});
        assert.equal(f.events.size, 0);
    }
    for (const [name, value] of Object.entries(originals)) {
        if (typeof value === 'undefined') delete globalThis[name];
        else globalThis[name] = value;
    }
});

test('三種驗收尺寸及縮小viewport都保留工具列空間、視窗與控制的可見範圍', () => {
    for (const size of [[1280, 720], [1024, 768], [1360, 628], [360, 480]]) {
        const viewport = {width: size[0], height: size[1]};
        const rect = initialTutorRect(viewport);
        assert.ok(rect.x >= 12 && rect.y >= 56);
        assert.ok(rect.x + rect.width <= viewport.width - 12);
        assert.ok(rect.y + rect.height <= viewport.height - 12);
        const moved = clampTutorRect({...rect, x: 10000, y: -10000}, viewport);
        assert.equal(moved.x + moved.width, viewport.width - 12);
        assert.equal(moved.y, 56);
    }
});

test('縮放固定左上角且不超出右下邊界，縮小不能低於可用最小尺寸', () => {
    const viewport = {width: 1280, height: 720};
    const rect = {x: 500, y: 56, width: 460, height: 600};
    assert.deepEqual(resizeTutorRect(rect, 10000, 10000, viewport),
        {x: 500, y: 56, width: 768, height: 652});
    assert.deepEqual(resizeTutorRect(rect, -10000, -10000, viewport),
        {x: 500, y: 56, width: 320, height: 500});
});

test('實際標題列拖曳與右下角縮放改變位置尺寸；右鍵不啟動拖曳', () => {
    const f = fixture();
    act(f.open);
    const start = {...f.dialog().props.style};
    const captures = [];
    const event = (x, y, button = 0) => ({button, isPrimary: true, pointerId: 7,
        clientX: x, clientY: y, preventDefault() {}, stopPropagation() {},
        currentTarget: {setPointerCapture: id => captures.push(id), hasPointerCapture: () => true,
            releasePointerCapture: id => captures.push(-id)}});
    act(() => f.control('移動解題導師視窗').props.onPointerDown(event(100, 100, 2)));
    act(() => f.control('移動解題導師視窗').props.onPointerMove(event(220, 84)));
    assert.deepEqual(f.dialog().props.style, start);
    act(() => f.control('移動解題導師視窗').props.onPointerDown(event(100, 100)));
    act(() => f.control('移動解題導師視窗').props.onPointerMove(event(220, 84)));
    act(() => f.control('移動解題導師視窗').props.onPointerUp(event(220, 84)));
    assert.equal(f.dialog().props.style.left, start.left + 120);
    assert.equal(f.dialog().props.style.top, 56);
    act(() => f.control('調整解題導師視窗大小').props.onPointerDown(event(0, 0)));
    act(() => f.control('調整解題導師視窗大小').props.onPointerMove(event(100, 20)));
    act(() => f.control('調整解題導師視窗大小').props.onPointerUp(event(100, 20)));
    assert.equal(f.dialog().props.style.width, start.width + 100);
    assert.equal(f.dialog().props.style.height, start.height + 20);
    assert.deepEqual(captures, [7, -7, 7, -7]);
});

test('縮小、關閉再開與更新觀察保留真導師的對話、草稿和模式；浮窗不再放連線控制', async () => {
    const f = fixture();
    assert.equal(f.root.root.findAllByProps({id: 'tutor-question'}).length, 0);
    act(f.open);
    act(() => f.question().props.onChange({target: {value: '先問一輪'}}));
    await act(async () => f.root.root.findByType('form').props.onSubmit({preventDefault() {}}));
    act(() => f.question().props.onChange({target: {value: '未送出的草稿'}}));
    const assertKept = () => {
        assert.equal(f.question().props.value, '未送出的草稿');
        assert.equal(f.root.root.findByProps({role: 'log'}).findAllByType('article').length, 1);
        assert.equal(f.root.root.findAllByProps({id: 'tutor-mode'}).length, 0);
        assert.equal(f.root.root.findAllByProps({id: 'tutor-settings'}).length, 0);
        assert.equal(f.root.root.findAllByType('button').some(button => button.props.children === '連線設定'), false);
    };
    assertKept();
    assertKept();
    act(() => f.control('縮小解題導師').props.onClick());
    assert.equal(f.dialog().props.hidden, true);
    assertKept();
    act(() => f.button('展開解題導師').props.onClick());
    assert.equal(f.dialog().props.hidden, false);
    act(() => f.control('關閉解題導師').props.onClick());
    assert.equal(f.dialog().props.hidden, true);
    act(f.open);
    act(() => f.button('更新觀察').props.onClick());
    assert.equal(f.dialog().props.hidden, false);
    assertKept();
    const readsBeforeRefresh = f.reads;
    act(() => f.root.root.findByProps({id: 'tutor-observation'}).findAllByType('button')[0].props.onClick());
    assert.equal(f.reads, readsBeforeRefresh + 1);
    assertKept();
});

test('方向鍵可移動與縮放、Escape關閉，viewport變小會重新夾限', () => {
    const f = fixture();
    act(f.open);
    const event = key => ({key, shiftKey: false, preventDefault() {}, stopPropagation() {}});
    const start = {...f.dialog().props.style};
    act(() => f.control('移動解題導師視窗').props.onKeyDown(event('ArrowLeft')));
    act(() => f.control('調整解題導師視窗大小').props.onKeyDown(event('ArrowRight')));
    assert.equal(f.dialog().props.style.left, start.left - 10);
    assert.equal(f.dialog().props.style.width, start.width + 10);
    act(() => {
        globalThis.window.innerWidth = 360;
        globalThis.window.innerHeight = 480;
        f.events.get('resize')();
    });
    assert.deepEqual(f.dialog().props.style, {left: 12, top: 56, width: 336, height: 412});
    act(() => f.dialog().props.onKeyDown(event('Escape')));
    assert.equal(f.dialog().props.hidden, true);
});
