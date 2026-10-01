/* eslint-disable import/no-commonjs */
// 只處理尺寸與位置，讓浮窗始終留在工具列下方的可用範圍。
const limits = viewport => {
    const left = Math.min(12, Math.max(0, viewport.width / 2));
    const top = Math.min(56, Math.max(0, viewport.height - 1));
    return {
        left,
        top,
        width: Math.max(1, viewport.width - (left * 2)),
        height: Math.max(1, viewport.height - top - Math.min(12, viewport.height - top - 1))};
};

const clampTutorRect = (rect, viewport) => {
    const area = limits(viewport);
    const width = Math.max(Math.min(320, area.width), Math.min(rect.width, area.width));
    const height = Math.max(Math.min(500, area.height), Math.min(rect.height, area.height));
    return {
        width,
        height,
        x: Math.max(area.left, Math.min(rect.x, area.left + area.width - width)),
        y: Math.max(area.top, Math.min(rect.y, area.top + area.height - height))};
};

const initialTutorRect = viewport => clampTutorRect({
    x: (viewport.width - 460) / 2, y: 72, width: 460, height: 600
}, viewport);

const resizeTutorRect = (rect, dx, dy, viewport) => {
    const area = limits(viewport);
    // 縮放固定左上角，右下角不超出畫面；移動則由 clampTutorRect 夾限。
    return clampTutorRect({...rect,
        width: Math.min(rect.width + dx, area.left + area.width - rect.x),
        height: Math.min(rect.height + dy, area.top + area.height - rect.y)
    }, viewport);
};

module.exports = {clampTutorRect, initialTutorRect, resizeTutorRect};
