/**
 * Fixed left sidebar — collapsed icon rail (72px) that expands on hover
 * to reveal labels (220px). Data-driven from the workspace store; the
 * Settings entry sits at the bottom and opens the existing drawer.
 */

import { el, escapeHtml } from '../utils.js';
import { getAllWorkspaces, getCustomWorkspaces } from './store.js';
import { icon } from './icons.js';

let root = null;

export function initSidebar() {
  root = document.getElementById('sidebar');
  if (!root) return;
  render();
  // Keep in sync with workspace CRUD from Settings
  window.addEventListener('candy:workspaces-changed', render);
  // Highlight the active workspace
  window.addEventListener('candy:workspace-activated', (e) => {
    syncActive(e.detail?.id);
  });
}

function render() {
  if (!root) return;
  root.innerHTML = '';

  const list = el('div', { className: 'sidebar__list' });
  const presets = getAllWorkspaces().filter((ws) => !ws.custom);
  const custom = getCustomWorkspaces();

  for (const ws of presets) list.append(buildItem(ws));
  if (custom.length) {
    list.append(el('div', { className: 'sidebar__divider' }));
    for (const ws of custom) list.append(buildItem(ws));
  }

  const settingsBtn = el('button', {
    type: 'button',
    className: 'sidebar__item',
    title: 'Settings',
    'aria-label': 'Open settings',
    html: `<span class="sidebar__icon">${icon('settings', 22)}</span><span class="sidebar__label">Settings</span>`,
  });
  settingsBtn.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('candy:open-settings'));
  });

  root.append(list, el('div', { className: 'sidebar__spacer' }), settingsBtn);
  syncActive(document.querySelector('.workspace.is-active')?.dataset.workspace);
}

function buildItem(ws) {
  const btn = el('button', {
    type: 'button',
    className: 'sidebar__item',
    dataset: { ws: ws.id },
    title: ws.title,
    'aria-label': ws.title,
    html:
      `<span class="sidebar__icon">${icon(ws.icon, 22)}</span>` +
      `<span class="sidebar__label">${escapeHtml(ws.title)}</span>`,
  });
  btn.addEventListener('click', () => {
    // Hash navigation — the router does the rest
    window.location.hash = `#${ws.id}`;
  });
  return btn;
}

function syncActive(activeWsId) {
  if (!root) return;
  for (const btn of root.querySelectorAll('.sidebar__item[data-ws]')) {
    const active = btn.dataset.ws === activeWsId;
    btn.classList.toggle('is-active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
}
