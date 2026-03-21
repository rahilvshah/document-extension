import type { RecordedEvent, RecordingState, ExtensionMessage, ClickMeta, InputMeta, SelectMeta } from '@docext/shared';
import { storeEvent, storeScreenshot, getAllEvents, getAllScreenshots, clearAll } from './lib/idb-store.js';
import { createSession, uploadEvents, uploadScreenshotBlob, finalizeSession, deleteSession } from './lib/api-client.js';

// ── Configuration ──

const SCREENSHOT_DELAY_MS = 200;
const NAVIGATE_LOAD_TIMEOUT_MS = 8000;
const CLICK_SCREENSHOT_DELAY_MS = 50;
const BATCH_INTERVAL_MS = 30_000;
const UPLOAD_CONCURRENCY = 4;
const NAVIGATE_RENDER_DELAY_MS = 3500;

// ── Sequential Event Queue ──

const eventQueue: Array<{ event: RecordedEvent; resolve: () => void }> = [];
let processingEvent = false;

async function drainEventQueue() {
  if (processingEvent) return;
  processingEvent = true;
  while (eventQueue.length > 0) {
    const item = eventQueue.shift()!;
    try {
      await handleEventCaptured(item.event);
    } catch (err) {
      console.error('[docext] Event queue error:', err);
    }
    item.resolve();
  }
  processingEvent = false;
}

function enqueueEvent(event: RecordedEvent): Promise<void> {
  return new Promise<void>((resolve) => {
    eventQueue.push({ event, resolve });
    drainEventQueue();
  });
}

// ── Tab Load Waiting ──

function waitForTabLoad(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const listener = (id: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') done();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') done();
    }).catch(done);
  });
}

// ── State ──

function defaultState(): RecordingState {
  return {
    isRecording: false,
    sessionId: null,
    eventCount: 0,
    startedAt: null,
    editMode: false,
    theme: 'system',
  };
}

let state: RecordingState = defaultState();
let batchTimer: ReturnType<typeof setInterval> | null = null;
let activeTabId: number | null = null;
let flushing = false;
const pendingCaptures = new Set<Promise<void>>();

function getState(): RecordingState {
  return { ...state };
}

