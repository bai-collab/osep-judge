// 連線資料屬於本次頁面，不屬於會被卸載／重建的題目面板。
// 模組記憶體會在整頁重新載入時消失；不接觸任何瀏覽器儲存或後端保存。
/* eslint-disable import/no-commonjs */
const {useEffect, useState} = require('react');

let connection = {
    apiKey: '',
    mode: 'mock',
    managed: true,
    aiConfigured: false,
    statusReady: false
};
const listeners = new Set();
let statusRequest = null;
const update = change => {
    const next = {...connection, ...change};
    if (Object.keys(next).every(key => next[key] === connection[key])) return;
    connection = next;
    listeners.forEach(listener => listener(connection));
};
const setApiKey = apiKey => {
    if (typeof apiKey === 'string') update({apiKey});
};
const setMode = mode => {
    if (mode === 'mock' || mode === 'live') update({mode});
};

// 由導師服務本身提供的 http: 頁面（本機 127.0.0.1 或教師機區網位址）才呼叫 API；
// 一律使用相對路徑 ./api/...，請求只會回到提供此頁的同一來源。GitHub Pages（https:）與 file: 不呼叫。
const isTutorServicePage = () => typeof window !== 'undefined' && Boolean(window.location) &&
    window.location.protocol === 'http:' && Boolean(window.location.hostname);

const refreshStatus = () => {
    if (!isTutorServicePage()) {
        update({managed: true, aiConfigured: false, statusReady: true});
        return Promise.resolve(connection);
    }
    if (statusRequest) return statusRequest;
    statusRequest = fetch('./api/tutor/status')
        .then(response => {
            if (!response.ok) throw new Error('STATUS_UNAVAILABLE');
            return response.json();
        })
        .then(status => {
            if (typeof status.managed !== 'boolean') throw new Error('INVALID_STATUS');
            update({
                managed: status.managed,
                aiConfigured: status.aiConfigured === true,
                statusReady: true,
                ...(status.managed ? {
                    apiKey: ''
                } : {})
            });
            return connection;
        })
        .catch(() => {
            // 服務尚未啟動時保留安全的教師管理畫面，不顯示或要求學生輸入金鑰。
            update({managed: true, aiConfigured: false, statusReady: true});
            return connection;
        })
        .finally(() => {
            statusRequest = null;
        });
    return statusRequest;
};

const useTutorConnection = () => {
    const [current, setCurrent] = useState(() => connection);
    useEffect(() => {
        listeners.add(setCurrent);
        // 補上 render 與 effect 之間可能發生的輸入，避免回到舊狀態。
        setCurrent(connection);
        return () => listeners.delete(setCurrent);
    }, []);
    useEffect(() => {
        refreshStatus();
    }, []);
    return {...current, setApiKey, setMode, refreshStatus};
};

module.exports = {useTutorConnection, isTutorServicePage};
