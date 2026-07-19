/**
 * Background service worker — weather + stocks alarms.
 * Never fabricates data; failed fetches leave cache untouched.
 */

import { fetchWeather } from '../js/weather/providers.js';
import { fetchQuote, normalizeSymbol, isCryptoSymbol } from '../js/stocks/providers.js';

const WEATHER_ALARM = 'candy-weather-refresh';
const STOCKS_ALARM = 'candy-stocks-refresh';
const DEFAULT_WEATHER_MINUTES = 15;
const MIN_WEATHER_MINUTES = 10;
/** Tick every 5 min; per-symbol cadence is enforced inside the handler */
const STOCKS_TICK_MINUTES = 5;
const INTERVAL_MARKET_MS = 12 * 60_000;
const INTERVAL_OFF_MS = 210 * 60_000;
const INTERVAL_CRYPTO_MS = 12 * 60_000;
const INTERVAL_STOOQ_MS = 180 * 60_000;

// Mirror minimal IDB access in SW (same DB)
const DB_NAME = 'candy_db';
const DB_VERSION = 2;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('weather')) {
        db.createObjectStore('weather', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('articles')) {
        const articles = db.createObjectStore('articles', { keyPath: 'id' });
        articles.createIndex('by_category', 'categoryId', { unique: false });
      }
      if (!db.objectStoreNames.contains('category_meta')) {
        db.createObjectStore('category_meta', { keyPath: 'categoryId' });
      }
      if (!db.objectStoreNames.contains('favicons')) {
        db.createObjectStore('favicons', { keyPath: 'host' });
      }
      if (!db.objectStoreNames.contains('feed_subscriptions')) {
        const subs = db.createObjectStore('feed_subscriptions', { keyPath: 'id' });
        subs.createIndex('by_url', 'url', { unique: true });
      }
      if (!db.objectStoreNames.contains('feed_items')) {
        const items = db.createObjectStore('feed_items', { keyPath: 'id' });
        items.createIndex('by_feed', 'feedId', { unique: false });
        items.createIndex('by_guid', 'guid', { unique: false });
        items.createIndex('by_published', 'publishedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('feed_meta')) {
        db.createObjectStore('feed_meta', { keyPath: 'feedId' });
      }
    };
  });
}

async function idbGet(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readonly');
    const req = t.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(storeName, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readwrite');
    t.objectStore(storeName).put(value);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

function readConfigFromLocalStorageUnavailable() {
  // Service workers can't access localStorage. Use chrome.storage if we sync,
  // or read last-known coords from weather cache + chrome.storage.local mirror.
  return null;
}

/**
 * Mirror config bits into chrome.storage.local so SW can read them.
 */
const ALLOWED_CHROME_URLS = new Set([
  'chrome://settings',
  'chrome://extensions',
  'chrome://bookmarks',
  'chrome://history',
  'chrome://downloads',
]);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'open:chrome-url') {
    const url = msg.url;
    if (!ALLOWED_CHROME_URLS.has(url)) {
      sendResponse({ ok: false, error: 'url not allowed' });
      return false;
    }
    chrome.tabs
      .create({ url })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true; // async
  }
  if (msg?.type === 'weather:set-alarm') {
    scheduleWeatherAlarm(msg.minutes);
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'stocks:set-alarm') {
    scheduleStocksAlarm();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'weather:updated') {
    idbPut('kv', {
      key: 'weather_last_provider',
      value: msg.provider,
    }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'newtab:ready') {
    ensureAlarms();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'config:sync') {
    chrome.storage.local.set({ candy_config_mirror: msg.config }).then(() => {
      scheduleWeatherAlarm(msg.config?.weather?.refreshMinutes);
      scheduleStocksAlarm();
      sendResponse({ ok: true });
    });
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
});

async function ensureAlarms() {
  let minutes = DEFAULT_WEATHER_MINUTES;
  try {
    const stored = await chrome.storage.local.get('candy_config_mirror');
    const m = stored?.candy_config_mirror?.weather?.refreshMinutes;
    if (m) minutes = Math.max(MIN_WEATHER_MINUTES, Number(m) || DEFAULT_WEATHER_MINUTES);
  } catch {
    /* ignore */
  }
  scheduleWeatherAlarm(minutes);
  scheduleStocksAlarm();
}

function scheduleWeatherAlarm(minutes) {
  const period = Math.max(MIN_WEATHER_MINUTES, Number(minutes) || DEFAULT_WEATHER_MINUTES);
  chrome.alarms.create(WEATHER_ALARM, {
    periodInMinutes: period,
    delayInMinutes: 1,
  });
}

function scheduleStocksAlarm() {
  chrome.alarms.create(STOCKS_ALARM, {
    periodInMinutes: STOCKS_TICK_MINUTES,
    delayInMinutes: 1,
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === WEATHER_ALARM) {
    await backgroundWeatherRefresh();
    return;
  }
  if (alarm.name === STOCKS_ALARM) {
    await backgroundStocksRefresh();
  }
});

async function backgroundWeatherRefresh() {
  try {
    const cached = await idbGet('weather', 'current');
    let lat = cached?.lat;
    let lon = cached?.lon;
    let name = cached?.city;

    // Prefer mirrored manual coords
    try {
      const stored = await chrome.storage.local.get('candy_config_mirror');
      const w = stored?.candy_config_mirror?.weather;
      if (w?.locationMode === 'manual' && w.manualLat != null) {
        lat = w.manualLat;
        lon = w.manualLon;
        name = w.manualName || name;
      }
    } catch {
      /* ignore */
    }

    if (lat == null || lon == null) {
      // No coordinates yet — skip silently
      return;
    }

    const data = await fetchWeather(lat, lon, name);
    if (!data) {
      await idbPut('kv', {
        key: 'weather_last_error',
        value: new Date().toISOString(),
      });
      return;
    }

    await idbPut('weather', { id: 'current', ...data });
    await idbPut('kv', {
      key: 'weather_last_error',
      value: null,
    });
  } catch (e) {
    console.warn('[candy sw] weather refresh failed', e);
    try {
      await idbPut('kv', {
        key: 'weather_last_error',
        value: String(e?.message || e),
      });
    } catch {
      /* ignore */
    }
  }
}

// ── Stocks background refresh ─────────────────────────────

function isUsMarketOpen(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(now);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const weekday = get('weekday');
    if (['Sat', 'Sun'].includes(weekday)) return false;
    let hour = Number(get('hour'));
    const minute = Number(get('minute'));
    if (hour === 24) hour = 0;
    const mins = hour * 60 + minute;
    return mins >= 9 * 60 + 30 && mins < 16 * 60;
  } catch {
    return true;
  }
}