function broadcastState() {
  const snapshot = getState();
  if (snapshot.isRecording) {
    chrome.action.setBadgeText({ text: String(snapshot.eventCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, {
      type: 'RECORDING_STATE',
      payload: snapshot,
    } as ExtensionMessage).catch(() => {});
  }
}

// ── Screenshot Processing ──

interface ScreenshotOpts {
  crop?: { x: number; y: number; width: number; height: number };
  highlight?: { x: number; y: number; width: number; height: number };
  viewportWidth: number;
  viewportHeight: number;
}

function canvasToPng(canvas: OffscreenCanvas): Promise<Blob> {
  return canvas.convertToBlob({ type: 'image/png' });
}

function drawRoundRect(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawHighlight(
  ctx: OffscreenCanvasRenderingContext2D,
  ex: number, ey: number, ew: number, eh: number,
  canvasW: number, canvasH: number, scale: number,
) {
  if (ew < 2 || eh < 2) return;

  const pad = 4 * scale;
  const rx = Math.max(0, ex - pad);
  const ry = Math.max(0, ey - pad);
  const rw = Math.min(canvasW - rx, ew + pad * 2);
  const rh = Math.min(canvasH - ry, eh + pad * 2);
  const radius = 6 * scale;
  const lw = 3 * scale;

  ctx.strokeStyle = 'rgba(249,115,22,0.3)';
  ctx.lineWidth = lw + 4 * scale;
  drawRoundRect(ctx, rx, ry, rw, rh, radius);
  ctx.stroke();

  ctx.strokeStyle = '#f97316';
  ctx.lineWidth = lw;
  drawRoundRect(ctx, rx, ry, rw, rh, radius);
  ctx.stroke();

  const spaceR = canvasW - (rx + rw);
  const spaceL = rx;
  const spaceT = ry;
  const spaceB = canvasH - (ry + rh);
  const best = Math.max(spaceR, spaceL, spaceT, spaceB);

  if (best < 30 * scale) return;

  const arrowLen = Math.min(65 * scale, best * 0.7);
  const gap = 8 * scale;
  let tipX: number, tipY: number, startX: number, startY: number, cpX: number, cpY: number;

  if (best === spaceR) {
    tipX = rx + rw + gap; tipY = ry + rh / 2;
    startX = tipX + arrowLen; startY = tipY - arrowLen * 0.7;
    cpX = startX; cpY = tipY;
  } else if (best === spaceL) {
    tipX = rx - gap; tipY = ry + rh / 2;
    startX = tipX - arrowLen; startY = tipY - arrowLen * 0.7;
    cpX = startX; cpY = tipY;
  } else if (best === spaceT) {
    tipX = rx + rw / 2; tipY = ry - gap;
    startX = tipX + arrowLen * 0.7; startY = tipY - arrowLen;
    cpX = tipX; cpY = startY;
  } else {
    tipX = rx + rw / 2; tipY = ry + rh + gap;
    startX = tipX + arrowLen * 0.7; startY = tipY + arrowLen;
    cpX = tipX; cpY = startY;
  }

  ctx.strokeStyle = '#f97316';
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.quadraticCurveTo(cpX, cpY, tipX, tipY);
  ctx.stroke();

  const headLen = 12 * scale;
  const angle = Math.atan2(tipY - cpY, tipX - cpX);
  ctx.fillStyle = '#f97316';
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - headLen * Math.cos(angle - 0.45), tipY - headLen * Math.sin(angle - 0.45));
  ctx.lineTo(tipX - headLen * Math.cos(angle + 0.45), tipY - headLen * Math.sin(angle + 0.45));
  ctx.closePath();
  ctx.fill();
}

async function processScreenshot(blob: Blob, opts?: ScreenshotOpts): Promise<Blob> {
  if (!opts || (!opts.crop && !opts.highlight)) return blob;

  let srcBitmap: ImageBitmap;
  try {
    srcBitmap = await createImageBitmap(blob);
  } catch {
    return blob;
  }

  if (srcBitmap.width === 0 || srcBitmap.height === 0) {
    srcBitmap.close();
    return blob;
  }

  const imgScaleX = srcBitmap.width / opts.viewportWidth;
  const imgScaleY = srcBitmap.height / opts.viewportHeight;

  let sx = 0, sy = 0, sw = srcBitmap.width, sh = srcBitmap.height;
  let originX = 0, originY = 0;

  if (opts.crop) {
    const c = opts.crop;
    const edgePad = 16;
    let cropLeft = c.x - edgePad;
    let cropTop = c.y - edgePad;
    let cropRight = c.x + c.width + edgePad;
    let cropBottom = c.y + c.height + edgePad;

    if (opts.highlight) {
      const h = opts.highlight;
      const hlPad = edgePad + 80;
      cropLeft = Math.min(cropLeft, h.x - hlPad);
      cropTop = Math.min(cropTop, h.y - hlPad);
      cropRight = Math.max(cropRight, h.x + h.width + hlPad);
      cropBottom = Math.max(cropBottom, h.y + h.height + hlPad);
    }

    originX = Math.max(0, cropLeft);
    originY = Math.max(0, cropTop);
    const clampedRight = Math.min(opts.viewportWidth, cropRight);
    const clampedBottom = Math.min(opts.viewportHeight, cropBottom);
    sx = Math.round(originX * imgScaleX);
    sy = Math.round(originY * imgScaleY);
    sw = Math.min(srcBitmap.width - sx, Math.round((clampedRight - originX) * imgScaleX));
    sh = Math.min(srcBitmap.height - sy, Math.round((clampedBottom - originY) * imgScaleY));

    if (sw < 100 || sh < 100) {
      sx = 0; sy = 0; sw = srcBitmap.width; sh = srcBitmap.height;
      originX = 0; originY = 0;
    }
  }

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(srcBitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  srcBitmap.close();

  if (opts.highlight) {
    const h = opts.highlight;
    const ex = (h.x - originX) * imgScaleX;
    const ey = (h.y - originY) * imgScaleY;
    const ew = h.width * imgScaleX;
    const eh = h.height * imgScaleY;
    drawHighlight(ctx, ex, ey, ew, eh, sw, sh, imgScaleX);
  }

  return canvasToPng(canvas);
}

// ── Toolbar Visibility ──

async function hideToolbar() {
  if (!activeTabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      func: () => {
        const el = document.getElementById('docext-toolbar');
        if (el) el.style.display = 'none';
      },
    });
    await new Promise((r) => setTimeout(r, 30));
  } catch { /* tab closed or restricted */ }
}

async function showToolbar() {
  if (!activeTabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      func: () => {
        const el = document.getElementById('docext-toolbar');
        if (el) el.style.display = '';
      },
    });
  } catch { /* tab closed or restricted */ }
}

