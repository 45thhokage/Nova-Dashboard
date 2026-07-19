/**
 * Feed reader engine — cache-first, TTL refresh, prune, compose view.
 */

import {
  getAllSubscriptions,
  getSubscription,
  putSubscription,
  deleteSubscription,
  getFeedItems,
  putFeedItems,
  getFeedMeta,
  setFeedMeta,
  kvSet,
} from '../storage/idb.js';
import { cacheImage } from '../storage/cache-api.js';
import { fetchAndParseFeed } from './parse.js';
import { uid, hostFromUrl, normalizeUrl } from '../utils.js';
import {
  getFeedSettings,
  maxAgeMs,
} from './settings.js';
import {
  recomputeAndStoreView,
  getStoredView,
  normalizeTimestamp,
  probeImageMeta,
  isBlocked,
  VIEW_KEY,
} from './compose.js';
import {
  resolveItemImage,
  normalizeImageQuality,
  upgradeImageUrl,
} from './images.js';

/**
 * Load for render: precomputed all-view, or single-feed slice from IDB.
 */
export async function loadReaderFromCache({ feedId = null } = {}) {
  const subs = await getAllSubscriptions();
  const settings = getFeedSettings();
  const ageCutoff = Date.now() - maxAgeMs(settings);

  if (!feedId) {
    let view = await getStoredView();
    // Cold start: build view from raw items if empty
    if (!view?.items?.length) {
      const all = await getFeedItems(null);
      view = await recomputeAndStoreView(all, subs);
    }
    // Counts: prefer stored; fall back to counting
    const counts = view.counts || countByFeed(await getFeedItems(null), ageCutoff, subs);
    return {
      subscriptions: subs,
      items: view.items || [],
      counts,
      settings,
      mode: 'all',
    };
  }

  // Single-feed: full history for that sub (within max age), reverse-chron
  let items = await getFeedItems(feedId);
  const sub = subs.find((s) => s.id === feedId);
  items = items
    .filter((i) => normalizeTimestamp(i) >= ageCutoff)
    .filter((i) => !isBlocked(i, settings.blocklist))
    .sort((a, b) => normalizeTimestamp(b) - normalizeTimestamp(a))
    .map((item) => ({
      ...item,
      effectiveAt: normalizeTimestamp(item),
      feedTitle: sub?.title || item.feedTitle || 'Feed',
      feedUrl: sub?.url || '',
      tileSize: item.tileSize || 'md',
    }));

  const allForCounts = await getFeedItems(null);
  return {
    subscriptions: subs,
    items,
    counts: countByFeed(allForCounts, ageCutoff, subs),
    settings,
    mode: 'single',
  };
}

function countByFeed(items, ageCutoff, subs) {
  const counts = {};
  for (const s of subs) counts[s.id] = 0;
  for (const it of items || []) {
    if (normalizeTimestamp(it) < ageCutoff) continue;
    counts[it.feedId] = (counts[it.feedId] || 0) + 1;
  }
  return counts;
}

/**
 * After paint: refresh stale (non-paused) feeds, prune, recompose view.
 */
export async function backgroundRefreshStaleFeeds(onUpdated) {
  const settings = getFeedSettings();
  const defaultTtl = (settings.refreshMinutes || 30) * 60_000;
  const subs = await getAllSubscriptions();

  let any = false;
  for (const sub of subs) {
    if (sub.paused) continue;
    const ttl =
      sub.refreshMinutes != null
        ? Math.max(15, Number(sub.refreshMinutes)) * 60_000
        : defaultTtl;
    // eslint-disable-next-line no-await-in-loop
    const meta = await getFeedMeta(sub.id);
    const age = meta?.lastFetchedAt ? Date.now() - meta.lastFetchedAt : Infinity;
    if (age < ttl) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await refreshFeed(sub.id, { silent: true });
      any = true;
    } catch (e) {
      console.warn('[candy] feed refresh failed', sub.url, e);
    }
  }

  // Always recompose + prune once per cycle
  await pruneAndRecompose();
  if (onUpdated) onUpdated();
  return any;
}

/**
 * Prune items past max age globally, cap per feed, recompute view.
 */
