/**
 * Stock / ETF / crypto quote providers.
 * Primary: Yahoo Finance chart API (unofficial, no key).
 * Fallbacks: Stooq (equities) · CoinGecko (crypto).
 * Never fabricates prices — failures return null / throw.
 */

/** Rough crypto symbol → CoinGecko id map for common pairs */
const COINGECKO_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  DOGE: 'dogecoin',
  XRP: 'ripple',
  ADA: 'cardano',
  AVAX: 'avalanche-2',
  DOT: 'polkadot',
  MATIC: 'matic-network',
  LINK: 'chainlink',
  LTC: 'litecoin',
  BNB: 'binancecoin',
  UNI: 'uniswap',
  ATOM: 'cosmos',
  NEAR: 'near',
};

export function normalizeSymbol(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

/**
 * Classify ticker for market-hours gating and fallback routing.
 * Crypto pairs usually look like BTC-USD / ETH-USD.
 */
export function classifyAsset(symbol) {
  const s = normalizeSymbol(symbol);
  if (!s) return 'equity';
  if (s.includes('-') || s.endsWith('USD') && /^[A-Z]{2,6}(-USD)?$/.test(s)) {
    // BTC-USD, ETH-USD, or bare BTC when paired style
    const base = s.replace(/-USD$/, '').replace(/USD$/, '');
    if (COINGECKO_IDS[base] || s.includes('-')) return 'crypto';
  }
  if (s.startsWith('^')) return 'index';
  return 'equity';
}

export function isCryptoSymbol(symbol) {
  return classifyAsset(symbol) === 'crypto';
}

function baseCryptoId(symbol) {
  const s = normalizeSymbol(symbol);
  const base = s.replace(/-USD$/, '').replace(/USD$/, '');
  return COINGECKO_IDS[base] || null;
}

/**
 * @typedef {object} QuoteResult
 * @property {string} symbol
 * @property {number} price
 * @property {number|null} change
 * @property {number|null} changePercent
 * @property {number[]} history  // sparkline closes, oldest → newest
 * @property {string} currency
 * @property {string} provider
 * @property {'equity'|'crypto'|'index'} assetType
 * @property {number} updatedAt
 */

// ── Yahoo Finance ─────────────────────────────────────────

/**
 * Fetch a single symbol from Yahoo chart endpoint.
 * @returns {Promise<QuoteResult>}
 */
export async function fetchYahoo(symbol) {
  const sym = normalizeSymbol(symbol);
  if (!sym) throw new Error('empty symbol');

  // 1d / 5m gives enough points for a sparkline during market hours;
  // 5d / 1h is a decent fallback shape when after-hours is thin.
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
    `?interval=5m&range=1d&includePrePost=false`;

  const res = await fetch(url, {
    credentials: 'omit',
    headers: { Accept: 'application/json' },
  });
  if (res.status === 429) {
    const err = new Error('HTTP 429 Too Many Requests (Yahoo)');
    err.status = 429;
    err.provider = 'yahoo';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Yahoo HTTP ${res.status}`);
    err.status = res.status;
    err.provider = 'yahoo';
    throw err;
  }

  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('Yahoo: empty result');

  const meta = result.meta || {};
  const closes = (result.indicators?.quote?.[0]?.close || []).filter(
    (v) => v != null && !Number.isNaN(Number(v))
  );
  const price =
    meta.regularMarketPrice ??
    meta.previousClose ??
    (closes.length ? closes[closes.length - 1] : null);
  if (price == null || Number.isNaN(Number(price))) {
    throw new Error('Yahoo: no price');
  }

  const prev =
    meta.chartPreviousClose ??
    meta.previousClose ??
    (closes.length > 1 ? closes[0] : null);
  const change = prev != null ? Number(price) - Number(prev) : null;
  const changePercent =
    prev != null && Number(prev) !== 0
      ? (change / Number(prev)) * 100
      : null;

  // Downsample sparkline to ~24 points for a clean SVG
  const history = downsample(closes.map(Number), 24);

  return {
    symbol: meta.symbol || sym,
    price: Number(price),
    change: change != null ? Number(change) : null,
    changePercent: changePercent != null ? Number(changePercent) : null,
    history,
    currency: meta.currency || 'USD',
    provider: 'yahoo',
    assetType: classifyAsset(sym),
    updatedAt: Date.now(),
  };
}

// ── Stooq (equity / ETF / index fallback) ─────────────────

/**
 * Daily CSV from Stooq. Delayed data — light cadence only.
 * US listings use `.us` suffix (aapl.us). Indices: ^spx → ^spx
 */
export async function fetchStooq(symbol) {
  const sym = normalizeSymbol(symbol);
  if (!sym) throw new Error('empty symbol');

  let stooqSym;
  if (sym.startsWith('^')) {
    // Common index aliases
    const map = { '^GSPC': '^spx', '^DJI': '^dji', '^IXIC': '^ndq' };
    stooqSym = (map[sym] || sym).toLowerCase();
  } else {
    stooqSym = `${sym.toLowerCase()}.us`;
  }

  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`;
  const res = await fetch(url, { credentials: 'omit' });
  if (res.status === 429) {
    const err = new Error('HTTP 429 Too Many Requests (Stooq)');
    err.status = 429;
    err.provider = 'stooq';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Stooq HTTP ${res.status}`);
    err.status = res.status;
    err.provider = 'stooq';
    throw err;
  }

  const text = await res.text();
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2 || /No data/i.test(text)) {
    throw new Error('Stooq: no data');
  }

  // CSV: Date,Open,High,Low,Close,Volume
  const rows = lines.slice(1).map((line) => {
    const parts = line.split(',');
    return { date: parts[0], close: parseFloat(parts[4]) };
  }).filter((r) => Number.isFinite(r.close));

  if (!rows.length) throw new Error('Stooq: parse failed');

  // Last ~30 sessions for sparkline + day change
  const tail = rows.slice(-30);
  const price = tail[tail.length - 1].close;
  const prev = tail.length > 1 ? tail[tail.length - 2].close : null;
  const change = prev != null ? price - prev : null;
  const changePercent =
    prev != null && prev !== 0 ? (change / prev) * 100 : null;

  return {
    symbol: sym,
    price,
    change,
    changePercent,
    history: downsample(tail.map((r) => r.close), 24),
    currency: 'USD',
    provider: 'stooq',
    assetType: classifyAsset(sym),
    updatedAt: Date.now(),
  };
}

// ── CoinGecko (crypto fallback) ───────────────────────────

export async function fetchCoinGecko(symbol) {
  const sym = normalizeSymbol(symbol);
  const id = baseCryptoId(sym);
  if (!id) {
    throw new Error(`CoinGecko: unknown crypto id for ${sym}`);
  }

  // Simple price + 24h change (no key)
  const priceUrl =
    `https://api.coingecko.com/api/v3/simple/price` +
    `?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_24hr_change=true`;

  const res = await fetch(priceUrl, { credentials: 'omit' });
  if (res.status === 429) {
    const err = new Error('HTTP 429 Too Many Requests (CoinGecko)');
    err.status = 429;
    err.provider = 'coingecko';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`CoinGecko HTTP ${res.status}`);
    err.status = res.status;
    err.provider = 'coingecko';
    throw err;
  }

  const data = await res.json();
  const row = data?.[id];
  if (!row || row.usd == null) throw new Error('CoinGecko: no price');

  const price = Number(row.usd);
  const changePercent =
    row.usd_24h_change != null ? Number(row.usd_24h_change) : null;
  const change =
    changePercent != null
      ? price * (changePercent / (100 + changePercent))
      : null;

  // Optional sparkline from market_chart (same request budget — best effort)
  let history = [];
  try {
    const chartUrl =
      `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}` +
      `/market_chart?vs_currency=usd&days=1`;
    const cRes = await fetch(chartUrl, { credentials: 'omit' });
    if (cRes.ok) {
      const cData = await cRes.json();
      const prices = (cData.prices || []).map((p) => Number(p[1])).filter(Number.isFinite);
      history = downsample(prices, 24);
    }
  } catch {
    /* sparkline optional */
  }

  if (!history.length) history = [price];

  return {
    symbol: sym.includes('-') ? sym : `${sym}-USD`,
    price,
    change,
    changePercent,
    history,
    currency: 'USD',
    provider: 'coingecko',
    assetType: 'crypto',
    updatedAt: Date.now(),
  };
}

// ── Orchestration ─────────────────────────────────────────

/**
 * Fetch one symbol: Yahoo → asset-specific fallback.
 * Tracks preferred provider per-symbol via `preferredProvider`.
 * On success with Yahoo after a fallback stretch, preferred becomes yahoo again
 * when the caller records it.
 *
 * @param {string} symbol
 * @param {{ preferredProvider?: string }} [opts]
 * @returns {Promise<{ quote: QuoteResult|null, error: string|null, status?: number }>}
 */
export async function fetchQuote(symbol, opts = {}) {
  const sym = normalizeSymbol(symbol);
  const assetType = classifyAsset(sym);
  const preferred = opts.preferredProvider || 'yahoo';

  const tryYahoo = async () => {
    const quote = await fetchYahoo(sym);
    return { quote, error: null };
  };

  const tryFallback = async () => {
    if (assetType === 'crypto') {
      const quote = await fetchCoinGecko(sym);
      return { quote, error: null };
    }
    const quote = await fetchStooq(sym);
    return { quote, error: null };
  };

  // Opportunistic: always prefer Yahoo unless caller pinned fallback *this cycle*
  // Spec: check Yahoo each refresh cycle even if last success was fallback.
  const order =
    preferred === 'yahoo'
      ? [tryYahoo, tryFallback]
      : [tryYahoo, tryFallback]; // still try Yahoo first every cycle

  let lastErr = null;
  let lastStatus = null;
  for (const fn of order) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      lastStatus = e?.status ?? null;
      console.warn(`[candy stocks] ${fn.name || 'provider'} failed for ${sym}`, e);
    }
  }

  return {
    quote: null,
    error: lastErr?.message || 'fetch failed',
    status: lastStatus,
  };
}

/** Validate a symbol resolves before adding to watchlist */
export async function validateSymbol(symbol) {
  const sym = normalizeSymbol(symbol);
  if (!sym || sym.length > 16) {
    return { ok: false, error: 'Invalid symbol' };
  }
  const { quote, error } = await fetchQuote(sym);
  if (!quote) return { ok: false, error: error || 'Symbol not found' };
  return { ok: true, quote };
}

function downsample(arr, maxPoints) {
  if (!arr?.length) return [];
  if (arr.length <= maxPoints) return arr.slice();
  const out = [];
  const step = (arr.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    out.push(arr[Math.round(i * step)]);
  }
  return out;
}
