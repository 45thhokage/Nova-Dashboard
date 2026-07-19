/**
 * Nova New Tab — orchestrator.
 *
 * Staged reveal pipeline:
 * 1. Sync config from localStorage (block one)
 * 2. Paint solid bg (already in HTML)
 * 3. Preload wallpaper
 * 4. Load news from IDB cache + weather from IDB
 * 5. Build core UI together
 * 6. Reveal app as one unit
 * 7. Background: weather refresh, news TTL refresh
 */

import { getConfig } from './config.js';
import { prepareWallpaper } from './wallpaper.js';
import { initSearch } from './ui/search.js';
import { initShortcuts } from './ui/shortcuts.js';
import { initWeatherWidget } from './ui/weather-widget.js';
import { initStocksWidget } from './ui/stocks-widget.js';
import { initFeed, refreshFeed } from './ui/feed.js';
import { initSettings } from './ui/settings.js';
import { initChromeToolbar } from './ui/chrome-toolbar.js';
import { getWeatherForRender } from './weather/weather.js';
import { getStocksForRender } from './stocks/stocks.js';
import { openDb } from './storage/idb.js';

async function main() {
  // 1. Synchronous config — first line of app logic
  const config = getConfig();

  // Mirror config for service worker alarms / location
  try {
    chrome?.storage?.local?.set?.({ candy_config_mirror: config });
  } catch {
    /* ignore */
  }

  // Warm IDB open in parallel with wallpaper preload
  const idbReady = openDb().catch((e) => {
    console.warn('[candy] idb open failed', e);
  });

  // 2–3. Preload wallpaper before revealing UI
  await prepareWallpaper(config.wallpaper);

  // Ensure IDB is ready before cache reads
  await idbReady;

  // 4. Parallel cache-first loads (local only — no network on critical path)
  const searchApi = initSearch();

  await Promise.all([
    initShortcuts(),
    initWeatherWidget(),
    initStocksWidget(),
    initFeed(),
  ]);

  // 5–6. Staged reveal — core components appear together
  const app = document.getElementById('app');
  app?.classList.add('is-ready');

  // Soft focus search after reveal
  requestAnimationFrame(() => {
    setTimeout(() => searchApi?.focus?.(), 200);
  });

  // Fixed chrome toolbar (handlers only — markup is already painted)
  initChromeToolbar();

  // Settings drawer
  initSettings({
    onChange: async (what) => {
      if (what === 'shortcuts') {
        window.dispatchEvent(new CustomEvent('candy:shortcuts-changed'));
      }
      if (what === 'feed') {
        await refreshFeed();
      }
      if (what === 'weather') {
        // Re-init widget from cache (units may have changed)
        await initWeatherWidget();
      }
      if (what === 'stocks') {
        await initStocksWidget();
      }
      if (what === 'wallpaper') {
        /* applied live in settings */
      }
    },
  });

  // Shortcuts re-render hook
  window.addEventListener('candy:shortcuts-changed', async () => {
    await initShortcuts();
  });

  // Kick weather / stocks after reveal (non-blocking; cache already painted)
  getWeatherForRender().catch(() => {});
  getStocksForRender().catch(() => {});

  // Tell service worker tab is alive / ensure alarms
  try {
    chrome.runtime?.sendMessage?.({ type: 'newtab:ready' });
  } catch {
    /* ignore — may run outside extension context in file:// tests */
  }
}

main().catch((err) => {
  console.error('[candy] boot failed', err);
  // Still reveal UI so the tab isn't blank forever
  document.getElementById('app')?.classList.add('is-ready');
});
