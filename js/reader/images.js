/**
 * Per-source image quality: small | medium | large.
 * Large tries hard for original / full-size art (og:image, URL upgrades, page scrape).
 */

import { safeHttpUrl } from '../utils.js';

export const IMAGE_QUALITY = {
  SMALL: 'small',
  MEDIUM: 'medium',
  LARGE: 'large',
};

export const IMAGE_QUALITY_OPTIONS = [
  {
    value: 'small',
    label: 'Small',
    hint: 'Feed thumbnails only — fastest, lowest bandwidth',
  },
  {
    value: 'medium',
    label: 'Medium',
    hint: 'Prefer larger feed images; fill gaps with Open Graph',
  },
  {
    value: 'large',
    label: 'Large',
    hint: 'Best effort original: upgrade thumbs, scrape article for full-size',
  },
];

export function normalizeImageQuality(q) {
  if (q === 'small' || q === 'medium' || q === 'large') return q;
  return 'medium';
}

/**
 * Resolve the best display image for an item given subscription quality.
 * @returns {{ url: string|null, quality: string, source: string }}
 */
export async function resolveItemImage(item, quality = 'medium') {
  const q = normalizeImageQuality(quality);
  const feedImg = safeHttpUrl(item.imageUrl) || null;
  const pageUrl = safeHttpUrl(item.url) || null;

  if (q === 'small') {
    // Use feed-provided image only; optionally strip nothing — keep as-is
    return { url: feedImg, quality: q, source: feedImg ? 'feed' : 'none' };
  }

  if (q === 'medium') {
    // Prefer upgraded feed URL; if missing/tiny, try og:image
    let url = upgradeImageUrl(feedImg, 'medium') || feedImg;
    if (!url && pageUrl) {
      const page = await fetchPageImages(pageUrl, { preferLarge: false });
      if (page?.url) return { url: page.url, quality: q, source: page.source };
    }
    // If feed image looks like a tiny thumb, try page og
    if (url && looksLikeThumbnail(url) && pageUrl) {
      const page = await fetchPageImages(pageUrl, { preferLarge: false });
      if (page?.url && !looksLikeThumbnail(page.url)) {
        return { url: page.url, quality: q, source: page.source };
      }
    }
    return { url, quality: q, source: url ? 'feed' : 'none' };
  }

  // large — original / biggest available
  const candidates = [];

  if (feedImg) {
    candidates.push({ url: feedImg, score: scoreUrl(feedImg, 10), source: 'feed' });
    const upgraded = upgradeImageUrl(feedImg, 'large');
    if (upgraded && upgraded !== feedImg) {
      candidates.push({ url: upgraded, score: scoreUrl(upgraded, 40), source: 'feed-upgrade' });
    }
  }

  // Collect from content HTML if present
  if (item.contentHtml) {
    for (const u of extractImgsFromHtml(item.contentHtml)) {
      candidates.push({
        url: u,
        score: scoreUrl(u, 20),
        source: 'content',
      });
    }
  }

  if (pageUrl) {
    const page = await fetchPageImages(pageUrl, { preferLarge: true });
    if (page?.url) {
      candidates.push({
        url: page.url,
        score: scoreUrl(page.url, 80) + (page.width || 0) / 10,
        source: page.source,
      });
      if (page.all) {
        for (const p of page.all) {
          candidates.push({
            url: p.url,
            score: scoreUrl(p.url, 50) + (p.width || 0) / 10,
            source: p.source || 'page',
          });
        }
      }
    }
  }

  // Dedup and pick highest score
  const best = pickBestCandidate(candidates);
  if (best) return { url: best.url, quality: q, source: best.source };

  return { url: feedImg, quality: q, source: feedImg ? 'feed' : 'none' };
}

/**
 * Upgrade common resized/thumbnail URL patterns toward originals.
 */