function intervalForSymbol(symbol, provider) {
  if (isCryptoSymbol(symbol)) return INTERVAL_CRYPTO_MS;
  if (provider === 'stooq') return INTERVAL_STOOQ_MS;
  return isUsMarketOpen() ? INTERVAL_MARKET_MS : INTERVAL_OFF_MS;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function backgroundStocksRefresh() {
  try {
    const stored = await chrome.storage.local.get('candy_config_mirror');
    const cfg = stored?.candy_config_mirror;
    if (cfg?.stocks?.enabled === false) return;

    const symbols = (cfg?.stocks?.symbols || [])
      .map((s) => normalizeSymbol(s))
      .filter(Boolean);
    if (!symbols.length) return;

    const cacheRow = await idbGet('kv', 'stocks_cache');
    const metaRow = await idbGet('kv', 'stocks_meta');
    const cache = cacheRow?.value || { quotes: {}, updatedAt: null };
    const meta = metaRow?.value || {
      lastError: null,
      lastErrorAt: null,
      lastErrorStatus: null,
      perSymbol: {},
    };
    const quotes = { ...(cache.quotes || {}) };
    let anyOk = false;

    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      const existing = quotes[sym];
      const preferred =
        meta.perSymbol?.[sym]?.provider || existing?.provider || 'yahoo';

      if (existing?.updatedAt) {
        const age = Date.now() - existing.updatedAt;
        if (age < intervalForSymbol(sym, preferred)) continue;
      }

      if (i > 0) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(400);
      }

      // eslint-disable-next-line no-await-in-loop
      const { quote, error, status } = await fetchQuote(sym, {
        preferredProvider: preferred,
      });

      if (quote) {
        anyOk = true;
        quotes[sym] = { ...quote, symbol: sym, stale: false };
        meta.perSymbol = {
          ...meta.perSymbol,
          [sym]: {
            provider: quote.provider,
            error: null,
            updatedAt: quote.updatedAt,
          },
        };
      } else {
        if (existing) quotes[sym] = { ...existing, stale: true };
        meta.lastError = error || `Failed ${sym}`;
        meta.lastErrorStatus = status ?? null;
        meta.lastErrorAt = Date.now();
        meta.perSymbol = {
          ...meta.perSymbol,
          [sym]: {
            provider: preferred,
            error: meta.lastError,
            updatedAt: Date.now(),
          },
        };
      }
    }

    await idbPut('kv', { key: 'stocks_meta', value: meta });
    if (anyOk) {
      await idbPut('kv', {
        key: 'stocks_cache',
        value: { quotes, updatedAt: Date.now() },
      });
    }
  } catch (e) {
    console.warn('[candy sw] stocks refresh failed', e);
    try {
      const metaRow = await idbGet('kv', 'stocks_meta');
      const meta = metaRow?.value || {};
      await idbPut('kv', {
        key: 'stocks_meta',
        value: {
          ...meta,
          lastError: String(e?.message || e),
          lastErrorAt: Date.now(),
        },
      });
    } catch {
      /* ignore */
    }
  }
}
