/**
 * Synchronous configuration loading from localStorage.
 * Block-one of execution — no async, no flicker.
 */

export const STORAGE_KEYS = {
  config: 'candy_config',
  weather: 'candy_weather_meta', // lightweight pointer; full data in IDB
};

/** Default topics catalog */
export const DEFAULT_TOPICS = [
  { id: 'popular', label: 'Popular Today', query: 'top stories', following: true },
  { id: 'science', label: 'Science', query: 'science', following: true },
  { id: 'photojournalism', label: 'Photojournalism', query: 'photojournalism photography', following: true },
  { id: 'worldcup2026', label: 'World Cup 2026', query: 'World Cup 2026', following: true },
  { id: 'politics', label: 'Politics', query: 'politics', following: true },
  { id: 'explained', label: 'Explained', query: 'explained analysis', following: true },
  { id: 'music', label: 'Music', query: 'music', following: false },
  { id: 'mlb', label: 'MLB', query: 'MLB baseball', following: false },
  { id: 'tech', label: 'Technology', query: 'technology', following: false },
  { id: 'sports', label: 'Sports', query: 'sports', following: false },
];

export const DEFAULT_SHORTCUTS = [
  { id: 'sc-chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com' },
  { id: 'sc-youtube', name: 'YouTube', url: 'https://www.youtube.com' },
  { id: 'sc-twitch', name: 'Twitch', url: 'https://www.twitch.tv' },
  { id: 'sc-github', name: 'GitHub', url: 'https://github.com' },
  { id: 'sc-reddit', name: 'Reddit', url: 'https://www.reddit.com' },
  { id: 'sc-gmail', name: 'Gmail', url: 'https://mail.google.com' },
];

/** Detect OS locale preference for temperature units */
function detectTempUnit() {
  try {
    const locale = navigator.language || 'en-US';
    // US, Liberia, Myanmar typically use Fahrenheit
    const fahrenheitLocales = ['en-US', 'en-LR', 'en-MM', 'es-US'];
    if (fahrenheitLocales.some((l) => locale.startsWith(l) || locale === l)) {
      return 'f';
    }
    // Broad US check
    if (locale === 'en-US' || (locale.startsWith('en') && navigator.language.includes('US'))) {
      return 'f';
    }
    return 'c';
  } catch {
    return 'f';
  }
}

function detectWindUnit() {
  return detectTempUnit() === 'f' ? 'mph' : 'kmh';
}

export function createDefaultConfig() {
  return {
    version: 1,
    wallpaper: {
      type: 'solid', // solid | abstract | image | custom
      value: '#1c1b22',
      customDataUrl: null,
    },
    shortcuts: {
      enabled: true,
      rows: 1,
      perRow: 12,
      items: DEFAULT_SHORTCUTS.map((s) => ({ ...s })),
    },
    content: {
      enabled: true,
    },
    topics: DEFAULT_TOPICS.map((t) => ({ ...t })),
    weather: {
      tempUnit: detectTempUnit(), // f | c
      windUnit: detectWindUnit(), // mph | kmh | ms | kn
      pressureUnit: 'hpa', // hpa | inhg | mmhg
      clock24h: false,
      locationMode: 'geo', // geo | manual
      locations: [],
      activeLocationId: null,
      refreshMinutes: 15, // floor 10
      manualLat: null,
      manualLon: null,
      manualName: null,
    },
    stocks: {
      enabled: true,
      // Watchlist order is the display order (drag-reorder in the widget)
      symbols: ['SPY', 'AAPL', 'BTC-USD'],
    },
    news: {
      ttlMinutes: 25,
      pageSize: 12,
    },
    weatherCacheTtlMinutes: 10,
  };
}

/**
 * Read config synchronously from localStorage.
 * Merges with defaults for forward-compat.
 */
export function loadConfigSync() {
  const defaults = createDefaultConfig();
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.config);
    if (!raw) {
      localStorage.setItem(STORAGE_KEYS.config, JSON.stringify(defaults));
      return defaults;
    }
    const parsed = JSON.parse(raw);
    return deepMerge(defaults, parsed);
  } catch {
    return defaults;
  }
}

export function saveConfigSync(config) {
  try {
    localStorage.setItem(STORAGE_KEYS.config, JSON.stringify(config));
  } catch (e) {
    console.warn('[candy] config save failed', e);
  }
  // Mirror for service worker (no localStorage in SW)
  try {
    chrome?.storage?.local?.set?.({ candy_config_mirror: config });
  } catch {
    /* ignore outside extension context */
  }
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const key of Object.keys(override)) {
    const bv = base[key];
    const ov = override[key];
    if (
      ov &&
      typeof ov === 'object' &&
      !Array.isArray(ov) &&
      bv &&
      typeof bv === 'object' &&
      !Array.isArray(bv)
    ) {
      out[key] = deepMerge(bv, ov);
    } else if (ov !== undefined) {
      out[key] = ov;
    }
  }
  return out;
}

/** Mutable runtime config singleton — mutated in place, saved via saveConfigSync */
let _config = null;

export function getConfig() {
  if (!_config) _config = loadConfigSync();
  return _config;
}

export function setConfig(next) {
  _config = next;
  saveConfigSync(_config);
  return _config;
}

export function updateConfig(patcher) {
  const cfg = getConfig();
  const next = typeof patcher === 'function' ? patcher(cfg) : { ...cfg, ...patcher };
  return setConfig(next);
}
