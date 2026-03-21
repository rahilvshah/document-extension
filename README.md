# DocExt v0.1

A Chrome/Edge extension that records your browser actions, captures screenshots in both light and dark themes, and generates step-by-step documentation. Export everything as a ZIP with Markdown and WebP images.

## Features

- **Action recording**: captures clicks, text input, dropdowns, form submissions, page navigation, and modals
- **Dual-theme screenshots**: automatically toggles between light and dark themes to capture both versions
- **Element highlighting**: adds an orange border and arrow to the clicked element in each screenshot
- **Smart cropping**: first step is a full-page screenshot, subsequent steps zoom into the relevant area
- **Inline page editing**: edit text directly on the live page while recording (survives modal close/reopen and page refresh)
- **Auto-generated step titles**: creates readable titles from button labels, ARIA attributes, breadcrumbs, and tooltips
- **Drag-and-drop editor**: reorder, rename, or delete steps after recording
- **ZIP export**: download a `documentation.md` file alongside all screenshots (`step01-light.webp`, `step01-dark.webp`, etc.)

## Project Structure

```
packages/
  shared/       Shared TypeScript types and utilities
  extension/    Chrome Extension (Manifest V3)
  server/       Express + SQLite backend
  editor/       React web app for viewing and editing sessions
```

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+
- Chrome or Edge

### Install and Run

```bash
npm install
npm run dev              # starts the server (port 3001) and editor (port 5173)
npm run build:extension  # builds the Chrome extension
```

### Load the Extension

1. Run `npm run build:extension`
2. Open `chrome://extensions` (or `edge://extensions`)
3. Enable **Developer Mode**
4. Click **Load unpacked** and select `packages/extension/dist`

### How to Use

1. Click the DocExt icon in the browser toolbar and press **Start Recording**
2. Use the website normally. A floating bar at the bottom shows the action count and timer.
3. Click **Edit Page** on the floating bar to change text directly on the page
4. Click **Stop Recording**. The editor opens automatically with the generated steps.
5. Reorder, edit, or delete steps as needed
6. Click **Export ZIP** to download your documentation

## Development

```bash
npm run dev              # server + editor with hot reload
npm run build            # build everything
npm run build:extension  # build the extension only
npm run build:editor     # build the editor only
npm run build:server     # build the server only
```

- Server API: `http://localhost:3001/api`
- Editor dev server: `http://localhost:5173` (proxies API requests to the server)
- Database: `./data/docext.db` (SQLite)
- Screenshots: `./data/screenshots/` (lossless WebP)

## Key Files

### Extension (`packages/extension`)

| File | What it does |
|------|-------------|
| `src/content.ts` | Listens for DOM events, manages the floating toolbar, handles edit mode and theme toggling |
| `src/background.ts` | Service worker that manages recording state, captures and processes screenshots, uploads to the backend |
| `src/lib/element-resolver.ts` | Builds CSS selectors and extracts text, labels, and context from DOM elements |
| `src/lib/event-filter.ts` | Deduplicates clicks and debounces text input events |
| `src/popup/App.tsx` | The extension popup UI |

### Server (`packages/server`)

| File | What it does |
|------|-------------|
| `src/routes/sessions.ts` | API routes for sessions, events, screenshots, and steps |
| `src/routes/export.ts` | Generates the ZIP export with Markdown and images |
| `src/lib/step-generator.ts` | Turns raw recorded events into human-readable steps |
| `src/lib/exporter.ts` | Builds the Markdown file and packages it with screenshots |
| `src/lib/screenshot-store.ts` | Saves screenshots to disk and converts them to WebP |
| `src/db/` | Database schema and setup (Drizzle ORM + SQLite) |

### Editor (`packages/editor`)

| File | What it does |
|------|-------------|
| `src/pages/SessionList.tsx` | Lists all recorded sessions |
| `src/pages/SessionEditor.tsx` | Step editor with drag-and-drop reordering and inline editing |
| `src/components/StepCard.tsx` | Displays a single step with its screenshots |
| `src/components/ConfirmModal.tsx` | Confirmation dialog for destructive actions |
| `src/components/ExportPanel.tsx` | The export button |

## How It Works

1. **Recording**: The content script intercepts click and pointer events, figures out which element was targeted, and sends the event details to the service worker. For elements like dropdowns and menus, the original event is paused and replayed after the screenshot is taken.

2. **Screenshots**: The service worker hides the floating toolbar, switches to light theme, takes a screenshot, switches to dark theme, takes another screenshot, then restores everything. The raw screenshots are cropped to the relevant area and annotated with a highlight on the clicked element.

3. **Edit persistence**: When you edit text on the page, the changes are saved to `chrome.storage.local`. A MutationObserver watches for DOM changes and reapplies your edits. If an element is destroyed and recreated (like when a modal reopens), it searches for the element by its original text content as a fallback.

4. **Step generation**: The server groups consecutive typing events together, removes duplicate actions, filters out trivial inputs, and generates descriptive titles based on element labels and surrounding context.

5. **Export**: Produces a ZIP file containing `documentation.md` (with relative image paths) and a `screenshots/` folder with numbered WebP files for both themes.

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Extension | TypeScript, React 19, Chrome Manifest V3, Shadow DOM |
| Server | Node.js, Express, better-sqlite3, Drizzle ORM, sharp, archiver |
| Editor | React 19, Vite, Tailwind CSS, React Query, dnd-kit |
