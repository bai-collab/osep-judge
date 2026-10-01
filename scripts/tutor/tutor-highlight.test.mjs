import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {requestGuidance, sanitizeContext, mockGuidance} from './provider.mjs';
const require = createRequire(import.meta.url);
const {groundRelatedBlocks, createTutorBlockHighlight, HIGHLIGHT_ATTRIBUTE} =
    require('../../src/lib/tutor-block-highlight.js');
const editor = {workspaceStatus: 'complete', availableStatus: 'complete',
    renderedBlocks: [{id: 'ask-one', opcode: 'sensing_askandwait', label: '詢問名字並等待'}],
    availableBlocks: [{opcode: 'control_repeat', label: '重複 □ 次', category: '控制'},
        {opcode: 'sensing_askandwait', label: '詢問 □ 並等待', category: '專用'}]};
const root = () => {
    const attributes = new Map();
    return {getAttribute: name => attributes.get(name) ?? null,
        setAttribute: (name, value) => attributes.set(name, value),
        removeAttribute: name => attributes.delete(name)};
};
const block = (id, type, label = type) => ({id, type, svg: root(), disabled: false,
    getSvgRoot() {return this.svg;}, isShadow: () => false, getParent: () => null,
    toString: () => label, getRelativeToSurfaceXY: () => ({x: 0, y: 280})});
const workspace = (blocks = []) => ({blocks, listeners: new Set(),
    getAllBlocks() {return this.blocks;},
    addChangeListener(fn) {this.listeners.add(fn);},
    removeChangeListener(fn) {this.listeners.delete(fn);},
    emit() {for (const fn of [...this.listeners]) fn({type: 'change'});}});
const fixture = () => {
    const placed = block('ask-one', 'sensing_askandwait', '詢問名字並等待');
    const other = block('ask-two', 'sensing_askandwait');
    const repeat = block('repeat-menu', 'control_repeat', '重複 □ 次');
    const menu = workspace([repeat]);
    const canvas = workspace([placed, other]);
    const scrolls = [];
    const flyout = {getWorkspace: () => menu, scrollTo: n => scrolls.push(n)};
    canvas.getFlyout = () => flyout;
    const scratch = {getMainWorkspace: () => canvas};
    const updates = [];
    const control = createTutorBlockHighlight(scratch, value => updates.push(value));
    return {placed, other, repeat, canvas, menu, scrolls, scratch, control, updates};
};

test('目標只接受当前畫布 id／真正選單種類，未知 id 不降級同種類', () => {
    assert.deepEqual(groundRelatedBlocks([{id: 'missing', opcode: 'sensing_askandwait'},
        {opcode: '#tutor-api-key', selector: 'input'}, {id: 'ask-one', opcode: 'looks_say'}], editor), []);
    const targets = groundRelatedBlocks([{id: 'ask-one', selector: 'input', label: '<script>'},
        {opcode: 'control_repeat', category: '偵測'}, {id: 'ask-one'}], editor);
    assert.equal(targets.length, 2);
    assert.equal(targets[0].label, '詢問名字並等待');
    assert.equal(targets[1].category, '控制');
    assert.ok(!JSON.stringify(targets).includes('script'));
    assert.deepEqual(groundRelatedBlocks(null), []);
    assert.equal(groundRelatedBlocks(Array(100).fill({opcode: 'control_repeat'}), editor).length, 1);
});

test('畫布只框指定一個；選單定位、取消與重顯不改學生積木', () => {
    const f = fixture();
    const before = JSON.stringify(f.canvas.blocks.map(b => ({id: b.id, type: b.type, disabled: b.disabled})));
    const targets = groundRelatedBlocks([{id: 'ask-one'}, {opcode: 'control_repeat'}], editor);
    f.control.show(targets);
    assert.equal(f.placed.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), 'true');
    assert.equal(f.other.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), null);
    assert.equal(f.repeat.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), 'true');
    assert.deepEqual(f.updates.at(-1), {canvas: 1, toolbox: 1, missing: 0});
    assert.deepEqual(f.scrolls, [264]);
    f.control.clear();
    assert.equal(f.placed.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), null);
    assert.equal(f.repeat.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), null);
    assert.equal(f.canvas.listeners.size + f.menu.listeners.size, 0);
    f.control.show(targets, false);
    assert.equal(f.scrolls.length, 1);
    assert.equal(JSON.stringify(f.canvas.blocks.map(b => ({id: b.id, type: b.type, disabled: b.disabled}))), before);
    f.control.dispose();
    assert.equal(f.canvas.listeners.size + f.menu.listeners.size, 0);
});

