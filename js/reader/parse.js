/**
 * Unified feed parser: RSS 2.0, Atom, XML, JSON Feed, Substack RSS.
 * Normalizes into { feed, items[] }.
 */

import { hostFromUrl } from '../utils.js';
import { collectMediaCandidates, pickFeedImage } from './images.js';

/**
 * Fetch URL, auto-detect format, return normalized feed + items.
 */
export async function fetchAndParseFeed(url) {
  const res = await fetch(url, {
    credentials: 'omit',
    headers: { Accept: 'application/feed+json, application/json, application/atom+xml, application/rss+xml, application/xml, text/xml, */*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const text = await res.text();
  return parseFeedText(text, { contentType, sourceUrl: url });
}

/**
 * Validate / detect by parsing body without full persistence.
 */
export function parseFeedText(text, { contentType = '', sourceUrl = '' } = {}) {
  const trimmed = (text || '').trim();
  if (!trimmed) throw new Error('Empty response');

  // JSON Feed
  if (
    contentType.includes('json') ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[')
  ) {
    try {
      return parseJsonFeed(JSON.parse(trimmed), sourceUrl);
    } catch (e) {
      if (contentType.includes('json') || trimmed.startsWith('{')) {
        throw new Error(`JSON Feed parse failed: ${e.message}`);
      }
      // fall through to XML
    }
  }

  return parseXmlFeed(trimmed, sourceUrl);
}

function parseJsonFeed(data, sourceUrl) {
  // JSON Feed 1.0/1.1
  if (!data || (data.version && !String(data.version).includes('jsonfeed') && !data.items)) {
    // Some APIs return { items: [] } without version
    if (!Array.isArray(data.items) && !Array.isArray(data)) {
      throw new Error('Not a JSON Feed');
    }
  }

  const itemsRaw = Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : [];
  const feed = {
    title: data.title || hostFromUrl(sourceUrl) || 'Untitled feed',
    siteUrl: data.home_page_url || data.home_page || sourceUrl,
    description: data.description || '',
    format: 'json',
    image: data.icon || data.favicon || null,
  };

  const items = itemsRaw.map((it) => {
    const link = it.url || it.external_url || it.id || '';
    const contentHtml = it.content_html || it.content_text || it.summary || '';
    const image =
      it.image ||
      it.banner_image ||
      pickAttachmentImage(it.attachments) ||
      firstImgInHtml(contentHtml) ||
      null;

    return {
      title: it.title || 'Untitled',
      url: link,
      guid: String(it.id || link),
      summary: stripHtml(it.summary || it.content_text || '').slice(0, 400),
      contentHtml: typeof contentHtml === 'string' ? contentHtml : '',
      imageUrl: image,
      author: it.author?.name || it.authors?.[0]?.name || '',
      publishedAt: parseDate(it.date_published || it.date_modified),
    };
  });

  return { feed, items };
}

function pickAttachmentImage(attachments) {
  if (!Array.isArray(attachments)) return null;
  for (const a of attachments) {
    const mime = (a.mime_type || a.type || '').toLowerCase();
    const url = a.url || a.href;
    if (url && (mime.startsWith('image/') || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url))) {
      return url;
    }
  }
  return null;
}

function parseXmlFeed(xmlText, sourceUrl) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Invalid XML — not a recognized feed');
  }

  // Atom
  const atomFeed = doc.querySelector('feed');
  if (atomFeed && doc.querySelector('entry')) {
    return parseAtom(doc, sourceUrl);
  }

  // RSS 2.0 / RDF / generic channel
  const channel = doc.querySelector('channel') || doc.querySelector('rdf\\:RDF, RDF');
  if (channel || doc.querySelector('item')) {
    return parseRss(doc, sourceUrl);
  }

  throw new Error('Unrecognized feed format (expected RSS, Atom, or JSON Feed)');
}

function parseRss(doc, sourceUrl) {
  const channel = doc.querySelector('channel') || doc.documentElement;
  const title = textOf(channel, 'title') || hostFromUrl(sourceUrl) || 'Untitled feed';
  const link = textOf(channel, 'link') || sourceUrl;
  const description = textOf(channel, 'description') || '';
  const image =
    channel.querySelector('image url')?.textContent?.trim() ||
    channel.querySelector('image')?.getAttribute?.('href') ||
    null;

  const items = [...doc.querySelectorAll('item')].map((item) => {
    const itemTitle = textOf(item, 'title') || 'Untitled';
    const itemLink = textOf(item, 'link') || attrOf(item, 'link', 'href') || '';
    const guid = textOf(item, 'guid') || itemLink;
    const desc = textOf(item, 'description') || textOf(item, 'content\\:encoded') || getContentEncoded(item);
    const pubDate = textOf(item, 'pubDate') || textOf(item, 'dc\\:date') || textOf(item, 'date');
    const author =
      textOf(item, 'author') ||
      textOf(item, 'dc\\:creator') ||
      textOf(item, 'creator') ||
      '';
    const mediaCandidates = collectMediaCandidates(item);
    const imageUrl = pickFeedImage(mediaCandidates, desc, 'medium') || extractItemImage(item, desc);

    return {
      title: itemTitle,
      url: itemLink,
      guid,
      summary: stripHtml(desc).slice(0, 400),
      contentHtml: desc,
      imageUrl,
      imageCandidates: mediaCandidates.map((c) => c.url).filter(Boolean),
      author,
      publishedAt: parseDate(pubDate),
    };
  });

  return {
    feed: {
      title,
      siteUrl: link,
      description,
      format: 'rss',
      image,
    },
    items,
  };
}

function parseAtom(doc, sourceUrl) {
  const feedEl = doc.querySelector('feed');
  const title = textOf(feedEl, 'title') || hostFromUrl(sourceUrl) || 'Untitled feed';
  const siteUrl =
    feedEl.querySelector('link[rel="alternate"]')?.getAttribute('href') ||
    feedEl.querySelector('link')?.getAttribute('href') ||
    sourceUrl;
  const description = textOf(feedEl, 'subtitle') || textOf(feedEl, 'summary') || '';
  const image =
    feedEl.querySelector('logo')?.textContent?.trim() ||
    feedEl.querySelector('icon')?.textContent?.trim() ||
    null;

  const items = [...doc.querySelectorAll('entry')].map((entry) => {
    const itemTitle = textOf(entry, 'title') || 'Untitled';
    const itemLink =
      entry.querySelector('link[rel="alternate"]')?.getAttribute('href') ||
      entry.querySelector('link')?.getAttribute('href') ||
      '';
    const guid = textOf(entry, 'id') || itemLink;
    const content =
      getAtomContent(entry, 'content') ||
      getAtomContent(entry, 'summary') ||
      '';
    const pubDate = textOf(entry, 'published') || textOf(entry, 'updated');
    const author = entry.querySelector('author name')?.textContent?.trim() || '';
    const mediaCandidates = collectMediaCandidates(entry);
    const imageUrl =
      pickFeedImage(mediaCandidates, content, 'medium') || extractItemImage(entry, content);

    return {
      title: itemTitle,
      url: itemLink,
      guid,
      summary: stripHtml(content).slice(0, 400),
      contentHtml: content,
      imageUrl,
      imageCandidates: mediaCandidates.map((c) => c.url).filter(Boolean),
      author,
      publishedAt: parseDate(pubDate),
    };
  });

  return {
    feed: {
      title,
      siteUrl,
      description,
      format: 'atom',
      image,
    },
    items,
  };
}

function getAtomContent(entry, tag) {
  const el = entry.querySelector(tag);
  if (!el) return '';
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'html' || type === 'xhtml') return el.innerHTML || el.textContent || '';
  return el.textContent || '';
}

