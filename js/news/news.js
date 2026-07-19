/**
 * News feed engine — cache-first render, background TTL refresh,
 * dedup on merge, infinite scroll pagination.
 */

import { getConfig } from '../config.js';
import {
  getArticlesByCategory,
  putArticles,
  getCategoryMeta,
  setCategoryMeta,
} from '../storage/idb.js';
import { cacheImage } from '../storage/cache-api.js';
import { fetchCategoryArticles, placeholderImage } from './feeds.js';
import { ensureFavicon } from '../favicon.js';

const PAGE_SIZE_DEFAULT = 12;

/**
 * Load all following topics' cached articles for first paint.
 * Synchronous relative to UI: awaits IDB only (local, fast).
 */
export async function loadFeedFromCache() {
  const cfg = getConfig();
  if (!cfg.content?.enabled) return { sections: [], enabled: false };

  const following = (cfg.topics || []).filter((t) => t.following);
  const sections = [];

  for (const topic of following) {
    // eslint-disable-next-line no-await-in-loop
    const articles = await getArticlesByCategory(topic.id);
    // eslint-disable-next-line no-await-in-loop
    const meta = await getCategoryMeta(topic.id);
    sections.push({
      topic,
      articles,
      meta: meta || null,
      hasCache: articles.length > 0,
    });
  }

  return { sections, enabled: true };
}

/**
 * After paint: refresh stale categories in background.
 */
export async function backgroundRefreshStale(onCategoryUpdated) {
  const cfg = getConfig();
  const ttlMs = (cfg.news?.ttlMinutes || 25) * 60_000;
  const following = (cfg.topics || []).filter((t) => t.following);

  for (const topic of following) {
    // eslint-disable-next-line no-await-in-loop
    const meta = await getCategoryMeta(topic.id);
    const age = meta?.lastFetchedAt ? Date.now() - meta.lastFetchedAt : Infinity;
    if (age < ttlMs) continue;

    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await refreshCategory(topic.id, topic.query, { silent: true });
      if (result && onCategoryUpdated) onCategoryUpdated(topic.id, result);
    } catch (e) {
      console.warn('[candy] bg news refresh failed', topic.id, e);
      // Offline fallback: keep cache, no error UI
    }
  }
}

/**
 * Force refresh one category (manual refresh).
 * Merges with dedup by URL/GUID; does not reorder past items aggressively.
 */
export async function refreshCategory(categoryId, query, { silent = false } = {}) {
  const cfg = getConfig();
  const limit = (cfg.news?.pageSize || PAGE_SIZE_DEFAULT) * 2;

  let incoming;
  try {
    incoming = await fetchCategoryArticles(categoryId, query, { limit });
  } catch (e) {
    if (!silent) console.warn('[candy] refresh failed', categoryId, e);
    return null;
  }

  const existing = await getArticlesByCategory(categoryId);
  const byKey = new Map();
  for (const a of existing) {
    byKey.set(a.guid || a.url, a);
  }

  const merged = [];
  const seen = new Set();

  // Keep existing order for items already known (stable scroll)
  for (const a of existing) {
    const key = a.guid || a.url;
    seen.add(key);
    // Prefer fresher metadata if re-fetched
    const newer = incoming.find((i) => (i.guid || i.url) === key);
    if (newer) {
      merged.push({
        ...a,
        ...newer,
        // Preserve original published ordering identity
        id: a.id,
      });
    } else {
      merged.push(a);
    }
  }

  // Prepend truly new items (not in cache)
  const brandNew = [];
  for (const item of incoming) {
    const key = item.guid || item.url;
    if (seen.has(key)) continue;
    seen.add(key);
    brandNew.push(item);
  }

  // New items first, then existing (news-feed style) — but only insert new at top
  const finalList = [...brandNew, ...merged];

  // Cap storage
  const capped = finalList.slice(0, 80);
  await putArticles(capped);
  await setCategoryMeta({
    categoryId,
    lastFetchedAt: Date.now(),
    lastCount: capped.length,
    lastError: null,
  });

  // Warm image/favicon caches in background (don't await all)
  warmAssets(brandNew.concat(capped.slice(0, 6))).catch(() => {});

  return {
    articles: capped,
    newIds: new Set(brandNew.map((a) => a.id)),
  };
}

async function warmAssets(articles) {
  for (const a of articles.slice(0, 12)) {
    if (a.imageUrl) {
      // eslint-disable-next-line no-await-in-loop
      await cacheImage(a.imageUrl).catch(() => {});
    }
    if (a.publisherHost || a.url) {
      // eslint-disable-next-line no-await-in-loop
      await ensureFavicon(a.publisherHost || a.url).catch(() => {});
    }
  }
}

/**
 * Paginate: return next page slice from an in-memory article list.
 */
export function pageArticles(articles, page, pageSize = PAGE_SIZE_DEFAULT) {
  const start = page * pageSize;
  return {
    items: articles.slice(start, start + pageSize),
    hasMore: start + pageSize < articles.length,
    nextPage: page + 1,
  };
}

export function articleImageSrc(article) {
  return article.imageUrl || placeholderImage(article.id || article.title);
}
