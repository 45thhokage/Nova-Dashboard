/**
 * Quick-search overlay — local tabs/bookmarks + AI provider hand-off.
 *
 * Perf rules:
 * - Icon + overlay markup are static in newtab.html (no layout shift / no build-on-click).
 * - Never call tabs/bookmarks APIs on page load; only when the overlay opens.
 * - Debounce filtering (~140ms); cap result counts; CSS-only open/close.
 */

import { debounce } from '../utils.js';
import { getConfig, updateConfig } from '../config.js';

/** @typedef {{ id: string, name: string, template: string, iconHtml: string }} AiProvider */

/**
 * Array-driven providers — one-line add. Icons are inline SVG (no extra network).
 * Official brand mark paths simplified for 18–20px.
 */
export const AI_PROVIDERS = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    template: 'https://chatgpt.com/?q=%s',
    iconHtml: `<svg class="qsearch-provider__svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/></svg>`,
  },
  {
    id: 'claude',
    name: 'Claude',
    template: 'https://claude.ai/new?q=%s',
    iconHtml: `<svg class="qsearch-provider__svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M17.304 3.541h-3.672l6.696 16.918H24Zm-10.608 0L0 20.459h3.744l1.37-3.553h7.005l1.369 3.553h3.744L10.536 3.541Zm-.371 10.223L8.232 8.01l1.401 5.754Z"/></svg>`,
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    template: 'https://www.perplexity.ai/?q=%s',
    iconHtml: `<svg class="qsearch-provider__svg" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M19.712 2H15.47l-3.482 7.555L8.507 2H4.265l5.054 10.36v5.39h1.96v-3.88l1.96-4.25 1.96 4.25v7.13h1.96v-9.64zm-13.97 11.85H3.78V22h1.962zm14.476 0h-1.962V22h1.962z"/></svg>`,
  },
];

const DEBOUNCE_MS = 140;
const MAX_TABS = 12;
const MAX_BOOKMARKS = 12;

/** @type {null | { tabs: Array, bookmarks: Array, loadedAt: number }} */
let _cache = null;
const CACHE_TTL_MS = 30_000;

/** @type {Set<string>} */
let selectedProviders = new Set();

/** @type {number} highlighted index in flat result list (-1 = none) */
let highlightIndex = -1;

/** @type {Array<{ type: 'tab'|'bookmark', title: string, url: string, favIconUrl?: string, tabId?: number, windowId?: number }>} */
let flatResults = [];

let overlayEl;
let panelEl;
let inputEl;
let resultsEl;
let providersEl;
let openBtn;
let isOpen = false;

export function initQuickSearch() {
  openBtn = document.getElementById('qsearch-open');
  overlayEl = document.getElementById('qsearch-overlay');
  panelEl = document.getElementById('qsearch-panel');
  inputEl = document.getElementById('qsearch-input');
  resultsEl = document.getElementById('qsearch-results');
  providersEl = document.getElementById('qsearch-providers');

  if (!openBtn || !overlayEl || !inputEl || !resultsEl || !providersEl) return;

  // Mount provider icons once (static for session)
  renderProviderBar();

  // Restore last-used selection as a single selected provider
  const lastId = getConfig()?.quickSearch?.lastProviderId;
  if (lastId && AI_PROVIDERS.some((p) => p.id === lastId)) {
    selectedProviders = new Set([lastId]);
    syncProviderSelectedUi();
  }

  openBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    open();
  });

  // Click dimmed backdrop closes (panel stops propagation)
  overlayEl.addEventListener('click', (e) => {
    if (e.target === overlayEl) close();
  });
  panelEl?.addEventListener('click', (e) => e.stopPropagation());

  inputEl.addEventListener('input', onInputDebounced);
  inputEl.addEventListener('keydown', onInputKeydown);

  resultsEl.addEventListener('click', onResultsClick);
  resultsEl.addEventListener('mousemove', onResultsMouseMove);

  providersEl.addEventListener('click', onProvidersClick);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) {
      e.preventDefault();
      close();
    }
  });
}

function renderProviderBar() {
  providersEl.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'qsearch__providers-label';
  label.textContent = 'Ask AI';
  providersEl.append(label);

  for (const p of AI_PROVIDERS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qsearch-provider';
    btn.dataset.providerId = p.id;
    btn.title = `${p.name} — click to open · Ctrl+click multi-select · Enter to open selected`;
    btn.setAttribute(
      'aria-label',
      `Open with ${p.name}. Ctrl+click to multi-select, then Enter to open all selected.`
    );
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = p.iconHtml;
    providersEl.append(btn);
  }
}

