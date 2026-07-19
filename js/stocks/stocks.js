/**
 * Stocks engine — cache-first quotes, market-hours aware background refresh.
 * Never hits the network on the render path.
 */

import { getConfig, updateConfig } from '../config.js';
import { kvGet, kvSet } from '../storage/idb.js';
import {
  fetchQuote,
  validateSymbol,
  normalizeSymbol,
  isCryptoSymbol,
  classifyAsset,
} from './providers.js';

const CACHE_KEY = 'stocks_cache';
const META_KEY = 'stocks_meta'; // last errors, per-symbol provider

const listeners = new Set();

/** Market-hours poll (ms) — equities during session */
const INTERVAL_MARKET_MS = 12 * 60_000; // 12 min within 10–15
/** Off-hours equities */
const INTERVAL_OFF_MS = 210 * 60_000; // 3.5h within 180–240
/** Crypto always on the faster cadence */
const INTERVAL_CRYPTO_MS = 12 * 60_000;
/** Stooq is delayed + quota-sensitive — never poll it as aggressively */
const INTERVAL_STOOQ_MS = 180 * 60_000;

export function onStocksUpdate(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(cache) {
  for (const fn of listeners) {
    try {
      fn(cache);
    } catch (e) {
      console.warn(e);
    }
  }
}

/**
 * Cache shape (atomic blob):
 * {
 *   quotes: { [symbol]: QuoteResult & { stale?: boolean, preferredProvider?: string } },
 *   updatedAt: number
 * }
 */
export async function getStocksCache() {
  const cache = await kvGet(CACHE_KEY);
  return cache || { quotes: {}, updatedAt: null };
}

export async function setStocksCache(cache) {
  const blob = {
    quotes: cache.quotes || {},
    updatedAt: cache.updatedAt ?? Date.now(),
  };
  await kvSet(CACHE_KEY, blob);
  emit(blob);
  return blob;
}

export async function getStocksMeta() {
  return (
    (await kvGet(META_KEY)) || {
      lastError: null,
      lastErrorAt: null,
      lastErrorStatus: null,
      perSymbol: {}, // symbol → { provider, error, updatedAt }
    }
  );
}

async function setStocksMeta(meta) {
  await kvSet(META_KEY, meta);
}

/** US equity session 9:30–16:00 America/New_York, Mon–Fri */
export function isUsMarketOpen(now = new Date()) {
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
    // hour12:false can still yield 24 for midnight in some engines
    if (hour === 24) hour = 0;
    const mins = hour * 60 + minute;
    const open = 9 * 60 + 30;
    const close = 16 * 60;
    return mins >= open && mins < close;
  } catch {
    // Fail open to market interval rather than hammering
    return true;
  }
}

function intervalForSymbol(symbol, preferredProvider) {
  if (isCryptoSymbol(symbol)) return INTERVAL_CRYPTO_MS;
  if (preferredProvider === 'stooq') return INTERVAL_STOOQ_MS;
  return isUsMarketOpen() ? INTERVAL_MARKET_MS : INTERVAL_OFF_MS;
}

/**
 * Read-only for paint — never network.
 */
export async function getStocksForRender() {
  return getStocksCache();
}

/**
 * Background refresh of the watchlist. Staggered per symbol.
 * @param {{ force?: boolean }} [opts]
 */
export async function refreshStocksInBackground({ force = false } = {}) {
  const cfg = getConfig();
  const symbols = (cfg.stocks?.symbols || []).map(normalizeSymbol).filter(Boolean);
  if (!symbols.length) {
    return getStocksCache();
  }

  const cache = await getStocksCache();
  const meta = await getStocksMeta();
  const quotes = { ...(cache.quotes || {}) };
  let anyOk = false;
  let lastError = meta.lastError;
  let lastErrorStatus = meta.lastErrorStatus;
  let lastErrorAt = meta.lastErrorAt;

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const existing = quotes[sym];
    const preferred =
      meta.perSymbol?.[sym]?.provider || existing?.provider || 'yahoo';

    if (!force && existing?.updatedAt) {
      const age = Date.now() - existing.updatedAt;
      const maxAge = intervalForSymbol(sym, preferred);
      if (age < maxAge) continue;
    }

    // Stagger between requests (except first)
    if (i > 0) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(350 + Math.floor(Math.random() * 250));
    }

    // eslint-disable-next-line no-await-in-loop
    const { quote, error, status } = await fetchQuote(sym, {
      preferredProvider: preferred,
    });

    if (quote) {
      anyOk = true;
      quotes[sym] = {
        ...quote,
        symbol: sym,
        stale: false,
      };
      meta.perSymbol = {
        ...meta.perSymbol,
        [sym]: {
          provider: quote.provider,
          error: null,
          updatedAt: quote.updatedAt,
        },
      };
    } else {
      // Keep last good quote; mark stale for diagnostics only
      if (existing) {
        quotes[sym] = { ...existing, stale: true };
      }
      lastError = error || `Failed ${sym}`;
      lastErrorStatus = status ?? null;
      lastErrorAt = Date.now();
      meta.perSymbol = {
        ...meta.perSymbol,
        [sym]: {
          provider: preferred,
          error: lastError,
          updatedAt: Date.now(),
        },
      };
    }
  }

  meta.lastError = lastError;
  meta.lastErrorStatus = lastErrorStatus;
  meta.lastErrorAt = lastErrorAt;
  await setStocksMeta(meta);

  if (anyOk || force) {
    // Atomic write of full quote map + timestamp together
    return setStocksCache({
      quotes,
      updatedAt: Date.now(),
    });
  }

  return cache;
}

