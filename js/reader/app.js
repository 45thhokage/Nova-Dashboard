/**
 * Feed reader page — grid "All feeds", sidebar counts, settings, QoL.
 * Render only reads precomputed view / local cache — no sort work on paint.
 */

import {
  loadReaderFromCache,
  backgroundRefreshStaleFeeds,
  refreshFeed,
  addFeed,
  removeFeed,
  setFeedPaused,
  setFeedRefreshOverride,
  setFeedImageQuality,
  markItemRead,
  markAllRead,
  exportOpml,
  importOpml,
  pruneAndRecompose,
} from './engine.js';
import {
  getFeedSettings,
  updateFeedSettings,
  AGE_OPTIONS,
  REFRESH_OPTIONS,
} from './settings.js';
import { IMAGE_QUALITY_OPTIONS, normalizeImageQuality } from './images.js';
import { getCachedImageUrl } from '../storage/cache-api.js';
import { el, relativeTime, hostFromUrl, uid, safeHttpUrl } from '../utils.js';
import { placeholderImage } from '../news/feeds.js';

let activeFeedId = null; // null = all
let cacheSnapshot = {
  subscriptions: [],
  items: [],
  counts: {},
  settings: null,
  mode: 'all',
};
let searchQuery = '';

async function main() {
  const data = await loadReaderFromCache();
  cacheSnapshot = data;
  applyColumnCss(data.settings?.columns || 5);
  renderSidebar();
  renderList();
  initSearchBar();

  document.getElementById('reader-app')?.classList.add('is-ready');

  initDrawer();
  initHeaderActions();

  queueIdle(() => {
    backgroundRefreshStaleFeeds(async () => {
      await reloadSnapshot();
      renderSidebar();
      renderList();
    });
  });
}

async function reloadSnapshot() {
  cacheSnapshot = await loadReaderFromCache({ feedId: activeFeedId });
  applyColumnCss(cacheSnapshot.settings?.columns || getFeedSettings().columns);
}

function applyColumnCss(cols) {
  const n = Math.min(8, Math.max(4, Number(cols) || 5));
  document.documentElement.style.setProperty('--reader-cols', String(n));
  const root = document.getElementById('reader-list');
  if (root) root.dataset.cols = String(n);
}

// ── Sidebar ───────────────────────────────────────────────