test('刪除／切角色移除舊根，不能框另一個同種類；選單重建重新標記', () => {
    const f = fixture();
    f.control.show(groundRelatedBlocks([{id: 'ask-one'}, {opcode: 'control_repeat'}], editor));
    f.canvas.blocks = [f.other];
    f.canvas.emit();
    assert.equal(f.placed.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), null);
    assert.equal(f.other.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), null);
    assert.deepEqual(f.updates.at(-1), {canvas: 0, toolbox: 1, missing: 1});
    const replacement = block('new-menu', 'control_repeat', '重複 □ 次');
    f.menu.blocks = [replacement];
    f.menu.emit();
    assert.equal(f.repeat.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), null);
    assert.equal(replacement.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), 'true');
    f.control.dispose();
    assert.equal(replacement.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), null);
});

test('選單同種類有不同變數名稱時，只框快照的那一個', () => {
    const f = fixture();
    const first = block('var-a', 'data_variable', '朋友一');
    const second = block('var-b', 'data_variable', '朋友二');
    f.menu.blocks = [first, second];
    const targets = groundRelatedBlocks([{opcode: 'data_variable'}], {
        availableBlocks: [{opcode: 'data_variable', label: '朋友二', category: '變數'}]
    });
    f.control.show(targets);
    assert.equal(first.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), null);
    assert.equal(second.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), 'true');
    f.control.dispose();
});

test('影子與插入預覽不標示；取消還原原標記，dispose後不能再啟動', () => {
    const f = fixture();
    f.placed.isShadow = () => true;
    f.control.show(groundRelatedBlocks([{id: 'ask-one'}], editor));
    assert.equal(f.placed.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), null);
    f.placed.isShadow = () => false;
    f.placed.isInsertionMarker = () => true;
    f.canvas.emit();
    assert.equal(f.placed.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), null);
    f.placed.isInsertionMarker = () => false;
    f.placed.svg.setAttribute(HIGHLIGHT_ATTRIBUTE, 'previous-owner');
    f.canvas.emit();
    assert.equal(f.placed.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), 'true');
    f.control.dispose();
    assert.equal(f.placed.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), 'previous-owner');
    f.control.show(groundRelatedBlocks([{id: 'ask-one'}], editor));
    assert.equal(f.placed.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), 'previous-owner');
});

test('後端丟棄不存在的模型目標、只返快照名稱；舊回覆仍相容', async () => {
    const context = sanitizeContext({task: {code: 'test', description: '讀取名字。'}, blocks: [], editor});
    const reply = async relatedBlocks => requestGuidance({apiKey: 'invalid-fixture-key', context,
        question: '問題', history: [], fetchImpl: async () => new Response(JSON.stringify({output_text:
            JSON.stringify({guidance: '看看相關積木。', question: '你預期什麼？', relatedBlocks})}))});
    assert.deepEqual((await reply([{id: 'ask-one', label: '惡意'}, {opcode: 'control_repeat'},
        {id: 'non-existent', opcode: 'sensing_askandwait'}])).relatedBlocks,
    groundRelatedBlocks([{id: 'ask-one'}, {opcode: 'control_repeat'}], editor));
    assert.deepEqual((await reply(undefined)).relatedBlocks, []);
    const mock = mockGuidance(context, '我要詢問名字');
    assert.equal(mock.relatedBlocks[0].id, 'ask-one');
    assert.equal(mockGuidance({...context, editor: {...context.editor, renderedBlocks: []}},
        '我要輸入名字').relatedBlocks[0].opcode, 'sensing_askandwait');
});

