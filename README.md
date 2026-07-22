<div align="center">
 
# Nova-Dashboard — New Tab Dashboard  




![Version](https://img.shields.io/badge/version-1.2.1-7c6af7?style=flat-square)
![Manifest](https://img.shields.io/badge/manifest-v3-blue?style=flat-square)
![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)

**A fast, dark-themed new tab dashboard with news, weather, stocks, RSS reader, and offline-first caching.**

✨ *Transform your new tab experience with elegance and performance* ✨

<div>

---

## 🌟 Overview

Nova-Dashboard is a premium Chrome extension that replaces your default new tab page with a beautiful, feature-rich dashboard designed for speed, privacy, and productivity. Built with a **dark-first aesthetic**, **offline-first architecture**, and **zero external dependencies**, Nova-Dashboard delivers a seamless browsing experience that respects your time and data.

## 🎨 Features

### 📰 Smart News Feed
- **Google News Integration**: Fetches RSS feeds directly from `news.google.com` for comprehensive, real-time coverage
- **Personalized Topics**: Follow your favorite categories (Tech, Business, Sports, Entertainment, Science, Health, etc.)
- **Cache-First Rendering**: Instant load from IndexedDB with background TTL refresh
- **Infinite Scroll**: Seamless pagination without interrupting your flow
- **Deduplication**: Intelligent article merging across multiple sources
- **High-Quality Images**: Cached and optimized for fast display

### 🌤️ Weather Widget
- **Real-Time Data**: Powered by Open-Meteo (primary) + wttr.in (fallback)
- **Geolocation Support**: Automatic location detection with manual override
- **Detailed Forecasts**: 7-day outlook with temperature, conditions, wind, and precipitation
- **No API Keys Required**: Free, unlimited access without registration
- **Powered by Open-Meteo**: Free weather forecast API

### 📈 Stocks Tracker
- **Multi-Asset Support**: Track stocks, cryptocurrencies, and indices
- **Market-Aware Refresh**: Intelligent polling based on market hours
- **Multiple Providers**: Yahoo Finance, CoinGecko, Stooq, Finnhub with automatic fallback
- **Real-Time Quotes**: Price, change, percentage change with color-coded indicators
- **Powered by CoinGecko**: Free cryptocurrency data API

### 📑 RSS/Atom Feed Reader
- **Full-Featured Reader**: Subscribe to any RSS or Atom feed
- **OPML Import/Export**: Easy migration from other readers
- **Smart Filtering**: Unread, starred, and custom view modes
- **Image Optimization**: Lazy-loading with quality normalization
- **Offline Reading**: Cached articles available without internet

### 🔍 Quick Search Overlay
- **AI-Powered**: Direct search integration with ChatGPT, Claude, Perplexity
- **Local Results**: Search open tabs and bookmarks instantly
- **Keyboard Shortcuts**: `Ctrl+K` / `Cmd+K` for instant access
- **Provider Switching**: Toggle between AI providers with a single click

### ⚡ Performance Highlights
- **Instant Load**: Solid background painted before any JavaScript executes
- **No Layout Shift**: Static markup prevents visual instability
- **IndexedDB Storage**: Fast, persistent local storage for all data
- **Service Worker**: Background sync and periodic refresh without blocking UI
- **Zero Web Fonts**: System font stack eliminates network requests

### 🎯 User Experience
- **Dark Theme**: Carefully crafted color tokens for reduced eye strain
- **Custom Wallpapers**: Upload your own or use dynamic backgrounds
- **Quick Shortcuts**: Bookmark your favorite sites with custom icons
- **Glass Morphism**: Modern UI with subtle transparency effects
- **Responsive Design**: Adapts to different screen sizes seamlessly

## 🛠️ Technical Architecture

```
Nova-Dashboard Extension
├── manifest.json          # Manifest V3 configuration
├── newtab.html            # Main dashboard entry point
├── feeds.html             # RSS reader interface
├── background/
│   └── service-worker.js  # Background tasks & alarms
├── js/
│   ├── app.js             # Orchestrator & staged reveal
│   ├── config.js          # Configuration management
│   ├── utils.js           # Utility functions
│   ├── wallpaper.js       # Background image handling
│   ├── favicon.js         # Favicon caching
│   ├── ui/                # UI components
│   │   ├── search.js      # Main search bar
│   │   ├── quick-search.js # AI overlay search
│   │   ├── shortcuts.js   # Quick links grid
│   │   ├── weather-widget.js
│   │   ├── stocks-widget.js
│   │   ├── feed.js        # News feed renderer
│   │   ├── settings.js    # Settings modal
│   │   └── chrome-toolbar.js
│   ├── news/              # News engine
│   │   ├── news.js        # Cache-first loading
│   │   └── feeds.js       # Multi-source fetching
│   ├── weather/           # Weather engine
│   │   ├── weather.js     # Geolocation & caching
│   │   └── providers.js   # Open-Meteo + wttr.in
│   ├── stocks/            # Stocks engine
│   │   ├── stocks.js      # Quote management
│   │   └── providers.js   # Multi-provider quotes
│   ├── reader/            # RSS reader
│   │   ├── engine.js      # Feed parsing & caching
│   │   ├── parse.js       # XML/Atom parsing
│   │   ├── compose.js     # View composition
│   │   ├── images.js      # Image resolution
│   │   └── settings.js    # Reader preferences
│   └── storage/
│       ├── idb.js         # IndexedDB wrapper
│       └── cache-api.js   # CacheStorage API
├── css/
│   ├── tokens.css         # Design tokens (colors, spacing, type)
│   └── base.css           # Base styles & resets
└── assets/
    └── icons/             # Extension icons (16, 48, 128)
```

## 🚀 Installation


### Manual Installation (Development)
1. **Clone the repository**
   ```bash
   git clone https://github.com/45thhokage/nova-dashboard.git
   cd nova-dashboard
   ```
   
2. **Load in Chrome**
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top-right)
   - Click "Load unpacked"
   - Select the project directory

3. **Set as Default New Tab**
   - The extension automatically overrides the new tab page
   - Open a new tab to see Nova-Dashboard in action

## ⚙️ Configuration

Access settings by clicking the gear icon (⚙️) in the bottom-right corner.

### Available Settings

| Category | Options |
|----------|---------|
| **Appearance** | Wallpaper upload, theme intensity, glass opacity |
| **Content** | Enable/disable news, topic selection, articles per page |
| **Weather** | Location (auto/manual), units (°C/°F), show/hide forecast |
| **Stocks** | Add/remove symbols, refresh intervals, provider priority |
| **Shortcuts** | Add/edit/remove quick links, custom icons |
| **Search** | Default search engine, AI provider preference |
| **Reader** | Feed management, OPML import/export, cache duration |

## 🔐 Permissions

Nova-Dashboard requests minimal permissions for core functionality:

| Permission | Purpose |
|------------|---------|
| `storage` | Save user preferences and cached data |
| `alarms` | Background refresh of weather, news, stocks |
| `geolocation` | Auto-detect location for weather widget |
| `unlimitedStorage` | Store large amounts of cached content |
| `tabs` (optional) | Search open tabs in quick search |
| `bookmarks` (optional) | Search bookmarks in quick search |
| `<all_urls>` | Fetch news, weather, stocks from various APIs |

**Note:** All data is stored locally. No personal information is transmitted to external servers except for API requests (weather, news, stocks).

## 🏗️ Development

### Prerequisites
- Chrome 88+ (for Manifest V3 support)
- Modern text editor (VS Code recommended)

### Project Structure
The codebase follows a modular architecture with clear separation of concerns:

- **UI Layer**: Vanilla JavaScript with no frameworks
- **State Management**: localStorage for config, IndexedDB for cached data
- **Styling**: CSS custom properties (design tokens) for theming
- **Build Process**: None required — pure vanilla JS, ready to run

### Adding Features

#### New Weather Provider
```javascript
// js/weather/providers.js
export async function fetchFromYourProvider(lat, lon) {
  const response = await fetch(`YOUR_API_ENDPOINT?lat=${lat}&lon=${lon}`);
  const data = await response.json();
  return {
    temp: data.temperature,
    condition: data.conditions,
    // ... map to standard format
  };
}
```

#### New News Source
```javascript
// js/news/feeds.js
export async function fetchFromYourSource(category) {
  const response = await fetch(`YOUR_NEWS_API?category=${category}`);
  const articles = await response.json();
  return articles.map(article => ({
    id: uid(),
    title: article.title,
    url: article.url,
    imageUrl: article.image,
    source: article.source,
    publishedAt: article.published_at,
    categoryId: category,
  }));
}
```

## 🎨 Design Philosophy

Nova-Dashboard follows these core design principles:

1. **Dark-First**: Reduces eye strain, saves battery on OLED displays
2. **Performance**: Zero layout shift, instant perceived load time
3. **Privacy**: Local storage, no tracking, minimal external requests
4. **Accessibility**: High contrast, keyboard navigation, screen reader support
5. **Simplicity**: No build tools, no dependencies, easy to understand


## 🗺️ Roadmap

### v1.3.0 (Upcoming)
- [ ] Custom widgets marketplace
- [ ] Focus mode (hide all widgets)
- [ ] Multiple dashboard profiles
- [ ] Analytics dashboard (local only)


### Future Considerations
- [ ] Firefox compatibility
- [ ] AI-powered news summarization

## 🤝 Contributing

Contributions are welcome! Please follow these guidelines:

1. **Fork the repository**
2. **Create a feature branch** (`git checkout -b feature/amazing-feature`)
3. **Make your changes** (follow existing code style)
4. **Test thoroughly** (ensure no regressions)
5. **Commit your changes** (`git commit -m 'Add amazing feature'`)
6. **Push to the branch** (`git push origin feature/amazing-feature`)
7. **Open a Pull Request**

### Code Style
- Use ES6+ features (const/let, arrow functions, async/await)
- JSDoc comments for public functions
- Modular architecture (one responsibility per file)
- No console.log in production code

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

```
Copyright (c) 2026 45thhokage

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
```

## 🙏 Acknowledgments

Nova-Dashboard leverages several excellent open-source APIs and services. We extend our gratitude to:

- **[Google News](https://news.google.com)** — RSS feed aggregation for comprehensive news coverage
- **[Open-Meteo](https://open-meteo.com)** — weather forecast API (primary provider)
- **[wttr.in](https://wttr.in)** — Fallback weather service
- **[CoinGecko](https://www.coingecko.com)** — Cryptocurrency market data API
- **Yahoo Finance** — Stock quotes and financial data
- **All RSS feed publishers** — Content providers worldwide

These services make Nova-Dashboard possible without requiring API keys or paid subscriptions.

## 

- **Author**: 45thhokage
- **Issues**: [Report a bug](https://github.com/45thhokage/nova-dashboard/issues)
- **Discussions**: [Feature requests & Q&A](https://github.com/45thhokage/nova-dashboard/discussions)

---

<div align="center">

**Enjoying Nova-Dashboard?** ⭐ Star this repository to show your support!

Made with ❤️ by [45thhokage](https://github.com/45thhokage)

</div>