function renderSidebar() {
  const side = document.getElementById('reader-sidebar');
  if (!side) return;
  const subs = cacheSnapshot.subscriptions || [];
  const counts = cacheSnapshot.counts || {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  side.innerHTML = '';
  side.append(el('div', { className: 'reader-sidebar__label', text: 'Subscriptions' }));

  const allCount =
    activeFeedId == null
      ? (cacheSnapshot.items?.length ?? total)
      : total;
  const allBtn = el('button', {
    type: 'button',
    className: `reader-feed-btn${activeFeedId == null ? ' is-active' : ''}`,
  }, [
    el('span', { className: 'reader-feed-btn__name', text: 'All feeds' }),
    el('span', { className: 'reader-feed-btn__count', text: String(allCount) }),
  ]);
  allBtn.addEventListener('click', () => selectFeed(null));
  side.append(allBtn);

  for (const sub of subs) {
    const count = counts[sub.id] ?? 0;
    const broken = (sub.failCount || 0) >= 3;
    const kids = [
      el('span', {
        className: 'reader-feed-btn__name',
        text: sub.title || hostFromUrl(sub.url),
      }),
    ];
    if (sub.paused) {
      kids.push(el('span', { className: 'reader-feed-btn__badge', text: 'paused' }));
    }
    if (broken) {
      kids.push(
        el('span', {
          className: 'reader-feed-btn__warn',
          title: sub.lastError || 'Recent fetch failures',
          text: '⚠',
        })
      );
    }
    kids.push(el('span', { className: 'reader-feed-btn__count', text: String(count) }));

    const btn = el('button', {
      type: 'button',
      className: `reader-feed-btn${activeFeedId === sub.id ? ' is-active' : ''}${sub.paused ? ' is-paused' : ''}${broken ? ' is-broken' : ''}`,
      title: sub.url,
    }, kids);
    btn.addEventListener('click', () => selectFeed(sub.id));
    side.append(btn);
  }
}

async function selectFeed(feedId) {
  activeFeedId = feedId;
  await reloadSnapshot();
  renderSidebar();
  renderList();
}

// ── List / Grid ───────────────────────────────────────────

function visibleItems() {
  let items = cacheSnapshot.items || [];
  const q = searchQuery.trim().toLowerCase();
  if (q) {
    items = items.filter(
      (i) =>
        (i.title || '').toLowerCase().includes(q) ||
        (i.summary || '').toLowerCase().includes(q) ||
        (i.feedTitle || '').toLowerCase().includes(q)
    );
  }
  return items;
}

function renderList() {
  const root = document.getElementById('reader-list');
  const subEl = document.getElementById('reader-subtitle');
  if (!root) return;

  const items = visibleItems();
  const subs = cacheSnapshot.subscriptions || [];
  const subCount = subs.length;
  const isAll = activeFeedId == null;

  if (subEl) {
    subEl.textContent =
      subCount === 0
        ? 'Add a feed to get started'
        : `${items.length} item${items.length === 1 ? '' : 's'} · ${subCount} subscription${subCount === 1 ? '' : 's'}${searchQuery ? ' (filtered)' : ''}`;
  }

  root.innerHTML = '';
  root.className = isAll ? 'reader-list reader-list--grid' : 'reader-list reader-list--stack';
  applyColumnCss(cacheSnapshot.settings?.columns || getFeedSettings().columns);

  if (!subCount) {
    root.append(
      el('div', { className: 'reader-empty' }, [
        el('h2', { text: 'No feeds yet' }),
        el('p', {
          text: 'Subscribe to RSS, Atom, JSON Feed, or Substack feeds. Open Manage Feeds (gear) to add a URL.',
        }),
        el('button', {
          type: 'button',
          className: 'btn btn--primary',
          text: 'Manage Feeds',
          onClick: () => openDrawer(),
        }),
      ])
    );
    return;
  }

  if (!items.length) {
    if (searchQuery) {
      root.append(
        el('div', {
          className: 'reader-empty',
          text: 'No items match your search.',
        })
      );
      return;
    }
    for (let i = 0; i < 6; i++) {
      root.append(
        el('div', {
          className: isAll ? 'reader-skel reader-skel--grid' : 'reader-skel',
          'aria-hidden': 'true',
        }, [
          el('div', { className: 'reader-skel__media' }),
          el('div', { className: 'reader-skel__line', style: { width: '90%' } }),
          el('div', { className: 'reader-skel__line', style: { width: '50%' } }),
        ])
      );
    }
    return;
  }

  for (const item of items) {
    root.append(buildItem(item, isAll));
  }
}

function buildItem(item, isGrid) {
  const mediaSrc = item.imageUrl || placeholderImage(item.id || item.title);
  const img = el('img', { alt: '', loading: 'lazy', decoding: 'async' });
  resolveImage(mediaSrc, img);

  const tile = item.tileSize || 'md';
  const classes = [
    'reader-item',
    isGrid ? `reader-item--${tile}` : '',
    item.read ? 'is-read' : '',
    item.pinned ? 'is-pinned' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const href = safeHttpUrl(item.url) || '#';
  const link = el('a', {
    className: classes,
    href,
    target: href === '#' ? undefined : '_blank',
    rel: 'noopener noreferrer',
    dataset: { id: item.id },
  }, [
    el('div', { className: 'reader-item__media' }, [
      img,
      item.pinned
        ? el('span', { className: 'reader-item__pin', text: 'Pinned' })
        : null,
      !item.read
        ? el('span', { className: 'reader-item__unread', title: 'Unread' })
        : null,
    ]),
    el('div', { className: 'reader-item__body' }, [
      el('div', { className: 'reader-item__meta' }, [
        el('span', { className: 'reader-item__feed', text: item.feedTitle || 'Feed' }),
        item.effectiveAt || item.publishedAt
          ? el('span', {
              text: `· ${relativeTime(item.effectiveAt || item.publishedAt)}`,
            })
          : null,
      ]),
      el('h2', { className: 'reader-item__title', text: item.title || 'Untitled' }),
      !isGrid && item.summary
        ? el('p', { className: 'reader-item__summary', text: item.summary })
        : isGrid && item.summary
          ? el('p', { className: 'reader-item__summary', text: item.summary })
          : null,
    ]),
  ]);

  link.addEventListener('click', () => {
    markItemRead(item.id, true).then(() => {
      item.read = true;
      link.classList.add('is-read');
      const dot = link.querySelector('.reader-item__unread');
      if (dot) dot.remove();
    });
  });

  return link;
}

async function resolveImage(src, imgEl) {
  try {
    const cached = await getCachedImageUrl(src);
    imgEl.src = cached || src;
  } catch {
    imgEl.src = src;
  }
}

// ── Search ────────────────────────────────────────────────

function initSearchBar() {
  const input = document.getElementById('reader-search');
  if (!input) return;
  let t = null;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      searchQuery = input.value || '';
      renderList();
    }, 120);
  });
}

