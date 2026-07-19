/**
 * Weather widget — cache-first render; popover lazy-loads forecast UI only.
 */

import { getConfig } from '../config.js';
import {
  getWeatherForRender,
  weatherDisplayModel,
  weatherIconSvg,
  onWeatherUpdate,
  refreshWeatherInBackground,
} from '../weather/weather.js';
import { el, relativeTime } from '../utils.js';

let popoverOpen = false;

export async function initWeatherWidget() {
  const root = document.getElementById('weather-root');
  if (!root) return;

  const cached = await getWeatherForRender();
  render(root, cached);

  onWeatherUpdate((data) => {
    if (!popoverOpen) render(root, data);
    else render(root, data, { keepPopover: true });
  });

  // Close popover on outside click
  document.addEventListener('mousedown', (e) => {
    if (!popoverOpen) return;
    if (!root.contains(e.target)) {
      popoverOpen = false;
      const pop = root.querySelector('.weather__popover');
      if (pop) pop.hidden = true;
    }
  });
}

function render(root, raw, { keepPopover = false } = {}) {
  const cfg = getConfig();
  const model = weatherDisplayModel(raw, cfg);
  const wasOpen = keepPopover && popoverOpen;

  root.innerHTML = '';

  const widget = el('div', { className: 'weather' });
  const trigger = el('button', {
    type: 'button',
    className: 'weather__trigger',
    'aria-expanded': wasOpen ? 'true' : 'false',
    'aria-haspopup': 'true',
  }, [
    el('div', {
      className: 'weather__icon',
      html: weatherIconSvg(model.icon),
      'aria-hidden': 'true',
    }),
    el('div', { className: 'weather__meta' }, [
      el('div', { className: 'weather__temp-row' }, [
        el('span', { text: model.temp }),
        model.wind
          ? el('span', { className: 'weather__wind', text: `· ${model.wind}` })
          : null,
      ]),
      el('div', { className: 'weather__city', text: model.city }),
      el('div', { className: 'weather__condition', text: model.condition }),
      // Extra stats on the compact chip so the wider widget is useful without opening
      el('div', { className: 'weather__chips' }, [
        el('span', {
          className: 'weather__chip',
          text: `Humidity ${model.humidity}`,
        }),
        el('span', {
          className: 'weather__chip',
          text: `Rain ${model.rainChance}`,
        }),
        !model.empty && model.feelsLike !== '—'
          ? el('span', {
              className: 'weather__chip',
              text: `Feels ${model.feelsLike}`,
            })
          : null,
      ]),
    ]),
  ]);

  const popover = el('div', {
    className: 'weather__popover',
    hidden: !wasOpen,
    role: 'dialog',
    'aria-label': '7-day forecast',
  });

  // Forecast content only built when opened
  trigger.addEventListener('click', async () => {
    popoverOpen = !popoverOpen;
    trigger.setAttribute('aria-expanded', popoverOpen ? 'true' : 'false');
    if (popoverOpen) {
      await fillPopover(popover, raw);
      popover.hidden = false;
    } else {
      popover.hidden = true;
      popover.innerHTML = '';
    }
  });

  if (wasOpen) {
    fillPopover(popover, raw);
  }

  widget.append(trigger, popover);
  root.append(widget);
}

async function fillPopover(popover, raw) {
  const cfg = getConfig();
  // Re-read cache in case it updated
  const data = raw || (await getWeatherForRender());
  const model = weatherDisplayModel(data, cfg);

  popover.innerHTML = '';

  if (model.empty) {
    popover.append(
      el('p', {
        className: 'settings-section__desc',
        text: 'No weather data yet. Allow location access or set a city in Settings.',
      })
    );
    return;
  }

  // Expanded stats row (humidity, rain chance, feels-like, pressure, wind)
  popover.append(
    el('div', { className: 'weather__stats' }, [
      el('span', { html: `Humidity <strong>${model.humidity}</strong>` }),
      el('span', { html: `Rain <strong>${model.rainChance}</strong>` }),
      el('span', { html: `Feels <strong>${model.feelsLike}</strong>` }),
      el('span', { html: `Pressure <strong>${model.pressure}</strong>` }),
      model.wind
        ? el('span', { html: `Wind <strong>${model.wind}</strong>` })
        : null,
    ])
  );

  const forecast = el('div', { className: 'weather__forecast' });
  for (const day of model.daily) {
    forecast.append(
      el('div', { className: 'weather__day' }, [
        el('span', { className: 'weather__day-name', text: day.name }),
        el('span', {
          className: 'weather__day-icon',
          html: weatherIconSvg(day.icon),
          'aria-hidden': 'true',
        }),
        el('span', {
          className: 'weather__day-rain',
          text: day.rainChance || '',
          title: day.rainChance ? 'Chance of precipitation' : '',
        }),
        el('span', {
          className: 'weather__day-temps',
          html: `<span class="hi">${day.hi}</span> / ${day.lo}`,
        }),
      ])
    );
  }
  popover.append(forecast);

  const footer = el('div', { className: 'weather__popover-footer' }, [
    el('span', {
      text: model.updatedAt
        ? `Updated ${relativeTime(model.updatedAt)}`
        : '',
    }),
  ]);

  const refreshBtn = el('button', {
    type: 'button',
    className: 'btn btn--sm btn--ghost',
    text: 'Refresh',
  });
  refreshBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    refreshBtn.disabled = true;
    refreshBtn.textContent = '…';
    const next = await refreshWeatherInBackground({ force: true });
    await fillPopover(popover, next);
    // Update compact widget too
    const root = document.getElementById('weather-root');
    if (root) render(root, next, { keepPopover: true });
  });
  footer.append(refreshBtn);
  popover.append(footer);
}