// ── Screenshot Capture ──

async function toWebp(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return canvas.convertToBlob({ type: 'image/webp', quality: 1 });
}

// ── Theme Toggle ──

async function pauseContentCapture() {
  if (!activeTabId) return;
  try { await chrome.tabs.sendMessage(activeTabId, { type: 'PAUSE_CAPTURE' }); } catch {}
}

async function resumeContentCapture() {
  if (!activeTabId) return;
  try { await chrome.tabs.sendMessage(activeTabId, { type: 'RESUME_CAPTURE' }); } catch {}
}

async function setEmulatedTheme(theme: 'light' | 'dark' | 'system') {
  if (!activeTabId) return;
  try {
    await chrome.tabs.sendMessage(activeTabId, {
      type: 'TOGGLE_THEME',
      payload: { theme },
    } as ExtensionMessage);
  } catch {}
  state.theme = theme;
}

async function processPng(rawBlob: Blob, opts?: ScreenshotOpts): Promise<Blob> {
  if (!opts) return rawBlob;
  try {
    const processed = await processScreenshot(rawBlob, opts);
    if (processed.size > 1000) return processed;
  } catch (e) {
    console.warn('[docext] Screenshot processing failed, using full-page:', e);
  }
  return rawBlob;
}

async function storeFinalScreenshot(pngBlob: Blob): Promise<string> {
  const blob = await toWebp(pngBlob);
  const id = `ss-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await storeScreenshot(id, blob);
  return id;
}

interface RawDualCapture {
  lightRaw: Blob | null;
  darkRaw: Blob | null;
  fallbackRaw: Blob | null;
}

async function captureRawDual(themeSettleMs = 300): Promise<RawDualCapture> {
  const result: RawDualCapture = { lightRaw: null, darkRaw: null, fallbackRaw: null };
  const originalTheme = state.theme;

  try {
    await hideToolbar();

    if (activeTabId) {
      try {
        await pauseContentCapture();

        const needsLightSwitch = originalTheme !== 'light';
        if (needsLightSwitch) {
          await setEmulatedTheme('light');
          await new Promise((r) => setTimeout(r, themeSettleMs));
        }

        const lightDataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
        result.lightRaw = await (await globalThis.fetch(lightDataUrl)).blob();

        await setEmulatedTheme('dark');
        await new Promise((r) => setTimeout(r, themeSettleMs));

        const darkDataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
        result.darkRaw = await (await globalThis.fetch(darkDataUrl)).blob();

        await setEmulatedTheme(originalTheme === 'system' ? 'system' : originalTheme);
        await new Promise((r) => setTimeout(r, 50));
        await resumeContentCapture();

        await showToolbar();
        return result;
      } catch (err) {
        console.warn('[docext] Dual-theme capture failed, falling back:', err);
        try { await setEmulatedTheme(originalTheme === 'system' ? 'system' : originalTheme); } catch {}
        await resumeContentCapture();
      }
    }

    const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'png' });
    result.fallbackRaw = await (await globalThis.fetch(dataUrl)).blob();
    await showToolbar();
  } catch (err) {
    await showToolbar();
    console.warn('[docext] Raw screenshot capture failed:', err);
  }

  return result;
}

async function processRawDual(
  raw: RawDualCapture,
  opts?: ScreenshotOpts,
): Promise<{ mainId: string | null; altId: string | null }> {
  let mainId: string | null = null;
  let altId: string | null = null;

  try {
    if (raw.lightRaw && raw.darkRaw) {
      const [lightPng, darkPng] = await Promise.all([
        processPng(raw.lightRaw, opts),
        processPng(raw.darkRaw, opts),
      ]);

      const [lId, dId] = await Promise.all([
        storeFinalScreenshot(lightPng),
        storeFinalScreenshot(darkPng),
      ]);

      mainId = lId;
      altId = dId;
    } else if (raw.fallbackRaw) {
      const png = await processPng(raw.fallbackRaw, opts);
      mainId = await storeFinalScreenshot(png);
    }
  } catch (err) {
    console.warn('[docext] Screenshot processing failed:', err);
  }

  return { mainId, altId };
}

async function captureDualScreenshots(
  opts?: ScreenshotOpts,
  themeSettleMs = 300,
): Promise<{ mainId: string | null; altId: string | null }> {
  const raw = await captureRawDual(themeSettleMs);
  return processRawDual(raw, opts);
}

// ── Event Processing ──

async function handleEventCaptured(event: RecordedEvent) {
  const isClick = event.type === 'click';
  const isNavigate = event.type === 'navigate';

  try {
    if (isNavigate && activeTabId) {
      await waitForTabLoad(activeTabId, NAVIGATE_LOAD_TIMEOUT_MS);
      await new Promise((r) => setTimeout(r, NAVIGATE_RENDER_DELAY_MS));
    } else {
      const delay = isClick ? CLICK_SCREENSHOT_DELAY_MS : SCREENSHOT_DELAY_MS;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    let opts: ScreenshotOpts | undefined;
    const meta = event.metadata as ClickMeta | InputMeta | SelectMeta;
    const hasRect = isClick || event.type === 'input' || event.type === 'select';
    if (hasRect && meta.viewportSize) {
      const vp = meta.viewportSize;
      const shouldCrop = state.eventCount > 0 && (meta.cropRect || meta.elementRect);
      opts = {
        crop: shouldCrop ? (meta.cropRect || meta.elementRect) : undefined,
        highlight: meta.elementRect || undefined,
        viewportWidth: vp.width,
        viewportHeight: vp.height,
      };
    }

    const rawCapture = await captureRawDual(isNavigate ? 800 : 150);

    const processPromise = (async () => {
      try {
        const { mainId, altId } = await processRawDual(rawCapture, opts);
        if (mainId) event.screenshotId = mainId;
        if (altId) event.altScreenshotId = altId;
        await storeEvent(event);
        state.eventCount++;
        broadcastState();
      } catch (err) {
        console.warn('[docext] Screenshot processing failed:', err);
        try { await storeEvent(event); state.eventCount++; broadcastState(); } catch {}
      }
    })();

    pendingCaptures.add(processPromise);
    processPromise.finally(() => pendingCaptures.delete(processPromise));
  } catch (err) {
    console.warn('[docext] Event capture failed:', err);
    try { await storeEvent(event); state.eventCount++; broadcastState(); } catch {}
  }
}

async function waitForPendingCaptures() {
  const maxWait = 30_000;
  const start = Date.now();
  while ((eventQueue.length > 0 || processingEvent) && Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (pendingCaptures.size > 0) {
    await Promise.allSettled([...pendingCaptures]);
  }
}

// ── Recording Lifecycle ──

async function startRecording(tab: chrome.tabs.Tab) {
  if (state.isRecording) return;

  activeTabId = tab.id ?? null;

  try {
    const { session } = await createSession(tab.url || '', tab.title);
    state = { ...defaultState(), isRecording: true, sessionId: session.id, startedAt: Date.now() };
  } catch (err) {
    console.warn('[docext] Failed to create session on server, using local:', err);
    state = { ...defaultState(), isRecording: true, sessionId: `local-${Date.now()}`, startedAt: Date.now() };
  }

  await clearAll();
  pendingCaptures.clear();

  if (activeTabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTabId, allFrames: true },
        files: ['content.js'],
      });
    } catch { /* content script may already be injected */ }

    await new Promise((r) => setTimeout(r, 50));

    try {
      await chrome.tabs.sendMessage(activeTabId, { type: 'START_RECORDING' } as ExtensionMessage);
    } catch (err) {
      console.warn('[docext] Failed to send START_RECORDING:', err);
    }

    // Ensure the page starts in light mode for consistent screenshots
    await setEmulatedTheme('light');
    state.theme = 'light';
  }

  batchTimer = setInterval(flushToBackend, BATCH_INTERVAL_MS);
  broadcastState();
}

async function captureFinalScreenshots(): Promise<void> {
  if (!activeTabId) return;
  try {
    let tab: chrome.tabs.Tab | undefined;
    try { tab = await chrome.tabs.get(activeTabId); } catch { return; }

    const { mainId: ssId, altId } = await captureDualScreenshots(undefined, 500);

    const event: RecordedEvent = {
      id: `final-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'navigate',
      timestamp: Date.now(),
      url: tab?.url || '',
      pageTitle: tab?.title || '',
      metadata: { fromUrl: '', toUrl: tab?.url || '', newTitle: tab?.title || '' },
      screenshotId: ssId ?? undefined,
      altScreenshotId: altId ?? undefined,
    };

    await storeEvent(event);
    state.eventCount++;
  } catch (err) {
    console.warn('[docext] Final screenshot capture failed:', err);
  }
}

