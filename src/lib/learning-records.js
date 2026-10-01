/* eslint-disable import/no-commonjs */
const React = require('react');
const listeners = new Set();
let studentId = '';
try {
    studentId = window.localStorage.getItem('osepStudentCode') || '';
} catch (e) { /* 本機儲存可能停用。 */ }
const validStudentId = value => /^[\p{L}\p{N}_-]{1,40}$/u.test(value);
const newRecordId = () => crypto.randomUUID();
const setStudentId = value => {
    studentId = value;
    try {
        window.localStorage.setItem('osepStudentCode', value);
    } catch (e) { /* 仍保留本頁。 */ }
    listeners.forEach(listener => listener(value));
};
const useStudentIdentity = () => {
    const [value, setValue] = React.useState(studentId);
    React.useEffect(() => {
        listeners.add(setValue);
        setValue(studentId);
        return () => listeners.delete(setValue);
    }, []);
    return {studentId: value, setStudentId};
};
// 保存學生程式結構；執行中的變數值、資產及題庫資料不在此快照。
const captureProgram = vm => {
    const project = JSON.parse(vm.toJSON());
    const targets = (project.targets || []).map(target => ({
        name: target.name || '',
        isStage: target.isStage === true,
        variables: Object.fromEntries(Object.entries(target.variables || {}).map(([id, value]) => [id, [value[0], 0]])),
        lists: Object.fromEntries(Object.entries(target.lists || {}).map(([id, value]) => [id, [value[0], []]])),
        blocks: Object.fromEntries(Object.entries(target.blocks || {}).map(([id, block]) => {
            if (Array.isArray(block)) return [id, block];
            const copy = {};
            ['opcode', 'next', 'parent', 'inputs', 'fields', 'shadow', 'topLevel', 'x', 'y'].forEach(key => {
                if (typeof block[key] !== 'undefined') copy[key] = block[key];
            });
            return [id, copy];
        }))
    }));
    const program = {targets};
    if (JSON.stringify(program).length > 120000) throw new Error('程式超過記錄容量；本次程式未記錄。');
    return program;
};
const safeProgram = (vm, apiKey) => {
    const program = captureProgram(vm);
    if (apiKey && JSON.stringify(program).includes(apiKey)) throw new Error('程式文字含有 API 金鑰；請移除後再記錄。');
    return program;
};
const recordingText = recording => {
    if (!recording || recording.status === 'skipped') return '未記錄：請先填寫有效的學生代號。';
    if (recording.status === 'failed') return '記錄失敗；本次結果仍可查看，請回報教師。';
    return '已保存本機紀錄；試算表同步狀態請看教師頁。';
};
const postGradeRecord = async record => {
    try {
        const response = await fetch('./api/records', {method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(record)});
        if (!response.ok) return '記錄失敗；評分結果仍可查看，請回報教師。';
        return recordingText((await response.json()).recording);
    } catch (e) {
        return '記錄失敗；評分結果仍可查看，請回報教師。';
    }
};
module.exports = {useStudentIdentity,
    setStudentId,
    validStudentId,
    newRecordId,
    captureProgram,
    safeProgram,
    recordingText,
    postGradeRecord};
