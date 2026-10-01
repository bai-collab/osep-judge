import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const React = require('react'), {create, act} = require('react-test-renderer'), VM = require('scratch-vm');
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/components/judge-panel/judge-panel.jsx');
const sourceRequire = createRequire(source);
const code = require('@babel/core').transformFileSync(source, {babelrc: false, configFile: false,
    presets: [require.resolve('@babel/preset-react')], plugins: [require.resolve('@babel/plugin-proposal-dynamic-import'),
        require.resolve('@babel/plugin-transform-modules-commonjs')]}).code;
const task = {code: 'q1', title: '測試題', description: '公開說明', examples: [], testCases: [{input: 'HIDDEN', expectedOutput: 'GOLD'}]};
let gradeImpl;
const subject = {exports: {}};
new Function('require', 'module', 'exports', code)(name => {
    if (name.endsWith('.css')) return {};
    if (name === '../../lib/tw-judge-engine.js') return {prepareVmForGrading: () => {}, gradeSubmission: (...args) => gradeImpl(...args)};
    if (name === '../../lib/judge-content/index.js') return {courses: [], findTaskByCode: async () => ({course: {code: 'C1'}, task})};
    if (name === '../../lib/scaffold-content.js') return {scaffoldUrlForCourse: () => null};
    if (name === './task-list.jsx') return {__esModule: true, default: ({onSelectTask}) =>
        React.createElement('button', {onClick: () => onSelectTask('q1')}, '選測試題')};
    if (['./tutor-tab.jsx', './floating-tutor.jsx'].includes(name)) return {__esModule: true, default: () => null};
    return sourceRequire(name);
}, subject, subject.exports);
const JudgePanel = subject.exports.default;
test('真正評分按鈕保存按下當時程式與分數；重複點擊不重跑；記錄失敗不吞分數', async t => {
    const oldWindow = globalThis.window, oldFetch = globalThis.fetch;
    const storage = new Map(), records = [];
    globalThis.window = {localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)}};
    let saveFailed = false;
    globalThis.fetch = async (url, options) => {
        if (url === './api/records') {
            records.push(JSON.parse(options.body));
            return new Response(JSON.stringify({recording: {status: saveFailed ? 'failed' : 'saved_local'}}));
        }
        return new Response('{}');
    };
    const vm = new VM();
    let blockText = '按下前';
    vm.toJSON = () => JSON.stringify({targets: [{name: '學生角色', blocks: {one: {opcode: 'looks_say',
        inputs: {MESSAGE: [1, [10, blockText]]}, fields: {}}}, costumes: ['ASSET']}], hiddenTests: 'GOLD'});
    let root;
    t.after(() => {act(() => root.unmount()); vm.quit(); globalThis.window = oldWindow; globalThis.fetch = oldFetch;});
    await act(async () => {root = create(React.createElement(JudgePanel, {vm}));});
    const button = text => root.root.findAllByType('button').find(node => node.props.children === text);
    await act(async () => button('選測試題').props.onClick());
    act(() => root.root.findByProps({id: 'student-code'}).props.onChange({target: {value: 'S01'}}));
    act(() => button('評分').props.onClick());
    let resolveGrade, calls = 0;
    gradeImpl = () => {calls++; return new Promise(resolve => {resolveGrade = resolve;});};
    let pending;
    act(() => {const handler = button('執行評分').props.onClick; pending = handler(); handler();});
    assert.equal(calls, 1);
    blockText = '評分途中改過';
    await act(async () => {resolveGrade({totalScore: 7, maxScore: 10, results: [{pass: true}]}); await pending;});
    assert.equal(records.length, 1);
    assert.equal(records[0].program.targets[0].blocks.one.inputs.MESSAGE[1][1], '按下前');
    assert.equal(records[0].programChanged, true);
    assert.equal(records[0].totalScore, 7);
    for (const forbidden of ['HIDDEN', 'GOLD', 'ASSET']) assert.ok(!JSON.stringify(records).includes(forbidden));
    saveFailed = true;
    gradeImpl = async () => ({totalScore: 0, maxScore: 10, results: [{pass: false}]});
    await act(async () => button('執行評分').props.onClick());
    assert.equal(records[1].programChanged, false);
    assert.equal(records[1].totalScore, 0);
    assert.ok(JSON.stringify(root.toJSON()).includes('分數：'));
    assert.ok(JSON.stringify(root.toJSON()).includes('記錄失敗'));
    gradeImpl = async () => {throw new Error('GRADER_INTERNAL');};
    await act(async () => button('執行評分').props.onClick());
    assert.equal(records[2].status, 'failed');
    assert.equal(records[2].errorCode, 'GRADING_FAILED');
    assert.ok(!JSON.stringify(records[2]).includes('GRADER_INTERNAL'));
    act(() => root.root.findByProps({id: 'student-code'}).props.onChange({target: {value: ''}}));
    await act(async () => button('執行評分').props.onClick());
    assert.equal(records.length, 3);
});
