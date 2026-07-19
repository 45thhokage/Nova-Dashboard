/**
 * Weather data engine — cache-first, never blocks UI.
 * Background refresh via alarms (service worker) + on-tab stale check.
 */

import { getConfig } from '../config.js';
import { getWeatherCache, setWeatherCache } from '../storage/idb.js';
import {
  fetchWeather,
  formatTemp,
  formatWind,
  formatPressure,
  wmoIcon,
} from './providers.js';

const weatherListeners = new Set();

export function onWeatherUpdate(fn) {
  weatherListeners.add(fn);
  return () => weatherListeners.delete(fn);
}

function emit(data) {
  for (const fn of weatherListeners) {
    try {
      fn(data);
    } catch (e) {
      console.warn(e);
    }
  }
}

/**
 * Read weather for render — always from cache. Never awaits network.
 * Optionally kicks a background refresh if stale.
 */
export async function getWeatherForRender({ forceRefresh = false } = {}) {
  const cached = await getWeatherCache();
  const cfg = getConfig();
  const ttlMs = (cfg.weatherCacheTtlMinutes || 10) * 60_000;

  if (cached && !forceRefresh) {
    const age = Date.now() - (cached.updatedAt || 0);
    if (age > ttlMs) {
      // Stale — return cache, refresh in background
      refreshWeatherInBackground().catch(() => {});
    }
    return cached;
  }

  if (forceRefresh || !cached) {
    // Still non-blocking for first paint: kick bg fetch
    refreshWeatherInBackground({ force: true }).catch(() => {});
  }

  return cached || null;
}

export async function refreshWeatherInBackground({ force = false } = {}) {
  const cfg = getConfig();
  const coords = await resolveCoords(cfg);
  if (!coords) {
    return null;
  }

  if (!force) {
    const cached = await getWeatherCache();
    const ttlMs = (cfg.weatherCacheTtlMinutes || 10) * 60_000;
    if (cached && Date.now() - (cached.updatedAt || 0) < ttlMs) {
      return cached;
    }
  }

  const data = await fetchWeather(coords.lat, coords.lon, coords.name);
  if (!data) {
    // Keep last good cache
    return getWeatherCache();
  }

  // Atomic write of full blob
  await setWeatherCache(data);
  emit(data);

  // Notify service worker diagnostics
  try {
    chrome.runtime?.sendMessage?.({ type: 'weather:updated', provider: data.provider });
  } catch {
    /* ignore */
  }

  return data;
}

async function resolveCoords(cfg) {
  const w = cfg.weather || {};

  if (w.locationMode === 'manual' && w.manualLat != null && w.manualLon != null) {
    return {
      lat: w.manualLat,
      lon: w.manualLon,
      name: w.manualName || 'Custom',
    };
  }

  // Saved active location
  if (w.activeLocationId && w.locations?.length) {
    const loc = w.locations.find((l) => l.id === w.activeLocationId);
    if (loc) return { lat: loc.lat, lon: loc.lon, name: loc.label || loc.name };
  }

  // Browser geolocation
  try {
    const pos = await getCurrentPosition();
    return {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      name: null, // filled by reverse/geocode later if needed
    };
  } catch {
    // Default fallback: approximate (no fake weather — but we need coords to fetch)
    // Use a neutral public IP-free default only for first-run geo deny:
    // return null so UI shows "Set location" rather than fabricated temps.
    return null;
  }
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('no geolocation'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: 8000,
      maximumAge: 30 * 60_000,
    });
  });
}

// ── Display helpers for UI ────────────────────────────────

export function weatherDisplayModel(raw, cfg) {
  if (!raw) {
    return {
      empty: true,
      temp: '—',
      feelsLike: '—',
      wind: '',
      city: 'Set location',
      condition: 'Weather unavailable',
      icon: 'cloudy',
      humidity: '—',
      rainChance: '—',
      pressure: '—',
      daily: [],
      updatedAt: null,
      provider: null,
    };
  }

  const unit = cfg.weather?.tempUnit || 'f';
  const windUnit = cfg.weather?.windUnit || 'mph';
  const pressureUnit = cfg.weather?.pressureUnit || 'hpa';

  return {
    empty: false,
    temp: formatTemp(raw.tempC, unit),
    feelsLike:
      raw.feelsLikeC != null ? formatTemp(raw.feelsLikeC, unit) : '—',
    wind: formatWind(raw.windMs, windUnit, raw.windCompass),
    city: raw.city || 'Local',
    condition: raw.condition || '—',
    icon: raw.icon || wmoIcon(raw.weatherCode),
    humidity: raw.humidity != null ? `${Math.round(raw.humidity)}%` : '—',
    rainChance:
      raw.precipProb != null && !Number.isNaN(Number(raw.precipProb))
        ? `${Math.round(Number(raw.precipProb))}%`
        : '—',
    pressure: formatPressure(raw.pressureHpa, pressureUnit),
    daily: (raw.daily || []).map((d) => ({
      date: d.date,
      icon: wmoIcon(d.code),
      hi: formatTemp(d.tMaxC, unit),
      lo: formatTemp(d.tMinC, unit),
      rainChance:
        d.precipProb != null && !Number.isNaN(Number(d.precipProb))
          ? `${Math.round(Number(d.precipProb))}%`
          : null,
      name: dayName(d.date, cfg.weather?.clock24h),
    })),
    updatedAt: raw.updatedAt,
    provider: raw.provider,
  };
}

function dayName(dateStr) {
  try {
    const d = new Date(dateStr + 'T12:00:00');
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Today';
    return d.toLocaleDateString(undefined, { weekday: 'short' });
  } catch {
    return dateStr;
  }
}

export function weatherIconSvg(icon) {
  const common = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
  switch (icon) {
    case 'clear':
      return `<svg viewBox="0 0 24 24" ${common}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`;
    case 'partly':
      return `<svg viewBox="0 0 24 24" ${common}><path d="M12 4V2M5.6 5.6 4.2 4.2M4 12H2"/><circle cx="12" cy="10" r="3"/><path d="M20 17.5A3.5 3.5 0 0 0 16.5 14h-1.1A5 5 0 1 0 8 18.5h12a3.5 3.5 0 0 0 0-1z"/></svg>`;
    case 'rain':
      return `<svg viewBox="0 0 24 24" ${common}><path d="M20 16.2A4.5 4.5 0 0 0 17.5 8h-1.1A6 6 0 1 0 6 15.5"/><path d="m8 19-1 2M12 19l-1 2M16 19l-1 2"/></svg>`;
    case 'snow':
      return `<svg viewBox="0 0 24 24" ${common}><path d="M20 17.5A3.5 3.5 0 0 0 16.5 14h-1.1A5 5 0 1 0 8 18.5h12"/><path d="M8 20h.01M12 20h.01M16 20h.01"/></svg>`;
    case 'storm':
      return `<svg viewBox="0 0 24 24" ${common}><path d="M19 16.9A5 5 0 0 0 18 7h-1.3a6 6 0 1 0-10.7 5"/><path d="m13 11-3 6h4l-2 4"/></svg>`;
    case 'fog':
      return `<svg viewBox="0 0 24 24" ${common}><path d="M4 14h16M4 18h12M6 10h14"/></svg>`;
    case 'cloudy':
    default:
      return `<svg viewBox="0 0 24 24" ${common}><path d="M20 17.5A3.5 3.5 0 0 0 16.5 14h-1.1A5 5 0 1 0 8 18.5h12a3.5 3.5 0 0 0 0-1z"/></svg>`;
  }
}
