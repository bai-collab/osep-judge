/**
 * @fileoverview
 * osep-judge: TurboWarp 擴充功能庫（extensions.turbowarp.org）幾乎只有 zh-cn 翻譯、沒有 zh-tw。
 * 這裡在缺少 zh-tw 時，把 zh-cn 用 OpenCC（簡體→臺灣正體＋臺灣慣用詞，如 鼠标→滑鼠）即時轉成繁中。
 * 涵蓋兩處：擴充功能庫卡片的名稱／說明，以及擴充功能積木本身的文字（Scratch.translate）。
 */

// webpack 4 不支援 package.json 的 exports 子路徑，直接指向 cn2t（只含簡→繁字典）的建置檔
import * as OpenCC from 'opencc-js/dist/umd/cn2t.js';

let converter = null;
const toTraditional = text => {
    if (!converter) {
        converter = OpenCC.Converter({from: 'cn', to: 'twp'});
    }
    return converter(text);
};

/**
 * 擴充功能庫卡片用：優先取原本的 zh-tw，沒有就把 zh-cn 轉繁中。
 * @param {object} translations locale → 字串
 * @returns {?string} zh-tw 字串，兩種都沒有時為 null
 */
const getZhTwFromTranslations = translations => {
    if (translations['zh-tw']) return translations['zh-tw'];
    if (translations['zh-cn']) return toTraditional(translations['zh-cn']);
    return null;
};

/**
 * Scratch.translate.setup() 的翻譯表：用 zh-cn 轉出的繁中補齊 zh-tw，原本就有的 zh-tw 優先。
 * @param {object} translations locale → {id: 字串}
 * @returns {object} 補齊 zh-tw 後的翻譯表
 */
const fillZhTwFromZhCn = translations => {
    const zhCn = translations && translations['zh-cn'];
    if (!zhCn) return translations;
    const converted = {};
    for (const id of Object.keys(zhCn)) {
        converted[id] = toTraditional(zhCn[id]);
    }
    return {
        ...translations,
        'zh-tw': {
            ...converted,
            ...translations['zh-tw']
        }
    };
};

/**
 * 掛在 vm 的 CREATE_UNSANDBOXED_EXTENSION_API 事件上：每個擴充功能載入前，
 * 包一層它的 Scratch.translate.setup，讓擴充功能呼叫 setup 時自動補上 zh-tw。
 * @param {object} Scratch 這個擴充功能專屬的 global.Scratch 物件
 */
const patchScratchTranslate = Scratch => {
    const translate = Scratch.translate;
    if (!translate || typeof translate.setup !== 'function') return;
    const originalSetup = translate.setup;
    translate.setup = newTranslations => originalSetup(
        newTranslations ? fillZhTwFromZhCn(newTranslations) : newTranslations
    );
};

export {
    getZhTwFromTranslations,
    fillZhTwFromZhCn,
    patchScratchTranslate
};
