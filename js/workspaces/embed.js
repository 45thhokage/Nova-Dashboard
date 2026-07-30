/**
 * Iframe container system — embeds external pages inside workspaces.
 *
 *   Workspace → Page Grid → Iframe Container → <iframe>
 *
 * The declarativeNetRequest rules in the service worker strip
 * X-Frame-Options / CSP frame restrictions so these sites can render
 * inside the containers. Containers provide: rounded corners, borders,
 * shadows, overflow clipping, loading state, slow-load fallback,
 * reload / open-in-tab / remove controls, drag-to-reorder, width and
 * height panel resizing (persisted per page), and a workspace-level
 * resource monitor that pauses / resumes every panel (pausing unloads
 * the iframe documents to free CPU/memory without touching config).
 * Panel controls live in a hover overlay: reload, change URL, open in
 * new tab, and remove — visible only while the container is hovered.
 */

import { el, escapeHtml, hostFromUrl, normalizeUrl, safeHttpUrl } from '../utils.js';
import { ensureFavicon } from '../favicon.js';
import { getPages, addPage, removePage, reorderPage, patchPage } from './store.js';
import { icon } from './icons.js';

const SLOW_LOAD_MS = 15000;

/**
 * Mount a full page-grid workspace (header + optional tabs + grid).
 * Variants:
 *   chat   — tall panels (default)
 *   media  — filter tabs [All | Audio | Video] + shorter cards
 *   compact— shorter cards (trending sources)
 */
export function mountPageGrid(root, ws, { variant = 'chat', title } = {}) {
  if (!root || !ws) return;
  root.innerHTML = '';

  // ── Header ──────────────────────────────────────────────
  const count = el('span', { className: 'ws-header__count' });
  const addBtn = el('button', {
    type: 'button',
    className: 'btn btn--sm btn--soft',
    html: `${icon('plus', 14)} Add page`,
  });

  const headerLeft = el('div', { className: 'ws-header__left' }, [
    el('h2', { className: 'ws-header__title', text: title || ws.title }),
    count,
  ]);

  const tabs = variant === 'media' ? buildTabs() : null;

  // ── Resource monitor — top-right: live panel count + pause/resume ──
  const monitor = el('button', {
    type: 'button',
    className: 'ws-monitor btn btn--sm btn--ghost',
  });
  monitor.addEventListener('click', () => {
    if (isGridPaused(grid)) resumeGrid(grid, monitor);
    else pauseGrid(grid, monitor);
  });

  const headerActions = el('div', { className: 'ws-header__actions' }, [
    tabs,
    addBtn,
    monitor,
  ].filter(Boolean));

  const header = el('div', { className: 'ws-header' }, [headerLeft, headerActions]);

  // ── Add-page form (hidden until requested) ──────────────
  const form = buildAddForm(ws, variant, {
    onAdded: (page) => {
      // Adding a page signals intent to use the workspace — resume first
      if (isGridPaused(grid)) resumeGrid(grid, monitor);
      grid.append(buildContainer(ws, page, variant));
      updateCount();
      renderMonitorButton(grid, monitor);
    },
  });

  addBtn.addEventListener('click', () => {
    const showing = !form.hidden;
    form.hidden = showing;
    if (!showing) form.querySelector('input')?.focus();
  });

  // ── Grid ────────────────────────────────────────────────
  const gridClass =
    variant === 'media'
      ? 'page-grid page-grid--media'
      : variant === 'compact'
        ? 'page-grid page-grid--compact'
        : 'page-grid';
  const grid = el('div', { className: gridClass });

  function updateCount() {
    const n = getPages(ws.id).length;
    count.textContent = `${n} page${n === 1 ? '' : 's'}`;
  }

  function renderAll() {
    grid.innerHTML = '';
    for (const page of getPages(ws.id)) grid.append(buildContainer(ws, page, variant));
    updateCount();
    if (tabs) applyTabFilter(grid, tabs.dataset.active || 'all');
  }

  renderAll();
  renderMonitorButton(grid, monitor);
  root.append(header, form, grid);
  // Keep the header count + monitor in sync with removals inside containers
  root.addEventListener('pages:changed', () => {
    updateCount();
    renderMonitorButton(grid, monitor);
  });

  // Paused panels resume automatically the moment the user returns to
  // this workspace — no manual restart required.
  window.addEventListener('candy:workspace-activated', (e) => {
    const shell = root.closest('.workspace');
    if (shell && shell.dataset.workspace === e.detail?.id && isGridPaused(grid)) {
      resumeGrid(grid, monitor);
    }
  });
}

