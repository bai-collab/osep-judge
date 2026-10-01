// 僅匯出教學需要的文字與積木結構，不傳送答案檔、隱藏測資或專案資產。
// 此純函式也由原生 Node 測試載入，因此保留 CommonJS 匯出。
/* eslint-disable import/no-commonjs */
const shortText = (value, limit) => String(value === null || typeof value === 'undefined' ? '' : value).slice(0, limit);
const buildTutorContext = (task, vm, grading, editor = {}) => {
    // TurboWarp 預設會把 id 改成 a/b；保留原 id 才能與真畫布文字對照。
    const project = JSON.parse(vm.toJSON(null, {allowOptimization: false}));
    const blocks = [];
    let totalBlocks = 0;
    const counts = new Map();
    (project.targets || []).forEach(target => {
        Object.entries(target.blocks || {}).forEach(([id, serialized]) => {
            // Serializer 用緊湊陣列儲存獨立變數／清單積木，不可當成沒有積木。
            const block = Array.isArray(serialized) ?
                ([12, 13].includes(serialized[0]) ? {
                    opcode: serialized[0] === 12 ? 'data_variable' : 'data_listcontents',
                    fields: {name: serialized[1]},
                    topLevel: true
                } : null) : serialized;
            if (!block || typeof block.opcode !== 'string') return;
            totalBlocks++;
            counts.set(block.opcode, (counts.get(block.opcode) || 0) + 1);
            if (blocks.length >= 80) return;
            blocks.push({
                id: shortText(id, 80),
                opcode: shortText(block.opcode, 80),
                target: shortText(target.name, 80),
                shadow: Boolean(block.shadow),
                topLevel: Boolean(block.topLevel),
                disabled: Boolean(block.disabled),
                next: block.next ? shortText(block.next, 80) : null,
                parent: block.parent ? shortText(block.parent, 80) : null,
                fields: shortText(JSON.stringify(block.fields || {}), 350),
                inputs: shortText(JSON.stringify(block.inputs || {}), 500)
            });
        });
    });
    return {
        task: {
            code: shortText(task.code, 120),
            title: shortText(task.title, 200),
            description: shortText(task.description, 6000),
            examples: (task.examples || []).slice(0, 3).map(example => ({
                input: shortText(example.input, 500),
                output: shortText(example.output, 500)
            }))
        },
        blocks,
        totalBlocks,
        omittedBlocks: Math.max(0, totalBlocks - blocks.length),
        blockTypes: Array.from(counts, ([opcode, count]) => ({opcode, count})).slice(0, 120),
        omittedBlockTypes: Math.max(0, counts.size - 120),
        selectedTarget: vm.editingTarget && typeof vm.editingTarget.getName === 'function' ?
            shortText(vm.editingTarget.getName(), 80) : '',
        editor,
        grading: grading && Array.isArray(grading.results) ? {
            passed: grading.results.filter(result => result.pass).length,
            total: grading.results.length
        } : null
    };
};

module.exports = {buildTutorContext};
