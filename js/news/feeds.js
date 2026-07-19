/**
 * News sources: Google News RSS per category (keyless).
 * Parsed in the extension; images/favicons cached via Cache API / IDB.
 */

import { uid, hostFromUrl } from '../utils.js';

const GOOGLE_NEWS_RSS = (query) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;

/**
 * Fetch & parse RSS for a category query.
 * Returns normalized article objects (no IDB write).
 */
export async function fetchCategoryArticles(categoryId, query, { limit = 24 } = {}) {
  const url = GOOGLE_NEWS_RSS(query);
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`rss ${res.status}`);
  const text = await res.text();
  const items = parseRss(text);

  const now = Date.now();
  return items.slice(0, limit).map((item) => {
    const link = item.link || item.guid || '';
    const publisher = item.source || hostFromUrl(link) || 'News';
    const publisherHost = hostFromUrl(item.sourceUrl || link) || publisher.toLowerCase().replace(/\s+/g, '');
    return {
      id: hashId(categoryId, link || item.title),
      categoryId,
      title: item.title || 'Untitled',
      url: link,
      guid: item.guid || link,
      publisher,
      publisherHost,
      imageUrl: item.image || null,
      publishedAt: item.pubDate ? Date.parse(item.pubDate) || now : now,
      fetchedAt: now,
      duration: item.duration || null, // optional badge
    };
  });
}

function hashId(categoryId, key) {
  let h = 0;
  const s = `${categoryId}::${key}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `art_${categoryId}_${(h >>> 0).toString(36)}`;
}

/**
 * Minimal RSS/Atom parser using DOMParser.
 */
function parseRss(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) {
    // Sometimes Google returns HTML errors
    throw new Error('rss parse error');
  }

  const items = [...doc.querySelectorAll('item')];
  if (items.length) {
    return items.map((item) => {
      const title = textOf(item, 'title');
      const link = textOf(item, 'link');
      const guid = textOf(item, 'guid') || link;
      const pubDate = textOf(item, 'pubDate');
      const sourceEl = item.querySelector('source');
      const source = sourceEl?.textContent?.trim() || '';
      const sourceUrl = sourceEl?.getAttribute('url') || '';
      const description = textOf(item, 'description');
      const image = extractImage(item, description);
      return { title, link, guid, pubDate, source, sourceUrl, image };
    });
  }

  // Atom
  const entries = [...doc.querySelectorAll('entry')];
  return entries.map((entry) => {
    const title = textOf(entry, 'title');
    const link =
      entry.querySelector('link[rel="alternate"]')?.getAttribute('href') ||
      entry.querySelector('link')?.getAttribute('href') ||
      '';
    const guid = textOf(entry, 'id') || link;
    const pubDate = textOf(entry, 'published') || textOf(entry, 'updated');
    const source = textOf(entry, 'source') || '';
    const summary = textOf(entry, 'summary') || textOf(entry, 'content');
    const image = extractImage(entry, summary);
    return { title, link, guid, pubDate, source, sourceUrl: '', image };
  });
}

function textOf(parent, tag) {
  return parent.querySelector(tag)?.textContent?.trim() || '';
}

function extractImage(item, html) {
  // media:content / enclosure
  const media =
    item.querySelector('content')?.getAttribute('url') ||
    item.querySelector('enclosure')?.getAttribute('url') ||
    item.getElementsByTagName?.('media:content')?.[0]?.getAttribute?.('url');
  if (media && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(media)) return media;

  if (html) {
    const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m) return m[1];
  }
  return null;
}

/**
 * Google News items often lack images. Try to enrich a few via
 * Open Graph on the article page — best-effort, non-blocking, limited.
 */
export async function enrichArticleImage(article) {
  if (article.imageUrl) return article.imageUrl;
  if (!article.url) return null;
  try {
    // Use a lightweight approach: duckduckgo icoz / or skip heavy scrapes
    // Prefer unavatar / google favicon as last-resort visual — not article image
    // For news cards, generate a gradient placeholder keyed by publisher
    return null;
  } catch {
    return null;
  }
}

/**
 * Placeholder gradient for articles without images.
 */
export function placeholderImage(seed) {
  const colors = [
    ['#2c2b33', '#4a3f7a'],
    ['#1e2a3a', '#2d5a4a'],
    ['#3a1e2a', '#6a3a4a'],
    ['#1a2a3a', '#3a5a7a'],
    ['#2a2a1a', '#5a5a3a'],
    ['#2a1a3a', '#5a3a7a'],
  ];
  let h = 0;
  const s = String(seed || 'x');
  for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i) * (i + 1)) % colors.length;
  const [a, b] = colors[h];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${a}"/><stop offset="100%" stop-color="${b}"/>
    </linearGradient></defs>
    <rect width="800" height="500" fill="url(#g)"/>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export { uid };
