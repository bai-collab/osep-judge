// 連線資料屬於本次頁面，不屬於會被卸載／重建的題目面板。
// 模組記憶體會在整頁重新載入時消失；不接觸任何瀏覽器儲存或後端保存。
/* eslint-disable import/no-commonjs */
const {useEffect, useState} = require('react');

let connection = {apiKey: '', mode: 'mock'};
const listeners = new Set();
const update = change => {
    const next = {...connection, ...change};
    if (next.apiKey === connection.apiKey && next.mode === connection.mode) return;
    connection = next;
    listeners.forEach(listener => listener(connection));
};
const setApiKey = apiKey => {
    if (typeof apiKey === 'string') update({apiKey});
};
const setMode = mode => {
    if (mode === 'mock' || mode === 'live') update({mode});
};

const useTutorConnection = () => {
    const [current, setCurrent] = useState(() => connection);
    useEffect(() => {
        listeners.add(setCurrent);
        // 補上 render 與 effect 之間可能發生的輸入，避免回到舊狀態。
        setCurrent(connection);
        return () => listeners.delete(setCurrent);
    }, []);
    return {...current, setApiKey, setMode};
};

module.exports = {useTutorConnection};