async function stopRecording() {
  if (!state.isRecording) return;

  const sessionId = state.sessionId;

  // Stop batch timer first to prevent races during final flush
  if (batchTimer) {
    clearInterval(batchTimer);
    batchTimer = null;
  }

  // Wait for any in-progress batch flush to finish
  await waitForFlush();

  await waitForPendingCaptures();
  await captureFinalScreenshots();

  if (activeTabId) {
    try {
      await chrome.tabs.sendMessage(activeTabId, { type: 'STOP_RECORDING' } as ExtensionMessage);
    } catch { /* tab may have closed */ }
  }

  await forceFlushToBackend();

  if (sessionId && !sessionId.startsWith('local-')) {
    try {
      await finalizeSession(sessionId);
    } catch (err) {
      console.warn('[docext] Failed to finalize session:', err);
    }
  }

  state = defaultState();
  pendingCaptures.clear();
  broadcastState();

  return sessionId;
}

async function cancelRecording() {
  if (!state.isRecording) return;

  const sessionId = state.sessionId;

  if (batchTimer) {
    clearInterval(batchTimer);
    batchTimer = null;
  }

  if (activeTabId) {
    try {
      await chrome.tabs.sendMessage(activeTabId, { type: 'STOP_RECORDING' } as ExtensionMessage);
    } catch { /* tab may have closed */ }
  }

  await clearAll();
  pendingCaptures.clear();
  eventQueue.length = 0;
  processingEvent = false;

  if (sessionId && !sessionId.startsWith('local-')) {
    try {
      await deleteSession(sessionId);
    } catch (err) {
      console.warn('[docext] Failed to delete cancelled session:', err);
    }
  }

  state = defaultState();
  broadcastState();
}

