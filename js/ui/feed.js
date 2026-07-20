/**
 * News feed UI — sections, asymmetrical cards, infinite scroll,
 * skeleton on first run, silent merge of background updates.
 */

import { getConfig, updateConfig } from '../config.js';
import {
  loadFeedFromCache,
  backgroundRefreshStale,
  refreshCategory,
  pageArticles,
  articleImageSrc,
} from '../news/news.js';
import { getCachedImageUrl } from '../storage/cache-api.js';
import { getCachedFavicon, ensureFavicon } from '../favicon.js';
import { el, safeHttpUrl } from '../utils.js';

const PAGE_SIZE = 12;
/** @type {Map<string, { articles: any[], page: number, hasMore: boolean }>} */
const sectionState = new Map();

export async function initFeed() {
  const root = document.getElementById('feed-root');
  if (!root) return;

  const cfg = getConfig();
  if (!cfg.content?.enabled) {
    root.innerHTML = '';
    return;
  }

  const { sections } = await loadFeedFromCache();

  root.innerHTML = '';

  if (!sections.length) {
    root.append(
      el('div', {
        className: 'feed-empty',
        text: 'No topics followed. Open Settings → Manage Topics to follow categories.',
      })
    );
    return;
  }

  for (const section of sections) {
    const sectionEl = buildSection(section);
    root.append(sectionEl);
  }

  // Page-level sentinel for loading more across sections near bottom
  const sentinel = el('div', { className: 'feed-sentinel', 'aria-hidden': 'true' });
  root.append(sentinel);
  observeSentinel(sentinel);

  // Background refresh after paint
  queueBackground(() => {
    backgroundRefreshStale((categoryId, result) => {
      mergeSectionUpdate(categoryId, result);
    });
  });
}

function buildSection(section) {
  const { topic, articles, hasCache } = section;
  const wrap = el('section', {
    className: 'section',
    id: `section-${topic.id}`,
    dataset: { category: topic.id },
  });

  const header = el('div', { className: 'section__header' }, [
    el('h2', { className: 'section__title', text: topic.label }),
  ]);

  const actions = el('div', { className: 'section__actions' });

  const followBtn = el('button', {
    type: 'button',
    className: `btn btn--sm section__follow ${topic.following ? 'btn--soft' : 'btn--ghost'}`,
    text: topic.following ? 'Following' : 'Follow',
    dataset: { following: topic.following ? '1' : '0' },
  });
  followBtn.addEventListener('click', () => {
    const next = followBtn.dataset.following !== '1';
    updateConfig((c) => ({
      ...c,
      topics: c.topics.map((t) =>
        t.id === topic.id ? { ...t, following: next } : t
      ),
    }));
    followBtn.dataset.following = next ? '1' : '0';
    followBtn.textContent = next ? 'Following' : 'Follow';
    followBtn.className = `btn btn--sm section__follow ${next ? 'btn--soft' : 'btn--ghost'}`;
    if (!next) {
      wrap.remove();
    }
  });

  const refreshBtn = el('button', {
    type: 'button',
    className: 'section__refresh-btn',
    title: 'Refresh section',
    'aria-label': `Refresh ${topic.label}`,
    html: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`,
  });
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.classList.add('is-spinning');
    const result = await refreshCategory(topic.id, topic.query);
    refreshBtn.classList.remove('is-spinning');
    if (result) mergeSectionUpdate(topic.id, result, { replace: true });
  });

  const menuBtn = el('button', {
    type: 'button',
    className: 'section__menu-btn',
    title: 'Options',
    'aria-label': `Options for ${topic.label}`,
    html: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>`,
  });
  menuBtn.addEventListener('click', (e) => {
    showSectionMenu(e.currentTarget, topic);
  });

  actions.append(followBtn, refreshBtn, menuBtn);
  header.append(actions);
  wrap.append(header);

  const grid = el('div', { className: 'card-grid', dataset: { category: topic.id } });

  if (!hasCache || !articles.length) {
    grid.append(...buildSkeletons(6));
    // Kick first fetch
    queueBackground(async () => {
      const result = await refreshCategory(topic.id, topic.query);
      if (result) mergeSectionUpdate(topic.id, result, { replace: true });
    });
  } else {
    const page = pageArticles(articles, 0, PAGE_SIZE);
    sectionState.set(topic.id, {
      articles,
      page: 0,
      hasMore: page.hasMore,
    });
    for (const a of page.items) {
      grid.append(buildCard(a));
    }
  }

  wrap.append(grid);
  return wrap;
}

function buildSkeletons(n) {
  const nodes = [];
  for (let i = 0; i < n; i++) {
    nodes.push(
      el('div', { className: 'skeleton-card', 'aria-hidden': 'true' }, [
        el('div', { className: 'skeleton-media' }),
        el('div', { className: 'skeleton-line skeleton-line--title' }),
        el('div', { className: 'skeleton-line skeleton-line--meta' }),
      ])
    );
  }
  return nodes;
}

