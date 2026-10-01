// 模型只能提出快照內的積木 id／opcode；不能提供 DOM 選擇器或樣式。
/* eslint-disable import/no-commonjs */
const HIGHLIGHT_ATTRIBUTE = 'data-osep-tutor-highlight';
// 同一種類可能有多個變數／函式；名稱也必須與快照一致，不能任選第一個。
const matchesMenuTarget = (block, target) => block.type === target.opcode && !block.isShadow() &&
    (!target.label || block.toString().slice(0, 160) === target.label);
const groundRelatedBlocks = (candidates, editor = {}) => {
    const rendered = Array.isArray(editor.renderedBlocks) ? editor.renderedBlocks : [];
    const available = Array.isArray(editor.availableBlocks) ? editor.availableBlocks : [];
    const seen = new Set();
    const targets = [];
    for (const candidate of (Array.isArray(candidates) ? candidates : []).slice(0, 3)) {
        if (!candidate || typeof candidate !== 'object') continue;
        let target;
        if (typeof candidate.id === 'string' && candidate.id) {
            const block = rendered.find(b => b.id === candidate.id &&
                (!candidate.opcode || candidate.opcode === b.opcode));
            if (block) target = {kind: 'workspace', id: block.id, opcode: block.opcode, label: block.label};
        } else if (typeof candidate.opcode === 'string') {
            const block = available.find(b => b.opcode === candidate.opcode);
            if (block) target = {kind: 'toolbox', opcode: block.opcode, category: block.category, label: block.label};
        }
        if (!target) continue;
        const key = `${target.kind}:${target.id || target.opcode}`;
        if (!seen.has(key)) {
            seen.add(key);
            targets.push(target);
        }
    }
    return targets;
};

// 與 Blockly 自己的選取／執行高亮分開；不改積木、連線、顏色或執行狀態。
const createTutorBlockHighlight = (scratchBlocks, onUpdate = () => {}) => {
    let targets = [];
    let marked = [];
    let listeners = [];
    let disposed = false;
    let refresh = null;
    const unmark = () => {
        marked.forEach(({root, previous}) => {
            if (previous === null) root.removeAttribute(HIGHLIGHT_ATTRIBUTE);
            else root.setAttribute(HIGHLIGHT_ATTRIBUTE, previous);
        });
        marked = [];
    };
    const detach = () => {
        listeners.forEach(workspace => workspace.removeChangeListener(refresh));
        listeners = [];
    };
    refresh = () => {
        if (disposed) return;
        unmark();
        const counts = {canvas: 0, toolbox: 0, missing: targets.length};
        try {
            const workspace = scratchBlocks && scratchBlocks.getMainWorkspace();
            if (!workspace || !targets.length) return;
            const flyout = workspace.getFlyout();
            const flyoutWorkspace = flyout && flyout.getWorkspace();
            const current = [workspace, flyoutWorkspace].filter(w => w &&
                typeof w.addChangeListener === 'function' && typeof w.removeChangeListener === 'function');
            if (current.length !== listeners.length || current.some((w, i) => w !== listeners[i])) {
                detach();
                listeners = current;
                listeners.forEach(w => w.addChangeListener(refresh));
            }
            const canvas = workspace.getAllBlocks(false);
            const menu = flyoutWorkspace ? flyoutWorkspace.getAllBlocks(false) : [];
            targets.forEach(target => {
                const block = target.kind === 'workspace' ?
                    canvas.find(b => b.id === target.id && b.type === target.opcode) :
                    menu.find(b => matchesMenuTarget(b, target));
                if (!block || block.isShadow() || (block.isInsertionMarker && block.isInsertionMarker())) return;
                const root = block.getSvgRoot();
                if (!root || marked.some(entry => entry.root === root)) return;
                marked.push({root, previous: root.getAttribute(HIGHLIGHT_ATTRIBUTE)});
                root.setAttribute(HIGHLIGHT_ATTRIBUTE, 'true');
                counts[target.kind === 'workspace' ? 'canvas' : 'toolbox']++;
                counts.missing--;
            });
        } catch (e) {
            // 工作區正被重建或已卸載：保留未找到的文字狀態，不指向其他積木。
        } finally {
            onUpdate(counts);
        }
    };
    const clear = () => {
        targets = [];
        unmark();
        detach();
        if (!disposed) onUpdate(null);
    };
    return {
        show: (next, locate = true) => {
            if (disposed) return;
            targets = Array.isArray(next) ? next.slice(0, 3) : [];
            refresh();
            if (!locate) return;
            // 定位只捲動視圖；不選取、拖入或執行積木。
            try {
                const workspace = scratchBlocks && scratchBlocks.getMainWorkspace();
                const target = targets.find(t => t.kind === 'toolbox');
                const flyout = workspace && workspace.getFlyout();
                const block = target && flyout && flyout.getWorkspace().getAllBlocks(false)
                    .find(b => matchesMenuTarget(b, target));
                if (block && typeof flyout.scrollTo === 'function') {
                    const position = block.getRelativeToSurfaceXY();
                    flyout.scrollTo(Math.max(0, (flyout.horizontalLayout_ ? position.x : position.y) - 16));
                }
            } catch (e) {
                // 不支援定位的編輯器仍可看粗邊與文字名稱。
            }
        },
        clear,
        dispose: () => {
            disposed = true;
            clear();
        }
    };
};

module.exports = {groundRelatedBlocks, createTutorBlockHighlight, HIGHLIGHT_ATTRIBUTE};