// ── Filter tabs (media variant) ─────────────────────────────

function buildTabs() {
  const tabs = el('div', { className: 'ws-tabs', role: 'tablist', dataset: { active: 'all' } });
  for (const [value, label] of [['all', 'All'], ['audio', 'Audio'], ['video', 'Video']]) {
    const tab = el('button', {
      type: 'button',
      className: `ws-tab${value === 'all' ? ' is-active' : ''}`,
      role: 'tab',
      dataset: { filter: value },
      text: label,
    });
    tab.addEventListener('click', () => {
      tabs.dataset.active = value;
      tabs.querySelectorAll('.ws-tab').forEach((t) =>
        t.classList.toggle('is-active', t === tab)
      );
      const grid = tab.closest('.workspace__inner')?.querySelector('.page-grid');
      if (grid) applyTabFilter(grid, value);
    });
    tabs.append(tab);
  }
  return tabs;
}

function applyTabFilter(grid, filter) {
  for (const c of grid.querySelectorAll('.iframe-container')) {
    const type = c.dataset.pageType || '';
    c.classList.toggle('is-filtered', filter !== 'all' && type !== filter);
  }
}

// ── Add-page form ───────────────────────────────────────────

function buildAddForm(ws, variant, { onAdded }) {
  const urlInput = el('input', {
    type: 'url',
    className: 'field__input ws-addform__url',
    placeholder: 'https://example.com',
    required: true,
    spellcheck: 'false',
  });
  const titleInput = el('input', {
    type: 'text',
    className: 'field__input ws-addform__title',
    placeholder: 'Title (optional)',
    maxlength: '60',
  });

  const typeSelect =
    variant === 'media'
      ? el('select', { className: 'field__select' }, [
          el('option', { value: 'audio', text: 'Audio' }),
          el('option', { value: 'video', text: 'Video' }),
        ])
      : null;

  const submit = el('button', { type: 'submit', className: 'btn btn--sm btn--primary', text: 'Add' });
  const cancel = el('button', { type: 'button', className: 'btn btn--sm btn--ghost', text: 'Cancel' });

  const form = el('form', { className: 'ws-addform', hidden: true, autocomplete: 'off' }, [
    urlInput,
    titleInput,
    typeSelect,
    submit,
    cancel,
  ].filter(Boolean));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = safeHttpUrl(normalizeUrl(urlInput.value));
    if (!url) {
      urlInput.focus();
      return;
    }
    const page = addPage(ws.id, {
      url,
      title: titleInput.value,
      type: typeSelect?.value,
    });
    urlInput.value = '';
    titleInput.value = '';
    form.hidden = true;
    onAdded(page);
  });

  cancel.addEventListener('click', () => {
    form.hidden = true;
  });

  return form;
}

// ── Inline URL editor (per panel) ───────────────────────

function buildUrlForm(ws, page, container) {
  const input = el('input', {
    type: 'url',
    className: 'field__input iframe-container__urlinput',
    value: page.url,
    spellcheck: 'false',
    'aria-label': 'Page URL',
  });
  const save = el('button', { type: 'submit', className: 'btn btn--sm btn--primary', text: 'Save' });
  const cancel = el('button', { type: 'button', className: 'btn btn--sm btn--ghost', text: 'Cancel' });
  const form = el(
    'form',
    { className: 'iframe-container__urlform', hidden: true, autocomplete: 'off' },
    [input, save, cancel]
  );

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = safeHttpUrl(normalizeUrl(input.value));
    if (!url) {
      input.focus();
      return;
    }
    const oldHost = hostFromUrl(page.url);
    const newHost = hostFromUrl(url);
    // Follow the URL when the title was auto-derived from the old host
    const retitled = page.title === oldHost ? newHost : page.title;
    patchPage(ws.id, page.id, { url, title: retitled });
    page.url = url;
    page.title = retitled;
    applyIdentity(container, page);
    const iframe = container.querySelector('iframe');
    armLoader(iframe, container.querySelector('.iframe-loader'));
    iframe.src = url;
    form.hidden = true;
  });

  cancel.addEventListener('click', () => {
    form.hidden = true;
  });

  return form;
}

