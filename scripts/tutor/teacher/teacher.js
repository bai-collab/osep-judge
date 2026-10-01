const $ = id => document.getElementById(id);
let records = [], limit = 100, busy = false;
let connection = {initialized: true};
function hideTeacherData(resetSettings = true) {
    records = [];
    options('student', [], '全部學生');
    options('task', [], '全部題目');
    render();
    $('logout').hidden = true;
    if (resetSettings) $('settings-form').reset();
}
const text = (tag, value, className = '') => {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
};
const time = value => new Date(value).toLocaleString('zh-TW');
const filtered = () => records.filter(record => (!$('student').value || record.studentId === $('student').value) &&
    (!$('task').value || record.task.code === $('task').value));
const options = (id, entries, allLabel) => {
    const select = $(id), current = select.value;
    select.replaceChildren(new Option(allLabel, ''));
    for (const [value, label] of entries) select.append(new Option(label, value));
    if (entries.some(([value]) => value === current)) select.value = current;
};
function render() {
    const expanded = new Set([...$('records').querySelectorAll('details[open]')].map(node => node.dataset.recordId));
    const shown = filtered().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const pairs = new Map();
    for (const record of shown) {
        const key = JSON.stringify([record.studentId, record.task.code]);
        const pair = pairs.get(key) || {record, latestGrade: null, ai: 0, grades: 0};
        pair.record = record;
        if (record.type === 'ai') pair.ai++;
        else {
            pair.grades++;
            if (record.status === 'completed' && !record.demoLoaded && !record.programChanged) pair.latestGrade = record;
        }
        pairs.set(key, pair);
    }
    $('summary').replaceChildren();
    for (const {record, latestGrade, ai, grades} of pairs.values()) {
        const card = text('article', '', 'card');
        card.append(text('strong', `${record.studentId}｜${record.task.title || record.task.code}`),
            text('p', latestGrade ? `${latestGrade.totalScore} / ${latestGrade.maxScore}` : '尚無有效成績', 'score'),
            text('p', `求助 ${ai} 次，評分 ${grades} 次`), text('p', `最近活動：${time(record.timestamp)}`));
        const button = text('button', '查看這位學生的本題紀錄');
        button.onclick = () => { $('student').value = record.studentId; $('task').value = record.task.code; limit = 100; render(); };
        card.append(button);
        $('summary').append(card);
    }
    if (!pairs.size) $('summary').append(text('p', '目前沒有紀錄。請先在學生頁填代號，再求助或評分。'));
    $('records').replaceChildren();
    for (const record of shown.reverse().slice(0, limit)) {
        const details = document.createElement('details');
        details.dataset.recordId = record.id;
        details.open = expanded.has(record.id);
        const result = record.type === 'ai' ? `導師求助／${record.source === 'mock' ? '模擬' : '真模型'}` :
            `評分 ${record.totalScore ?? '無分數'} / ${record.maxScore ?? '—'}`;
        const labels = [record.status === 'failed' ? '失敗' : '', record.demoLoaded ? '範例程式' : '',
            record.programChanged ? '評分時程式有變更或無法核對' : ''].filter(Boolean).join('；');
        details.append(text('summary', `${time(record.timestamp)}｜${record.studentId}｜${record.task.title || record.task.code}｜${result}${labels ? `（${labels}）` : ''}`));
        const content = document.createElement('article');
        if (record.type === 'ai') content.append(text('p', `學生提問：${record.question}`),
            text('p', `AI 引導：${record.guidance || '沒有可用回覆'}`), text('p', `AI 追問：${record.followup || '—'}`));
        if (record.errorCode) content.append(text('p', `錯誤代碼：${record.errorCode}`));
        content.append(text('h3', '當時程式（積木結構）'), text('pre', JSON.stringify(record.program, null, 2)));
        details.append(content);
        $('records').append(details);
    }
    $('more').hidden = shown.length <= limit;
}
function showStatus(sync) {
    $('status').textContent = `共 ${sync.total} 筆本機紀錄；${sync.configured ? `待同步 ${sync.pending} 筆` : '尚未設定 Google 試算表，紀錄先存本機'}。` +
        (sync.lastSyncError ? '上次同步失敗；本機紀錄仍保留。' : '') + (sync.more ? '雲端還有紀錄，請再按同步繼續匯入。' : '');
}
async function refresh(sync = false) {
    if (busy) return;
    busy = true;
    $('refresh').disabled = $('sync').disabled = true;
    $('error').hidden = true;
    try {
        const stateResponse = await fetch('/api/tutor/status');
        if (!stateResponse.ok) throw new Error('無法確認教師設定，請確認本機服務。');
        connection = await stateResponse.json();
        $('connection-status').textContent = connection.managed ?
            `教師設定：${connection.initialized ? '已完成' : '尚未初始化'}；AI：${connection.aiConfigured ? '已設定' : '未設定'}；試算表：${connection.sheetConfigured ? '已設定' : '未設定'}。` : '舊版本機服務。';
        if (connection.managed && !connection.initialized) {
            hideTeacherData(false);
            $('setup-panel').hidden = false;
            $('setup-panel').open = true;
            $('login').hidden = true;
            $('status').textContent = '請由教師先設定密碼，再交給學生使用；未設定前無法讀取教師紀錄。';
            return;
        }
        let syncResult;
        if (sync) {
            $('status').textContent = '正在同步；不會重跑評分或 AI 求助…';
            const response = await fetch('/api/records/sync', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
            if (!response.ok) throw new Error('同步失敗；本機紀錄仍保留。');
            syncResult = (await response.json()).sync;
        }
        const response = await fetch('/api/records');
        if (response.status === 401) {
            $('login').hidden = false;
            hideTeacherData();
            $('setup-panel').hidden = true;
            $('status').textContent = '教師尚未登入。';
            throw new Error('請先輸入教師密碼。');
        }
        if (!response.ok) throw new Error('無法讀取紀錄；請確認本機導師服務仍在執行。');
        const result = await response.json();
        records = result.records;
        $('login').hidden = true;
        $('setup-panel').hidden = !connection.managed;
        $('logout').hidden = !connection.managed;
        options('student', [...new Set(records.map(record => record.studentId))].sort().map(value => [value, value]), '全部學生');
        options('task', [...new Map(records.map(record => [record.task.code, record.task.title || record.task.code]))], '全部題目');
        showStatus(syncResult || result.sync);
        render();
    } catch (error) { $('error').textContent = error.message; $('error').hidden = false; }
    finally { busy = false; $('refresh').disabled = $('sync').disabled = false; }
}
$('refresh').onclick = () => refresh();
$('login').onsubmit = async event => {
    event.preventDefault();
    try {
        const response = await fetch('/api/teacher/login', {method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({password: $('teacher-password').value})});
        $('teacher-password').value = '';
        if (!response.ok) throw new Error('教師登入未完成，請確認密碼。');
        await refresh();
    } catch (error) { $('error').textContent = error.message; $('error').hidden = false; }
};
$('sync').onclick = () => refresh(true);
$('settings-form').onsubmit = async event => {
    event.preventDefault();
    $('save-settings').disabled = true;
    const body = {password: $('settings-password').value, aiKey: $('settings-ai').value,
        sheetUrl: $('settings-url').value, sheetToken: $('settings-token').value,
        clearAi: $('clear-ai').checked, clearSheet: $('clear-sheet').checked};
    $('settings-form').reset();
    try {
        const response = await fetch('/api/teacher/settings', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '設定未保存，請重試。');
        $('settings-result').textContent = '已保存到這台電腦；服務重啟仍會載入。密鑰欄位已清空，留白保存會保留原值。';
        await refresh();
    } catch (error) { $('settings-result').textContent = error.message; }
    finally { $('save-settings').disabled = false; }
};
$('logout').onclick = async () => {
    try {
        const response = await fetch('/api/teacher/logout', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
        if (!response.ok) throw new Error('登出未完成，請重試。');
        hideTeacherData();
        $('setup-panel').hidden = true;
        $('settings-result').textContent = '';
        await refresh();
    } catch (error) { $('error').textContent = error.message; $('error').hidden = false; }
};
for (const id of ['student', 'task']) $(id).onchange = () => { limit = 100; render(); };
$('more').onclick = () => {limit += 100; render();};
setInterval(() => {if ($('auto-refresh').checked && !document.hidden) refresh();}, 10000);
refresh();