// ── Backend Sync ──

async function uploadWithRetry(sessionId: string, blob: Blob, retries = 2): Promise<string> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await uploadScreenshotBlob(sessionId, blob);
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw new Error('Upload exhausted retries');
}

async function uploadScreenshotsParallel(
  sessionId: string,
  events: RecordedEvent[],
  ssMap: Map<string, Blob>,
) {
  const tasks: Array<{ event: RecordedEvent; field: 'screenshotId' | 'altScreenshotId'; localId: string }> = [];

  for (const event of events) {
    if (event.screenshotId && ssMap.has(event.screenshotId)) {
      tasks.push({ event, field: 'screenshotId', localId: event.screenshotId });
    }
    if (event.altScreenshotId && ssMap.has(event.altScreenshotId)) {
      tasks.push({ event, field: 'altScreenshotId', localId: event.altScreenshotId });
    }
  }

  const idMap = new Map<string, string>();
  const seen = new Set<string>();
  const uniqueTasks = tasks.filter((t) => {
    if (seen.has(t.localId)) return false;
    seen.add(t.localId);
    return true;
  });

  let i = 0;
  while (i < uniqueTasks.length) {
    const batch = uniqueTasks.slice(i, i + UPLOAD_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (t) => {
        const remoteId = await uploadWithRetry(sessionId, ssMap.get(t.localId)!);
        idMap.set(t.localId, remoteId);
      })
    );
    for (const r of results) {
      if (r.status === 'rejected') console.warn('[docext] Screenshot upload failed:', r.reason);
    }
    i += UPLOAD_CONCURRENCY;
  }

  for (const t of tasks) {
    const remoteId = idMap.get(t.localId);
    if (remoteId) {
      (t.event as any)[t.field] = remoteId;
    } else {
      (t.event as any)[t.field] = undefined;
    }
  }
}

