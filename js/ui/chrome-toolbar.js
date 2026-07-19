/**
 * Bottom-left chrome:// quick-access toolbar.
 * chrome:// URLs must open via the service worker (tabs.create).
 */

const ALLOWED = new Set([
  'chrome://settings',
  'chrome://extensions',
  'chrome://bookmarks',
  'chrome://history',
  'chrome://downloads',
]);

export function initChromeToolbar() {
  const root = document.getElementById('chrome-toolbar');
  if (!root) return;

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-chrome-url]');
    if (!btn) return;
    e.preventDefault();
    const url = btn.getAttribute('data-chrome-url');
    if (!url || !ALLOWED.has(url)) return;
    openChromeUrl(url);
  });
}

export function openChromeUrl(url) {
  try {
    chrome.runtime.sendMessage({ type: 'open:chrome-url', url }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        console.warn('[candy] open chrome url failed', chrome.runtime.lastError);
      }
    });
  } catch (err) {
    console.warn('[candy] open chrome url unavailable', err);
  }
}
