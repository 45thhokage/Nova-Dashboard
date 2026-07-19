/**
 * Precompute mixed "All feeds" timeline: sort, diversity, pin, tile size, dedupe.
 * Runs during background refresh — never on scroll/render path.
 */

import { getFeedSettings, maxAgeMs, pinNewWindowMs } from './settings.js';
import { kvGet, kvSet } from '../storage/idb.js';

export const VIEW_KEY = 'feed_reader_view';

/** Time window for source-diversity interleave (ms) */
const CLUSTER_WINDOW_MS = 90 * 60 * 1000; // 90 minutes

/**
 * Build and persist the ordered "All feeds" view from raw items + subs.
 * @returns {Promise<{ items: any[], counts: Record<string, number>, total: number }>}
 */
export async function recomputeAndStoreView(allItems, subscriptions) {
  const settings = getFeedSettings();
  const now = Date.now();
  const ageCutoff = now - maxAgeMs(settings);
  const subMap = new Map((subscriptions || []).map((s) => [s.id, s]));

  // Counts before age filter (cached items per sub, post-prune caller handles store)
  const counts = {};
  for (const s of subscriptions || []) counts[s.id] = 0;

  // Sidebar counts: all cached items within max-age (incl. paused feeds)
  for (const raw of allItems || []) {
    if (!subMap.has(raw.feedId)) continue;
    if (normalizeTimestamp(raw) < ageCutoff) continue;
    counts[raw.feedId] = (counts[raw.feedId] || 0) + 1;
  }

  // Mixed-view pool: skip paused; normalize timestamps; age filter; blocklist
  let pool = [];
  for (const raw of allItems || []) {
    const sub = subMap.get(raw.feedId);
    if (!sub || sub.paused) continue;
    const effectiveAt = normalizeTimestamp(raw);
    if (effectiveAt < ageCutoff) continue;
    if (isBlocked(raw, settings.blocklist)) continue;
    pool.push({
      ...raw,
      effectiveAt,
      feedTitle: sub.title || raw.feedTitle || 'Feed',
      feedUrl: sub.url || '',
    });
  }

  // 2) New-subscription backlog throttle (mixed view only)
  pool = applyNewSubThrottle(pool, subMap, settings);

  // 3) Cross-feed URL dedupe
  if (settings.dedupeByUrl) {
    pool = dedupeByUrl(pool);
  }

  // 4) Source-diversity interleave within time clusters, then reverse-chron
  pool = diversifySort(pool);

  // 5) Keyword pins
  const { pinned, rest } = applyKeywordPins(pool, settings);
  const ordered = [...pinned, ...rest];

  // 6) Tile sizes from stored image meta
  const withTiles = ordered.map((item, index) => ({
    ...item,
    tileSize: assignTileSize(item, index),
    pinned: Boolean(item._pinned),
  }));

  // Strip internal flags; keep display fields
  const viewItems = withTiles.map(({ _pinned, ...item }) => item);

  const view = {
    items: viewItems,
    counts,
    total: viewItems.length,
    updatedAt: now,
  };

  await kvSet(VIEW_KEY, view);
  return view;
}

export async function getStoredView() {
  return (await kvGet(VIEW_KEY)) || { items: [], counts: {}, total: 0, updatedAt: 0 };
}

/** Effective publish time: reliable pubDate or fetch-time fallback */
export function normalizeTimestamp(item) {
  const pub = item.publishedAt;
  const fetched = item.fetchedAt || 0;
  // Unreliable: missing, epoch, or far future
  if (pub == null || pub <= 0 || Number.isNaN(pub)) return fetched || Date.now();
  if (pub > Date.now() + 60_000) return fetched || Date.now();
  // Extremely old vs fetch might still be valid — keep pub
  return pub;
}

function applyNewSubThrottle(pool, subMap, settings) {
  const limit = settings.newSubSurfaceLimit || 6;
  const NEW_SUB_MS = 48 * 60 * 60 * 1000; // first 48h after subscribe
  const now = Date.now();

  // Per-feed, if recently subscribed, only keep top N by effectiveAt
  const byFeed = new Map();
  for (const item of pool) {
    if (!byFeed.has(item.feedId)) byFeed.set(item.feedId, []);
    byFeed.get(item.feedId).push(item);
  }

  const out = [];
  for (const [feedId, items] of byFeed) {
    const sub = subMap.get(feedId);
    const subscribedAt = sub?.subscribedAt || sub?.addedAt || 0;
    const isNewSub = subscribedAt && now - subscribedAt < NEW_SUB_MS;
    items.sort((a, b) => b.effectiveAt - a.effectiveAt);
    if (isNewSub && items.length > limit) {
      out.push(...items.slice(0, limit));
    } else {
      out.push(...items);
    }
  }
  return out;
}