// ── Drawer ────────────────────────────────────────────────

function initDrawer() {
  document.getElementById('reader-settings-btn')?.addEventListener('click', openDrawer);
  document.getElementById('reader-drawer-close')?.addEventListener('click', closeDrawer);
  document.getElementById('reader-overlay')?.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });
}

function openDrawer() {
  const overlay = document.getElementById('reader-overlay');
  const drawer = document.getElementById('reader-drawer');
  if (!overlay || !drawer) return;
  overlay.hidden = false;
  renderDrawerBody();
  requestAnimationFrame(() => {
    overlay.classList.add('is-open');
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
  });
}

function closeDrawer() {
  const overlay = document.getElementById('reader-overlay');
  const drawer = document.getElementById('reader-drawer');
  if (!drawer) return;
  overlay?.classList.remove('is-open');
  drawer.classList.remove('is-open');
  drawer.setAttribute('aria-hidden', 'true');
  setTimeout(() => {
    if (overlay) overlay.hidden = true;
  }, 300);
}

function renderDrawerBody() {
  const body = document.getElementById('reader-drawer-body');
  if (!body) return;
  body.innerHTML = '';
  const settings = getFeedSettings();

  // ── Settings section ──
  body.append(sectionTitle('Display & refresh'));

  body.append(
    rowSelect(
      'Grid columns (All feeds)',
      String(settings.columns),
      [4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: `${n} columns` })),
      async (v) => {
        updateFeedSettings((s) => ({ ...s, columns: Number(v) }));
        applyColumnCss(Number(v));
        await reloadSnapshot();
        renderList();
      }
    ),
    rowSelect(
      'Max stories per source',
      String(settings.maxItemsPerFeed),
      [10, 25, 50, 75, 100].map((n) => ({ value: String(n), label: String(n) })),
      async (v) => {
        updateFeedSettings((s) => ({ ...s, maxItemsPerFeed: Number(v) }));
        await pruneAndRecompose();
        await reloadSnapshot();
        renderSidebar();
        renderList();
      }
    ),
    rowSelect(
      'Refresh interval',
      String(settings.refreshMinutes),
      REFRESH_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })),
      (v) => {
        updateFeedSettings((s) => ({ ...s, refreshMinutes: Number(v) }));
      }
    ),
    rowSelect(
      'Max article age',
      String(settings.maxAgeDays),
      AGE_OPTIONS.map((o) => ({ value: String(o.value), label: o.label })),
      async (v) => {
        updateFeedSettings((s) => ({ ...s, maxAgeDays: Number(v) }));
        await pruneAndRecompose();
        await reloadSnapshot();
        renderSidebar();
        renderList();
      },
      'Older items are removed from cache on the next refresh cycle'
    )
  );

  // Blocklist — directly above priority keywords
  body.append(sectionTitle('Blocklist'));
  body.append(
    el('p', {
      className: 'feed-add-hint',
      text: 'Hide stories whose title or summary contains these words (case-insensitive). Applied on the next recompute — never shows in All feeds or single-feed views.',
    })
  );
  const blList = el('div', { className: 'keyword-list' });
  for (const entry of settings.blocklist || []) {
    blList.append(blocklistRow(entry));
  }
  body.append(blList);

  const blForm = el('form', { className: 'feed-add-form', style: { marginTop: '8px' } });
  const blInput = el('input', {
    type: 'text',
    className: 'field__input',
    placeholder: 'Add blocked word…',
    maxlength: '40',
  });
  blForm.append(blInput);
  const blAdd = el('button', {
    type: 'submit',
    className: 'btn btn--sm btn--primary',
    text: 'Add to blocklist',
    style: { marginTop: '8px', alignSelf: 'flex-start' },
  });
  blForm.append(blAdd);
  blForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = blInput.value.trim();
    if (!text) return;
    const exists = (getFeedSettings().blocklist || []).some(
      (b) => b.text.toLowerCase() === text.toLowerCase()
    );
    if (exists) {
      blInput.value = '';
      return;
    }
    updateFeedSettings((s) => ({
      ...s,
      blocklist: [...(s.blocklist || []), { id: uid('bl'), text }],
    }));
    blInput.value = '';
    await pruneAndRecompose();
    await reloadSnapshot();
    renderSidebar();
    renderList();
    renderDrawerBody();
  });
  body.append(blForm);

  // Keywords
  body.append(sectionTitle('Keyword priority pins'));
  body.append(
    el('p', {
      className: 'feed-add-hint',
      text: 'Matched titles (and summaries) pin to the top of All feeds. Default: only while new (24h). Toggle “Always pin” to keep them pinned until max age prunes them.',
    })
  );
  const kwList = el('div', { className: 'keyword-list' });
  for (const kw of settings.keywords || []) {
    kwList.append(keywordRow(kw));
  }
  body.append(kwList);

  const kwForm = el('form', { className: 'feed-add-form', style: { marginTop: '8px' } });
  const kwInput = el('input', {
    type: 'text',
    className: 'field__input',
    placeholder: 'Add keyword…',
    maxlength: '40',
  });
  kwForm.append(kwInput);
  const kwAdd = el('button', {
    type: 'submit',
    className: 'btn btn--sm btn--primary',
    text: 'Add keyword',
    style: { marginTop: '8px', alignSelf: 'flex-start' },
  });
  kwForm.append(kwAdd);
  kwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = kwInput.value.trim();
    if (!text) return;
    updateFeedSettings((s) => ({
      ...s,
      keywords: [...(s.keywords || []), { id: uid('kw'), text, alwaysPin: false }],
    }));
    kwInput.value = '';
    await pruneAndRecompose();
    await reloadSnapshot();
    renderList();
    renderDrawerBody();
  });
  body.append(kwForm);

  // Dedupe toggle
  body.append(sectionTitle('Mixing'));
  body.append(
    rowToggle('Collapse duplicate URLs across feeds', settings.dedupeByUrl, async (v) => {
      updateFeedSettings((s) => ({ ...s, dedupeByUrl: v }));
      await pruneAndRecompose();
      await reloadSnapshot();
      renderList();
    })
  );

  // Add feed
  body.append(sectionTitle('Add feed'));
  body.append(buildAddFeedForm());

  // Subscriptions management
  body.append(sectionTitle('Your subscriptions'));
  body.append(buildSubsManager());

  // Read state + OPML
  body.append(sectionTitle('Data'));
  const dataActions = el('div', { className: 'storage-actions' });
  const markAll = el('button', {
    type: 'button',
    className: 'btn btn--ghost btn--sm',
    text: activeFeedId ? 'Mark feed as read' : 'Mark all as read',
  });
  markAll.addEventListener('click', async () => {
    await markAllRead(activeFeedId);
    await reloadSnapshot();
    renderList();
  });
  const exportBtn = el('button', {
    type: 'button',
    className: 'btn btn--ghost btn--sm',
    text: 'Export OPML',
  });
  exportBtn.addEventListener('click', async () => {
    const xml = await exportOpml();
    downloadText('candy-feeds.opml', xml, 'text/xml');
  });
  const importBtn = el('button', {
    type: 'button',
    className: 'btn btn--ghost btn--sm',
    text: 'Import OPML',
  });
  importBtn.addEventListener('click', () => {
    const input = el('input', { type: 'file', accept: '.opml,.xml,text/xml', style: { display: 'none' } });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        const res = await importOpml(text);
        alert(`Import done: ${res.added} added, ${res.skipped} skipped, ${res.errors.length} errors.`);
        await reloadSnapshot();
        renderSidebar();
        renderList();
        renderDrawerBody();
      } catch (err) {
        alert(err?.message || 'Import failed');
      }
    });
    document.body.append(input);
    input.click();
    input.remove();
  });
  dataActions.append(markAll, exportBtn, importBtn);
  body.append(dataActions);
}

