/**
 * Feeds-page settings — independent of main extension news config.
 * Sync localStorage read for instant paint; mirror to chrome.storage optional.
 */

const KEY = 'candy_feed_reader_settings';

export const AGE_OPTIONS = [
  { value: 1, label: '24 hours' },
  { value: 3, label: '3 days' },
  { value: 7, label: '7 days' },
  { value: 21, label: '21 days' },
  { value: 30, label: '30 days' },
];

/** Floor 15 min so we don't hammer feed servers */
export const REFRESH_OPTIONS = [
  { value: 15, label: '15 min (min)' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 hour' },
  { value: 120, label: '2 hours' },
  { value: 360, label: '6 hours' },
];

export function createDefaultFeedSettings() {
  return {
    version: 1,
    /** All-feeds grid columns: 4–8 */
    columns: 5,
    /** Max stories cached/pulled per source: 1–100 */
    maxItemsPerFeed: 50,
    /** Global refresh interval (minutes), floor 15 */
    refreshMinutes: 30,
    /** Max article age in days — also prunes cache */
    maxAgeDays: 7,
    /** Hours considered "new" for keyword pin default */
    pinNewWindowHours: 24,
    /** After subscribe, only surface this many latest in mixed view */
    newSubSurfaceLimit: 6,
    /** Collapse same URL across feeds */
    dedupeByUrl: true,
    /** Blocklist: { id, text } — case-insensitive hide from feed views */
    blocklist: [],
    /** Keywords: { id, text, alwaysPin } */
    keywords: [],
  };
}

let _settings = null;

export function loadFeedSettingsSync() {
  const defaults = createDefaultFeedSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      localStorage.setItem(KEY, JSON.stringify(defaults));
      return { ...defaults };
    }
    const parsed = JSON.parse(raw);
    return {
      ...defaults,
      ...parsed,
      columns: clamp(Number(parsed.columns) || defaults.columns, 4, 8),
      maxItemsPerFeed: clamp(Number(parsed.maxItemsPerFeed) || defaults.maxItemsPerFeed, 1, 100),
      refreshMinutes: Math.max(15, Number(parsed.refreshMinutes) || defaults.refreshMinutes),
      maxAgeDays: [1, 3, 7, 21, 30].includes(Number(parsed.maxAgeDays))
        ? Number(parsed.maxAgeDays)
        : defaults.maxAgeDays,
      blocklist: Array.isArray(parsed.blocklist) ? parsed.blocklist : [],
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
    };
  } catch {
    return defaults;
  }
}

export function getFeedSettings() {
  if (!_settings) _settings = loadFeedSettingsSync();
  return _settings;
}

export function saveFeedSettings(next) {
  _settings = {
    ...createDefaultFeedSettings(),
    ...next,
    columns: clamp(Number(next.columns) || 5, 4, 8),
    maxItemsPerFeed: clamp(Number(next.maxItemsPerFeed) || 50, 1, 100),
    refreshMinutes: Math.max(15, Number(next.refreshMinutes) || 30),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(_settings));
  } catch (e) {
    console.warn('[candy] feed settings save failed', e);
  }
  return _settings;
}

export function updateFeedSettings(patcher) {
  const cur = getFeedSettings();
  const next = typeof patcher === 'function' ? patcher(cur) : { ...cur, ...patcher };
  return saveFeedSettings(next);
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function maxAgeMs(settings = getFeedSettings()) {
  return (settings.maxAgeDays || 7) * 24 * 60 * 60 * 1000;
}

export function pinNewWindowMs(settings = getFeedSettings()) {
  return (settings.pinNewWindowHours || 24) * 60 * 60 * 1000;
}
