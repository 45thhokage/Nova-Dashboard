/**
 * Workspace system orchestrator — boots sidebar + router and registers
 * content mounters for every workspace.
 *
 *   #newpage        → existing dashboard (router controls staged reveal)
 *   #trending       → embedded source pages (Hacker News, Reddit, …)
 *   #ai-chat        → embedded AI chat page grid
 *   #ai-audio-video → embedded AI media page grid with type tabs
 *   #<custom id>    → user-created workspace page grid
 */

import { initSidebar } from './sidebar.js';
import { initRouter, registerMounter, ensureShell, navigate, getActiveWorkspaceId } from './router.js';
import { mountPageGrid } from './embed.js';
import { getAllWorkspaces, getWorkspace, getCustomWorkspaces, NEWPAGE_ID } from './store.js';

export function initWorkspaces() {
  // Preset mounters
  registerMounter('trending', (root, ws) => mountPageGrid(root, ws, { variant: 'compact' }));
  registerMounter('ai-chat', (root, ws) => mountPageGrid(root, ws, { variant: 'chat' }));
  registerMounter('ai-audio-video', (root, ws) =>
    mountPageGrid(root, ws, { variant: 'media' })
  );

  // Custom workspaces — shell + mounter for each
  syncCustomWorkspaces();

  initSidebar();
  initRouter();

  // Dashboard chrome (bottom-left toolbar + bottom-right FABs) belongs to
  // the New Page only — hide it inside every other workspace
  window.addEventListener('candy:workspace-activated', (e) => {
    document.documentElement.classList.toggle(
      'chrome-off',
      e.detail?.id !== NEWPAGE_ID
    );
  });

  // React to workspace CRUD from the Settings drawer
  // (the sidebar re-renders on the same event)
  window.addEventListener('candy:workspaces-changed', () => {
    syncCustomWorkspaces();
    // If the active workspace was deleted, fall back to the dashboard
    const active = getActiveWorkspaceId();
    if (active && !getWorkspace(active)) navigate('newpage');
  });
}

function syncCustomWorkspaces() {
  for (const ws of getCustomWorkspaces()) {
    ensureShell(ws);
    registerMounter(ws.id, (root, w) => mountPageGrid(root, w, { variant: 'chat' }));
  }
}

export { getAllWorkspaces };