function syncProviderSelectedUi() {
  providersEl.querySelectorAll('.qsearch-provider').forEach((btn) => {
    const id = btn.dataset.providerId;
    const on = selectedProviders.has(id);
    btn.classList.toggle('is-selected', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

async function open() {
  if (isOpen) return;
  isOpen = true;

  overlayEl.hidden = false;
  // Force reflow so the transition runs
  void overlayEl.offsetWidth;
  overlayEl.classList.add('is-open');

  inputEl.value = '';
  highlightIndex = -1;
  flatResults = [];
  resultsEl.innerHTML = '';
  resultsEl.classList.remove('has-results');

  // Focus after paint so the caret is visible immediately
  requestAnimationFrame(() => {
    inputEl.focus();
  });

  // Resolve live permission state + warm local data only if granted
  await refreshLocalCache({ force: true });
  // If the user typed while the cache was loading, apply the filter now
  if (inputEl.value.trim()) runFilter(inputEl.value);
}

function close() {
  if (!isOpen) return;
  isOpen = false;
  overlayEl.classList.remove('is-open');
  // Wait for CSS transition, then hide (matches settings drawer pattern)
  setTimeout(() => {
    if (!isOpen) overlayEl.hidden = true;
  }, 200);
  openBtn?.focus?.();
}

const onInputDebounced = debounce(() => {
  if (!isOpen) return;
  runFilter(inputEl.value);
}, DEBOUNCE_MS);

/**
 * Check optional permission without throwing if chrome.permissions is missing.
 */
export async function hasOptionalPermission(name) {
  try {
    if (!chrome?.permissions?.contains) return false;
    return await chrome.permissions.contains({ permissions: [name] });
  } catch {
    return false;
  }
}

/**
 * Effective sources: config preference AND live permission grant.
 * Revoked chrome://extensions grants quietly disable the source.
 */
export async function getEffectiveSearchSources() {
  const cfg = getConfig()?.quickSearch || {};
  const wantTabs = !!cfg.searchTabs;
  const wantBookmarks = !!cfg.searchBookmarks;

  const [hasTabs, hasBookmarks] = await Promise.all([
    wantTabs ? hasOptionalPermission('tabs') : Promise.resolve(false),
    wantBookmarks ? hasOptionalPermission('bookmarks') : Promise.resolve(false),
  ]);

  return {
    tabs: wantTabs && hasTabs,
    bookmarks: wantBookmarks && hasBookmarks,
  };
}

async function refreshLocalCache({ force = false } = {}) {
  const sources = await getEffectiveSearchSources();
  if (!sources.tabs && !sources.bookmarks) {
    _cache = { tabs: [], bookmarks: [], loadedAt: Date.now(), sources };
    return _cache;
  }

  if (
    !force &&
    _cache &&
    Date.now() - _cache.loadedAt < CACHE_TTL_MS &&
    _cache.sources?.tabs === sources.tabs &&
    _cache.sources?.bookmarks === sources.bookmarks
  ) {
    return _cache;
  }

  const tabs = sources.tabs ? await loadTabsSafe() : [];
  const bookmarks = sources.bookmarks ? await loadBookmarksSafe() : [];
  _cache = { tabs, bookmarks, loadedAt: Date.now(), sources };
  return _cache;
}

async function loadTabsSafe() {
  try {
    const tabs = await chrome.tabs.query({});
    // Cap early — filter later; drop chrome://newtab and extension pages noise lightly
    const out = [];
    for (const t of tabs) {
      if (!t.id || t.id === chrome.tabs.TAB_ID_NONE) continue;
      const title = t.title || t.url || 'Tab';
      const url = t.url || '';
      out.push({
        type: 'tab',
        tabId: t.id,
        windowId: t.windowId,
        title,
        url,
        favIconUrl: t.favIconUrl || '',
      });
      if (out.length >= 200) break; // hard cap source size
    }
    return out;
  } catch (e) {
    console.warn('[candy] tabs query failed', e);
    return [];
  }
}

async function loadBookmarksSafe() {
  try {
    const tree = await chrome.bookmarks.getTree();
    const out = [];
    flattenBookmarks(tree, out, 200);
    return out;
  } catch (e) {
    console.warn('[candy] bookmarks query failed', e);
    return [];
  }
}

function flattenBookmarks(nodes, out, max) {
  if (!nodes || out.length >= max) return;
  for (const n of nodes) {
    if (out.length >= max) return;
    if (n.url) {
      out.push({
        type: 'bookmark',
        id: n.id,
        title: n.title || n.url,
        url: n.url,
      });
    }
    if (n.children?.length) flattenBookmarks(n.children, out, max);
  }
}

function runFilter(raw) {
  const q = (raw || '').trim().toLowerCase();
  highlightIndex = -1;
  flatResults = [];

  if (!q) {
    renderResults([], false);
    return;
  }

  const cache = _cache || { tabs: [], bookmarks: [] };
  const tabHits = filterList(cache.tabs, q, MAX_TABS);
  const bmHits = filterList(cache.bookmarks, q, MAX_BOOKMARKS);
  flatResults = [...tabHits, ...bmHits];
  renderResults(flatResults, true);
}

function filterList(items, q, max) {
  if (!items?.length) return [];
  const hits = [];
  for (const item of items) {
    const title = (item.title || '').toLowerCase();
    const url = (item.url || '').toLowerCase();
    if (title.includes(q) || url.includes(q)) {
      hits.push(item);
      if (hits.length >= max) break;
    }
  }
  return hits;
}

function renderResults(items, searched) {
  resultsEl.innerHTML = '';
  resultsEl.classList.toggle('has-results', items.length > 0);

  if (!items.length) {
    if (searched) {
      const empty = document.createElement('div');
      empty.className = 'qsearch__empty';
      empty.textContent = 'No matching tabs or bookmarks';
      // Only show empty state if at least one local source is active
      const sources = _cache?.sources;
      if (sources?.tabs || sources?.bookmarks) {
        resultsEl.append(empty);
      }
      // AI-only mode: no empty state — provider row is the product
    }
    return;
  }

  let lastType = null;
  items.forEach((item, index) => {
    if (item.type !== lastType) {
      lastType = item.type;
      const header = document.createElement('div');
      header.className = 'qsearch__group-label';
      header.textContent = item.type === 'tab' ? 'Open tabs' : 'Bookmarks';
      resultsEl.append(header);
    }

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'qsearch__row';
    row.role = 'option';
    row.dataset.index = String(index);
    row.setAttribute('aria-selected', 'false');

    const fav = document.createElement('img');
    fav.className = 'qsearch__fav';
    fav.width = 16;
    fav.height = 16;
    fav.alt = '';
    fav.decoding = 'async';
    fav.loading = 'lazy';
    fav.src = faviconFor(item);
    fav.addEventListener('error', () => {
      fav.src = letterMarkDataUrl(item.title || item.url || '?');
    });

    const text = document.createElement('span');
    text.className = 'qsearch__row-text';

    const title = document.createElement('span');
    title.className = 'qsearch__row-title';
    title.textContent = item.title || item.url || 'Untitled';

    const meta = document.createElement('span');
    meta.className = 'qsearch__row-meta';
    meta.textContent = item.url || '';

    text.append(title, meta);

    const source = document.createElement('span');
    source.className = 'qsearch__row-source';
    source.textContent = item.type === 'tab' ? 'Tab' : 'Bookmark';

    row.append(fav, text, source);
    resultsEl.append(row);
  });
}

function faviconFor(item) {
  if (item.favIconUrl && !item.favIconUrl.startsWith('chrome://')) {
    return item.favIconUrl;
  }
  try {
    const host = new URL(item.url).hostname;
    if (host) {
      return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
    }
  } catch {
    /* ignore */
  }
  return letterMarkDataUrl(item.title || '?');
}

function letterMarkDataUrl(label) {
  const letter = (String(label).trim().match(/[A-Za-z0-9]/)?.[0] || '?').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="6" fill="#35343d"/><text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" fill="#f5f5f7" font-family="system-ui,sans-serif" font-size="14" font-weight="600">${letter}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function setHighlight(index) {
  const rows = resultsEl.querySelectorAll('.qsearch__row');
  rows.forEach((r) => {
    r.classList.remove('is-active');
    r.setAttribute('aria-selected', 'false');
  });
  highlightIndex = index;
  if (index < 0 || index >= rows.length) return;
  const row = rows[index];
  row.classList.add('is-active');
  row.setAttribute('aria-selected', 'true');
  row.scrollIntoView({ block: 'nearest' });
}

function onResultsMouseMove(e) {
  const row = e.target.closest('.qsearch__row');
  if (!row) return;
  const idx = Number(row.dataset.index);
  if (!Number.isNaN(idx) && idx !== highlightIndex) setHighlight(idx);
}

function onResultsClick(e) {
  const row = e.target.closest('.qsearch__row');
  if (!row) return;
  const idx = Number(row.dataset.index);
  const item = flatResults[idx];
  if (item) activateResult(item);
}

function onInputKeydown(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!flatResults.length) return;
    setHighlight(highlightIndex < flatResults.length - 1 ? highlightIndex + 1 : 0);
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!flatResults.length) return;
    setHighlight(highlightIndex > 0 ? highlightIndex - 1 : flatResults.length - 1);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (highlightIndex >= 0 && flatResults[highlightIndex]) {
      activateResult(flatResults[highlightIndex]);
      return;
    }
    // No row highlighted → AI hand-off (selected providers, else last-used)
    handOffToAi(inputEl.value.trim());
    return;
  }
}

async function activateResult(item) {
  try {
    if (item.type === 'tab' && item.tabId != null) {
      await chrome.tabs.update(item.tabId, { active: true });
      if (item.windowId != null) {
        try {
          await chrome.windows.update(item.windowId, { focused: true });
        } catch {
          /* windows API may be unavailable; tab switch still helps */
        }
      }
    } else if (item.url) {
      await chrome.tabs.create({ url: item.url });
    }
  } catch (err) {
    console.warn('[candy] activate result failed', err);
    // Fallback: navigate current tab for bookmarks if tabs.create fails
    if (item.url && item.type === 'bookmark') {
      window.location.href = item.url;
    }
  }
  close();
}

function onProvidersClick(e) {
  const btn = e.target.closest('.qsearch-provider');
  if (!btn) return;
  const id = btn.dataset.providerId;
  if (!id) return;

  const q = inputEl.value.trim();
  // Multi-select (toggle / second-click deselect):
  //   • empty query, or
  //   • Ctrl/Cmd held (build a multi set while a query is already typed)
  // Hand-off:
  //   • plain click with a non-empty query → open that provider immediately
  //   • Enter (no result highlighted) → every selected provider, else last-used
  const multiKey = e.metaKey || e.ctrlKey;
  const toggleOnly = !q || multiKey;

  if (toggleOnly) {
    if (selectedProviders.has(id)) selectedProviders.delete(id);
    else selectedProviders.add(id);
    syncProviderSelectedUi();
    updateConfig((c) => ({
      ...c,
      quickSearch: { ...(c.quickSearch || {}), lastProviderId: id },
    }));
    return;
  }

  selectedProviders = new Set([id]);
  syncProviderSelectedUi();
  updateConfig((c) => ({
    ...c,
    quickSearch: { ...(c.quickSearch || {}), lastProviderId: id },
  }));
  handOffToAi(q, [id]);
}

/**
 * Open one new tab per selected provider (background for all but last).
 * Falls back to last-used provider if none selected.
 */
export function handOffToAi(query, providerIds) {
  const q = (query || '').trim();
  if (!q) return;

  let ids = providerIds
    ? [...providerIds]
    : [...selectedProviders];

  if (!ids.length) {
    const last = getConfig()?.quickSearch?.lastProviderId || AI_PROVIDERS[0].id;
    ids = [last];
  }

  const providers = ids
    .map((id) => AI_PROVIDERS.find((p) => p.id === id))
    .filter(Boolean);
  if (!providers.length) return;

  // Remember first as last-used
  updateConfig((c) => ({
    ...c,
    quickSearch: {
      ...(c.quickSearch || {}),
      lastProviderId: providers[0].id,
    },
  }));

  openProviders(providers, q);
  close();
}

/**
 * @param {AiProvider[]} providers
 * @param {string} query
 */
export function openProviders(providers, query) {
  const encoded = encodeURIComponent(query);
  providers.forEach((provider, i) => {
    const url = provider.template.replace('%s', encoded);
    const active = i === providers.length - 1;
    try {
      chrome.tabs.create({ url, active });
    } catch (err) {
      // Outside extension context (file:// tests)
      if (active) window.open(url, '_blank');
    }
  });
}

export function openProvider(provider, query) {
  openProviders([provider], query);
}