const React = require('react');
const {create, act} = require('react-test-renderer');
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/components/judge-panel/tutor-tab.jsx');
const code = require('@babel/core').transformFileSync(source, {babelrc: false, configFile: false,
    presets: [require.resolve('@babel/preset-react')],
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]}).code;
const module = {exports: {}};
const sourceRequire = createRequire(source);
let currentScratch;
new Function('require', 'module', 'exports', code)(name => {
    if (name.endsWith('.css')) return {};
    if (name === '../../lib/tw-lazy-scratch-blocks') return {isLoaded: () => true, get: () => currentScratch};
    return sourceRequire(name);
}, module, module.exports);
const {TutorTab} = module.exports;
const originals = {window: globalThis.window, fetch: globalThis.fetch};
const mounted = [];
const mount = () => {
    const f = fixture();
    currentScratch = f.scratch;
    globalThis.window = {location: {protocol: 'http:', hostname: '127.0.0.1'}};
    let setVisible;
    let setKey;
    const Harness = () => {
        const [visible, updateVisible] = React.useState(true);
        const [apiKey, updateKey] = React.useState('invalid-memory-only-key');
        setVisible = updateVisible;
        setKey = updateKey;
        return React.createElement(TutorTab, {task: {code: 'test', title: '測試', description: '讀取名字。'},
            vm: {toJSON: () => JSON.stringify({targets: []})}, mode: 'mock', apiKey, onKeyChange: updateKey,
            onModeChange() {}, visible});
    };
    act(() => {f.root = create(React.createElement(Harness));});
    f.visibility = value => act(() => setVisible(value));
    f.key = value => act(() => setKey(value));
    f.button = text => f.root.root.findAllByType('button').find(b => b.props.children === text);
    f.enter = () => act(() => f.root.root.findByProps({id: 'tutor-question'}).props
        .onChange({target: {value: '我要詢問名字'}}));
    f.submit = () => f.root.root.findByType('form').props.onSubmit({preventDefault() {}});
    mounted.push(f);
    return f;
};
afterEach(() => {
    for (const f of mounted.splice(0)) {
        act(() => f.root.unmount());
        assert.equal(f.placed.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), null);
        assert.equal(f.canvas.listeners.size + f.menu.listeners.size, 0);
    }
    for (const [name, value] of Object.entries(originals)) {
        if (value === undefined) delete globalThis[name];
        else globalThis[name] = value;
    }
});
const response = relatedBlocks => new Response(JSON.stringify({source: 'mock', guidance: '先看詢問。',
    question: '想讀什麼？', relatedBlocks}), {headers: {'Content-Type': 'application/json'}});

test('真正元件回覆自動高亮；更新、取消、重顯與浮窗開關保留連線／對話', async () => {
    const f = mount();
    let calls = 0;
    globalThis.fetch = async () => {calls++; return response([{id: 'ask-one'}]);};
    f.enter();
    await act(async () => f.submit());
    assert.equal(f.placed.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), 'true');
    act(() => f.button('更新觀察').props.onClick());
    act(() => f.button('取消高亮').props.onClick());
    assert.equal(f.placed.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), null);
    act(() => f.button('顯示相關積木').props.onClick());
    assert.equal(f.placed.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), 'true');
    f.visibility(false);
    assert.equal(f.placed.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), null);
    f.visibility(true);
    assert.equal(f.placed.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), 'true');
    assert.equal(f.root.root.findByProps({role: 'status'}).children.join(''), '連線由教師設定；更新觀察不影響設定。');
    assert.equal(f.root.root.findByProps({role: 'log'}).findAllByType('article').length, 1);
    assert.equal(calls, 1);
});

test('晚到回覆不能在已關閉浮窗留下粗邊；未知目標只顯示引導', async () => {
    const f = mount();
    let resolve;
    globalThis.fetch = () => new Promise(r => {resolve = r;});
    f.enter();
    let pending;
    act(() => {pending = f.submit();});
    f.visibility(false);
    await act(async () => {resolve(response([{id: 'ask-one'}])); await pending;});
    assert.equal(f.placed.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), null);
    f.visibility(true);
    assert.equal(f.placed.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), 'true');
    globalThis.fetch = async () => response([{id: 'stale', opcode: 'sensing_askandwait', selector: 'input'}]);
    f.enter();
    await act(async () => f.submit());
    assert.equal(f.placed.svg.getAttribute(HIGHLIGHT_ATTRIBUTE), null);
    assert.equal(f.root.root.findByProps({role: 'log'}).findAllByType('article').length, 2);
});
