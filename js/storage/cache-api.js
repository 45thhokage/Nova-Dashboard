/**
 * Cache API helpers for article thumbnails, publisher favicons, wallpapers.
 */

const CACHE_IMAGES = 'candy-images-v1';
const CACHE_WALLPAPERS = 'candy-wallpapers-v1';

async function open(name) {
  return caches.open(name);
}

/**
 * Fetch an image URL and permanently cache it.
 * Returns a blob URL or the original URL on failure.
 */
export async function cacheImage(url, { cacheName = CACHE_IMAGES } = {}) {
  if (!url) return null;
  try {
    const cache = await open(cacheName);
    const key = new Request(url, { mode: 'no-cors' });

    // Try match first (cors mode for readable body when possible)
    let match = await cache.match(url);
    if (match) {
      try {
        const blob = await match.blob();
        if (blob.size > 0) return URL.createObjectURL(blob);
      } catch {
        /* fall through */
      }
    }

    // Fetch with cors when possible; fall back to opaque
    let response;
    try {
      response = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'force-cache' });
      if (!response.ok) throw new Error(String(response.status));
    } catch {
      try {
        response = await fetch(url, { mode: 'no-cors', credentials: 'omit' });
      } catch {
        return url;
      }
    }

    // Only put readable responses into cache with a clean request key
    try {
      if (response.type !== 'opaque' && response.ok) {
        await cache.put(url, response.clone());
        const blob = await response.blob();
        if (blob.size > 0) return URL.createObjectURL(blob);
      } else if (response.type === 'opaque') {
        await cache.put(url, response.clone());
        // Opaque — can't create object URL reliably; use original
        return url;
      }
    } catch {
      /* ignore cache put failures */
    }

    return url;
  } catch {
    return url;
  }
}

/**
 * Resolve a cached image if present; otherwise return original URL
 * without network (for sync-ish render). Background hydrate can upgrade later.
 */
export async function getCachedImageUrl(url) {
  if (!url) return null;
  try {
    const cache = await open(CACHE_IMAGES);
    const match = await cache.match(url);
    if (match) {
      const blob = await match.blob();
      if (blob.size > 0) return URL.createObjectURL(blob);
    }
  } catch {
    /* ignore */
  }
  return url;
}

/**
 * Preload wallpaper into memory (Image decode) and optionally cache.
 * Resolves when the image is ready to paint.
 */
export function preloadImage(src) {
  return new Promise((resolve, reject) => {
    if (!src) {
      resolve(null);
      return;
    }
    // Solid color / CSS gradient — nothing to load
    if (src.startsWith('#') || src.startsWith('linear-gradient') || src.startsWith('rgb')) {
      resolve(src);
      return;
    }
    const img = new Image();
    img.onload = () => resolve(src);
    img.onerror = () => resolve(src); // soft-fail — still reveal UI
    img.src = src;
  });
}

export async function clearImageCache() {
  try {
    await caches.delete(CACHE_IMAGES);
  } catch {
    /* ignore */
  }
}

export async function clearWallpaperCache() {
  try {
    await caches.delete(CACHE_WALLPAPERS);
  } catch {
    /* ignore */
  }
}

export async function clearAllCaches() {
  await clearImageCache();
  await clearWallpaperCache();
}

/**
 * Rough size estimate for Cache API entries.
 */
export async function estimateCacheSize(cacheName = CACHE_IMAGES) {
  try {
    const cache = await open(cacheName);
    const keys = await cache.keys();
    let total = 0;
    for (const req of keys) {
      // eslint-disable-next-line no-await-in-loop
      const res = await cache.match(req);
      if (!res) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const blob = await res.clone().blob();
        total += blob.size || 0;
      } catch {
        total += 50_000; // opaque estimate
      }
    }
    return total;
  } catch {
    return 0;
  }
}

export { CACHE_IMAGES, CACHE_WALLPAPERS };
