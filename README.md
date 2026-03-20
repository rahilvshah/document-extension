# Document Extension

A Chrome extension that records browser actions, captures screenshots, and generates step-by-step documentation.

## Structure

- `packages/shared` — Shared TypeScript types
- `packages/extension` — Chrome Extension (Manifest V3)
- `packages/server` — Express backend API
- `packages/editor` — React editor web app

## Getting Started

```bash
npm install
npm run dev          # starts server + editor
npm run build:extension  # builds the Chrome extension
```

### Load the extension

1. Run `npm run build:extension`
2. Open `chrome://extensions`
3. Enable Developer Mode
4. Click "Load unpacked" and select `packages/extension/dist`

### Development

- Backend runs at `http://localhost:3001`
- Editor dev server runs at `http://localhost:5173` (proxies API to backend)
- SQLite DB at `./data/docext.db`, screenshots at `./data/screenshots/`