function getContentEncoded(item) {
  // content:encoded with namespace
  const nodes = item.getElementsByTagNameNS
    ? item.getElementsByTagNameNS('http://purl.org/rss/1.0/modules/content/', 'encoded')
    : [];
  if (nodes[0]) return nodes[0].textContent || '';
  // fallback local name
  for (const child of item.children || []) {
    if (child.localName === 'encoded' || child.tagName?.endsWith?.(':encoded')) {
      return child.textContent || '';
    }
  }
  return '';
}

function extractItemImage(item, html) {
  // media:content / media:thumbnail
  const mediaContent = findMediaUrl(item, 'content');
  if (mediaContent) return mediaContent;
  const mediaThumb = findMediaUrl(item, 'thumbnail');
  if (mediaThumb) return mediaThumb;

  // enclosure
  const enc = item.querySelector('enclosure');
  if (enc) {
    const type = (enc.getAttribute('type') || '').toLowerCase();
    const url = enc.getAttribute('url');
    if (url && (type.startsWith('image/') || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url))) {
      return url;
    }
  }

  // itunes:image
  const itunes = item.querySelector('image');
  const href = itunes?.getAttribute('href') || itunes?.getAttribute('url');
  if (href) return href;

  return firstImgInHtml(html);
}

function findMediaUrl(item, localName) {
  for (const child of item.children || []) {
    if (child.localName === localName || child.tagName?.toLowerCase?.().endsWith(`:${localName}`)) {
      const url = child.getAttribute('url') || child.getAttribute('href');
      const type = (child.getAttribute('type') || child.getAttribute('medium') || '').toLowerCase();
      if (url && (type.startsWith('image') || type === '' || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url))) {
        return url;
      }
    }
  }
  // media:group nested
  const group = [...(item.children || [])].find(
    (c) => c.localName === 'group' || c.tagName?.toLowerCase?.().includes('group')
  );
  if (group) return findMediaUrl(group, localName);
  return null;
}

function firstImgInHtml(html) {
  if (!html) return null;
  const m = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

/**
 * Best-effort og:image from article page (background enrich only).
 * Prefer resolveItemImage() for quality-aware resolution.
 */
export async function fetchOgImage(pageUrl) {
  const { fetchPageImages } = await import('./images.js');
  const page = await fetchPageImages(pageUrl, { preferLarge: false });
  return page?.url || null;
}

function textOf(parent, selector) {
  if (!parent) return '';
  // Try simple tag; namespaced via localName scan if needed
  const direct = parent.querySelector?.(selector);
  if (direct?.textContent) return direct.textContent.trim();

  // namespaced fallback e.g. content:encoded
  if (selector.includes('\\:')) {
    const local = selector.split('\\:').pop();
    for (const child of parent.children || []) {
      if (child.localName === local) return (child.textContent || '').trim();
    }
  }
  return '';
}

function attrOf(parent, selector, attr) {
  return parent.querySelector?.(selector)?.getAttribute(attr) || '';
}

function parseDate(s) {
  if (!s) return Date.now();
  const t = Date.parse(s);
  return Number.isNaN(t) ? Date.now() : t;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export { stripHtml };
