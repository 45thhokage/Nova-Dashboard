/**
 * Weather providers: Open-Meteo (primary) + wttr.in (fallback).
 * No fabricated data — failures return null.
 */

import { degreesToCompass } from '../utils.js';

const WMO_LABELS = {
  0: 'Clear',
  1: 'Mainly Clear',
  2: 'Partly Cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime Fog',
  51: 'Light Drizzle',
  53: 'Drizzle',
  55: 'Heavy Drizzle',
  56: 'Freezing Drizzle',
  57: 'Freezing Drizzle',
  61: 'Light Rain',
  63: 'Rain',
  65: 'Heavy Rain',
  66: 'Freezing Rain',
  67: 'Freezing Rain',
  71: 'Light Snow',
  73: 'Snow',
  75: 'Heavy Snow',
  77: 'Snow Grains',
  80: 'Rain Showers',
  81: 'Rain Showers',
  82: 'Heavy Showers',
  85: 'Snow Showers',
  86: 'Snow Showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm',
  99: 'Thunderstorm',
};

export function wmoLabel(code) {
  return WMO_LABELS[code] ?? 'Unknown';
}

/** Map WMO → simple icon key used by UI */
export function wmoIcon(code) {
  if (code === 0 || code === 1) return 'clear';
  if (code === 2) return 'partly';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'rain';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  if ([95, 96, 99].includes(code)) return 'storm';
  return 'cloudy';
}

/**
 * Normalize into our internal shape (always °C / m/s / hPa internally).
 */
function normalizeReading({
  tempC,
  feelsLikeC,
  windMs,
  windDir,
  humidity,
  pressureHpa,
  precipMm,
  precipProb,
  code,
  condition,
  city,
  lat,
  lon,
  daily = [],
  provider,
}) {
  return {
    tempC,
    feelsLikeC: feelsLikeC ?? null,
    windMs,
    windDir,
    windCompass: degreesToCompass(windDir),
    humidity,
    pressureHpa,
    precipMm: precipMm ?? null,
    precipProb: precipProb ?? null, // 0–100 chance of precipitation
    weatherCode: code,
    condition: condition || wmoLabel(code),
    icon: wmoIcon(code),
    city,
    lat,
    lon,
    daily, // [{ date, code, tMaxC, tMinC, precipProb? }]
    provider,
    updatedAt: Date.now(),
  };
}

// ── Open-Meteo ────────────────────────────────────────────

