/**
 * Hash-based SPA router for workspaces.
 *
 *   sidebar click → window.location.hash = "#ai-chat" → hashchange
 *   → previous workspace hidden (.is-active removed, display:none)
 *   → selected workspace shown.
 *
 * Workspaces stay mounted in the DOM (display:none when inactive) so
 * embedded iframes keep their state across switches. The existing
 * dashboard's staged reveal (#app.is-ready) is controlled here: it only
 * applies while the "newpage" workspace is active.
 */

import { getWorkspace, NEWPAGE_ID } from './store.js';

let activeId = null;
const mounters = new Map(); // wsId -> (rootEl, workspace) => void
const mountedOnce = new Set();

/** Register the content mounter for a workspace (called on first activation) */
export function registerMounter(wsId, fn) {
  mounters.set(wsId, fn);
}

/** Create the DOM shell for a workspace if it doesn't exist yet */
export function ensureShell(ws) {
  if (shellFor(ws.id)) return shellFor(ws.id);
  const shell = document.createElement('div');
  shell.className = 'workspace';
  shell.dataset.workspace = ws.id;
  const inner = document.createElement('div');
  inner.className = 'workspace__inner';
  inner.id = `wsroot-${ws.id}`;
  shell.append(inner);
  document.getElementById('workspaces')?.append(shell);
  return shell;
}

function shellFor(wsId) {
  return document.querySelector(
    `.workspace[data-workspace="${cssEscape(wsId)}"]`
  );
}

function cssEscape(s) {
  return window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}

function idFromHash() {
  const id = window.location.hash.replace(/^#/, '');
  if (!id) return NEWPAGE_ID;
  return getWorkspace(id) ? id : NEWPAGE_ID;
}

export function initRouter() {
  window.addEventListener('hashchange', () => activate(idFromHash()));
  activate(idFromHash());
}

/**
 * Activate a workspace by id. Synchronous — callers may rely on the
 * workspace being visible immediately after this returns.
 */
export function activate(id) {
  let shell = shellFor(id);
  if (!shell) {
    id = NEWPAGE_ID;
    shell = shellFor(id);
  }
  if (!shell) return;

  if (activeId === id) {
    // Re-sync classes only (e.g. first call)
    shell.classList.add('is-active');
    if (id === NEWPAGE_ID) document.getElementById('app')?.classList.add('is-ready');
    announce(id);
    return;
  }

  // Leave previous workspace
  if (activeId) {
    shellFor(activeId)?.classList.remove('is-active');
    if (activeId === NEWPAGE_ID) {
      // Hide the dashboard and drop its staged-reveal state
      document.getElementById('app')?.classList.remove('is-ready');
    }
  }

  // Enter next workspace
  shell.classList.add('is-active');
  activeId = id;

  if (id === NEWPAGE_ID) {
    // Restore dashboard — content is untouched, staged reveal replays
    document.getElementById('app')?.classList.add('is-ready');
  } else if (!mountedOnce.has(id)) {
    mountedOnce.add(id);
    const ws = getWorkspace(id);
    const root = shell.querySelector('.workspace__inner');
    try {
      mounters.get(id)?.(root, ws);
    } catch (e) {
      console.warn('[candy] workspace mount failed', id, e);
    }
  }

  window.scrollTo({ top: 0 });
  announce(id);
}

function announce(id) {
  window.dispatchEvent(
    new CustomEvent('candy:workspace-activated', { detail: { id } })
  );
}

/** Navigate to a workspace without opening a new tab */
export function navigate(id) {
  if (window.location.hash === `#${id}`) {
    activate(id);
    return;
  }
  window.location.hash = `#${id}`;
}

export function getActiveWorkspaceId() {
  return activeId;
}