export async function addSymbol(raw) {
  const sym = normalizeSymbol(raw);
  if (!sym) return { ok: false, error: 'Enter a symbol' };

  const cfg = getConfig();
  const list = (cfg.stocks?.symbols || []).map(normalizeSymbol);
  if (list.includes(sym)) return { ok: false, error: 'Already on watchlist' };
  if (list.length >= 20) return { ok: false, error: 'Watchlist limit (20)' };

  const validated = await validateSymbol(sym);
  if (!validated.ok) return validated;

  updateConfig((c) => ({
    ...c,
    stocks: {
      ...c.stocks,
      symbols: [...(c.stocks?.symbols || []).map(normalizeSymbol), sym],
    },
  }));

  // Seed cache with the validation quote (atomic merge)
  const cache = await getStocksCache();
  const quotes = {
    ...(cache.quotes || {}),
    [sym]: { ...validated.quote, symbol: sym, stale: false },
  };
  await setStocksCache({ quotes, updatedAt: Date.now() });

  const meta = await getStocksMeta();
  meta.perSymbol = {
    ...meta.perSymbol,
    [sym]: {
      provider: validated.quote.provider,
      error: null,
      updatedAt: validated.quote.updatedAt,
    },
  };
  await setStocksMeta(meta);

  try {
    chrome.runtime?.sendMessage?.({ type: 'stocks:set-alarm' });
  } catch {
    /* ignore */
  }

  return { ok: true, quote: validated.quote };
}

export async function removeSymbol(raw) {
  const sym = normalizeSymbol(raw);
  updateConfig((c) => ({
    ...c,
    stocks: {
      ...c.stocks,
      symbols: (c.stocks?.symbols || [])
        .map(normalizeSymbol)
        .filter((s) => s !== sym),
    },
  }));

  const cache = await getStocksCache();
  const quotes = { ...(cache.quotes || {}) };
  delete quotes[sym];
  await setStocksCache({ quotes, updatedAt: Date.now() });
  return { ok: true };
}

export function reorderSymbols(fromId, toId) {
  const from = normalizeSymbol(fromId);
  const to = normalizeSymbol(toId);
  updateConfig((c) => {
    const items = [...(c.stocks?.symbols || []).map(normalizeSymbol)];
    const fi = items.indexOf(from);
    const ti = items.indexOf(to);
    if (fi < 0 || ti < 0) return c;
    const [moved] = items.splice(fi, 1);
    items.splice(ti, 0, moved);
    return { ...c, stocks: { ...c.stocks, symbols: items } };
  });
}

export function formatPrice(n, currency = 'USD') {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: digits,
    }).format(v);
  } catch {
    return `$${v.toFixed(2)}`;
  }
}

export function formatChange(change, changePercent) {
  if (changePercent == null && change == null) return { text: '—', dir: 'flat' };
  const pct = changePercent != null ? Number(changePercent) : null;
  const dir = pct > 0.005 ? 'up' : pct < -0.005 ? 'down' : 'flat';
  const sign = pct > 0 ? '+' : '';
  const text =
    pct != null ? `${sign}${pct.toFixed(2)}%` : change != null ? String(change) : '—';
  return { text, dir };
}

/** Inline SVG sparkline from cached history */
export function sparklineSvg(history, { up = true, width = 64, height = 22 } = {}) {
  const pts = (history || []).filter((n) => Number.isFinite(Number(n))).map(Number);
  if (pts.length < 2) {
    return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"></svg>`;
  }
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const pad = 1;
  const coords = pts.map((v, i) => {
    const x = pad + (i / (pts.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const color = up ? '#4ade80' : '#ff6b6b';
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"><polyline fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" points="${coords.join(' ')}"/></svg>`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Re-export helpers used by UI
export { normalizeSymbol, classifyAsset, isCryptoSymbol };