/** Refresh bar title / host / favicon + iframe title after a URL change */
function applyIdentity(container, page) {
  const host = hostFromUrl(page.url);
  const titleEl = container.querySelector('.iframe-container__title');
  const hostEl = container.querySelector('.iframe-container__host');
  const bar = container.querySelector('.iframe-container__bar');
  const fav = container.querySelector('.iframe-container__favicon');
  const iframe = container.querySelector('iframe');
  if (titleEl) titleEl.textContent = page.title || host;
  if (hostEl) hostEl.textContent = host;
  if (bar) bar.title = page.url;
  if (iframe) iframe.title = page.title || host;
  const hintLink = container.querySelector('.iframe-loader__hint a');
  if (hintLink) hintLink.href = page.url;
  if (fav) {
    ensureFavicon(page.url)
      .then((dataUrl) => {
        if (dataUrl) fav.src = dataUrl;
      })
      .catch(() => {});
  }
}

// ── Iframe container ────────────────────────────────────────

function buildContainer(ws, page, variant) {
  const host = hostFromUrl(page.url);
  const c = el('div', {
    className: 'iframe-container',
    dataset: { pageId: page.id, pageType: page.type || '' },
  });
  // Persisted panel resize (width + height)
  if (page.w) c.style.flex = `0 1 ${page.w}px`;
  if (page.h) c.style.height = `${page.h}px`;

  // Bar — identity (favicon / title / host) + drag source for reordering;
  // action controls live in the hover overlay below
  const bar = el('div', { className: 'iframe-container__bar', title: page.url });
  const grip = el('span', {
    className: 'iframe-container__grip',
    title: 'Drag to reorder',
    html: icon('grip', 14),
  });
  const fav = el('img', { className: 'iframe-container__favicon', alt: '' });
  ensureFavicon(page.url)
    .then((dataUrl) => {
      if (dataUrl) fav.src = dataUrl;
    })
    .catch(() => {});

  const title = el('span', {
    className: 'iframe-container__title',
    text: page.title || host,
  });

  bar.append(grip, fav, title);

  if (variant === 'media' && page.type) {
    bar.append(
      el('span', {
        className: 'iframe-container__type',
        html: `${icon(page.type === 'audio' ? 'music' : 'video', 12)} ${escapeHtml(page.type)}`,
      })
    );
  } else if (variant !== 'compact') {
    bar.append(el('span', { className: 'iframe-container__host', text: host }));
  }

  // Inline URL editor — opened from the hover overlay's pencil button
  const urlForm = buildUrlForm(ws, page, c);

  // Hover overlay — contextual controls float over the frame and only
  // appear while the container is hovered (or keyboard-focused), keeping
  // the panel clean the rest of the time.
  const overlay = el('div', { className: 'iframe-container__overlay' }, [
    barBtn('refresh', 'Reload page', () => {
      if (c.classList.contains('is-paused')) {
        // Refreshing a paused panel resumes the workspace's panels
        const gridEl = c.closest('.page-grid');
        if (gridEl) {
          resumeGrid(
            gridEl,
            gridEl.closest('.workspace__inner')?.querySelector('.ws-monitor')
          );
        } else {
          resumeContainer(c);
        }
      } else {
        reloadFrame(c);
      }
    }),
    barBtn('edit', 'Change URL', () => {
      urlForm.hidden = !urlForm.hidden;
      if (!urlForm.hidden) {
        const input = urlForm.querySelector('input');
        input.value = page.url;
        input.focus();
        input.select();
      }
    }),
    barBtn('external-link', 'Open in new tab', () =>
      window.open(page.url, '_blank', 'noopener')
    ),
    barBtn('x', 'Remove page', () => {
      removePage(ws.id, page.id);
      const grid = c.closest('.page-grid');
      c.remove();
      grid?.dispatchEvent(new CustomEvent('pages:changed', { bubbles: true }));
    }, true),
  ]);

  // Frame — iframe fills the container; loader overlays until load
  const frame = el('div', { className: 'iframe-container__frame' });
  const iframe = el('iframe', {
    src: page.url,
    title: page.title || host,
    loading: 'lazy',
    allow:
      'clipboard-read; clipboard-write; microphone; camera; fullscreen; geolocation; autoplay; encrypted-media; picture-in-picture',
    allowfullscreen: true,
    referrerpolicy: 'no-referrer-when-downgrade',
  });

  const loader = el('div', { className: 'iframe-loader' }, [
    el('div', { className: 'iframe-loader__spinner' }),
    el('span', { text: `Loading ${page.title || host}…` }),
    el('div', {
      className: 'iframe-loader__hint',
      html:
        'Taking longer than usual — some sites block embedding or are slow.' +
        `<br><a href="${escapeHtml(page.url)}" target="_blank" rel="noopener" style="color:var(--accent-hover)">Open in new tab</a>`,
    }),
  ]);
  armLoader(iframe, loader);

  // Paused overlay — visible while the panel's document is unloaded
  const resumeBtn = el('button', {
    type: 'button',
    className: 'btn btn--sm btn--soft',
    text: 'Resume now',
  });
  resumeBtn.addEventListener('click', () => {
    const gridEl = c.closest('.page-grid');
    if (gridEl) {
      resumeGrid(
        gridEl,
        gridEl.closest('.workspace__inner')?.querySelector('.ws-monitor')
      );
    }
  });
  const pausedOverlay = el('div', { className: 'iframe-paused' }, [
    el('span', { className: 'iframe-paused__icon', html: icon('pause', 22) }),
    el('div', { className: 'iframe-paused__title', text: 'Paused' }),
    el('div', {
      className: 'iframe-paused__hint',
      text: 'Rendering stopped to save CPU and memory. Panels resume automatically when you return to this workspace.',
    }),
    resumeBtn,
  ]);

  frame.append(iframe, loader, pausedOverlay, overlay);

  // Resize handles — right edge (width) and bottom edge (height)
  const resize = el('div', { className: 'iframe-container__resize', title: 'Drag to resize width' });
  attachResize(c, resize, ws, page);
  const resizeV = el('div', { className: 'iframe-container__resize-v', title: 'Drag to resize height' });
  attachResizeV(c, resizeV, ws, page);

  // Drag-to-reorder (drag starts from the bar; iframe keeps its own events)
  c.draggable = true;
  c.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', page.id);
    requestAnimationFrame(() => c.classList.add('is-dragging'));
  });
  c.addEventListener('dragend', () => {
    c.classList.remove('is-dragging');
    c.closest('.page-grid')
      ?.querySelectorAll('.is-drag-over')
      .forEach((n) => n.classList.remove('is-drag-over'));
  });
  c.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    c.classList.add('is-drag-over');
  });
  c.addEventListener('dragleave', () => c.classList.remove('is-drag-over'));
  c.addEventListener('drop', (e) => {
    e.preventDefault();
    c.classList.remove('is-drag-over');
    const fromId = e.dataTransfer.getData('text/plain');
    if (!fromId || fromId === page.id) return;
    reorderPage(ws.id, fromId, page.id);
    // Rebuild the grid in the stored order (the moved panel reloads)
    const inner = c.closest('.workspace__inner');
    if (inner) {
      const gridEl = inner.querySelector('.page-grid');
      const pages = getPages(ws.id);
      gridEl.innerHTML = '';
      for (const p of pages) gridEl.append(buildContainer(ws, p, variant));
      // Preserve the paused state across the rebuild
      if (isGridPaused(gridEl)) {
        gridEl.querySelectorAll('.iframe-container').forEach(pauseContainer);
      }
    }
  });

  c.append(bar, urlForm, frame, resize, resizeV);
  return c;
}

