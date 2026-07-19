/**
 * Favicon fetch via favicon.im — only on first save.
 * Permanently cached in IndexedDB as data URL.
 */

import { getFavicon, putFavicon } from './storage/idb.js';
import { hostFromUrl } from './utils.js';

const FAVICON_IM = (host) => `https://favicon.im/${encodeURIComponent(host)}?larger=true`;

/**
 * Get cached favicon data URL for a URL/host, or null if not cached.
 */
export async function getCachedFavicon(urlOrHost) {
  const host = urlOrHost.includes('://') ? hostFromUrl(urlOrHost) : urlOrHost.replace(/^www\./, '');
  if (!host) return null;
  const row = await getFavicon(host);
  return row?.dataUrl || null;
}

/**
 * Ensure favicon is cached. Fetches from favicon.im only if missing.
 * Returns data URL (or null).
 */
export async function ensureFavicon(urlOrHost) {
  const host = urlOrHost.includes('://') ? hostFromUrl(urlOrHost) : urlOrHost.replace(/^www\./, '');
  if (!host) return null;

  const existing = await getFavicon(host);
  if (existing?.dataUrl) return existing.dataUrl;

  try {
    const res = await fetch(FAVICON_IM(host), { credentials: 'omit' });
    if (!res.ok) throw new Error(String(res.status));
    const blob = await res.blob();
    const dataUrl = await blobToDataUrl(blob);
    await putFavicon(host, dataUrl);
    return dataUrl;
  } catch (e) {
    console.warn('[candy] favicon fetch failed for', host, e);
    // Store a letter-mark placeholder so we don't re-fetch every load
    const placeholder = letterMarkDataUrl(host);
    try {
      await putFavicon(host, placeholder);
    } catch {
      /* ignore */
    }
    return placeholder;
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function letterMarkDataUrl(host) {
  const letter = (host[0] || '?').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
    <rect width="64" height="64" rx="12" fill="#35343d"/>
    <text x="50%" y="54%" text-anchor="middle" fill="#f5f5f7" font-family="system-ui,sans-serif" font-size="28" font-weight="600">${letter}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Publisher favicon for news cards — prefer google s2 as lightweight fallback
 * after trying cache / favicon.im once.
 */
export async function publisherFavicon(publisherUrlOrHost) {
  return ensureFavicon(publisherUrlOrHost);
}
