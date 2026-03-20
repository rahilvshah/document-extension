# DocExt — Browser Action Documentation Generator

A Chrome/Edge extension that records browser actions, captures dual-theme screenshots (light + dark), and generates step-by-step documentation with a single click.

## Features

- **Action recording** — Captures clicks, text input, dropdown selections, form submissions, navigation, and modal appearances
- **Dual-theme screenshots** — Automatically toggles light/dark mode internally to capture both variants for every action
- **Smart cropping & highlighting** — First step gets a full-page screenshot; subsequent steps crop to the relevant area with an orange highlight border and arrow on the clicked element
- **Inline page editing** — Edit text on the live page via an overlay textarea (persists across refreshes while recording)
- **Step generation** — Deterministic, human-readable step titles and descriptions with context (labels, breadcrumbs, tooltips)
- **Editor UI** — Drag-and-drop reorder, inline title/description editing, side-by-side light/dark screenshots, full-size viewer
- **ZIP export** — Single ZIP containing Markdown documentation + all screenshots as WebP

## Architecture

```
packages/
  shared/     TypeScript types & shared utilities (logo SVG, types)
  extension/  Chrome Extension — Manifest V3 (content script, service worker, popup)
  server/     Express + Drizzle ORM + SQLite backend (sessions, events, screenshots, export)
  editor/     React 19 + Vite + Tailwind CSS frontend (session list, step editor, export)
```

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+

### Install & Run

```bash
npm install
npm run dev              # starts backend (port 3001) + editor dev server (port 5173)
npm run build:extension  # builds the Chrome extension to packages/extension/dist
```

### Load the Extension

1. Run `npm run build:extension`
2. Open `chrome://extensions` (or `edge://extensions`)
3. Enable **Developer Mode**
4. Click **Load unpacked** and select `packages/extension/dist`

### Usage

1. Navigate to any web page
2. Click the DocExt extension icon → **Start Recording**
3. Interact with the page — each action is captured with dual-theme screenshots
4. Use the floating toolbar to **Edit Page** (modify text on the page) or **Stop** recording
5. On stop, the editor opens automatically with generated steps
6. Reorder, edit, or delete steps as needed
7. Click **Export ZIP** to download Markdown + screenshots

## Development

| Service | URL | Notes |
|---------|-----|-------|
| Backend API | `http://localhost:3001` | Express + SQLite |
| Editor | `http://localhost:5173` | Vite dev server, proxies `/api` to backend |

### Build All

```bash
npm run build   # builds shared → server, extension, editor in parallel
```

### Data Storage

- SQLite database: `./data/docext.db`
- Screenshots: `./data/screenshots/<sessionId>/` (stored as lossless WebP)

## Tech Stack

- **Extension**: TypeScript, Manifest V3, Shadow DOM (toolbar + edit overlay), IndexedDB (offline buffer)
- **Backend**: Node.js, Express, Drizzle ORM, better-sqlite3, sharp (image processing), archiver (ZIP)
- **Editor**: React 19, Vite, Tailwind CSS, @tanstack/react-query, @dnd-kit
- **Shared**: TypeScript types, SVG logo utilities