function blocklistRow(entry) {
  const row = el('div', { className: 'keyword-row keyword-row--block' }, [
    el('span', { className: 'keyword-row__text', text: entry.text }),
  ]);
  const remove = el('button', {
    type: 'button',
    className: 'btn btn--sm btn--danger',
    text: 'Remove',
  });
  remove.addEventListener('click', async () => {
    updateFeedSettings((s) => ({
      ...s,
      blocklist: (s.blocklist || []).filter((b) => b.id !== entry.id),
    }));
    await pruneAndRecompose();
    await reloadSnapshot();
    renderSidebar();
    renderList();
    renderDrawerBody();
  });
  row.append(remove);
  return row;
}

function keywordRow(kw) {
  const row = el('div', { className: 'keyword-row' }, [
    el('span', { className: 'keyword-row__text', text: kw.text }),
  ]);
  const always = el('label', { className: 'keyword-row__always' }, [
    el('input', {
      type: 'checkbox',
      checked: kw.alwaysPin ? true : undefined,
    }),
    el('span', { text: 'Always pin' }),
  ]);
  always.querySelector('input').addEventListener('change', async (e) => {
    updateFeedSettings((s) => ({
      ...s,
      keywords: (s.keywords || []).map((k) =>
        k.id === kw.id ? { ...k, alwaysPin: e.target.checked } : k
      ),
    }));
    await pruneAndRecompose();
    await reloadSnapshot();
    renderList();
  });
  const remove = el('button', {
    type: 'button',
    className: 'btn btn--sm btn--danger',
    text: 'Remove',
  });
  remove.addEventListener('click', async () => {
    updateFeedSettings((s) => ({
      ...s,
      keywords: (s.keywords || []).filter((k) => k.id !== kw.id),
    }));
    await pruneAndRecompose();
    await reloadSnapshot();
    renderList();
    renderDrawerBody();
  });
  row.append(always, remove);
  return row;
}