async function flushToBackend() {
  if (!state.sessionId || state.sessionId.startsWith('local-')) return;
  if (flushing) return;
  flushing = true;

  try {
    const events = await getAllEvents();
    if (events.length === 0) return;

    const screenshots = await getAllScreenshots();
    const ssMap = new Map(screenshots.map((s) => [s.id, s.blob]));

    await uploadScreenshotsParallel(state.sessionId!, events, ssMap);
    await uploadEvents(state.sessionId!, events);
    await clearAll();
  } catch (err) {
    console.warn('[docext] Batch flush failed (will retry):', err);
  } finally {
    flushing = false;
  }
}

async function waitForFlush() {
  const maxWait = 15_000;
  const start = Date.now();
  while (flushing && Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function forceFlushToBackend() {
  await waitForFlush();

  if (!state.sessionId || state.sessionId.startsWith('local-')) return;

  flushing = true;
  try {
    const events = await getAllEvents();
    if (events.length === 0) return;

    const screenshots = await getAllScreenshots();
    const ssMap = new Map(screenshots.map((s) => [s.id, s.blob]));

    await uploadScreenshotsParallel(state.sessionId!, events, ssMap);
    await uploadEvents(state.sessionId!, events);
    await clearAll();
  } catch (err) {
    console.error('[docext] Force flush failed:', err);
  } finally {
    flushing = false;
  }
}

// ── Message Listener ──

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender, sendResponse) => {
    const handle = async () => {
      switch (message.type) {
        case 'START_RECORDING': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab) await startRecording(tab);
          return getState();
        }
        case 'STOP_RECORDING': {
          const sessionId = await stopRecording();
          if (sessionId && !sessionId.startsWith('local-')) {
            chrome.tabs.create({ url: `http://localhost:3001/session/${sessionId}` });
          }
          return { ...getState(), finishedSessionId: sessionId };
        }
        case 'CANCEL_RECORDING': {
          await cancelRecording();
          return getState();
        }
        case 'GET_STATE': {
          return getState();
        }
        case 'EVENT_CAPTURED': {
          const event = message.payload as RecordedEvent;
          await enqueueEvent(event);
          return { ok: true };
        }
        case 'ENTER_EDIT_MODE': {
          state.editMode = true;
          if (activeTabId) {
            await chrome.tabs.sendMessage(activeTabId, { type: 'ENTER_EDIT_MODE' } as ExtensionMessage);
          }
          broadcastState();
          return getState();
        }
        case 'EXIT_EDIT_MODE': {
          state.editMode = false;
          if (activeTabId) {
            await chrome.tabs.sendMessage(activeTabId, { type: 'EXIT_EDIT_MODE' } as ExtensionMessage);
          }
          broadcastState();
          return getState();
        }
        case 'TOGGLE_THEME': {
          const { theme } = message.payload as { theme: 'light' | 'dark' | 'system' };
          await setEmulatedTheme(theme);
          return getState();
        }
        default:
          return { error: 'Unknown message type' };
      }
    };

    handle()
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error('[docext] Background handler error:', err);
        sendResponse({ error: String(err) });
      });

    return true;
  }
);

// ── Content Script Re-injection ──

function injectAndStart(tabId: number, allFrames: boolean, frameIds?: number[]) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames };
  chrome.scripting.executeScript({
    target,
    files: ['content.js'],
  }).then(() => {
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, {
        type: 'START_RECORDING',
        payload: getState(),
      } as ExtensionMessage).catch(() => {});
    }, 50);
  }).catch(() => {});
}

chrome.webNavigation?.onDOMContentLoaded?.addListener((details) => {
  if (!state.isRecording || details.tabId !== activeTabId) return;
  if (details.frameId === 0) {
    injectAndStart(details.tabId, true);
  } else {
    injectAndStart(details.tabId, false, [details.frameId]);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (state.isRecording && tabId === activeTabId && changeInfo.status === 'complete') {
    injectAndStart(tabId, true);
  }
});
