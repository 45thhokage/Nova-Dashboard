/**
 * Workspace data model.
 *
 * Three layers:
 *  1. System workspace — "newpage" (the existing dashboard; no pages).
 *  2. Preset workspaces — ship with the extension (PRESET_WORKSPACES).
 *  3. Custom workspaces — user-created, stored in config.
 *
 * Page lists are editable (add / remove / reorder / resize). The first edit
 * copies a preset's default pages into config, so user changes survive
 * updates without shipping mutable state in code.
 */

import { getConfig, updateConfig } from '../config.js';
import { uid } from '../utils.js';

/** System workspace id — the existing dashboard */
export const NEWPAGE_ID = 'newpage';

// Built-in (Preset) Workspaces
// These are the default workspaces that ship with the extension.
// Each workspace has: id, title, icon (SVG name), group, and pages (URLs to embed).
export const PRESET_WORKSPACES = [
  {
    id: 'trending',
    title: 'Trending',
    icon: 'trending-up', // Lucide icon name
    group: 'dashboard', // not "custom" = preset
    pages: [
      { id: 'pg-hackernews', url: 'https://news.ycombinator.com', title: 'Hacker News' },
      { id: 'pg-reddit', url: 'https://www.reddit.com', title: 'Reddit' },
      { id: 'pg-producthunt', url: 'https://www.producthunt.com', title: 'Product Hunt' },
    ],
  },
  {
    id: 'ai-chat',
    title: 'AI Chat',
    icon: 'message-square',
    group: 'dashboard',
    pages: [
      { id: 'pg-chatgpt', url: 'https://chatgpt.com', title: 'ChatGPT' },
      { id: 'pg-claude', url: 'https://claude.ai', title: 'Claude' },
      { id: 'pg-gemini', url: 'https://gemini.google.com', title: 'Gemini' },
      { id: 'pg-perplexity', url: 'https://www.perplexity.ai', title: 'Perplexity' },
    ],
  },
  {
    id: 'ai-audio-video',
    title: 'AI Audio/Video',
    icon: 'video',
    group: 'dashboard',
    pages: [
      { id: 'pg-suno', url: 'https://suno.com', title: 'Suno (Music)', type: 'audio' },
      { id: 'pg-udio', url: 'https://www.udio.com', title: 'Udio (Music)', type: 'audio' },
      { id: 'pg-elevenlabs', url: 'https://elevenlabs.io', title: 'ElevenLabs (TTS)', type: 'audio' },
      { id: 'pg-runway', url: 'https://runwayml.com', title: 'Runway (Video)', type: 'video' },
      { id: 'pg-pika', url: 'https://www.pika.art', title: 'Pika (Video)', type: 'video' },
      { id: 'pg-kling', url: 'https://klingai.com', title: 'Kling (Video)', type: 'video' },
    ],
  },
];

/** The system workspace (existing dashboard) — always first in the sidebar */
const SYSTEM_WORKSPACE = {
  id: NEWPAGE_ID,
  title: 'New Page',
  icon: 'home',
  group: 'system',
  pages: [],
};

// ── Reads ─────────────────────────────────────────────────

function wsConfig() {
  return getConfig().workspaces || {};
}

/** Custom (user-created) workspaces, in saved order */
export function getCustomWorkspaces() {
  return (wsConfig().custom || []).map((ws) => ({ ...ws, custom: true }));
}

/** All workspaces: system → presets → custom */
export function getAllWorkspaces() {
  const presets = PRESET_WORKSPACES.map((ws) => ({ ...ws }));
  return [SYSTEM_WORKSPACE, ...presets, ...getCustomWorkspaces()];
}

export function getWorkspace(id) {
  return getAllWorkspaces().find((ws) => ws.id === id) || null;
}

/**
 * Effective page list for a workspace — user overrides from config if
 * present, otherwise the preset defaults.
 */
export function getPages(wsId) {
  const overrides = wsConfig().pages?.[wsId];
  if (overrides) return overrides.map((p) => ({ ...p }));
  const preset = PRESET_WORKSPACES.find((ws) => ws.id === wsId);
  return preset ? preset.pages.map((p) => ({ ...p })) : [];
}

// ── Writes (persisted via config → localStorage + SW mirror) ─

export function setPages(wsId, pages) {
  updateConfig((c) => ({
    ...c,
    workspaces: {
      ...(c.workspaces || {}),
      pages: {
        ...((c.workspaces || {}).pages || {}),
        [wsId]: pages.map((p) => ({ ...p })),
      },
    },
  }));
}

/** Update a single page in place (e.g. persist a resized panel width) */
export function patchPage(wsId, pageId, patch) {
  const pages = getPages(wsId);
  const i = pages.findIndex((p) => p.id === pageId);
  if (i < 0) return;
  pages[i] = { ...pages[i], ...patch };
  setPages(wsId, pages);
}

export function addPage(wsId, { url, title, type }) {
  const pages = getPages(wsId);
  const page = {
    id: uid('pg'),
    url,
    title: (title || '').trim() || new URL(url).hostname.replace(/^www\./, ''),
  };
  if (type) page.type = type;
  pages.push(page);
  setPages(wsId, pages);
  return page;
}

export function removePage(wsId, pageId) {
  setPages(
    wsId,
    getPages(wsId).filter((p) => p.id !== pageId)
  );
}

/** Move page `fromId` so it sits at `toId`'s position */
export function reorderPage(wsId, fromId, toId) {
  const pages = getPages(wsId);
  const fi = pages.findIndex((p) => p.id === fromId);
  const ti = pages.findIndex((p) => p.id === toId);
  if (fi < 0 || ti < 0 || fi === ti) return;
  const [moved] = pages.splice(fi, 1);
  pages.splice(ti, 0, moved);
  setPages(wsId, pages);
}

// ── Custom workspace CRUD ─────────────────────────────────

export function createWorkspace({ title, icon: iconName } = {}) {
  const ws = {
    id: uid('ws'),
    title: (title || '').trim().slice(0, 40) || 'Untitled',
    icon: iconName || 'globe',
    group: 'custom',
    pages: [],
  };
  updateConfig((c) => ({
    ...c,
    workspaces: {
      ...(c.workspaces || {}),
      custom: [...((c.workspaces || {}).custom || []), ws],
    },
  }));
  return { ...ws, custom: true };
}

export function deleteWorkspace(wsId) {
  updateConfig((c) => {
    const w = c.workspaces || {};
    const pages = { ...(w.pages || {}) };
    delete pages[wsId];
    return {
      ...c,
      workspaces: {
        ...w,
        custom: (w.custom || []).filter((ws) => ws.id !== wsId),
        pages,
      },
    };
  });
}
