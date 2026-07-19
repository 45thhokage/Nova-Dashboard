/**
 * Settings slide-out drawer — wallpapers, shortcuts, topics,
 * weather, storage & data.
 */

import {
  getConfig,
  updateConfig,
  createDefaultConfig,
  setConfig,
  DEFAULT_TOPICS,
} from '../config.js';
// getConfig used by topic drag-reorder re-render
import { el, formatBytes, debounce, clamp } from '../utils.js';
import {
  clearArticles,
  clearFavicons,
  clearWeatherCache,
  clearFeedItemsCache,
  estimateStoreSizes,
  wipeAllIdb,
  kvGet,
} from '../storage/idb.js';
import {
  clearAllCaches,
  estimateCacheSize,
  CACHE_IMAGES,
  CACHE_WALLPAPERS,
} from '../storage/cache-api.js';
import { geocodeCity } from '../weather/providers.js';
import { refreshWeatherInBackground, getWeatherForRender } from '../weather/weather.js';
import {
  getStocksForRender,
  getStocksMeta,
  refreshStocksInBackground,
} from '../stocks/stocks.js';
import { applyWallpaper, saveCustomWallpaper, clearCustomWallpaper } from '../wallpaper.js';

const ABSTRACT_WALLPAPERS = [
  { id: 'abs-1', label: 'Aurora', value: 'assets/wallpapers/abstract-1.svg' },
  { id: 'abs-2', label: 'Nebula', value: 'assets/wallpapers/abstract-2.svg' },
  { id: 'abs-3', label: 'Mesh', value: 'assets/wallpapers/abstract-3.svg' },
  { id: 'abs-4', label: 'Horizon', value: 'assets/wallpapers/abstract-4.svg' },
];

const SOLID_COLORS = [
  { id: 'solid-deep', label: 'Deep', value: '#1c1b22' },
  { id: 'solid-navy', label: 'Navy', value: '#0f1419' },
  { id: 'solid-forest', label: 'Forest', value: '#121a16' },
  { id: 'solid-wine', label: 'Wine', value: '#1a1216' },
  { id: 'solid-slate', label: 'Slate', value: '#1a1d24' },
  { id: 'solid-void', label: 'Void', value: '#0a0a0c' },
];

export function initSettings({ onChange } = {}) {
  const fab = document.getElementById('settings-fab');
  const drawer = document.getElementById('settings-drawer');
  const overlay = document.getElementById('settings-overlay');
  const closeBtn = document.getElementById('settings-close');
  const body = document.getElementById('settings-body');

  if (!fab || !drawer || !body) return;

  const open = () => {
    overlay.hidden = false;
    requestAnimationFrame(() => {
      overlay.classList.add('is-open');
      drawer.classList.add('is-open');
      drawer.setAttribute('aria-hidden', 'false');
    });
    renderBody(body, onChange);
  };

  const close = () => {
    overlay.classList.remove('is-open');
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    setTimeout(() => {
      overlay.hidden = true;
    }, 300);
  };

  fab.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  overlay?.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.classList.contains('is-open')) close();
  });
}

