/**
 * Shortcuts grid — drag-reorder, context menu Edit/Remove, + Add.
 * Favicons cached permanently on save only.
 */

import { getConfig, updateConfig } from '../config.js';
import { ensureFavicon, getCachedFavicon } from '../favicon.js';
import { el, uid, normalizeUrl, hostFromUrl } from '../utils.js';

let dragId = null;

export async function initShortcuts() {
  const root = document.getElementById('shortcuts-root');
  if (!root) return { refresh: () => {} };

  const cfg = getConfig();
  if (!cfg.shortcuts?.enabled) {
    root.hidden = true;
    return { refresh: render };
  }

  root.hidden = false;
  await render();

  async function render() {
    const c = getConfig();
    if (!c.shortcuts?.enabled) {
      root.hidden = true;
      root.innerHTML = '';
      return;
    }
    root.hidden = false;

    const items = c.shortcuts.items || [];
    const rows = Math.max(1, c.shortcuts.rows || 1);
    // 12 tiles per row; layout CSS shifts the row ~2 icon slots left of the old center
    const perRow = Math.max(1, c.shortcuts.perRow || 12);
    const maxVisible = rows * perRow;
    const visible = items.slice(0, maxVisible);

    root.innerHTML = '';

    for (const item of visible) {
      // Cache-only on render path — never block first paint on favicon.im
      // eslint-disable-next-line no-await-in-loop
      const fav = await getCachedFavicon(item.url);
      const imgEl = fav
        ? el('img', { src: fav, alt: '', width: '28', height: '28', loading: 'lazy' })
        : el('span', { className: 'shortcut__letter', text: (item.name || '?')[0] });

      const tile = el('a', {
        className: 'shortcut',
        href: item.url,
        draggable: 'true',
        dataset: { id: item.id },
        title: item.name,
      }, [
        el('div', { className: 'shortcut__tile' }, [imgEl]),
        el('span', { className: 'shortcut__label', text: item.name }),
      ]);

      if (!fav) {
        // Warm cache in background; swap in when ready
        ensureFavicon(item.url).then((dataUrl) => {
          if (!dataUrl) return;
          const box = tile.querySelector('.shortcut__tile');
          if (!box) return;
          box.innerHTML = '';
          box.append(
            el('img', { src: dataUrl, alt: '', width: '28', height: '28' })
          );
        });
      }

      tile.addEventListener('click', (e) => {
        // allow normal navigation unless dragging
        if (tile.classList.contains('is-dragging')) e.preventDefault();
      });

      tile.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showCtxMenu(e.clientX, e.clientY, item);
      });

      bindDrag(tile, item.id);
      root.append(tile);
    }

    // + Add tile
    const add = el('button', {
      type: 'button',
      className: 'shortcut shortcut--add',
      title: 'Add shortcut',
    }, [
      el('div', { className: 'shortcut__tile', html: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>' }),
      el('span', { className: 'shortcut__label', text: 'Add' }),
    ]);
    add.addEventListener('click', () => openShortcutModal(null));
    root.append(add);
  }

  function bindDrag(tile, id) {
    tile.addEventListener('dragstart', (e) => {
      dragId = id;
      tile.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
    });
    tile.addEventListener('dragend', () => {
      dragId = null;
      tile.classList.remove('is-dragging');
      root.querySelectorAll('.is-drag-over').forEach((n) => n.classList.remove('is-drag-over'));
    });
    tile.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      tile.classList.add('is-drag-over');
    });
    tile.addEventListener('dragleave', () => tile.classList.remove('is-drag-over'));
    tile.addEventListener('drop', (e) => {
      e.preventDefault();
      tile.classList.remove('is-drag-over');
      const from = dragId || e.dataTransfer.getData('text/plain');
      const to = id;
      if (!from || from === to) return;
      reorder(from, to);
      render();
    });
  }

  function reorder(fromId, toId) {
    updateConfig((c) => {
      const items = [...(c.shortcuts.items || [])];
      const fi = items.findIndex((x) => x.id === fromId);
      const ti = items.findIndex((x) => x.id === toId);
      if (fi < 0 || ti < 0) return c;
      const [moved] = items.splice(fi, 1);
      items.splice(ti, 0, moved);
      return { ...c, shortcuts: { ...c.shortcuts, items } };
    });
  }

  return { refresh: render };
}

