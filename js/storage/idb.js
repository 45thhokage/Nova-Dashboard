/**
 * IndexedDB wrapper for news articles, weather, favicons, wallpapers metadata.
 * Structured stores with async open; reads used after initial sync config paint.
 */

const DB_NAME = 'candy_db';
const DB_VERSION = 2;

/** @type {IDBDatabase | null} */
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains('articles')) {
        const articles = db.createObjectStore('articles', { keyPath: 'id' });
        articles.createIndex('by_category', 'categoryId', { unique: false });
        articles.createIndex('by_url', 'url', { unique: false });
        articles.createIndex('by_category_fetched', ['categoryId', 'fetchedAt'], { unique: false });
      }

      if (!db.objectStoreNames.contains('category_meta')) {
        db.createObjectStore('category_meta', { keyPath: 'categoryId' });
      }

      if (!db.objectStoreNames.contains('weather')) {
        db.createObjectStore('weather', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('favicons')) {
        db.createObjectStore('favicons', { keyPath: 'host' });
      }

      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }

      // Feed reader (v2)
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
  return dbPromise;
}

function tx(storeName, mode = 'readonly') {
  return openDb().then((db) => {
    const t = db.transaction(storeName, mode);
    return t.objectStore(storeName);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ── Articles ──────────────────────────────────────────────

export async function getArticlesByCategory(categoryId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('articles', 'readonly');
    const store = t.objectStore('articles');
    const idx = store.index('by_category');
    const req = idx.getAll(categoryId);
    req.onsuccess = () => {
      const rows = req.result || [];
      rows.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function putArticles(articles) {
  if (!articles?.length) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('articles', 'readwrite');
    const store = t.objectStore('articles');
    for (const a of articles) store.put(a);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getCategoryMeta(categoryId) {
  const store = await tx('category_meta');
  return reqToPromise(store.get(categoryId));
}

export async function setCategoryMeta(meta) {
  const store = await tx('category_meta', 'readwrite');
  return reqToPromise(store.put(meta));
}

export async function clearArticles() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(['articles', 'category_meta'], 'readwrite');
    t.objectStore('articles').clear();
    t.objectStore('category_meta').clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ── Weather (atomic write of full blob) ───────────────────

export async function getWeatherCache() {
  const store = await tx('weather');
  return reqToPromise(store.get('current'));
}

/**
 * Atomic write: current + forecast + timestamp + provider in one put.
 */
export async function setWeatherCache(data) {
  const store = await tx('weather', 'readwrite');
  return reqToPromise(
    store.put({
      id: 'current',
      ...data,
      updatedAt: data.updatedAt ?? Date.now(),
    })
  );
}

export async function clearWeatherCache() {
  const store = await tx('weather', 'readwrite');
  return reqToPromise(store.clear());
}

// ── Favicons ──────────────────────────────────────────────

export async function getFavicon(host) {
  const store = await tx('favicons');
  return reqToPromise(store.get(host));
}

export async function putFavicon(host, dataUrl) {
  const store = await tx('favicons', 'readwrite');
  return reqToPromise(
    store.put({ host, dataUrl, cachedAt: Date.now() })
  );
}

export async function clearFavicons() {
  const store = await tx('favicons', 'readwrite');
  return reqToPromise(store.clear());
}

// ── Feed reader subscriptions & items ─────────────────────

export async function getAllSubscriptions() {
  const store = await tx('feed_subscriptions');
  const rows = await reqToPromise(store.getAll());
  return (rows || []).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}

export async function getSubscription(id) {
  const store = await tx('feed_subscriptions');
  return reqToPromise(store.get(id));
}

export async function putSubscription(sub) {
  const store = await tx('feed_subscriptions', 'readwrite');
  return reqToPromise(store.put(sub));
}

export async function deleteSubscription(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(
      ['feed_subscriptions', 'feed_items', 'feed_meta'],
      'readwrite'
    );
    t.objectStore('feed_subscriptions').delete(id);
    t.objectStore('feed_meta').delete(id);
    // Delete items for this feed
    const idx = t.objectStore('feed_items').index('by_feed');
    const req = idx.openCursor(IDBKeyRange.only(id));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getFeedItems(feedId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('feed_items', 'readonly');
    if (feedId) {
      const idx = t.objectStore('feed_items').index('by_feed');
      const req = idx.getAll(feedId);
      req.onsuccess = () => {
        const rows = req.result || [];
        rows.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
        resolve(rows);
      };
      req.onerror = () => reject(req.error);
    } else {
      const req = t.objectStore('feed_items').getAll();
      req.onsuccess = () => {
        const rows = req.result || [];
        rows.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
        resolve(rows);
      };
      req.onerror = () => reject(req.error);
    }
  });
}

export async function putFeedItems(items) {
  if (!items?.length) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('feed_items', 'readwrite');
    const store = t.objectStore('feed_items');
    for (const item of items) store.put(item);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getFeedMeta(feedId) {
  const store = await tx('feed_meta');
  return reqToPromise(store.get(feedId));
}

export async function setFeedMeta(meta) {
  const store = await tx('feed_meta', 'readwrite');
  return reqToPromise(store.put(meta));
}

/** Clear cached feed items only — keeps subscriptions */
export async function clearFeedItemsCache() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const names = ['feed_items', 'feed_meta'].filter((n) =>
      db.objectStoreNames.contains(n)
    );
    if (!names.length) {
      resolve();
      return;
    }
    const t = db.transaction(names, 'readwrite');
    for (const n of names) t.objectStore(n).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ── KV helpers ────────────────────────────────────────────

export async function kvGet(key) {
  const store = await tx('kv');
  const row = await reqToPromise(store.get(key));
  return row?.value;
}

export async function kvSet(key, value) {
  const store = await tx('kv', 'readwrite');
  return reqToPromise(store.put({ key, value }));
}

export async function kvDelete(key) {
  const store = await tx('kv', 'readwrite');
  return reqToPromise(store.delete(key));
}

// ── Size accounting ───────────────────────────────────────

export async function estimateStoreSizes() {
  const db = await openDb();
  const sizes = {
    articles: 0,
    weather: 0,
    favicons: 0,
    kv: 0,
    category_meta: 0,
    feed_subscriptions: 0,
    feed_items: 0,
    feed_meta: 0,
  };

  for (const name of Object.keys(sizes)) {
    if (!db.objectStoreNames.contains(name)) continue;
    // eslint-disable-next-line no-await-in-loop
    sizes[name] = await measureStore(db, name);
  }

  return sizes;
}

function measureStore(db, storeName) {
  return new Promise((resolve) => {
    const t = db.transaction(storeName, 'readonly');
    const store = t.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => {
      try {
        const json = JSON.stringify(req.result || []);
        // UTF-16-ish estimate
        resolve(json.length * 2);
      } catch {
        resolve(0);
      }
    };
    req.onerror = () => resolve(0);
  });
}

export async function wipeAllIdb() {
  const db = await openDb();
  const names = [...db.objectStoreNames];
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, 'readwrite');
    for (const n of names) t.objectStore(n).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export { openDb };