function renderBody(body, onChange) {
  const cfg = getConfig();
  body.innerHTML = '';

  // ── Wallpapers ────────────────────────────────────────
  body.append(section('Wallpapers', null, buildWallpaperGrid(cfg, onChange)));

  // ── Shortcuts ─────────────────────────────────────────
  const shortcutsBlock = el('div');
  shortcutsBlock.append(
    rowToggle('Show shortcuts', cfg.shortcuts.enabled, (v) => {
      updateConfig((c) => ({ ...c, shortcuts: { ...c.shortcuts, enabled: v } }));
      onChange?.('shortcuts');
    }),
    rowSelect(
      'Shortcut rows',
      String(cfg.shortcuts.rows || 1),
      [
        { value: '1', label: '1 row' },
        { value: '2', label: '2 rows' },
        { value: '3', label: '3 rows' },
      ],
      (v) => {
        updateConfig((c) => ({
          ...c,
          shortcuts: { ...c.shortcuts, rows: Number(v) },
        }));
        onChange?.('shortcuts');
      }
    )
  );
  body.append(section('Shortcuts', null, shortcutsBlock));

  // ── Content ───────────────────────────────────────────
  body.append(
    section(
      'Content & Streams',
      null,
      rowToggle('Show news feed', cfg.content.enabled, (v) => {
        updateConfig((c) => ({ ...c, content: { ...c.content, enabled: v } }));
        onChange?.('feed');
      })
    )
  );

  // ── Topics ────────────────────────────────────────────
  body.append(
    section(
      'Manage Topics',
      'Toggle Following or Blocked. Drag the handle to reorder sections on the new tab page.',
      buildTopics(cfg, onChange)
    )
  );

  // ── Weather ───────────────────────────────────────────
  body.append(section('Weather', null, buildWeatherSettings(cfg, onChange)));

  // ── Markets (stocks widget) ───────────────────────────
  body.append(section('Markets', null, buildStocksSettings(cfg, onChange)));

  // ── Storage ───────────────────────────────────────────
  body.append(section('Storage & Data', null, buildStoragePanel(onChange)));

  // ── Discoverability pointer for feed reader ───────────
  body.append(buildFeedsPointer());
}

function buildFeedsPointer() {
  const wrap = el('div', {
    className: 'settings-section',
    style: {
      marginTop: '8px',
      paddingTop: '16px',
      borderTop: '1px solid var(--border)',
    },
  });
  wrap.append(
    el('p', {
      className: 'settings-section__desc',
      html:
        'Manage RSS, Atom, and JSON Feed subscriptions from the Feeds page — click the ' +
        '<a href="feeds.html" class="feeds-settings-link">feed icon</a> next to Settings.',
    })
  );
  return wrap;
}

function section(title, desc, content) {
  const s = el('section', { className: 'settings-section' }, [
    el('h3', { className: 'settings-section__title', text: title }),
  ]);
  if (desc) s.append(el('p', { className: 'settings-section__desc', text: desc }));
  if (content) s.append(content);
  return s;
}

