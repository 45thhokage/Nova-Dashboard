/**
 * Wallpaper application + preload before UI reveal.
 * Custom uploads live in IndexedDB (kv) so localStorage stays small.
 */

import { preloadImage } from './storage/cache-api.js';
import { kvGet, kvSet, kvDelete } from './storage/idb.js';

const CUSTOM_WALLPAPER_KEY = 'custom_wallpaper_dataurl';

/**
 * Resolve wallpaper CSS value from config (+ optional custom data URL from IDB).
 */
export function resolveWallpaperSrc(wallpaper, customDataUrl = null) {
  if (!wallpaper) return '#1c1b22';
  if (wallpaper.type === 'custom') {
    return customDataUrl || wallpaper.customDataUrl || '#1c1b22';
  }
  if (wallpaper.type === 'abstract' || wallpaper.type === 'image') {
    return wallpaper.value || '#1c1b22';
  }
  // solid
  return wallpaper.value || '#1c1b22';
}

/**
 * Preload then paint wallpaper layer. Resolves when ready.
 */
export async function prepareWallpaper(wallpaper) {
  let custom = null;
  if (wallpaper?.type === 'custom') {
    custom = (await kvGet(CUSTOM_WALLPAPER_KEY)) || wallpaper.customDataUrl || null;
  }
  const src = resolveWallpaperSrc(wallpaper, custom);
  await preloadImage(src);
  paintWallpaperLayer(src);
  return src;
}

export async function applyWallpaper(wallpaper) {
  let custom = null;
  if (wallpaper?.type === 'custom') {
    custom = (await kvGet(CUSTOM_WALLPAPER_KEY)) || wallpaper.customDataUrl || null;
  }
  paintWallpaperLayer(resolveWallpaperSrc(wallpaper, custom));
}

export async function saveCustomWallpaper(dataUrl) {
  await kvSet(CUSTOM_WALLPAPER_KEY, dataUrl);
}

export async function clearCustomWallpaper() {
  await kvDelete(CUSTOM_WALLPAPER_KEY);
}

function paintWallpaperLayer(src) {
  const layer = document.getElementById('wallpaper');
  if (!layer) return;

  if (src.startsWith('#') || src.startsWith('rgb') || src.startsWith('linear-gradient')) {
    layer.style.backgroundImage = 'none';
    layer.style.backgroundColor = src.startsWith('linear') ? 'transparent' : src;
    if (src.startsWith('linear')) {
      layer.style.backgroundImage = src;
    }
  } else {
    layer.style.backgroundColor = '#1c1b22';
    layer.style.backgroundImage = `url("${src.replace(/"/g, '\\"')}")`;
  }
}