export function upgradeImageUrl(url, quality = 'large') {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('data:')) return url;

  let out = url;

  // WordPress and many CMS: image-300x200.jpg → image.jpg
  out = out.replace(/[-_](\d{2,4})x(\d{2,4})(?=\.[a-z]{3,4}(?:\?|$))/i, '');

  // ?w=150&h=150 or width= / height=
  try {
    const u = new URL(out);
    if (quality === 'large') {
      ['w', 'h', 'width', 'height', 'resize', 'fit', 'quality', 'q', 'size', 's'].forEach((k) => {
        if (u.searchParams.has(k)) u.searchParams.delete(k);
      });
      // Common CDN size path segments
      u.pathname = u.pathname
        .replace(/\/(thumb|thumbnail|small|medium|resized)\//gi, '/')
        .replace(/\/\d+x\d+\//g, '/');
      out = u.href;
    } else if (quality === 'medium') {
      // Bump tiny dims if present
      if (u.searchParams.has('w')) {
        const w = parseInt(u.searchParams.get('w'), 10);
        if (w > 0 && w < 600) u.searchParams.set('w', '800');
      }
      if (u.searchParams.has('width')) {
        const w = parseInt(u.searchParams.get('width'), 10);
        if (w > 0 && w < 600) u.searchParams.set('width', '800');
      }
      out = u.href;
    }
  } catch {
    /* keep out */
  }

  // Google user content / lh3 size flags =s128 → =s0 or larger
  out = out.replace(/=s\d+(-[a-z])?/i, quality === 'large' ? '=s0' : '=s800');
  // =w100-h100
  out = out.replace(/=w\d+-h\d+/i, quality === 'large' ? '=w0-h0' : '=w1200-h0');

  // Substack CDN often has /_next/image?url= encoded original
  try {
    const u = new URL(out);
    if (u.pathname.includes('/_next/image') && u.searchParams.get('url')) {
      out = decodeURIComponent(u.searchParams.get('url'));
    }
  } catch {
    /* ignore */
  }

  return out !== url ? out : quality === 'large' ? out : url;
}

export function looksLikeThumbnail(url) {
  if (!url) return true;
  const s = url.toLowerCase();
  if (/[-_]\d{2,3}x\d{2,3}\./.test(s)) return true;
  if (/\/(thumb|thumbnail|small|icon)s?\//i.test(s)) return true;
  if (/[?&](w|width|s)=\d{1,3}\b/.test(s)) return true;
  if (/=s\d{2,3}\b/.test(s)) return true;
  return false;
}

function scoreUrl(url, base = 0) {
  if (!url) return -1;
  let score = base;
  if (!looksLikeThumbnail(url)) score += 25;
  if (/\.(jpe?g|png|webp)(\?|$)/i.test(url)) score += 5;
  if (/og|original|full|large|hero|featured/i.test(url)) score += 15;
  if (looksLikeThumbnail(url)) score -= 30;
  // Longer paths sometimes mean full assets
  if (url.length > 80) score += 3;
  return score;
}

function pickBestCandidate(candidates) {
  const map = new Map();
  for (const c of candidates) {
    if (!c?.url) continue;
    const key = c.url.split('?')[0].toLowerCase();
    const prev = map.get(key);
    if (!prev || c.score > prev.score) map.set(key, c);
  }
  const list = [...map.values()].sort((a, b) => b.score - a.score);
  return list[0] || null;
}

function extractImgsFromHtml(html) {
  if (!html) return [];
  const urls = [];
  const re = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const src = m[1];
    if (src && !src.startsWith('data:') && !/1x1|pixel|spacer|emoji/i.test(src)) {
      urls.push(src);
      // srcset largest
      const full = m[0];
      const srcset = full.match(/srcset=["']([^"']+)["']/i);
      if (srcset) {
        const best = largestFromSrcset(srcset[1]);
        if (best) urls.push(best);
      }
    }
  }
  return urls;
}

function largestFromSrcset(srcset) {
  let best = null;
  let bestW = 0;
  for (const part of srcset.split(',')) {
    const bits = part.trim().split(/\s+/);
    const u = bits[0];
    const w = parseInt((bits[1] || '').replace(/w$/, ''), 10) || 0;
    if (u && w >= bestW) {
      bestW = w;
      best = u;
    }
  }
  return best;
}

/**
 * Scrape article page for og:image / twitter:image / largest content image.
 */
export async function fetchPageImages(pageUrl, { preferLarge = true } = {}) {
  if (!pageUrl) return null;
  try {
    const res = await fetch(pageUrl, {
      credentials: 'omit',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        // Some CDNs soft-block empty UA
        'User-Agent': 'CandyFeedReader/1.0',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    return extractImagesFromPageHtml(html, { preferLarge, baseUrl: pageUrl });
  } catch {
    return null;
  }
}

export function extractImagesFromPageHtml(html, { preferLarge = true, baseUrl = '' } = {}) {
  const found = [];

  const metaProps = [
    ['og:image:secure_url', 100],
    ['og:image:url', 95],
    ['og:image', 90],
    ['twitter:image:src', 85],
    ['twitter:image', 80],
  ];

  for (const [prop, score] of metaProps) {
    const re1 = new RegExp(
      `<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`,
      'i'
    );
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`,
      'i'
    );
    const re3 = new RegExp(
      `<meta[^>]+name=["']${prop}["'][^>]+content=["']([^"']+)["']`,
      'i'
    );
    const m = html.match(re1) || html.match(re2) || html.match(re3);
    if (m?.[1]) {
      found.push({
        url: absolutize(m[1], baseUrl),
        score,
        source: prop,
        width: metaWidth(html, prop),
      });
    }
  }

  // link rel=image_src
  const linkImg = html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i);
  if (linkImg?.[1]) {
    found.push({
      url: absolutize(linkImg[1], baseUrl),
      score: 70,
      source: 'image_src',
    });
  }

  if (preferLarge) {
    // Largest <img> by width/height attrs or srcset
    const imgRe = /<img\b([^>]+)>/gi;
    let im;
    while ((im = imgRe.exec(html))) {
      const attrs = im[1];
      const src = attr(attrs, 'src');
      if (!src || src.startsWith('data:') || /avatar|logo|icon|sprite|emoji|1x1/i.test(src)) {
        continue;
      }
      const w = parseInt(attr(attrs, 'width') || '0', 10) || 0;
      const h = parseInt(attr(attrs, 'height') || '0', 10) || 0;
      const srcset = attr(attrs, 'srcset');
      const fromSet = srcset ? largestFromSrcset(srcset) : null;
      const url = absolutize(fromSet || src, baseUrl);
      let score = 30 + Math.min(w, 2000) / 20;
      if (w >= 800) score += 40;
      if (w >= 1200) score += 20;
      if (h >= 600) score += 10;
      if (looksLikeThumbnail(url)) score -= 40;
      found.push({ url, score, source: 'img', width: w });
    }
  }

  // Upgrade candidates
  const upgraded = [];
  for (const f of found) {
    upgraded.push(f);
    const u = upgradeImageUrl(f.url, preferLarge ? 'large' : 'medium');
    if (u && u !== f.url) {
      upgraded.push({ ...f, url: u, score: f.score + 15, source: `${f.source}-upgrade` });
    }
  }

  const best = pickBestCandidate(
    upgraded.map((f) => ({ url: f.url, score: f.score, source: f.source, width: f.width }))
  );
  if (!best) return null;
  return {
    url: best.url,
    source: best.source,
    width: best.width,
    all: upgraded.map((f) => ({ url: f.url, source: f.source, width: f.width })),
  };
}

function metaWidth(html, prop) {
  if (!prop.startsWith('og:image')) return 0;
  const m = html.match(/property=["']og:image:width["'][^>]+content=["'](\d+)["']/i)
    || html.match(/content=["'](\d+)["'][^>]+property=["']og:image:width["']/i);
  return m ? parseInt(m[1], 10) : 0;
}

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`${name}=["']([^"']+)["']`, 'i'));
  return m?.[1] || '';
}

function absolutize(url, base) {
  if (!url) return url;
  return safeHttpUrl(url, base || undefined) || null;
}

/**
 * From RSS/Atom item element, collect image candidates ranked by declared size.
 * Used at parse time so large quality can pick media:content over tiny thumbnails.
 */
export function collectMediaCandidates(itemEl) {
  const out = [];
  if (!itemEl?.children) return out;

  const walk = (el) => {
    for (const child of el.children || []) {
      const local = (child.localName || '').toLowerCase();
      const tag = (child.tagName || '').toLowerCase();
      const url =
        child.getAttribute('url') ||
        child.getAttribute('href') ||
        (local === 'url' ? child.textContent?.trim() : null);
      const type = (child.getAttribute('type') || child.getAttribute('medium') || '').toLowerCase();
      const w = parseInt(child.getAttribute('width') || '0', 10) || 0;
      const h = parseInt(child.getAttribute('height') || '0', 10) || 0;

      const isImage =
        type.startsWith('image') ||
        type === 'image' ||
        (url && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url)) ||
        local === 'thumbnail' ||
        local === 'content' && type.includes('image') ||
        (local === 'content' && url && !type.startsWith('video') && !type.startsWith('audio'));

      if (url && (isImage || local === 'thumbnail' || tag.includes('thumbnail'))) {
        let score = w || 0;
        if (local === 'thumbnail' || tag.includes('thumbnail')) score -= 50;
        if (local === 'content' || tag.includes('content')) score += 30;
        if (w >= 800) score += 100;
        out.push({ url, width: w, height: h, score, source: local || tag });
      }

      if (local === 'group' || tag.includes('group')) walk(child);
      // enclosure
      if (local === 'enclosure' || tag === 'enclosure') {
        const encUrl = child.getAttribute('url');
        const encType = (child.getAttribute('type') || '').toLowerCase();
        if (encUrl && encType.startsWith('image/')) {
          out.push({
            url: encUrl,
            width: 0,
            height: 0,
            score: 50,
            source: 'enclosure',
          });
        }
      }
    }
  };
  walk(itemEl);
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Pick feed-native image for a given quality from candidates + html fallback.
 */
export function pickFeedImage(candidates, html, quality = 'medium') {
  const q = normalizeImageQuality(quality);
  const list = [...(candidates || [])];
  const htmlImgs = extractImgsFromHtml(html);
  for (const u of htmlImgs) {
    list.push({ url: u, score: scoreUrl(u, 15), source: 'html' });
  }
  if (!list.length) return null;

  if (q === 'small') {
    // Prefer actual thumbnails / smallest declared
    const thumbs = list.filter((c) => looksLikeThumbnail(c.url) || (c.width > 0 && c.width < 400));
    if (thumbs.length) {
      thumbs.sort((a, b) => (a.width || 9999) - (b.width || 9999));
      return thumbs[0].url;
    }
    return list[list.length - 1]?.url || list[0].url;
  }

  // medium / large — biggest score; large upgrades URL
  list.sort((a, b) => b.score - a.score);
  let url = list[0].url;
  if (q === 'large') {
    url = upgradeImageUrl(url, 'large') || url;
  } else if (q === 'medium') {
    url = upgradeImageUrl(url, 'medium') || url;
  }
  return url;
}
