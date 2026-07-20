/**
 * Top-left stock/ETF ticker widget.
 * Cache-first paint; add / remove / reorder inline; sparklines from cache.
 */

import { getConfig } from '../config.js';
import { el, relativeTime } from '../utils.js';
import {
  getStocksForRender,
  onStocksUpdate,
  refreshStocksInBackground,
  addSymbol,
  removeSymbol,
  reorderSymbols,
  formatPrice,
  formatChange,
  sparklineSvg,
  normalizeSymbol,
} from '../stocks/stocks.js';

let dragSym = null;
let adding = false;
let listenersBound = false;

export async function initStocksWidget() {
  const root = document.getElementById('stocks-root');
  if (!root) return;

  const cfg = getConfig();
  if (cfg.stocks?.enabled === false) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  root.hidden = false;

  const cache = await getStocksForRender();
  render(root, cache);

  if (!listenersBound) {
    listenersBound = true;
    onStocksUpdate((next) => {
      const r = document.getElementById('stocks-root');
      if (!r) return;
      // Don't clobber an open "add" input mid-type unless forced empty
      if (adding) return;
      render(r, next);
    });
  }

  // Background refresh after paint — never on the critical path
  refreshStocksInBackground().catch(() => {});
}

function render(root, cache) {
  const cfg = getConfig();
  if (cfg.stocks?.enabled === false) {
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  root.hidden = false;

  const symbols = (cfg.stocks?.symbols || []).map(normalizeSymbol).filter(Boolean);
  const quotes = cache?.quotes || {};

  root.innerHTML = '';
  const card = el('div', {
    className: 'stocks',
    role: 'region',
    'aria-label': 'Stock watchlist',
  });

  const header = el('div', { className: 'stocks__header' }, [
    el('span', { className: 'stocks__title', text: 'Markets' }),
    el('button', {
      type: 'button',
      className: 'stocks__refresh',
      title: 'Refresh quotes',
      'aria-label': 'Refresh quotes',
      html: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.2"/><path d="M21 3v6h-6"/></svg>`,
    }),
  ]);

  const refreshBtn = header.querySelector('.stocks__refresh');
  refreshBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    refreshBtn.disabled = true;
    refreshBtn.classList.add('is-spinning');
    await refreshStocksInBackground({ force: true });
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('is-spinning');
    // render happens via onStocksUpdate; if still adding, force re-paint after
    if (!adding) {
      const next = await getStocksForRender();
      render(root, next);
    }
  });

  const list = el('div', { className: 'stocks__list' });

  for (const sym of symbols) {
    const q = quotes[sym];
    list.append(rowEl(sym, q, root));
  }

  // + Add row (same spirit as shortcut add tile)
  const addRow = el('div', { className: 'stocks__add-row' });
  const addBtn = el('button', {
    type: 'button',
    className: 'stocks__add-btn',
    text: '+ Add ticker',
  });
  addBtn.addEventListener('click', () => {
    openAddForm(addRow, root);
  });
  addRow.append(addBtn);

  const footer = el('div', { className: 'stocks__footer' }, [
    el('span', {
      className: 'stocks__updated',
      text: cache?.updatedAt ? `Updated ${relativeTime(cache.updatedAt)}` : 'No quotes yet',
    }),
  ]);

  card.append(header, list, addRow, footer);
  root.append(card);
}

function rowEl(sym, q, root) {
  const { text: chgText, dir } = formatChange(q?.change, q?.changePercent);
  const up = dir !== 'down';
  const priceText = q ? formatPrice(q.price, q.currency) : '—';
  const spark = sparklineSvg(q?.history || [], { up, width: 56, height: 20 });

  const row = el('div', {
    className: `stocks__row stocks__row--${dir}`,
    draggable: 'true',
    dataset: { symbol: sym },
    title: q?.provider ? `${sym} · ${q.provider}` : sym,
  }, [
    el('span', {
      className: 'stocks__dir',
      'aria-hidden': 'true',
      text: dir === 'up' ? '▲' : dir === 'down' ? '▼' : '●',
    }),
    el('span', { className: 'stocks__sym', text: sym }),
    el('span', { className: 'stocks__spark', html: spark }),
    el('span', { className: 'stocks__quote' }, [
      el('span', { className: 'stocks__price', text: priceText }),
      el('span', { className: 'stocks__chg', text: chgText }),
    ]),
    el('button', {
      type: 'button',
      className: 'stocks__remove',
      title: `Remove ${sym}`,
      'aria-label': `Remove ${sym}`,
      text: '×',
    }),
  ]);

  row.querySelector('.stocks__remove')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await removeSymbol(sym);
    adding = false;
    const next = await getStocksForRender();
    render(root, next);
  });

  bindDrag(row, sym, root);
  return row;
}

function bindDrag(row, sym, root) {
  row.addEventListener('dragstart', (e) => {
    dragSym = sym;
    row.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', sym);
  });
  row.addEventListener('dragend', () => {
    dragSym = null;
    row.classList.remove('is-dragging');
    root.querySelectorAll('.is-drag-over').forEach((n) => n.classList.remove('is-drag-over'));
  });
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add('is-drag-over');
  });
  row.addEventListener('dragleave', () => row.classList.remove('is-drag-over'));
  row.addEventListener('drop', async (e) => {
    e.preventDefault();
    row.classList.remove('is-drag-over');
    const from = dragSym || e.dataTransfer.getData('text/plain');
    const to = sym;
    if (!from || from === to) return;
    reorderSymbols(from, to);
    const next = await getStocksForRender();
    render(root, next);
  });
}

function openAddForm(addRow, root) {
  adding = true;
  addRow.innerHTML = '';
  const form = el('form', { className: 'stocks__add-form' }, [
    el('input', {
      type: 'text',
      className: 'stocks__add-input',
      placeholder: 'AAPL, BTC-USD…',
      maxlength: '16',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': 'Ticker symbol',
    }),
    el('button', { type: 'submit', className: 'btn btn--sm btn--primary', text: 'Add' }),
    el('button', { type: 'button', className: 'btn btn--sm btn--ghost stocks__add-cancel', text: 'Cancel' }),
  ]);
  const input = form.querySelector('.stocks__add-input');
  const cancel = form.querySelector('.stocks__add-cancel');
  const status = el('div', { className: 'stocks__add-status', hidden: true });

  cancel.addEventListener('click', async () => {
    adding = false;
    const next = await getStocksForRender();
    render(root, next);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = input.value.trim();
    if (!raw) return;
    input.disabled = true;
    form.querySelector('[type=submit]').disabled = true;
    status.hidden = false;
    status.textContent = 'Checking…';
    status.classList.remove('is-error');

    const result = await addSymbol(raw);
    if (!result.ok) {
      status.textContent = result.error || 'Could not add';
      status.classList.add('is-error');
      input.disabled = false;
      form.querySelector('[type=submit]').disabled = false;
      input.focus();
      return;
    }

    adding = false;
    const next = await getStocksForRender();
    render(root, next);
  });

  addRow.append(form, status);
  input.focus();
}