function rowToggle(label, checked, onToggle, hint) {
  const id = `sw_${Math.random().toString(36).slice(2, 8)}`;
  const row = el('div', { className: 'settings-row' });
  const left = el('div', { className: 'settings-row__left' }, [
    el('span', { className: 'settings-row__label', text: label }),
  ]);
  if (hint) left.append(el('span', { className: 'settings-row__hint', text: hint }));

  const sw = el('label', { className: 'switch', for: id }, [
    el('input', { type: 'checkbox', id, checked: checked ? true : undefined }),
    el('span', { className: 'switch__track' }),
  ]);
  sw.querySelector('input').addEventListener('change', (e) => onToggle(e.target.checked));
  row.append(left, sw);
  return row;
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

// ── Wallpapers ────────────────────────────────────────────

function buildWallpaperGrid(cfg, onChange) {
  const wrap = el('div');
  const grid = el('div', { className: 'wallpaper-grid' });

  const current = cfg.wallpaper || {};

  for (const solid of SOLID_COLORS) {
    const active =
      current.type === 'solid' && current.value === solid.value;
    const tile = el('button', {
      type: 'button',
      className: `wallpaper-tile${active ? ' is-active' : ''}`,
      title: solid.label,
    }, [
      el('span', {
        className: 'wallpaper-swatch',
        style: { background: solid.value },
      }),
      el('span', { className: 'wallpaper-tile__label', text: solid.label }),
    ]);
    tile.addEventListener('click', async () => {
      await clearCustomWallpaper();
      updateConfig((c) => ({
        ...c,
        wallpaper: { type: 'solid', value: solid.value, customDataUrl: null },
      }));
      await applyWallpaper(getConfig().wallpaper);
      onChange?.('wallpaper');
      renderBody(document.getElementById('settings-body'), onChange);
    });
    grid.append(tile);
  }

  for (const abs of ABSTRACT_WALLPAPERS) {
    const active =
      current.type === 'abstract' && current.value === abs.value;
    const tile = el('button', {
      type: 'button',
      className: `wallpaper-tile${active ? ' is-active' : ''}`,
      title: abs.label,
    }, [
      el('img', { src: abs.value, alt: abs.label }),
      el('span', { className: 'wallpaper-tile__label', text: abs.label }),
    ]);
    tile.addEventListener('click', async () => {
      await clearCustomWallpaper();
      updateConfig((c) => ({
        ...c,
        wallpaper: { type: 'abstract', value: abs.value, customDataUrl: null },
      }));
      await applyWallpaper(getConfig().wallpaper);
      onChange?.('wallpaper');
      renderBody(document.getElementById('settings-body'), onChange);
    });
    grid.append(tile);
  }

  // Upload
  const upload = el('button', {
    type: 'button',
    className: `wallpaper-tile wallpaper-upload${current.type === 'custom' ? ' is-active' : ''}`,
    title: 'Upload an image',
  }, [
    el('span', { text: '↑' }),
    el('span', { text: 'Upload' }),
  ]);
  upload.addEventListener('click', () => {
    const input = el('input', {
      type: 'file',
      accept: 'image/*',
      style: { display: 'none' },
    });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const dataUrl = await readFileAsDataUrl(file);
      // Store heavy payload in IDB — config only keeps the type flag
      await saveCustomWallpaper(dataUrl);
      updateConfig((c) => ({
        ...c,
        wallpaper: { type: 'custom', value: 'custom', customDataUrl: null },
      }));
      await applyWallpaper(getConfig().wallpaper);
      onChange?.('wallpaper');
      renderBody(document.getElementById('settings-body'), onChange);
    });
    document.body.append(input);
    input.click();
    input.remove();
  });
  grid.append(upload);

  wrap.append(grid);
  return wrap;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ── Topics ────────────────────────────────────────────────