function barBtn(iconName, label, onClick, danger = false) {
  const b = el('button', {
    type: 'button',
    className: `iframe-container__btn${danger ? ' iframe-container__btn--danger' : ''}`,
    title: label,
    'aria-label': label,
    html: icon(iconName, 15),
  });
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  // Buttons must not start a container drag
  b.addEventListener('dragstart', (e) => e.preventDefault());
  b.draggable = false;
  return b;
}

function reloadFrame(container) {
  const iframe = container.querySelector('iframe');
  const loader = container.querySelector('.iframe-loader');
  if (!iframe) return;
  armLoader(iframe, loader);
  // Re-assigning src restarts navigation (works cross-origin)
  // eslint-disable-next-line no-self-assign
  iframe.src = iframe.src;
}

/**
 * Wire the loader overlay to an iframe navigation: show it, flag slow
 * loads after SLOW_LOAD_MS, and dismiss it once the load event fires.
 */
function armLoader(iframe, loader) {
  if (!loader) return;
  loader.classList.remove('is-done', 'is-slow');
  const slowTimer = setTimeout(() => loader.classList.add('is-slow'), SLOW_LOAD_MS);
  iframe.addEventListener(
    'load',
    () => {
      clearTimeout(slowTimer);
      loader.classList.add('is-done');
    },
    { once: true }
  );
}

