// Bridge to the desktop client (Electron preload exposes window.liroNative).
// In a plain browser (page served by the Liro server itself) boards, media and local assets are kept in
// IndexedDB, so the browser version also has local boards and caching.
import { idbBridge } from './idb.js';

const SETTINGS_KEY = 'liro.settings';

const browserBridge = {
  isNative: false,
  async discover() {
    return [];
  },
  async getSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch {
      return {};
    }
  },
  async setSettings(s) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch {}
  },
  cache: globalThis.indexedDB ? idbBridge.cache : null,
  media: globalThis.indexedDB ? idbBridge.media : null,
  assets: globalThis.indexedDB ? idbBridge.assets : null,
};

export const native = globalThis.liroNative || browserBridge;