function buildCard(article, { isNew = false } = {}) {
  const card = el('article', {
    className: `card${isNew ? ' is-new' : ''}`,
    dataset: { id: article.id },
  });

  const href = safeHttpUrl(article.url) || '#';
  const link = el('a', {
    className: 'card__link',
    href,
    target: href === '#' ? undefined : '_blank',
    rel: 'noopener noreferrer',
  });

  const media = el('div', { className: 'card__media' });
  const img = el('img', {
    alt: '',
    loading: 'lazy',
    decoding: 'async',
  });
  // Resolve image async without blocking structure
  resolveCardImage(article, img);
  media.append(img);

  if (article.duration) {
    media.append(el('span', { className: 'card__badge', text: article.duration }));
  }

  const body = el('div', { className: 'card__body' }, [
    el('h3', { className: 'card__title', text: article.title }),
  ]);

  const meta = el('div', { className: 'card__meta' });
  const fav = el('img', {
    className: 'card__favicon',
    alt: '',
    width: '16',
    height: '16',
  });
  resolveFavicon(article, fav);
  meta.append(
    fav,
    el('span', { className: 'card__publisher', text: article.publisher || 'News' })
  );
  body.append(meta);

  link.append(media, body);
  card.append(link);
  return card;
}

async function resolveCardImage(article, imgEl) {
  const src = articleImageSrc(article);
  try {
    const cached = await getCachedImageUrl(src);
    imgEl.src = cached || src;
  } catch {
    imgEl.src = src;
  }
}

async function resolveFavicon(article, imgEl) {
  const host = article.publisherHost || article.url;
  try {
    let url = await getCachedFavicon(host);
    if (!url) url = await ensureFavicon(host);
    if (url) imgEl.src = url;
  } catch {
    /* ignore */
  }
}

/**
 * Merge background refresh into DOM without jarring scroll.
 */
function mergeSectionUpdate(categoryId, result, { replace = false } = {}) {
  const section = document.getElementById(`section-${categoryId}`);
  if (!section || !result) return;

  const grid = section.querySelector('.card-grid');
  if (!grid) return;

  const { articles, newIds } = result;
  const state = sectionState.get(categoryId) || {
    articles: [],
    page: 0,
    hasMore: true,
  };
  state.articles = articles;

  if (replace || grid.querySelector('.skeleton-card')) {
    grid.innerHTML = '';
    const page = pageArticles(articles, 0, PAGE_SIZE);
    state.page = 0;
    state.hasMore = page.hasMore;
    for (const a of page.items) {
      grid.append(buildCard(a, { isNew: newIds?.has(a.id) }));
    }
    sectionState.set(categoryId, state);
    return;
  }

  // Insert only brand-new cards at the top without clearing existing
  if (newIds?.size) {
    const existingIds = new Set(
      [...grid.querySelectorAll('.card')].map((n) => n.dataset.id)
    );
    const toInsert = articles.filter((a) => newIds.has(a.id) && !existingIds.has(a.id));
    // Insert in reverse so first new ends up first
    for (const a of toInsert.reverse()) {
      const card = buildCard(a, { isNew: true });
      grid.prepend(card);
    }
  }

  sectionState.set(categoryId, state);
}

/** Single observer reused across feed re-inits */
let feedIo = null;

function observeSentinel(sentinel) {
  if (!('IntersectionObserver' in window)) return;
  if (!feedIo) {
    feedIo = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) loadMoreNearBottom();
        }
      },
      { rootMargin: '400px 0px' }
    );
  } else {
    feedIo.disconnect();
  }
  feedIo.observe(sentinel);
}

function loadMoreNearBottom() {
  for (const [categoryId, state] of sectionState) {
    if (!state.hasMore) continue;
    const nextPage = state.page + 1;
    const next = pageArticles(state.articles, nextPage, PAGE_SIZE);
    if (!next.items.length) {
      state.hasMore = false;
      sectionState.set(categoryId, state);
      continue;
    }
    const grid = document.querySelector(`.card-grid[data-category="${categoryId}"]`);
    if (!grid) continue;
    for (const a of next.items) {
      grid.append(buildCard(a));
    }
    state.page = nextPage;
    state.hasMore = next.hasMore;
    sectionState.set(categoryId, state);
  }
}

function showSectionMenu(anchor, topic) {
  const menu = document.getElementById('ctx-menu');
  if (!menu) return;
  menu.innerHTML = '';
  menu.hidden = false;

  const unfollow = el('button', {
    type: 'button',
    className: 'ctx-menu__item',
    text: 'Unfollow topic',
  });
  unfollow.addEventListener('click', () => {
    updateConfig((c) => ({
      ...c,
      topics: c.topics.map((t) =>
        t.id === topic.id ? { ...t, following: false } : t
      ),
    }));
    document.getElementById(`section-${topic.id}`)?.remove();
    menu.hidden = true;
  });

  const refresh = el('button', {
    type: 'button',
    className: 'ctx-menu__item',
    text: 'Refresh now',
  });
  refresh.addEventListener('click', async () => {
    menu.hidden = true;
    const result = await refreshCategory(topic.id, topic.query);
    if (result) mergeSectionUpdate(topic.id, result, { replace: true });
  });

  menu.append(refresh, unfollow);

  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 180)}px`;
  menu.style.top = `${rect.bottom + 4}px`;

  setTimeout(() => {
    document.addEventListener(
      'mousedown',
      (e) => {
        if (!menu.contains(e.target)) menu.hidden = true;
      },
      { once: true }
    );
  }, 0);
}

function queueBackground(fn) {
  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => fn(), { timeout: 2000 });
  } else {
    setTimeout(fn, 100);
  }
}

export async function refreshFeed() {
  await initFeed();
}
