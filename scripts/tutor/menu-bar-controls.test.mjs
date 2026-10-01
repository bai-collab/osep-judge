import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const React = require('react');
const {create, act} = require('react-test-renderer');
const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = path.join(rootPath, 'src/components/menu-bar/tutor-controls.jsx');
const sourceRequire = createRequire(source);
const code = require('@babel/core').transformFileSync(source, {
    babelrc: false,
    configFile: false,
    presets: [require.resolve('@babel/preset-react')],
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')]
}).code;
const module = {exports: {}};
new Function('require', 'module', 'exports', code)(name => {
    if (name.endsWith('.css')) return {};
    return sourceRequire(name);
}, module, module.exports);
const TutorControls = module.exports.default;
const {useStudentIdentity} = require('../../src/lib/learning-records.js');
const {useTutorConnection} = require('../../src/lib/tutor-connection.js');
const originals = {window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch};

const fixture = () => {
    const listeners = new Map();
    const storage = new Map();
    globalThis.window = {
        location: {protocol: 'http:', hostname: '127.0.0.1'},
        localStorage: {getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value)}
    };
    globalThis.document = {
        addEventListener: (name, listener) => listeners.set(name, listener),
        removeEventListener: (name, listener) => {
            if (listeners.get(name) === listener) listeners.delete(name);
        }
    };
    globalThis.fetch = async () => new Response(JSON.stringify({managed: true, aiConfigured: true}),
        {headers: {'Content-Type': 'application/json'}});
    const state = {listeners, focusLog: []};
    const Harness = () => {
        state.student = useStudentIdentity();
        state.connection = useTutorConnection();
        return React.createElement(TutorControls);
    };
    act(() => {state.root = create(React.createElement(Harness), {createNodeMock: element => ({
        contains: () => false,
        focus() {state.focusLog.push(element.props.id || element.props['aria-controls'] || element.type);}
    })});});
    return state;
};

test('StudentCodeControl moves focus into the editor and back to the collapsed trigger', () => {
    const f = fixture();
    const lastFocus = () => f.focusLog[f.focusLog.length - 1];
    assert.equal(lastFocus(), 'student-code');
    const input = () => f.root.root.findByProps({id: 'student-code'});
    const confirm = () => f.root.root.findAllByType('button').find(button => button.props.disabled === false);
    act(() => input().props.onChange({target: {value: 'S01'}}));
    act(() => confirm().props.onClick());
    assert.equal(lastFocus(), 'student-code-panel');
    const compact = f.root.root.findByProps({['aria-controls']: 'student-code-panel'});
    act(() => compact.props.onClick());
    assert.equal(lastFocus(), 'student-code');
    act(() => f.student.setStudentId(''));
});

test('ConnectionControl focuses the mode select when opened and the trigger when closed', () => {
    const f = fixture();
    const lastFocus = () => f.focusLog[f.focusLog.length - 1];
    const open = () => f.root.root.findByProps({['aria-controls']: 'tutor-connection-panel'});
    act(() => open().props.onClick());
    assert.equal(lastFocus(), 'tutor-mode');
    act(() => f.listeners.get('keydown')({key: 'Escape', preventDefault() {}}));
    assert.equal(lastFocus(), 'tutor-connection-panel');
    act(() => open().props.onClick());
    act(() => open().props.onClick());
    assert.equal(lastFocus(), 'tutor-connection-panel');
    act(() => open().props.onClick());
    act(() => f.listeners.get('pointerdown')({target: {}}));
    assert.equal(lastFocus(), 'tutor-connection-panel');
});

afterEach(() => {
    if (typeof globalThis.window !== 'undefined' && globalThis.window.localStorage) {
        globalThis.window.localStorage.setItem('osepStudentCode', '');
    }
    for (const [name, value] of Object.entries(originals)) {
        if (typeof value === 'undefined') delete globalThis[name];
        else globalThis[name] = value;
    }
});

test('頂端選單列同時出現學生代號與連線設定兩個控制區', () => {
    const f = fixture();
    assert.equal(f.root.root.findAllByProps({id: 'student-code'}).length, 1);
    assert.equal(f.root.root.findAllByProps({['aria-controls']: 'tutor-connection-panel'}).length, 1);
    assert.equal(f.root.root.findAllByProps({id: 'student-code-panel'}).length, 1);
    assert.equal(f.root.root.findAllByProps({id: 'tutor-connection-panel'}).length, 0);
});

test('學生代號輸入即保存，但第一個有效字元不會自動收合，確認後才收合', () => {
    const f = fixture();
    const input = () => f.root.root.findByProps({id: 'student-code'});
    const confirm = () => f.root.root.findAllByType('button').find(button => button.props.children === '確認代號');
    act(() => input().props.onChange({target: {value: 'S01'}}));
    assert.equal(input().props.value, 'S01');
    assert.equal(f.root.root.findAllByProps({id: 'student-code-panel'}).length, 1);
    assert.equal(f.student.studentId, 'S01');
    act(() => confirm().props.onClick());
    assert.equal(f.root.root.findAllByProps({id: 'student-code'}).length, 0);
    assert.equal(f.root.root.findAllByProps({['aria-controls']: 'student-code-panel'}).length, 1);
    const compact = f.root.root.findByProps({['aria-controls']: 'student-code-panel'});
    act(() => compact.props.onClick());
    act(() => input().props.onChange({target: {value: 'S 01'}}));
    assert.equal(input().props['aria-invalid'], true);
    assert.equal(confirm().props.disabled, true);
});

test('連線設定面板保留導師模式與教師狀態，不顯示金鑰，支援再次點擊、Escape與面板外關閉', () => {
    const f = fixture();
    const open = () => f.root.root.findByProps({['aria-controls']: 'tutor-connection-panel'});
    act(() => open().props.onClick());
    assert.equal(f.root.root.findByProps({id: 'tutor-mode'}).props.value, 'mock');
    assert.equal(f.root.root.findAllByProps({id: 'tutor-api-key'}).length, 0);
    act(() => f.root.root.findByProps({id: 'tutor-mode'}).props.onChange({target: {value: 'live'}}));
    assert.equal(f.connection.mode, 'live');
    act(() => open().props.onClick());
    assert.equal(f.root.root.findAllByProps({id: 'tutor-connection-panel'}).length, 0);
    act(() => open().props.onClick());
    act(() => f.listeners.get('keydown')({key: 'Escape', preventDefault() {}}));
    assert.equal(f.root.root.findAllByProps({id: 'tutor-connection-panel'}).length, 0);
    act(() => open().props.onClick());
    act(() => f.listeners.get('pointerdown')({target: {}}));
    assert.equal(f.root.root.findAllByProps({id: 'tutor-connection-panel'}).length, 0);
});
