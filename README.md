# DocExt v0.2.1

A Chrome/Edge extension that records your browser actions, captures screenshots in both light and dark themes, and generates step-by-step documentation. Export everything as a ZIP with Markdown and WebP images.

## Release Notes

For full version history and detailed release notes, see `CHANGELOG.md`.

## Features

- **Action recording**: captures clicks, text input, dropdowns, form submissions, page navigation, and modals
- **Dual-theme screenshots**: every before and after frame is stored in both light and dark. The editor shows those two themes side by side for the same shot, with the same highlight on each.
- **Element highlighting**: adds an orange border and arrow to the clicked element; grouped multi-action steps use numbered circles
- **Smart crops**: the page stays full-frame. An open dropdown crops to that menu (heading and options). A modal crops to the whole dialog, including a confirm stacked on a larger modal. The app sidebar is never cropped on its own.
- **Frame controls per step**: **Highlights** (Annotated or Clean), **Moment** (Before, After, or Both), and **Theme** (Light, Dark, or Both). Annotated is hidden when the step has no highlight. A suggested merge sits on its own bar: **Merge with below**, **Merge with above**, or **Keep separate**.
- **Grouped steps with numbered annotations**: multiple related clicks on the same page area are combined into one card with a single annotated screenshot
- **Popup-aware merging**: trigger → popup-item sequences are merged into one step using the popup-open screenshot
- **Per-click annotate prompt**: **Keep** or **Skip** the highlight. Before and after shots are captured for every click.
- **Inline page editing**: edit text/hide elements directly on the live page while recording
- **Persistent page edits**: edits are saved to the session and shown in the editor
- **Auto-generated step titles**: layered extraction uses accessible names, parent region context, and page frame details
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
npm run dev              # starts server + editor at http://localhost:3001
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
3. After each click, an **"Annotate …?"** prompt appears. **Keep** leaves the highlight. **Skip** records the step without one. The before and after screenshots are taken either way.
4. Click **Edit Page** on the floating bar to change text directly on the page
5. Click **Stop Recording**. The editor opens automatically with the generated steps.
6. Reorder, edit, or delete steps as needed
7. Click **Export ZIP** to download your documentation

## About Theme Flicker (Important)

DocExt captures each visual step in both light and dark mode. To do this, the extension briefly switches the page theme during capture.

- **What you may notice**: a quick light/dark flash after a click, once for the before shot and again for the after shot.
- **Why this happens**: each of those shots is taken in light, then in dark, and the original theme is restored.
- **Why clicks sometimes feel delayed**: DocExt pauses the original click, captures the pre-click frame, then replays the click to preserve accurate before-action screenshots.
- **What is normal**: a short visual flicker and slight interaction delay during recording.
- **What is not normal**: controls becoming permanently unclickable, action counts increasing rapidly without interaction, or repeated looping captures.

If behavior feels stuck, stop recording and start a fresh session on the current page.

## Behavior Notes (What to Expect)

These behaviors are intentional and help keep screenshots and steps consistent:

- **Crops**: clicks on the normal page stay full-frame. A click inside a dropdown crops to the menu panel. A click inside a modal, or a confirm in front of one, crops to the whole modal behind the confirm so its sidebar and content stay in frame. The highlight is kept inside that crop. The persistent app sidebar is not a crop target.
- **Multi-action steps**: if you click several related elements in the same area of the page within 30 s, they are automatically grouped into one step. The screenshot is taken before any replays, so all annotated elements are visible together.
- **Popup / trigger merging**: clicking a button that opens a popup, then clicking an item inside the popup, produces a single merged step. The screenshot used is the one captured while the popup was open, so both the trigger button (annotation 1) and the popup item (annotation 2) are visible. Steps that stay inside the same dialog are suggested for merge on the step card.
- **Visual vs non-visual events**: dual-theme screenshots are prioritised for visual actions (clicks, modal open/close, page navigation, manual screenshots). Text/select/submit events may be recorded without full dual capture to reduce noise and extra flicker.
- **Typing order around clicks**: pending text input is flushed before a click on another control (for example, clicking **Save** after editing a field), so the typed step appears before the save/click step.
- **Submit deduping**: if a submit fires immediately after a captured click, DocExt may treat it as the same user intent to avoid duplicate steps.
- **Highlight targeting is best-effort**: the box stays on the clicked control row and stops before a dialog, nav, or sidebar. Highly nested custom components can still highlight a text wrapper or nearby parent.
- **Cross-origin navigation capture**: when moving between different origins (for example, app → OAuth provider), navigation capture may appear as its own step.
- **Light and dark on every frame**: before, after, annotated, and clean each keep a light image and a dark image. A dark frame is not dropped when it looks similar to the light one. The step card opens with both themes of the before shot, then both themes of the after shot, when those images exist. Theme switching uses a main-world file (`color-scheme-hook.js`) so pages with a strict script policy can still change theme.
- **Step order stability**: events are uploaded in deterministic order, but very close timestamps from app-side async updates can still create edge-case grouping differences in generated step text.