function buildAddFeedForm() {
  const form = el('form', { className: 'feed-add-form' });
  form.append(
    el('p', {
      className: 'feed-add-hint',
      text: 'RSS, Atom, JSON Feed, or Substack feed URL — format is detected automatically.',
    }),
    el('label', { className: 'field' }, [
      el('span', { className: 'field__label', text: 'Feed URL' }),
      el('input', {
        type: 'url',
        className: 'field__input',
        id: 'feed-url-input',
        placeholder: 'https://example.com/feed',
        required: true,
        autocomplete: 'off',
      }),
    ])
  );
  const errEl = el('div', { className: 'feed-add-error' });
  const submit = el('button', {
    type: 'submit',
    className: 'btn btn--primary',
    text: 'Add subscription',
  });
  form.append(errEl, submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.querySelector('#feed-url-input');
    errEl.textContent = '';
    submit.disabled = true;
    submit.textContent = 'Checking…';
    try {
      await addFeed(input.value.trim());
      input.value = '';
      await reloadSnapshot();
      renderSidebar();
      renderList();
      renderDrawerBody();
    } catch (err) {
      errEl.textContent = err?.message || 'Could not add feed';
      submit.disabled = false;
      submit.textContent = 'Add subscription';
    }
  });
  return form;
}

function buildSubsManager() {
  const list = el('div', { className: 'feed-sub-list' });
  const subs = cacheSnapshot.subscriptions || [];
  if (!subs.length) {
    list.append(el('p', { className: 'settings-section__desc', text: 'No subscriptions yet.' }));
    return list;
  }

  for (const sub of subs) {
    const row = el('div', { className: 'feed-sub-item' });
    const quality = normalizeImageQuality(sub.imageQuality);
    const info = el('div', { className: 'feed-sub-item__info' }, [
      el('div', { className: 'feed-sub-item__title', text: sub.title }),
      el('div', { className: 'feed-sub-item__url', text: sub.url }),
      el('span', {
        className: 'feed-sub-item__format',
        text: sub.format || 'rss',
      }),
      sub.lastError
        ? el('div', {
            className: 'feed-add-error',
            style: { marginTop: '4px' },
            text: sub.lastError,
          })
        : null,
    ]);

    const actions = el('div', { className: 'feed-sub-item__actions' });

    // Image quality — small / medium / large (per source)
    const imgLabel = el('label', { className: 'feed-sub-item__field' }, [
      el('span', { className: 'feed-sub-item__field-label', text: 'Images' }),
    ]);
    const imgSel = el('select', {
      className: 'field__select feed-sub-item__select',
      title: IMAGE_QUALITY_OPTIONS.find((o) => o.value === quality)?.hint || 'Image quality',
    });
    for (const o of IMAGE_QUALITY_OPTIONS) {
      const opt = el('option', { value: o.value, text: o.label });
      if (o.value === quality) opt.selected = true;
      imgSel.append(opt);
    }
    imgSel.addEventListener('change', async () => {
      imgSel.disabled = true;
      await setFeedImageQuality(sub.id, imgSel.value);
      // Soft reload after a short delay so some large images can resolve
      setTimeout(async () => {
        await reloadSnapshot();
        renderSidebar();
        renderList();
      }, 800);
      // Keep drawer open; re-enable select
      sub.imageQuality = imgSel.value;
      imgSel.disabled = false;
      imgSel.title =
        IMAGE_QUALITY_OPTIONS.find((o) => o.value === imgSel.value)?.hint || '';
    });
    imgLabel.append(imgSel);
    actions.append(imgLabel);

    const pauseBtn = el('button', {
      type: 'button',
      className: 'btn btn--sm btn--ghost',
      text: sub.paused ? 'Resume' : 'Pause',
    });
    pauseBtn.addEventListener('click', async () => {
      await setFeedPaused(sub.id, !sub.paused);
      await reloadSnapshot();
      renderSidebar();
      renderList();
      renderDrawerBody();
    });

    const refreshSel = el('select', {
      className: 'field__select feed-sub-item__select',
      title: 'Refresh interval override',
    });
    refreshSel.append(el('option', { value: '', text: 'Refresh: global' }));
    for (const o of REFRESH_OPTIONS) {
      const opt = el('option', { value: String(o.value), text: o.label });
      if (sub.refreshMinutes === o.value) opt.selected = true;
      refreshSel.append(opt);
    }
    refreshSel.addEventListener('change', async () => {
      await setFeedRefreshOverride(sub.id, refreshSel.value || null);
    });

    const remove = el('button', {
      type: 'button',
      className: 'btn btn--sm btn--danger',
      text: 'Remove',
    });
    remove.addEventListener('click', async () => {
      if (!confirm(`Unsubscribe from “${sub.title}”?`)) return;
      await removeFeed(sub.id);
      if (activeFeedId === sub.id) activeFeedId = null;
      await reloadSnapshot();
      renderSidebar();
      renderList();
      renderDrawerBody();
    });

    actions.append(pauseBtn, refreshSel, remove);
    row.append(info, actions);
    list.append(row);
  }
  return list;
}

