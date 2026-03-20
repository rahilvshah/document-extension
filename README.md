# DocExt — Browser Action Recorder & Documentation Generator

A Chrome/Edge extension that records browser actions (clicks, typing, navigation, dropdowns, modals), captures dual-theme screenshots (light & dark), and generates step-by-step documentation with highlighted elements — exportable as a ZIP with Markdown + WebP images.

## Features

- **Action recording** — clicks, text input, select/dropdown, form submit, navigation, and modal detection
- **Dual-theme screenshots** — automatic light/dark theme toggling captures both variants for every action
- **Highlighted elements** — orange border + arrow annotation on clicked elements in screenshots
- **Smart cropping** — first step is full-page, subsequent steps are cropped to the relevant area
- **Inline page editing** — edit text directly on the page during recording (persists across modal close/reopen and page refresh)
- **Rich step titles** — auto-generated from labels, ARIA attributes, breadcrumbs, tooltips, and context
- **Drag-and-drop step reorder** — reorder, rename, or delete steps in the editor
- **Export** — single ZIP containing `documentation.md` + all `stepNN-light.webp` / `stepNN-dark.webp` images

## Architecture

```
packages/
├── shared/      TypeScript types, logo utility — consumed by all packages
├── extension/   Chrome Extension (Manifest V3) — content scripts + service worker
├── server/      Express + SQLite (Drizzle ORM) — API, step generation, export
└── editor/      React 19 + Vite + Tailwind — session browser & step editor
```

| Component | Tech |
|-----------|------|
| Extension popup | React 19, inline styles |
| Content script | Vanilla TS, Shadow DOM toolbar |
| Service worker | chrome.tabs, IndexedDB, OffscreenCanvas |
| Server | Express, better-sqlite3 (Drizzle), sharp, archiver |
| Editor | React 19, Vite, Tailwind CSS, @tanstack/react-query, @dnd-kit |

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+
- Chrome or Edge browser

### Install & Run

```bash
npm install
npm run dev            # starts server (port 3001) + editor (port 5173)
npm run build:extension  # builds the Chrome extension
```

### Load the Extension

1. Run `npm run build:extension`
2. Open `chrome://extensions` (or `edge://extensions`)
3. Enable **Developer Mode**
4. Click **Load unpacked** → select `packages/extension/dist`

### Usage

1. Click the DocExt icon in the toolbar → **Start Recording**
2. Perform actions on the page — a floating bar shows the action count and elapsed time
3. Use **Edit Page** on the floating bar to modify text directly on the page
4. Click **Stop Recording** — the editor opens with the generated steps
5. Reorder, rename, or delete steps as needed
6. Click **Export ZIP** to download Markdown + all WebP screenshots

## Development

```bash
npm run dev              # server + editor with hot reload
npm run build            # build all packages (shared → server, extension, editor)
npm run build:extension  # build extension only
npm run build:editor     # build editor only
npm run build:server     # build server only
```

- **Server API** → `http://localhost:3001/api`
- **Editor dev server** → `http://localhost:5173` (proxies `/api` to the server)
- **SQLite DB** → `./data/docext.db`
- **Screenshots** → `./data/screenshots/` (lossless WebP)

## Project Structure

### Extension (`packages/extension`)

| File | Purpose |
|------|---------|
| `src/content.ts` | DOM event listeners, element resolution, floating toolbar, edit mode, theme toggling |
| `src/background.ts` | Service worker — recording state, screenshot capture/crop/annotate, IDB storage, backend flush |
| `src/lib/element-resolver.ts` | CSS selector generation, ARIA/text/context extraction |
| `src/lib/event-filter.ts` | Click dedup, input debounce |
| `src/popup/App.tsx` | Extension popup UI |
| `src/manifest.json` | Manifest V3 configuration |

### Server (`packages/server`)

| File | Purpose |
|------|---------|
| `src/routes/sessions.ts` | CRUD for sessions, events, screenshots, steps |
| `src/routes/export.ts` | ZIP export (Markdown + WebP images) |
| `src/lib/step-generator.ts` | Deterministic event → step transformation with dedup |
| `src/lib/exporter.ts` | Markdown/HTML generation, archiver integration |
| `src/lib/screenshot-store.ts` | Filesystem storage with sharp WebP conversion |
| `src/lib/mappers.ts` | DB row → API type mappers |
| `src/db/` | Drizzle ORM schema + SQLite setup |

### Editor (`packages/editor`)

| File | Purpose |
|------|---------|
| `src/pages/SessionList.tsx` | Session browser with delete |
| `src/pages/SessionEditor.tsx` | Step editor with DnD, inline editing, export |
| `src/components/StepCard.tsx` | Individual step tile with screenshot viewer |
| `src/components/ConfirmModal.tsx` | Reusable confirmation dialog |
| `src/components/ExportPanel.tsx` | ZIP export button |
| `src/api/client.ts` | API client functions |

## How It Works

1. **Recording** — The content script intercepts `pointerdown`/`click` events, resolves the target element, and sends the event metadata to the service worker. For elements that need native behavior preserved (dropdowns, menus), the original event is prevented and replayed after screenshot capture.

2. **Screenshots** — The service worker pauses the content script, hides the toolbar, toggles to light theme → captures → toggles to dark → captures → restores original theme → shows toolbar → resumes. Raw captures are then cropped, annotated with highlight borders/arrows, and converted to WebP.

3. **Edit persistence** — DOM edits are stored in `chrome.storage.local` and re-applied via a MutationObserver. When new nodes are added (modal reopen), edits apply immediately. When a CSS selector no longer matches (modal destroyed/recreated), a text-content fallback search finds the target.

4. **Step generation** — The server merges consecutive input events, deduplicates adjacent identical actions, filters trivial inputs, and generates human-readable titles from element labels, ARIA attributes, and DOM context.

5. **Export** — Generates a ZIP containing `documentation.md` with step descriptions and relative image references, plus a `screenshots/` folder with zero-padded WebP files (`step01-light.webp`, `step01-dark.webp`).