If a single flow is critical (onboarding, login, checkout), run one clean recording for that flow and avoid switching tabs mid-recording.

## Development

```bash
npm run dev              # server + editor with hot reload
npm run build            # build everything
npm run build:extension  # build the extension only
npm run build:editor     # build the editor only
npm run build:server     # build the server only
```

- Server API: `http://localhost:3001/api`
- Editor UI: `http://localhost:3001` (served by the server with Vite middleware in dev)
- Database: `./data/docext.db` (SQLite)
- Screenshots: `./data/screenshots/` (WebP, quality 85)

## Key Files

### Extension (`packages/extension`)

| File | What it does |
|------|-------------|
| `src/content.ts` | Listens for DOM events, manages toolbar/edit mode, controls click gate/replay timing, and always requests an after-click capture. |
| `src/color-scheme-hook.ts` | Main-world `matchMedia` hook injected as a file so theme emulation works under a strict page script policy. |
| `src/background.ts` | Service worker that manages recording lifecycle, dual-theme capture, upload batching, and after-capture storage. |
| `src/lib/floating-toolbar.ts` | Shadow DOM toolbar UI including the inline "Annotate …?" prompt row with Keep/Skip/After. |
| `src/lib/element-resolver.ts` | Builds CSS selectors and extracts text, labels, and context from DOM elements |
| `src/lib/page-extractor.ts` | Layered extraction for control/region/page frame context, after-state outcome detection, and modal or dropdown crop boxes |
| `src/lib/event-filter.ts` | Deduplicates clicks and debounces text input events |
| `src/lib/idb-store.ts` | IndexedDB storage for events and screenshots; includes skip-highlight and after-screenshot updates |
| `src/popup/App.tsx` | The extension popup UI |

### Server (`packages/server`)

| File | What it does |
|------|-------------|
| `src/routes/sessions.ts` | API routes for sessions, events, screenshots, page edits, and steps; runs server-side annotation on finalize |
| `src/routes/export.ts` | Generates the ZIP export with Markdown and images |
| `src/lib/step-generator.ts` | Turns raw recorded events into human-readable steps; handles same-area grouping, trigger+ephemeral merging, deduplication, and before/after frame mapping |
| `src/lib/screenshot-annotator.ts` | Server-side screenshot annotation using `sharp` + SVG overlays; draws the same highlight on light and dark, and expands a crop so the highlight stays inside the frame |
| `src/lib/exporter.ts` | Builds the Markdown file and packages it with screenshots |
| `src/lib/screenshot-store.ts` | Saves screenshots to disk and converts them to WebP |
| `src/db/` | Database schema and setup (Drizzle ORM + SQLite) |

### Editor (`packages/editor`)

| File | What it does |
|------|-------------|
| `src/pages/SessionList.tsx` | Lists all recorded sessions |
| `src/pages/SessionEditor.tsx` | Step editor with drag-and-drop reordering, inline editing, and session page-edits list |
| `src/components/StepCard.tsx` | Displays a single step with Highlights, Moment, and Theme controls, a merge suggestion bar, and paired light/dark shots |
| `src/components/ConfirmModal.tsx` | Confirmation dialog for destructive actions |
| `src/components/ExportPanel.tsx` | The export button |

## How It Works

1. **Recording**: The content script intercepts `pointerdown` events with `capture: true`, immediately calls `preventDefault()` and freezes the main-world click gate. This preserves the exact page state (hover states, open dropdowns, etc.) before the screenshot. After the screenshot is taken, the gate releases and the click is replayed.

2. **Screenshots**: The service worker moves the toolbar off-screen, waits for that paint, then captures a light frame and a dark frame for the before shot and again for the after shot. It restores the theme and stores both. A dropdown or modal crop is measured from the open layer and applied when the image is annotated.

3. **Annotate prompt**: After each click replays, the toolbar shows "Annotate …?" with **Keep**, **Skip**, and **After**. The before and after screenshots are already captured. Skip marks the event for no overlay, which also hides the Annotated control on that step.

4. **Step generation**: On finalize, the server groups consecutive same-area clicks into multi-action steps (within 250 px center-to-center, same page, same scroll position). It then merges trigger → ephemeral pairs (e.g. open-menu → select-item) using the popup-open screenshot. Consecutive input events on the same field are merged, and duplicate adjacent steps are removed.

5. **Annotation**: The server draws the same highlight onto the light and dark before shots, and onto the light and dark after shots, using `sharp`. Clean copies stay unannotated. A crop is expanded so every highlight remains inside the frame.

6. **Edit persistence**: While recording, page edits are stored per-session in extension storage and reapplied by MutationObserver. On upload/finalize they are persisted to the backend session and shown in the editor.

7. **Export**: Produces a ZIP with `documentation.md` and `screenshots/` including annotated images plus clean/after variants when available.

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Extension | TypeScript, React 19, Chrome Manifest V3, Shadow DOM |
| Server | Node.js, Express, better-sqlite3, Drizzle ORM, sharp, archiver |
| Editor | React 19, Vite, Tailwind CSS, React Query, dnd-kit |