// ── Small UI helpers ──────────────────────────────────────

function sectionTitle(text) {
  return el('h3', {
    className: 'settings-section__title',
    style: { marginTop: '16px' },
    text,
  });
}

function rowSelect(label, value, options, onChange, hint) {
  const row = el('div', { className: 'settings-row' });
  const left = el('div', { className: 'settings-row__left' }, [
    el('span', { className: 'settings-row__label', text: label }),
  ]);
  if (hint) left.append(el('span', { className: 'settings-row__hint', text: hint }));
  const select = el('select', { className: 'field__select' });
  for (const opt of options) {
    const o = el('option', { value: opt.value, text: opt.label });
    if (opt.value === value) o.selected = true;
    select.append(o);
  }
  select.addEventListener('change', () => onChange(select.value));
  row.append(left, select);
  return row;
}

function rowToggle(label, checked, onToggle) {
  const id = `sw_${Math.random().toString(36).slice(2, 8)}`;
  const row = el('div', { className: 'settings-row' });
  row.append(
    el('div', { className: 'settings-row__left' }, [
      el('span', { className: 'settings-row__label', text: label }),
    ])
  );
  const sw = el('label', { className: 'switch', for: id }, [
    el('input', { type: 'checkbox', id, checked: checked ? true : undefined }),
    el('span', { className: 'switch__track' }),
  ]);
  sw.querySelector('input').addEventListener('change', (e) => onToggle(e.target.checked));
  row.append(sw);
  return row;
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function initHeaderActions() {
  document.getElementById('reader-refresh-all')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const subs = (cacheSnapshot.subscriptions || []).filter((s) => !s.paused);
    for (const sub of subs) {
      // eslint-disable-next-line no-await-in-loop
      await refreshFeed(sub.id, { silent: true });
    }
    await pruneAndRecompose();
    await reloadSnapshot();
    renderSidebar();
    renderList();
    btn.disabled = false;
  });
}

function queueIdle(fn) {
  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => fn(), { timeout: 2000 });
  } else {
    setTimeout(fn, 120);
  }
}

main().catch((err) => {
  console.error('[candy] feed reader boot failed', err);
  document.getElementById('reader-app')?.classList.add('is-ready');
});