export async function fetchOpenMeteo(lat, lon, cityName) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: [
      'temperature_2m',
      'apparent_temperature',
      'relative_humidity_2m',
      'weather_code',
      'wind_speed_10m',
      'wind_direction_10m',
      'surface_pressure',
      'precipitation',
    ].join(','),
    hourly: 'precipitation_probability',
    daily:
      'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    wind_speed_unit: 'ms',
    timezone: 'auto',
    forecast_days: '7',
  });

  const url = `https://api.open-meteo.com/v1/forecast?${params}`;
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const data = await res.json();
  const c = data.current;
  if (!c) throw new Error('open-meteo missing current');

  // Nearest hourly precip probability (chance of rain)
  const precipProb = nearestHourlyValue(
    data.hourly?.time,
    data.hourly?.precipitation_probability,
    c.time || data.current?.time
  );
  const todayPrecip =
    precipProb ?? data.daily?.precipitation_probability_max?.[0] ?? null;

  const daily = (data.daily?.time || []).map((date, i) => ({
    date,
    code: data.daily.weather_code[i],
    tMaxC: data.daily.temperature_2m_max[i],
    tMinC: data.daily.temperature_2m_min[i],
    precipProb: data.daily.precipitation_probability_max?.[i] ?? null,
  }));

  return normalizeReading({
    tempC: c.temperature_2m,
    feelsLikeC: c.apparent_temperature,
    windMs: c.wind_speed_10m,
    windDir: c.wind_direction_10m,
    humidity: c.relative_humidity_2m,
    pressureHpa: c.surface_pressure,
    precipMm: c.precipitation,
    precipProb: todayPrecip,
    code: c.weather_code,
    city: cityName || `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
    lat,
    lon,
    daily,
    provider: 'open-meteo',
  });
}

/** Pick the hourly sample closest to `isoTime` (or now). */
function nearestHourlyValue(times, values, isoTime) {
  if (!Array.isArray(times) || !Array.isArray(values) || !times.length) return null;
  const target = isoTime ? Date.parse(isoTime) : Date.now();
  if (Number.isNaN(target)) return values[0] ?? null;
  let bestIdx = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = Date.parse(times[i]);
    if (Number.isNaN(t)) continue;
    const d = Math.abs(t - target);
    if (d < bestDelta) {
      bestDelta = d;
      bestIdx = i;
    }
  }
  const v = values[bestIdx];
  return v == null || Number.isNaN(Number(v)) ? null : Number(v);
}

// ── wttr.in fallback ──────────────────────────────────────

export async function fetchWttr(lat, lon, cityName) {
  // JSON format — keyless
  const url = `https://wttr.in/${lat},${lon}?format=j1`;
  const res = await fetch(url, {
    credentials: 'omit',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`wttr ${res.status}`);
  const data = await res.json();
  const cur = data.current_condition?.[0];
  if (!cur) throw new Error('wttr missing current');

  const tempC = parseFloat(cur.temp_C);
  const feelsLikeC = parseFloat(cur.FeelsLikeC);
  // windspeedKmph → m/s
  const windMs = parseFloat(cur.windspeedKmph) / 3.6;
  const windDir = parseFloat(cur.winddirDegree);
  const humidity = parseFloat(cur.humidity);
  const pressureHpa = parseFloat(cur.pressure);
  const precipMm = parseFloat(cur.precipMM);
  const code = mapWttrCode(cur.weatherCode);
  const condition = cur.weatherDesc?.[0]?.value || wmoLabel(code);

  // Prefer current-hour chance of rain from today's hourly block
  const todayHourly = data.weather?.[0]?.hourly || [];
  const nowHour = new Date().getHours();
  const hourSlot =
    todayHourly.find((h) => Number(h.time) / 100 === nowHour) ||
    todayHourly[Math.min(Math.floor(nowHour / 3), todayHourly.length - 1)];
  const precipProb = hourSlot?.chanceofrain != null
    ? parseFloat(hourSlot.chanceofrain)
    : todayHourly[0]?.chanceofrain != null
      ? parseFloat(todayHourly[0].chanceofrain)
      : null;

  const daily = (data.weather || []).slice(0, 7).map((d) => {
    const mid = d.hourly?.[4] || d.hourly?.[0];
    const dayProb = mid?.chanceofrain != null ? parseFloat(mid.chanceofrain) : null;
    return {
      date: d.date,
      code: mapWttrCode(mid?.weatherCode),
      tMaxC: parseFloat(d.maxtempC),
      tMinC: parseFloat(d.mintempC),
      precipProb: dayProb,
    };
  });

  return normalizeReading({
    tempC,
    feelsLikeC: Number.isFinite(feelsLikeC) ? feelsLikeC : null,
    windMs,
    windDir,
    humidity,
    pressureHpa,
    precipMm: Number.isFinite(precipMm) ? precipMm : null,
    precipProb: Number.isFinite(precipProb) ? precipProb : null,
    code,
    condition,
    city: cityName || data.nearest_area?.[0]?.areaName?.[0]?.value || `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
    lat,
    lon,
    daily,
    provider: 'wttr.in',
  });
}

/** Approximate mapping from wttr weather codes to WMO-ish */
function mapWttrCode(code) {
  const c = Number(code);
  if ([113].includes(c)) return 0;
  if ([116].includes(c)) return 2;
  if ([119, 122].includes(c)) return 3;
  if ([143, 248, 260].includes(c)) return 45;
  if ([176, 263, 266, 293, 296].includes(c)) return 61;
  if ([299, 302, 305, 308, 353, 356, 359].includes(c)) return 63;
  if ([179, 182, 185, 227, 230, 323, 326, 329, 332, 335, 338, 368, 371].includes(c)) return 73;
  if ([200, 386, 389, 392, 395].includes(c)) return 95;
  return 3;
}

/**
 * Fetch with primary → fallback chain.
 */
export async function fetchWeather(lat, lon, cityName) {
  try {
    return await fetchOpenMeteo(lat, lon, cityName);
  } catch (e1) {
    console.warn('[candy] open-meteo failed, trying wttr.in', e1);
    try {
      return await fetchWttr(lat, lon, cityName);
    } catch (e2) {
      console.warn('[candy] wttr.in failed', e2);
      return null;
    }
  }
}

// ── Geocoding (Open-Meteo) ────────────────────────────────

export async function geocodeCity(query) {
  const q = (query || '').trim();
  if (!q) return [];
  const params = new URLSearchParams({
    name: q,
    count: '6',
    language: 'en',
    format: 'json',
  });
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`, {
    credentials: 'omit',
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).map((r) => ({
    id: `loc_${r.id}`,
    name: r.name,
    admin1: r.admin1 || '',
    country: r.country || '',
    lat: r.latitude,
    lon: r.longitude,
    label: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
  }));
}

// ── Unit conversion (internal is °C / m/s / hPa) ──────────

export function convertTemp(tempC, unit) {
  if (tempC == null) return null;
  return unit === 'f' ? (tempC * 9) / 5 + 32 : tempC;
}

export function formatTemp(tempC, unit) {
  const v = convertTemp(tempC, unit);
  if (v == null) return '—';
  return `${Math.round(v)}°${unit === 'f' ? 'F' : 'C'}`;
}

export function convertWind(ms, unit) {
  if (ms == null) return null;
  switch (unit) {
    case 'mph':
      return ms * 2.23694;
    case 'kmh':
      return ms * 3.6;
    case 'kn':
      return ms * 1.94384;
    case 'ms':
    default:
      return ms;
  }
}

export function formatWind(ms, unit, compass) {
  const v = convertWind(ms, unit);
  if (v == null) return '—';
  const labels = { mph: 'mph', kmh: 'km/h', ms: 'm/s', kn: 'kn' };
  const dir = compass || '';
  return `${dir ? `${dir} ` : ''}${Math.round(v)} ${labels[unit] || unit}`;
}

export function convertPressure(hpa, unit) {
  if (hpa == null) return null;
  switch (unit) {
    case 'inhg':
      return hpa * 0.02953;
    case 'mmhg':
      return hpa * 0.750062;
    case 'hpa':
    default:
      return hpa;
  }
}

export function formatPressure(hpa, unit) {
  const v = convertPressure(hpa, unit);
  if (v == null) return '—';
  if (unit === 'inhg') return `${v.toFixed(2)} inHg`;
  if (unit === 'mmhg') return `${Math.round(v)} mmHg`;
  return `${Math.round(v)} hPa`;
}