function buildTopics(cfg, onChange) {
  const list = el('div', { className: 'topic-list' });
  // Preserve stored order; append any new catalog topics at the end
  const stored = [...(cfg.topics || [])];
  const seen = new Set(stored.map((t) => t.id));
  for (const def of DEFAULT_TOPICS) {
    if (!seen.has(def.id)) {
      stored.push({ ...def });
      seen.add(def.id);
    }
  }

  let dragId = null;

  for (const topic of stored) {
    const item = el('div', {
      className: 'topic-item',
      draggable: 'true',
      dataset: { id: topic.id },
    });

    const handle = el('span', {
      className: 'topic-item__handle',
      title: 'Drag to reorder',
      'aria-label': 'Drag to reorder',
      html: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>`,
    });

    const name = el('span', { className: 'topic-item__name', text: topic.label });

    const status = el('button', {
      type: 'button',
      className: `topic-item__status ${topic.following ? 'is-following' : 'is-blocked'}`,
      text: topic.following ? 'Following' : 'Blocked',
    });
    status.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = !topic.following;
      topic.following = next;
      updateConfig((c) => {
        const exists = c.topics.some((t) => t.id === topic.id);
        const topicsNext = exists
          ? c.topics.map((t) =>
              t.id === topic.id ? { ...t, following: next } : t
            )
          : [...c.topics, { ...topic, following: next }];
        return { ...c, topics: topicsNext };
      });
      status.textContent = next ? 'Following' : 'Blocked';
      status.className = `topic-item__status ${next ? 'is-following' : 'is-blocked'}`;
      onChange?.('feed');
    });

    item.append(handle, name, status);

    item.addEventListener('dragstart', (e) => {
      dragId = topic.id;
      item.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', topic.id);
    });
    item.addEventListener('dragend', () => {
      dragId = null;
      item.classList.remove('is-dragging');
      list.querySelectorAll('.is-drag-over').forEach((n) => n.classList.remove('is-drag-over'));
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('is-drag-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('is-drag-over'));
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('is-drag-over');
      const fromId = dragId || e.dataTransfer.getData('text/plain');
      const toId = topic.id;
      if (!fromId || fromId === toId) return;

      updateConfig((c) => {
        // Full ordered list including any newly discovered catalog topics
        const byId = new Map((c.topics || []).map((t) => [t.id, t]));
        for (const def of DEFAULT_TOPICS) {
          if (!byId.has(def.id)) byId.set(def.id, { ...def });
        }
        const order = [...byId.keys()];
        // Prefer current DOM order as source of truth for stored ids
        const currentOrder = [...list.querySelectorAll('.topic-item')].map(
          (n) => n.dataset.id
        );
        const base = currentOrder.length ? currentOrder : order;
        const topicsOrdered = base
          .map((id) => byId.get(id))
          .filter(Boolean);
        const fi = topicsOrdered.findIndex((t) => t.id === fromId);
        const ti = topicsOrdered.findIndex((t) => t.id === toId);
        if (fi < 0 || ti < 0) return c;
        const next = [...topicsOrdered];
        const [moved] = next.splice(fi, 1);
        next.splice(ti, 0, moved);
        return { ...c, topics: next };
      });
      onChange?.('feed');
      // Re-render list to match new order
      const parent = list.parentElement;
      const fresh = buildTopics(getConfig(), onChange);
      list.replaceWith(fresh);
    });

    list.append(item);
  }
  return list;
}

// ── Weather settings ──────────────────────────────────────

function buildWeatherSettings(cfg, onChange) {
  const wrap = el('div');
  const w = cfg.weather || {};

  wrap.append(
    rowSelect(
      'Temperature',
      w.tempUnit || 'f',
      [
        { value: 'f', label: '°F' },
        { value: 'c', label: '°C' },
      ],
      (v) => {
        updateConfig((c) => ({ ...c, weather: { ...c.weather, tempUnit: v } }));
        onChange?.('weather');
      }
    ),
    rowSelect(
      'Wind speed',
      w.windUnit || 'mph',
      [
        { value: 'mph', label: 'mph' },
        { value: 'kmh', label: 'km/h' },
        { value: 'ms', label: 'm/s' },
        { value: 'kn', label: 'knots' },
      ],
      (v) => {
        updateConfig((c) => ({ ...c, weather: { ...c.weather, windUnit: v } }));
        onChange?.('weather');
      }
    ),
    rowSelect(
      'Pressure',
      w.pressureUnit || 'hpa',
      [
        { value: 'hpa', label: 'hPa' },
        { value: 'inhg', label: 'inHg' },
        { value: 'mmhg', label: 'mmHg' },
      ],
      (v) => {
        updateConfig((c) => ({
          ...c,
          weather: { ...c.weather, pressureUnit: v },
        }));
        onChange?.('weather');
      }
    ),
    rowSelect(
      'Clock',
      w.clock24h ? '24' : '12',
      [
        { value: '12', label: '12-hour' },
        { value: '24', label: '24-hour' },
      ],
      (v) => {
        updateConfig((c) => ({
          ...c,
          weather: { ...c.weather, clock24h: v === '24' },
        }));
      }
    ),
    rowSelect(
      'Refresh interval',
      String(clamp(w.refreshMinutes || 15, 10, 120)),
      [
        { value: '10', label: '10 min (min)' },
        { value: '15', label: '15 min' },
        { value: '30', label: '30 min' },
        { value: '60', label: '60 min' },
      ],
      (v) => {
        const minutes = clamp(Number(v), 10, 120);
        updateConfig((c) => ({
          ...c,
          weather: { ...c.weather, refreshMinutes: minutes },
        }));
        try {
          chrome.runtime?.sendMessage?.({
            type: 'weather:set-alarm',
            minutes,
          });
        } catch {
          /* ignore */
        }
      },
      'Background update floor: 10 minutes'
    )
  );

  // Location
  const locBlock = el('div', { style: { marginTop: '12px' } });
  locBlock.append(
    el('p', {
      className: 'settings-section__desc',
      text: 'Location source and city search (Open-Meteo geocoding).',
    }),
    rowSelect(
      'Location source',
      w.locationMode || 'geo',
      [
        { value: 'geo', label: 'Browser geolocation' },
        { value: 'manual', label: 'Manual city' },
      ],
      (v) => {
        updateConfig((c) => ({
          ...c,
          weather: { ...c.weather, locationMode: v },
        }));
      }
    )
  );

  const searchField = el('label', { className: 'field', style: { marginTop: '8px' } }, [
    el('span', { className: 'field__label', text: 'City search' }),
    el('input', {
      type: 'search',
      className: 'field__input',
      id: 'weather-city-search',
      placeholder: 'Search city…',
      autocomplete: 'off',
    }),
  ]);
  const results = el('div', { className: 'location-results' });
  const input = searchField.querySelector('input');
  const doSearch = debounce(async () => {
    const q = input.value.trim();
    results.innerHTML = '';
    if (q.length < 2) return;
    const hits = await geocodeCity(q);
    for (const hit of hits) {
      const btn = el('button', {
        type: 'button',
        className: 'location-result',
        text: hit.label,
      });
      btn.addEventListener('click', async () => {
        updateConfig((c) => ({
          ...c,
          weather: {
            ...c.weather,
            locationMode: 'manual',
            manualLat: hit.lat,
            manualLon: hit.lon,
            manualName: hit.label,
            locations: mergeLocation(c.weather.locations || [], hit),
            activeLocationId: hit.id,
          },
        }));
        input.value = hit.label;
        results.innerHTML = '';
        await refreshWeatherInBackground({ force: true });
        onChange?.('weather');
      });
      results.append(btn);
    }
  }, 280);
  input.addEventListener('input', doSearch);
  locBlock.append(searchField, results);

  const resetLoc = el('button', {
    type: 'button',
    className: 'btn btn--sm btn--ghost',
    text: 'Use browser location',
    style: { marginTop: '8px' },
  });
  resetLoc.addEventListener('click', async () => {
    updateConfig((c) => ({
      ...c,
      weather: {
        ...c.weather,
        locationMode: 'geo',
        manualLat: null,
        manualLon: null,
        manualName: null,
        activeLocationId: null,
      },
    }));
    await refreshWeatherInBackground({ force: true });
    onChange?.('weather');
  });
  locBlock.append(resetLoc);

  const manualRefresh = el('button', {
    type: 'button',
    className: 'btn btn--sm btn--primary',
    text: 'Refresh weather now',
    style: { marginTop: '12px' },
  });
  manualRefresh.addEventListener('click', async () => {
    manualRefresh.disabled = true;
    manualRefresh.textContent = 'Refreshing…';
    await refreshWeatherInBackground({ force: true });
    manualRefresh.disabled = false;
    manualRefresh.textContent = 'Refresh weather now';
    onChange?.('weather');
  });
  locBlock.append(manualRefresh);

  // Diagnostics — collapsed, computed only when opened
  const diag = el('div', { className: 'collapsible', style: { marginTop: '12px' } });
  const diagTrigger = el('button', {
    type: 'button',
    className: 'collapsible__trigger',
    html: `<span>Diagnostics</span><span class="collapsible__chevron">▾</span>`,
  });
  const diagBody = el('div', { className: 'collapsible__body' });
  diagTrigger.addEventListener('click', async () => {
    const open = diag.classList.toggle('is-open');
    if (open && !diagBody.dataset.loaded) {
      diagBody.dataset.loaded = '1';
      const cached = await getWeatherForRender();
      const lastFail = await kvGet('weather_last_error');
      diagBody.append(
        el('dl', { className: 'diag-list' }, [
          el('dt', { text: 'Active provider' }),
          el('dd', { text: cached?.provider || 'none' }),
          el('dt', { text: 'Last successful update' }),
          el('dd', {
            text: cached?.updatedAt
              ? new Date(cached.updatedAt).toLocaleString()
              : 'never',
          }),
          el('dt', { text: 'Last failure' }),
          el('dd', { text: lastFail || 'none' }),
          el('dt', { text: 'Connection' }),
          el('dd', { text: navigator.onLine ? 'Online' : 'Offline' }),
        ])
      );
    }
  });
  diag.append(diagTrigger, diagBody);
  locBlock.append(diag);

  wrap.append(locBlock);
  return wrap;
}

function mergeLocation(list, hit) {
  const rest = list.filter((l) => l.id !== hit.id);
  return [hit, ...rest].slice(0, 8);
}

// ── Markets / stocks settings ─────────────────────────────

function buildStocksSettings(cfg, onChange) {
  const wrap = el('div');
  wrap.append(
    rowToggle('Show markets widget', cfg.stocks?.enabled !== false, (v) => {
      updateConfig((c) => ({
        ...c,
        stocks: { ...c.stocks, enabled: v },
      }));
      onChange?.('stocks');
    }),
    el('p', {
      className: 'settings-section__desc',
      text:
        'Watchlist is managed inline on the top-left widget (+ Add ticker). Quotes use Yahoo Finance with Stooq / CoinGecko fallbacks. No fake data.',
    })
  );

  const refreshBtn = el('button', {
    type: 'button',
    className: 'btn btn--sm btn--primary',
    text: 'Refresh quotes now',
    style: { marginTop: '12px' },
  });
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing…';
    await refreshStocksInBackground({ force: true });
    refreshBtn.disabled = false;
    refreshBtn.textContent = 'Refresh quotes now';
    onChange?.('stocks');
  });
  wrap.append(refreshBtn);

  const diag = el('div', { className: 'collapsible', style: { marginTop: '12px' } });
  const diagTrigger = el('button', {
    type: 'button',
    className: 'collapsible__trigger',
    html: `<span>Markets diagnostics</span><span class="collapsible__chevron">▾</span>`,
  });
  const diagBody = el('div', { className: 'collapsible__body' });
  diagTrigger.addEventListener('click', async () => {
    const open = diag.classList.toggle('is-open');
    if (open && !diagBody.dataset.loaded) {
      diagBody.dataset.loaded = '1';
      const cache = await getStocksForRender();
      const meta = await getStocksMeta();
      const statusNote =
        meta.lastErrorStatus === 429
          ? 'HTTP 429 Too Many Requests — rate limited. Wait and reduce refresh pressure.'
          : meta.lastErrorStatus
            ? `HTTP ${meta.lastErrorStatus}`
            : '—';

      const perSym = Object.entries(meta.perSymbol || {}).map(([sym, info]) =>
        el('div', {
          className: 'settings-section__desc',
          text: `${sym}: ${info.provider || '?'}${info.error ? ` · ${info.error}` : ''}${info.updatedAt ? ` · ${new Date(info.updatedAt).toLocaleString()}` : ''}`,
        })
      );

      diagBody.append(
        el('dl', { className: 'diag-list' }, [
          el('dt', { text: 'Watchlist' }),
          el('dd', {
            text: (getConfig().stocks?.symbols || []).join(', ') || '(empty)',
          }),
          el('dt', { text: 'Cache updated' }),
          el('dd', {
            text: cache?.updatedAt
              ? new Date(cache.updatedAt).toLocaleString()
              : 'never',
          }),
          el('dt', { text: 'Last error' }),
          el('dd', { text: meta.lastError || 'none' }),
          el('dt', { text: 'Last error status' }),
          el('dd', { text: statusNote }),
          el('dt', { text: 'Last error time' }),
          el('dd', {
            text: meta.lastErrorAt
              ? new Date(meta.lastErrorAt).toLocaleString()
              : '—',
          }),
          el('dt', { text: 'Connection' }),
          el('dd', { text: navigator.onLine ? 'Online' : 'Offline' }),
        ]),
        el('p', {
          className: 'settings-section__desc',
          style: { marginTop: '8px' },
          text: 'Per symbol',
        }),
        ...perSym
      );
    }
  });
  diag.append(diagTrigger, diagBody);
  wrap.append(diag);
  return wrap;
}

// ── Storage panel ─────────────────────────────────────────

function buildStoragePanel(onChange) {
  const wrap = el('div');
  const breakdown = el('div', { className: 'storage-breakdown' }, [
    el('div', { className: 'storage-row', text: 'Calculating…' }),
  ]);
  wrap.append(breakdown);

  (async () => {
    const sizes = await estimateStoreSizes();
    const imgCache = await estimateCacheSize(CACHE_IMAGES);
    const wallCache = await estimateCacheSize(CACHE_WALLPAPERS);

    let quotaUsage = 0;
    let quotaTotal = 0;
    try {
      const est = await navigator.storage?.estimate?.();
      quotaUsage = est?.usage || 0;
      quotaTotal = est?.quota || 0;
    } catch {
      /* ignore */
    }

    const articles = sizes.articles + sizes.category_meta;
    const feedItems = (sizes.feed_items || 0) + (sizes.feed_meta || 0);
    const feedSubs = sizes.feed_subscriptions || 0;
    const favicons = sizes.favicons;
    const weather = sizes.weather;
    const settingsEst = 50_000; // localStorage config rough
    const images = imgCache;
    const wallpapers = wallCache + (sizes.kv || 0);
    const total =
      articles + feedItems + feedSubs + images + wallpapers + settingsEst + favicons + weather;

    breakdown.innerHTML = '';
    const rows = [
      ['Cached articles', articles],
      ['Feed items cache', feedItems],
      ['Feed subscriptions', feedSubs],
      ['Cached images', images],
      ['Favicons', favicons],
      ['Wallpapers', wallpapers],
      ['Weather cache', weather],
      ['Settings/config', settingsEst],
    ];
    for (const [label, bytes] of rows) {
      breakdown.append(
        el('div', { className: 'storage-row' }, [
          el('span', { text: label }),
          el('span', { text: formatBytes(bytes) }),
        ])
      );
    }
    breakdown.append(
      el('div', { className: 'storage-row storage-row--total' }, [
        el('span', { text: 'Total (est.)' }),
        el('span', { text: formatBytes(total) }),
      ])
    );
    if (quotaTotal) {
      breakdown.append(
        el('div', {
          className: 'storage-row',
          style: { marginTop: '4px', fontSize: '12px', color: 'var(--text-tertiary)' },
          text: `Browser quota: ${formatBytes(quotaUsage)} / ${formatBytes(quotaTotal)}`,
        })
      );
    }
  })();

  const actions = el('div', { className: 'storage-actions' });

  const clearCache = el('button', {
    type: 'button',
    className: 'btn btn--ghost',
    text: 'Clear Cache',
  });
  clearCache.addEventListener('click', async () => {
    if (!confirm('Clear cached articles, feed items, images, and favicons? Settings, shortcuts, and feed subscriptions are kept.')) {
      return;
    }
    clearCache.disabled = true;
    await clearArticles();
    await clearFeedItemsCache();
    await clearFavicons();
    await clearWeatherCache();
    await clearAllCaches();
    clearCache.disabled = false;
    clearCache.textContent = 'Cleared';
    onChange?.('feed');
    onChange?.('weather');
    onChange?.('shortcuts');
    setTimeout(() => {
      clearCache.textContent = 'Clear Cache';
      renderBody(document.getElementById('settings-body'), onChange);
    }, 800);
  });

  const resetAll = el('button', {
    type: 'button',
    className: 'btn btn--danger',
    text: 'Reset All',
  });
  resetAll.addEventListener('click', async () => {
    if (
      !confirm(
        'Factory reset? This clears settings, shortcuts, wallpapers, and all caches.'
      )
    ) {
      return;
    }
    await wipeAllIdb();
    await clearAllCaches();
    localStorage.clear();
    setConfig(createDefaultConfig());
    location.reload();
  });

  actions.append(clearCache, resetAll);
  wrap.append(actions);
  return wrap;
}
