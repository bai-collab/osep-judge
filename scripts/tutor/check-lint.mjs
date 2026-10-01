import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const require = createRequire(import.meta.url);
const {ESLint} = require('eslint');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// babel-eslint 另外以 process.cwd() 尋找 .babelrc；入口可從工作區根目錄呼叫。
process.chdir(root);
const eslint = new ESLint({cwd: root, fix: false});
const added = ['src/lib/learning-records.js', 'src/lib/tutor-context.js', 'src/lib/tutor-editor.js', 'src/lib/tutor-connection.js',
    'src/lib/tutor-window-geometry.js', 'src/lib/tutor-block-highlight.js', 'src/components/judge-panel/floating-tutor.jsx',
    'src/components/judge-panel/tutor-tab.jsx'];
const newResults = await eslint.lintFiles(added.map(p => path.join(root, p)));
let failures = newResults.reduce((n, r) => n + r.errorCount, 0);
const changed = 'src/components/judge-panel/judge-panel.jsx';
const baseline = spawnSync('git', ['show', `HEAD:${changed}`], {cwd: root, encoding: 'utf8'});
if (baseline.status !== 0) throw new Error('讀取 lint 起始版本失敗。');
const current = fs.readFileSync(path.join(root, changed), 'utf8');
const [oldResult] = await eslint.lintText(baseline.stdout, {filePath: path.join(root, changed)});
const [nowResult] = await eslint.lintText(current, {filePath: path.join(root, changed)});
if (oldResult.fatalErrorCount || nowResult.fatalErrorCount) throw new Error('JSX 解析失敗，不可當成既有 lint 基線。');
const key = (m, source) => JSON.stringify([m.ruleId, m.message, source.split(/\r?\n/)[m.line - 1]?.trim()]);
const existing = new Map();
for (const m of oldResult.messages) {
    const k = key(m, baseline.stdout);
    existing.set(k, (existing.get(k) || 0) + 1);
}
const introduced = [];
for (const m of nowResult.messages) {
    const k = key(m, current), n = existing.get(k) || 0;
    if (n) existing.set(k, n - 1);
    else introduced.push(m);
}
failures += introduced.filter(m => m.severity === 2).length;
console.log(JSON.stringify({newFiles: newResults.map(r => ({path: path.relative(root, r.filePath), errors: r.errorCount})),
    existingFile: {baselineErrors: oldResult.errorCount, currentErrors: nowResult.errorCount, introduced}}, null, 2));
process.exitCode = failures ? 1 : 0;
