// 只觀察積木工作區與當前選單 XML；不讀整頁 DOM 或任何表單。
/* eslint-disable import/no-commonjs */
const text = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');
const readTutorEditor = (toolboxXML, scratchBlocks, Parser = typeof DOMParser === 'undefined' ? null : DOMParser) => {
    const result = {workspaceStatus: 'unavailable',
        renderedBlocks: [],
        renderedOmitted: 0,
        availableStatus: 'unavailable',
        availableBlocks: [],
        availableCategories: [],
        availableOmitted: 0};
    const labels = new Map();
    const flyoutBlocks = [];
    let flyoutReady = false;
    try {
        const workspace = scratchBlocks && scratchBlocks.getMainWorkspace();
        if (workspace) {
            const blocks = workspace.getAllBlocks(false);
            result.renderedOmitted = Math.max(0, blocks.length - 80);
            result.renderedBlocks = blocks.slice(0, 80).map(block => ({
                id: text(block.id, 80),
                opcode: text(block.type, 80),
                label: text(block.toString(), 160),
                disabled: Boolean(block.disabled),
                topLevel: !block.getParent()
            }));
            result.workspaceStatus = 'complete';
            const flyout = workspace.getFlyout();
            if (flyout) {
                flyout.getWorkspace().getAllBlocks(false)
                    .forEach(block => {
                        if (!block.isShadow()) {
                            const label = text(block.toString(), 160);
                            labels.set(block.type, label);
                            flyoutBlocks.push({opcode: text(block.type, 80),
                                label,
                                category: typeof block.getCategory === 'function' ? block.getCategory() : ''});
                        }
                    });
                flyoutReady = true;
            }
        }
    } catch (e) {
        // 部分編輯器未提供 flyout；保留成功取得的畫布觀察，不猜測缺漏。
    }
    try {
        if (!Parser || typeof toolboxXML !== 'string' || !toolboxXML) return result;
        const xml = new Parser().parseFromString(toolboxXML, 'text/xml');
        if (xml.querySelector('parsererror')) return result;
        const available = new Map();
        const categories = new Set();
        let dynamicMissing = false;
        Array.from(xml.querySelectorAll('category')).forEach(category => {
            const categoryName = text(category.getAttribute('name'), 80).replace(/%\{BKY_(\w+)\}/g,
                (match, id) => text(scratchBlocks && scratchBlocks.Msg && scratchBlocks.Msg[id], 80) || '名稱未就緒');
            categories.add(categoryName);
            Array.from(category.querySelectorAll('block[type]')).forEach(block => {
                const opcode = text(block.getAttribute('type'), 80);
                const label = labels.get(opcode) || text(scratchBlocks && scratchBlocks.Msg &&
                    scratchBlocks.Msg[opcode.toUpperCase()], 160).replace(/%\d+/g, '□');
                if (opcode) available.set(`${categoryName}:${opcode}`, {opcode, category: categoryName, label});
            });
            const dynamic = category.getAttribute('custom');
            if (dynamic) {
                if (!flyoutReady || !['VARIABLE', 'PROCEDURE'].includes(dynamic)) dynamicMissing = true;
                // 動態分類的 XML 沒有 block 節點，只取編輯器已呈現的積木。
                flyoutBlocks.filter(block =>
                    (dynamic === 'VARIABLE' && ['data', 'data_lists'].includes(block.category)) ||
                    (dynamic === 'PROCEDURE' && block.category === 'procedures')).forEach(block => {
                    available.set(`${categoryName}:${block.opcode}`, {...block, category: categoryName});
                });
            }
        });
        result.availableCategories = Array.from(categories).slice(0, 24);
        if (available.size) {
            result.availableBlocks = Array.from(available.values()).slice(0, 120);
            result.availableOmitted = Math.max(0, available.size - result.availableBlocks.length);
            result.availableStatus = result.availableOmitted || dynamicMissing ? 'partial' : 'complete';
        }
    } catch (e) {
        result.availableStatus = 'unavailable';
        result.availableBlocks = [];
    }
    return result;
};
module.exports = {readTutorEditor};