export async function pruneAndRecompose() {
  const settings = getFeedSettings();
  const maxPer = settings.maxItemsPerFeed || 50;
  const ageCutoff = Date.now() - maxAgeMs(settings);
  const subs = await getAllSubscriptions();
  const all = await getFeedItems(null);

  const byFeed = new Map();
  for (const item of all) {
    if (!byFeed.has(item.feedId)) byFeed.set(item.feedId, []);
    byFeed.get(item.feedId).push(item);
  }

  const keep = [];
  for (const [, items] of byFeed) {
    const filtered = items
      .filter((i) => normalizeTimestamp(i) >= ageCutoff)
      .sort((a, b) => normalizeTimestamp(b) - normalizeTimestamp(a))
      .slice(0, maxPer);
    keep.push(...filtered);
  }

  // Replace store: clear + put is safer for prune
  await replaceAllFeedItems(keep);
  return recomputeAndStoreView(keep, subs);
}

async function replaceAllFeedItems(items) {
  const { openDb } = await import('../storage/idb.js');
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('feed_items', 'readwrite');
    const store = t.objectStore('feed_items');
    store.clear();
    for (const item of items) store.put(item);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/**
 * Force refresh one subscription.
 */
export async function refreshFeed(feedId, { silent = false, enrichImages = true } = {}) {
  const sub = await getSubscription(feedId);
  if (!sub) return null;
  if (sub.paused) return null;

  const settings = getFeedSettings();
  const maxPer = settings.maxItemsPerFeed || 50;

  let parsed;
  try {
    parsed = await fetchAndParseFeed(sub.url);
  } catch (e) {
    if (!silent) console.warn('[candy] refresh feed', feedId, e);
    const failCount = (sub.failCount || 0) + 1;
    await putSubscription({
      ...sub,
      lastError: String(e?.message || e),
      failCount,
      lastFailAt: Date.now(),
    });
    return null;
  }

  const imageQuality = normalizeImageQuality(sub.imageQuality);
  const updatedSub = {
    ...sub,
    title: parsed.feed.title || sub.title,
    siteUrl: parsed.feed.siteUrl || sub.siteUrl,
    format: parsed.feed.format || sub.format,
    imageQuality,
    lastError: null,
    failCount: 0,
    lastSuccessAt: Date.now(),
  };
  await putSubscription(updatedSub);

  const existing = await getFeedItems(feedId);
  const byGuid = new Map(existing.map((i) => [i.guid || i.url, i]));
  const now = Date.now();
  const brandNew = [];
  const merged = [];

  for (const raw of (parsed.items || []).slice(0, maxPer)) {
    const guid = raw.guid || raw.url;
    const prev = byGuid.get(guid);
    const id = prev?.id || hashItemId(feedId, guid);
    const publishedAt = raw.publishedAt || null;
    // Prefer larger feed-native candidate when quality is medium/large
    let feedImage = raw.imageUrl || prev?.imageUrl || null;
    if (imageQuality !== 'small' && raw.imageCandidates?.length) {
      const upgraded = raw.imageCandidates
        .map((u) => upgradeImageUrl(u, imageQuality) || u)
        .filter(Boolean);
      feedImage = upgraded[0] || feedImage;
    } else if (imageQuality === 'large' && feedImage) {
      feedImage = upgradeImageUrl(feedImage, 'large') || feedImage;
    }
    const item = {
      id,
      feedId,
      title: raw.title,
      url: raw.url,
      guid,
      summary: raw.summary,
      contentHtml: raw.contentHtml,
      imageUrl: feedImage,
      imageMeta: prev?.imageMeta || null,
      imageQualityApplied: prev?.imageQualityApplied || null,
      author: raw.author,
      publishedAt: publishedAt || prev?.publishedAt || now,
      fetchedAt: prev?.fetchedAt && prev.guid === guid ? prev.fetchedAt : now,
      feedTitle: updatedSub.title,
      read: prev?.read || false,
      tileSize: prev?.tileSize || null,
    };
    // New items get fresh fetch time for synthetic timestamp fallback
    if (!prev) {
      item.fetchedAt = now;
      brandNew.push(item);
    }
    merged.push(item);
    byGuid.delete(guid);
  }

  for (const leftover of byGuid.values()) {
    merged.push(leftover);
  }

  const ageCutoff = now - maxAgeMs(settings);
  const capped = merged
    .filter((i) => normalizeTimestamp(i) >= ageCutoff)
    .sort((a, b) => normalizeTimestamp(b) - normalizeTimestamp(a))
    .slice(0, maxPer);

  await putFeedItems(capped);
  await setFeedMeta({
    feedId,
    lastFetchedAt: now,
    lastCount: capped.length,
    lastError: null,
  });

  // Enrich images per subscription quality (more work for large)
  const toWarm = pickItemsToWarm(capped, brandNew, imageQuality);
  warmFeedAssets(toWarm, {
    enrichImages,
    imageQuality,
  }).catch(() => {});

  // Recompose full view after single-feed update
  await pruneAndRecompose();

  return {
    subscription: updatedSub,
    items: capped,
    newIds: new Set(brandNew.map((a) => a.id)),
  };
}

function pickItemsToWarm(capped, brandNew, imageQuality) {
  const q = normalizeImageQuality(imageQuality);
  const limit = q === 'large' ? 16 : q === 'medium' ? 12 : 6;
  const need = [];
  const seen = new Set();
  for (const item of [...brandNew, ...capped]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    // Re-resolve if quality changed or missing image / missing meta for medium+
    if (
      item.imageQualityApplied !== q ||
      !item.imageUrl ||
      (q !== 'small' && !item.imageMeta)
    ) {
      need.push(item);
    }
    if (need.length >= limit) break;
  }
  return need;
}

async function warmFeedAssets(items, { enrichImages, imageQuality = 'medium' }) {
  const q = normalizeImageQuality(imageQuality);
  for (const item of items) {
    if (!enrichImages && q === 'small' && item.imageUrl) {
      // still probe meta for tile sizing if missing
      if (!item.imageMeta && item.imageUrl) {
        // eslint-disable-next-line no-await-in-loop
        const meta = await probeImageMeta(item.imageUrl);
        if (meta) {
          item.imageMeta = meta;
          // eslint-disable-next-line no-await-in-loop
          await putFeedItems([item]);
        }
      }
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const resolved = await resolveItemImage(item, q);
    const img = resolved.url || item.imageUrl;
    if (img) {
      item.imageUrl = img;
      item.imageQualityApplied = q;
      item.imageSource = resolved.source;
      // eslint-disable-next-line no-await-in-loop
      await cacheImage(img).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      const meta = await probeImageMeta(img);
      if (meta) item.imageMeta = meta;
      // eslint-disable-next-line no-await-in-loop
      await putFeedItems([item]);
    } else {
      item.imageQualityApplied = q;
      // eslint-disable-next-line no-await-in-loop
      await putFeedItems([item]);
    }
  }
  // After meta updates, recompose once
  const subs = await getAllSubscriptions();
  const all = await getFeedItems(null);
  await recomputeAndStoreView(all, subs);
}

export async function addFeed(rawUrl) {
  let url = (rawUrl || '').trim();
  if (!url) throw new Error('Enter a feed URL');
  url = normalizeUrl(url);

  const existing = await getAllSubscriptions();
  if (existing.some((s) => normalizeUrl(s.url) === url)) {
    throw new Error('Already subscribed to this feed');
  }

  const parsed = await fetchAndParseFeed(url);
  if (!parsed.items && !parsed.feed) {
    throw new Error('Could not detect a valid feed');
  }

  const settings = getFeedSettings();
  const maxPer = settings.maxItemsPerFeed || 50;
  const now = Date.now();

  const sub = {
    id: uid('feed'),
    url,
    title: parsed.feed.title || hostFromUrl(url) || 'Untitled feed',
    siteUrl: parsed.feed.siteUrl || url,
    format: parsed.feed.format || 'rss',
    addedAt: now,
    subscribedAt: now,
    lastError: null,
    failCount: 0,
    paused: false,
    refreshMinutes: null, // null = use global
    imageQuality: 'medium',
  };

  await putSubscription(sub);

  const items = (parsed.items || []).slice(0, maxPer).map((raw) => ({
    id: hashItemId(sub.id, raw.guid || raw.url),
    feedId: sub.id,
    title: raw.title,
    url: raw.url,
    guid: raw.guid || raw.url,
    summary: raw.summary,
    contentHtml: raw.contentHtml,
    imageUrl: raw.imageUrl,
    imageMeta: null,
    imageQualityApplied: null,
    author: raw.author,
    publishedAt: raw.publishedAt || now,
    fetchedAt: now,
    feedTitle: sub.title,
    read: false,
  }));
  await putFeedItems(items);
  await setFeedMeta({
    feedId: sub.id,
    lastFetchedAt: now,
    lastCount: items.length,
    lastError: null,
  });

  warmFeedAssets(items.slice(0, 12), {
    enrichImages: true,
    imageQuality: sub.imageQuality,
  }).catch(() => {});
  await pruneAndRecompose();

  return { subscription: sub, items };
}

export async function removeFeed(feedId) {
  await deleteSubscription(feedId);
  await pruneAndRecompose();
}

export async function setFeedPaused(feedId, paused) {
  const sub = await getSubscription(feedId);
  if (!sub) return;
  await putSubscription({ ...sub, paused: Boolean(paused) });
  await pruneAndRecompose();
}

export async function setFeedRefreshOverride(feedId, minutes) {
  const sub = await getSubscription(feedId);
  if (!sub) return;
  await putSubscription({
    ...sub,
    refreshMinutes: minutes == null || minutes === '' ? null : Math.max(15, Number(minutes)),
  });
}

/**
 * Per-source image quality: small | medium | large.
 * Immediately re-resolves cached items for this feed in the background.
 */
export async function setFeedImageQuality(feedId, quality) {
  const sub = await getSubscription(feedId);
  if (!sub) return;
  const imageQuality = normalizeImageQuality(quality);
  await putSubscription({ ...sub, imageQuality });

  const items = await getFeedItems(feedId);
  // Force re-resolve by clearing applied quality marker
  const reset = items.map((i) => ({
    ...i,
    imageQualityApplied: null,
  }));
  await putFeedItems(reset);

  // Warm more items for large quality
  const slice = reset.slice(0, imageQuality === 'large' ? 24 : imageQuality === 'medium' ? 16 : 8);
  warmFeedAssets(slice, {
    enrichImages: true,
    imageQuality,
  }).catch(() => {});
}

export async function markItemRead(itemId, read = true) {
  const all = await getFeedItems(null);
  const item = all.find((i) => i.id === itemId);
  if (!item) return;
  item.read = read;
  await putFeedItems([item]);
  // Update precomputed view flags without full rebuild if possible
  const view = await getStoredView();
  if (view?.items) {
    view.items = view.items.map((i) => (i.id === itemId ? { ...i, read } : i));
    await kvSet(VIEW_KEY, view);
  }
}

export async function markAllRead(feedId = null) {
  const items = await getFeedItems(feedId || null);
  const updated = items.map((i) => ({ ...i, read: true }));
  await putFeedItems(updated);
  await pruneAndRecompose();
}

/** OPML export of subscriptions */
export async function exportOpml() {
  const subs = await getAllSubscriptions();
  const outlines = subs
    .map(
      (s) =>
        `    <outline type="rss" text="${escXml(s.title)}" title="${escXml(s.title)}" xmlUrl="${escXml(s.url)}" htmlUrl="${escXml(s.siteUrl || s.url)}"/>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Nova Feeds</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${outlines}
  </body>
</opml>`;
}

export async function importOpml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid OPML');
  const outlines = [...doc.querySelectorAll('outline[xmlUrl], outline[xmlurl]')];
  const urls = [];
  for (const o of outlines) {
    const u = o.getAttribute('xmlUrl') || o.getAttribute('xmlurl');
    if (u) urls.push(u);
  }
  if (!urls.length) {
    // nested
    for (const o of doc.querySelectorAll('outline')) {
      const u = o.getAttribute('xmlUrl') || o.getAttribute('xmlurl');
      if (u) urls.push(u);
    }
  }
  const results = { added: 0, skipped: 0, errors: [] };
  for (const url of urls) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await addFeed(url);
      results.added++;
    } catch (e) {
      if (String(e.message || e).includes('Already')) results.skipped++;
      else results.errors.push({ url, error: String(e.message || e) });
    }
  }
  return results;
}

function escXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function hashItemId(feedId, key) {
  let h = 0;
  const s = `${feedId}::${key}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `fi_${feedId}_${(h >>> 0).toString(36)}`;
}

export { getFeedSettings, recomputeAndStoreView };