// ── Resource monitoring: pause / resume panels ────────────
//
// Pausing unloads every iframe document in the grid (src → about:blank),
// which stops the embedded pages from consuming CPU / memory / network.
// Panel configuration is untouched — resuming restores each saved src.
// The paused flag lives on the grid element so container-level handlers
// (drop-rebuild, per-panel resume) can read it without extra plumbing.

function isGridPaused(grid) {
  return grid?.dataset.paused === '1';
}

function pauseGrid(grid, monitor) {
  if (!grid) return;
  grid.dataset.paused = '1';
  grid.querySelectorAll('.iframe-container').forEach(pauseContainer);
  renderMonitorButton(grid, monitor);
}

function resumeGrid(grid, monitor) {
  if (!grid) return;
  delete grid.dataset.paused;
  grid.querySelectorAll('.iframe-container').forEach(resumeContainer);
  renderMonitorButton(grid, monitor);
}

function renderMonitorButton(grid, monitor) {
  if (!monitor || !grid) return;
  const n = grid.querySelectorAll('.iframe-container').length;
  const paused = isGridPaused(grid);
  monitor.innerHTML = paused
    ? `${icon('play', 14)}<span>${n} paused</span>`
    : `${icon('activity', 14)}<span>${n} panel${n === 1 ? '' : 's'}</span>`;
  monitor.classList.toggle('is-paused', paused);
  const label = paused
    ? `Resume ${n} panel${n === 1 ? '' : 's'}`
    : `Pause ${n} panel${n === 1 ? '' : 's'} to free CPU/memory`;
  monitor.title = label;
  monitor.setAttribute('aria-label', label);
}

function pauseContainer(c) {
  if (c.classList.contains('is-paused')) return;
  const iframe = c.querySelector('iframe');
  if (!iframe) return;
  // Remember the configured URL, then unload the document
  c.dataset.pausedSrc = iframe.getAttribute('src') || iframe.src;
  iframe.src = 'about:blank';
  c.classList.add('is-paused');
}

function resumeContainer(c) {
  if (!c.classList.contains('is-paused')) return;
  c.classList.remove('is-paused');
  const iframe = c.querySelector('iframe');
  const src = c.dataset.pausedSrc;
  delete c.dataset.pausedSrc;
  if (iframe && src) {
    armLoader(iframe, c.querySelector('.iframe-loader'));
    iframe.src = src;
  }
}

// ── Panel resize ────────────────────────────────────────────

function attachResize(container, handle, ws, page) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = container.getBoundingClientRect().width;
    container.classList.add('is-resizing');

    const onMove = (ev) => {
      const w = Math.max(280, Math.round(startW + (ev.clientX - startX)));
      container.style.flex = `0 1 ${w}px`;
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      container.classList.remove('is-resizing');
      const finalW = Math.round(container.getBoundingClientRect().width);
      patchPage(ws.id, page.id, { w: finalW });
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp, { once: true });
    handle.addEventListener('pointercancel', onUp, { once: true });
  });
  // Resize handle must not trigger the container drag
  handle.draggable = false;
  handle.addEventListener('dragstart', (e) => e.preventDefault());
}

function attachResizeV(container, handle, ws, page) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = container.getBoundingClientRect().height;
    container.classList.add('is-resizing');

    const onMove = (ev) => {
      const h = Math.max(240, Math.round(startH + (ev.clientY - startY)));
      container.style.height = `${h}px`;
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      container.classList.remove('is-resizing');
      const finalH = Math.round(container.getBoundingClientRect().height);
      patchPage(ws.id, page.id, { h: finalH });
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp, { once: true });
    handle.addEventListener('pointercancel', onUp, { once: true });
  });
  handle.draggable = false;
  handle.addEventListener('dragstart', (e) => e.preventDefault());
}