function dedupeByUrl(pool) {
  const seen = new Map(); // normalized url -> item
  // Prefer earlier in reverse-chron later — process newest first
  const sorted = [...pool].sort((a, b) => b.effectiveAt - a.effectiveAt);
  for (const item of sorted) {
    const key = normalizeUrlKey(item.url || item.guid);
    if (!key) {
      seen.set(item.id, item);
      continue;
    }
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}

function normalizeUrlKey(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    u.hash = '';
    // strip common tracking
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach((k) =>
      u.searchParams.delete(k)
    );
    return u.href.replace(/\/$/, '').toLowerCase();
  } catch {
    return String(url).toLowerCase();
  }
}

/**
 * Sort reverse-chron, but interleave sources within tight time clusters.
 */
function diversifySort(pool) {
  const sorted = [...pool].sort((a, b) => b.effectiveAt - a.effectiveAt);
  if (sorted.length <= 2) return sorted;

  const result = [];
  let i = 0;
  while (i < sorted.length) {
    const clusterStart = sorted[i].effectiveAt;
    const cluster = [];
    while (
      i < sorted.length &&
      clusterStart - sorted[i].effectiveAt <= CLUSTER_WINDOW_MS
    ) {
      cluster.push(sorted[i]);
      i++;
    }
    result.push(...roundRobinByFeed(cluster));
  }
  return result;
}

function roundRobinByFeed(cluster) {
  const queues = new Map();
  for (const item of cluster) {
    if (!queues.has(item.feedId)) queues.set(item.feedId, []);
    queues.get(item.feedId).push(item);
  }
  // Each queue already reverse-chron within cluster order
  const feedIds = [...queues.keys()];
  const out = [];
  let remaining = cluster.length;
  while (remaining > 0) {
    for (const fid of feedIds) {
      const q = queues.get(fid);
      if (q?.length) {
        out.push(q.shift());
        remaining--;
      }
    }
  }
  return out;
}

function applyKeywordPins(pool, settings) {
  const keywords = settings.keywords || [];
  if (!keywords.length) {
    return { pinned: [], rest: pool.map((p) => ({ ...p, _pinned: false })) };
  }

  const pinWindow = pinNewWindowMs(settings);
  const now = Date.now();
  const pinned = [];
  const rest = [];

  for (const item of pool) {
    const match = matchKeywords(item, keywords);
    if (!match) {
      rest.push({ ...item, _pinned: false });
      continue;
    }
    const always = match.alwaysPin;
    const isNew = now - item.effectiveAt <= pinWindow;
    if (always || isNew) {
      pinned.push({ ...item, _pinned: true, matchedKeyword: match.text });
    } else {
      rest.push({ ...item, _pinned: false });
    }
  }

  pinned.sort((a, b) => b.effectiveAt - a.effectiveAt);
  return { pinned, rest };
}

function matchKeywords(item, keywords) {
  const title = (item.title || '').toLowerCase();
  const summary = (item.summary || '').toLowerCase();
  for (const kw of keywords) {
    const t = (kw.text || '').trim().toLowerCase();
    if (!t) continue;
    if (title.includes(t) || summary.includes(t)) return kw;
  }
  return null;
}

/** Case-insensitive blocklist match against title + summary */
export function isBlocked(item, blocklist) {
  const list = blocklist || [];
  if (!list.length) return false;
  const title = (item.title || '').toLowerCase();
  const summary = (item.summary || '').toLowerCase();
  for (const entry of list) {
    const t = (entry.text || entry || '').toString().trim().toLowerCase();
    if (!t) continue;
    if (title.includes(t) || summary.includes(t)) return true;
  }
  return false;
}

/**
 * Tile size from pre-stored imageMeta — never measure live.
 * Larger / landscape images → lg; portrait/square mid; missing → rotate pattern.
 */
export function assignTileSize(item, index) {
  const meta = item.imageMeta;
  if (meta?.w && meta?.h) {
    const aspect = meta.w / meta.h;
    const area = meta.w * meta.h;
    if (area >= 400_000 && aspect >= 1.3) return 'lg';
    if (aspect >= 1.5) return 'lg';
    if (aspect < 0.85) return 'sm';
    if (area >= 200_000) return 'md';
    return 'sm';
  }
  // No meta: deterministic variety pattern (like main news grid)
  const pattern = ['lg', 'sm', 'md', 'md', 'lg', 'sm'];
  return pattern[index % pattern.length];
}

/**
 * Probe image dimensions once (used at cache time).
 */
export function probeImageMeta(url) {
  return new Promise((resolve) => {
    if (!url || url.startsWith('data:')) {
      resolve(null);
      return;
    }
    const img = new Image();
    const done = (meta) => {
      img.onload = null;
      img.onerror = null;
      resolve(meta);
    };
    img.onload = () =>
      done({
        w: img.naturalWidth || 0,
        h: img.naturalHeight || 0,
        aspect:
          img.naturalHeight > 0
            ? img.naturalWidth / img.naturalHeight
            : 1,
      });
    img.onerror = () => done(null);
    // Timeout so we don't hang refresh
    setTimeout(() => done(null), 4000);
    img.src = url;
  });
}
