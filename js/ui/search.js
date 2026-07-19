/**
 * Pill search bar — debounced address-vs-query detection.
 */

import { debounce, isAddressLike, googleSearchUrl, normalizeUrl } from '../utils.js';

export function initSearch() {
  const form = document.getElementById('search-form');
  const input = document.getElementById('search-input');
  if (!form || !input) return;

  // Precompute intent on input without lagging keystrokes
  let intent = 'search'; // search | navigate
  const updateIntent = debounce(() => {
    const v = input.value.trim();
    intent = v && isAddressLike(v) ? 'navigate' : 'search';
  }, 120);

  input.addEventListener('input', updateIntent);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;

    // Final check (no debounce lag on submit)
    if (isAddressLike(v)) {
      window.location.href = normalizeUrl(v);
    } else {
      window.location.href = googleSearchUrl(v);
    }
  });

  // Autofocus when ready (after reveal) — caller may invoke focus
  return {
    focus: () => input.focus(),
    getIntent: () => intent,
  };
}