// ── Context menu ──────────────────────────────────────────

function showCtxMenu(x, y, item) {
  const menu = document.getElementById('ctx-menu');
  if (!menu) return;
  menu.innerHTML = '';
  menu.hidden = false;

  const edit = el('button', {
    type: 'button',
    className: 'ctx-menu__item',
    role: 'menuitem',
    text: 'Edit',
  });
  edit.addEventListener('click', () => {
    hideCtx();
    openShortcutModal(item);
  });

  const remove = el('button', {
    type: 'button',
    className: 'ctx-menu__item ctx-menu__item--danger',
    role: 'menuitem',
    text: 'Remove',
  });
  remove.addEventListener('click', () => {
    hideCtx();
    updateConfig((c) => ({
      ...c,
      shortcuts: {
        ...c.shortcuts,
        items: (c.shortcuts.items || []).filter((s) => s.id !== item.id),
      },
    }));
    // Re-render via custom event
    window.dispatchEvent(new CustomEvent('candy:shortcuts-changed'));
  });

  menu.append(edit, remove);

  // Position within viewport
  menu.style.left = '0px';
  menu.style.top = '0px';
  const { width, height } = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - width - 8);
  const top = Math.min(y, window.innerHeight - height - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const onDoc = (e) => {
    if (!menu.contains(e.target)) hideCtx();
  };
  setTimeout(() => document.addEventListener('mousedown', onDoc, { once: true }), 0);
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') {
      hideCtx();
      document.removeEventListener('keydown', onKey);
    }
  });

  function hideCtx() {
    menu.hidden = true;
    menu.innerHTML = '';
  }
}

// ── Edit / Add modal ──────────────────────────────────────

function openShortcutModal(item) {
  const modal = document.getElementById('shortcut-modal');
  const overlay = document.getElementById('modal-overlay');
  const form = document.getElementById('shortcut-form');
  const nameInput = document.getElementById('shortcut-name');
  const urlInput = document.getElementById('shortcut-url');
  const title = document.getElementById('shortcut-modal-title');
  const cancel = document.getElementById('shortcut-cancel');

  if (!modal || !form) return;

  const isEdit = !!item;
  title.textContent = isEdit ? 'Edit Shortcut' : 'Add Shortcut';
  nameInput.value = item?.name || '';
  urlInput.value = item?.url || '';

  modal.hidden = false;
  overlay.hidden = false;
  nameInput.focus();

  const close = () => {
    modal.hidden = true;
    overlay.hidden = true;
    form.onsubmit = null;
  };

  cancel.onclick = close;
  overlay.onclick = close;

  form.onsubmit = async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    let url = urlInput.value.trim();
    if (!name || !url) return;
    url = normalizeUrl(url);

    if (isEdit) {
      updateConfig((c) => ({
        ...c,
        shortcuts: {
          ...c.shortcuts,
          items: (c.shortcuts.items || []).map((s) =>
            s.id === item.id ? { ...s, name, url } : s
          ),
        },
      }));
      // If URL host changed, re-fetch favicon
      if (hostFromUrl(item.url) !== hostFromUrl(url)) {
        await ensureFavicon(url);
      }
    } else {
      const newItem = { id: uid('sc'), name, url };
      updateConfig((c) => ({
        ...c,
        shortcuts: {
          ...c.shortcuts,
          items: [...(c.shortcuts.items || []), newItem],
        },
      }));
      // Fetch favicon once on save
      await ensureFavicon(url);
    }

    close();
    window.dispatchEvent(new CustomEvent('candy:shortcuts-changed'));
  };
}
