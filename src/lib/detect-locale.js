/**
 * @fileoverview
 * Utility function to detect locale from the browser setting or paramenter on the URL.
 */

import queryString from 'query-string';

// tw: read language from localStorage
export const LANGUAGE_KEY = 'tw:language';

/**
 * look for language setting in the browser. Check against supported locales.
 * If there's a parameter in the URL, override the browser setting
 * @param {Array.string} supportedLocales An array of supported locale codes.
 * @return {string} the preferred locale
 */
const detectLocale = supportedLocales => {
    // tw: read language from localStorage
    try {
        const storedLanguage = localStorage.getItem(LANGUAGE_KEY);
        if (storedLanguage && supportedLocales.includes(storedLanguage)) {
            return storedLanguage;
        }
    } catch (e) { /* ignore */ }

    // osep-judge: 預設一律繁體中文，不跟瀏覽器語言；使用者仍可從語言選單或 ?locale= 切換
    const locale = supportedLocales.includes('zh-tw') ? 'zh-tw' : 'en';

    const queryParams = queryString.parse(location.search);
    // Flatten potential arrays and remove falsy values
    const potentialLocales = [].concat(queryParams.locale, queryParams.lang).filter(l => l);
    if (!potentialLocales.length) {
        return locale;
    }

    const urlLocale = potentialLocales[0].toLowerCase();
    if (supportedLocales.includes(urlLocale)) {
        return urlLocale;
    }

    return locale;
};

export {
    detectLocale
};
