import type {
  RecordedEvent,
  RecordingState,
  ExtensionMessage,
} from '@docext/shared';
import { resolveElement, isInteractiveElement, isStrongInteractive } from './lib/element-resolver.js';
import {
  isDuplicateClick,
  debounceInput,
  flushPendingInput,
  flushAllPending,
  resetFilters,
} from './lib/event-filter.js';
import { buildClickEvent, buildInputEvent, buildSelectEvent, buildSubmitEvent } from './lib/event-builders.js';
import {
  enterEditMode,
  exitEditMode,
  isEditMode,
  getDomEdits,
  startEditGuard,
  stopEditGuard,
  loadEditsFromStorage,
} from './lib/edit-mode.js';
import {
  createFloatingToolbar,
  destroyFloatingToolbar,
  updateToolbar,
  startToolbarTimer,
  stopToolbarTimer,
  getToolbarHost,
  hideToolbar,
  showToolbar,
} from './lib/floating-toolbar.js';
import {
  startSpaObserver,
  stopSpaObserver,
  setLastClickTimestamp,
} from './lib/spa-observer.js';

// ── State ──

let isRecording = false;
let isReplayingClick = false;
let capturePaused = false;
let lastClickSentAt = 0;

const CLICK_COOLDOWN_MS = 4000;

// Guard against duplicate script injection
const INJECTED_KEY = '__docext_injected';
if ((window as any)[INJECTED_KEY]) {
  // Already injected — the existing listener handles messages.
} else {
  (window as any)[INJECTED_KEY] = true;
  initContentScript();
}

function initContentScript() {
  chrome.runtime.onMessage.addListener(messageHandler);
}

// Pointerdown → click coordination
let lastPointerCapture: {
  selector: string;
  time: number;
  promise: Promise<unknown>;
  target: Element;
  originalEvent?: PointerEvent;
  didPrevent: boolean;
} | null = null;

// ── Utilities ──

function safeSendMessage(msg: ExtensionMessage): Promise<unknown> {
  try {
    return chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

function sendEvent(event: RecordedEvent) {
  if (capturePaused) return;
  safeSendMessage({ type: 'EVENT_CAPTURED', payload: event });
}

// ── Interactive Element Resolution ──

const CONTAINER_ROLES = new Set(['menu', 'menubar', 'listbox', 'tablist', 'navigation', 'dialog', 'alertdialog']);
const CONTAINER_TAGS = new Set(['menu', 'nav', 'ul', 'ol', 'dialog']);
const FORM_FIELD_TAGS = new Set(['input', 'select', 'textarea']);

function hasActionableHints(n: Element): boolean {
  return (
    n.hasAttribute('aria-haspopup') ||
    n.hasAttribute('onclick') ||
    n.hasAttribute('data-action') ||
    n.getAttribute('role') === 'button' ||
    n.tagName.toLowerCase() === 'button' ||
    n.tagName.toLowerCase() === 'a'
  );
}

const VISUAL_ONLY_TAGS = new Set(['svg', 'img', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'use', 'g', 'icon', 'i', 'span']);

function findInteractiveAncestor(el: Element): Element | null {
  let node: Element | null = el;
  let depth = 0;
  let weakMatch: Element | null = null;

  while (node && depth < 10) {
    if (isStrongInteractive(node)) {
      const role = node.getAttribute('role');
      const tag = node.tagName.toLowerCase();
      if ((role && CONTAINER_ROLES.has(role)) || CONTAINER_TAGS.has(tag)) {
        if (!hasActionableHints(node)) {
          node = node.parentElement;
          depth++;
          continue;
        }
      }
      return node;
    }
    if (isInteractiveElement(node)) {
      const tag = node.tagName.toLowerCase();
      if (!weakMatch) {
        weakMatch = node;
      } else if (VISUAL_ONLY_TAGS.has(weakMatch.tagName.toLowerCase()) && !VISUAL_ONLY_TAGS.has(tag)) {
        weakMatch = node;
      }
    }
    node = node.parentElement;
    depth++;
  }

  return weakMatch;
}

function findPopupTriggerAncestor(el: Element): Element | null {
  let node: Element | null = el;
  let depth = 0;
  while (node && depth < 8) {
    const role = node.getAttribute('role');
    const tag = node.tagName.toLowerCase();
    const isContainer = role === 'menu' || role === 'menubar' || role === 'list' || role === 'listbox' || tag === 'menu' || tag === 'ul' || tag === 'ol' || tag === 'nav';
    const isTrigger =
      node.hasAttribute('aria-haspopup') ||
      node.hasAttribute('data-state') ||
      node.getAttribute('aria-expanded') !== null;
    if (isTrigger && !isContainer) return node;
    node = node.parentElement;
    depth++;
  }
  return null;
}

function liftFromVisualElement(el: Element): Element {
  if (!VISUAL_ONLY_TAGS.has(el.tagName.toLowerCase())) return el;
  let node = el.parentElement;
  let depth = 0;
  while (node && depth < 5) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || node.getAttribute('role') === 'button' || node.getAttribute('role') === 'link') {
      return node;
    }
    if (!VISUAL_ONLY_TAGS.has(tag) && isInteractiveElement(node)) return node;
    node = node.parentElement;
    depth++;
  }
  return el;
}

function resolveClickTarget(rawTarget: Element): Element | null {
  const popupTrigger = findPopupTriggerAncestor(rawTarget);
  let target = popupTrigger || findInteractiveAncestor(rawTarget) || rawTarget;
  target = liftFromVisualElement(target);
  const tag = target.tagName.toLowerCase();
  if (tag === 'html' || tag === 'body') return null;
  if (FORM_FIELD_TAGS.has(tag)) return null;
  return target;
}

// ── Event Handlers ──

function needsPointerdownPrevention(el: Element): boolean {
  if (el.hasAttribute('aria-haspopup')) return true;
  if (el.getAttribute('aria-expanded') === 'false') return true;
  if (el.getAttribute('data-state') === 'closed') return true;

  const role = el.getAttribute('role');
  if (role === 'menuitem' || role === 'menuitemcheckbox' || role === 'menuitemradio' || role === 'option') return true;

  if (el.closest('[role="menu"], [role="listbox"], [role="menubar"], [data-radix-menu-content], [data-radix-dropdown-menu-content], [data-radix-select-content]')) {
    return true;
  }

  return false;
}

function replayClick(target: Element) {
  isReplayingClick = true;
  try {
    if (typeof (target as HTMLElement).click === 'function') {
      (target as HTMLElement).click();
    } else {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
  } finally {
    isReplayingClick = false;
  }
}

function replayFullChain(target: Element, origPointerEvent: PointerEvent) {
  isReplayingClick = true;
  try {
    const opts = {
      bubbles: true, cancelable: true,
      clientX: origPointerEvent.clientX, clientY: origPointerEvent.clientY,
      screenX: origPointerEvent.screenX, screenY: origPointerEvent.screenY,
      button: origPointerEvent.button, buttons: origPointerEvent.buttons,
      pointerId: origPointerEvent.pointerId, pointerType: origPointerEvent.pointerType,
    };
    target.dispatchEvent(new PointerEvent('pointerdown', opts));
    target.dispatchEvent(new PointerEvent('pointerup', opts));
    if (typeof (target as HTMLElement).click === 'function') {
      (target as HTMLElement).click();
    } else {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
  } finally {
    isReplayingClick = false;
  }
}

function handlePointerdown(e: PointerEvent) {
  if (isReplayingClick) return;
  if (!isRecording || isEditMode() || capturePaused) return;
  const rawTarget = e.target as Element;
  const toolbar = getToolbarHost();
  if (!rawTarget || (toolbar && toolbar.contains(rawTarget))) return;

  const target = resolveClickTarget(rawTarget);
  if (!target) return;

  const info = resolveElement(target);
  if (isDuplicateClick(info.selector, Date.now())) return;

  const needsPrevent = needsPointerdownPrevention(target);
  if (needsPrevent) {
    e.stopPropagation();
    e.preventDefault();
  }

  const capturedEvent = buildClickEvent(target, e, info, getDomEdits());
  lastClickSentAt = Date.now();
  setLastClickTimestamp(lastClickSentAt);
  const promise = safeSendMessage({ type: 'EVENT_CAPTURED', payload: capturedEvent });

  lastPointerCapture = {
    selector: info.selector,
    time: Date.now(),
    promise,
    target,
    originalEvent: needsPrevent ? e : undefined,
    didPrevent: needsPrevent,
  };

  if (needsPrevent) {
    promise
      .then(() => { lastClickSentAt = Date.now(); setLastClickTimestamp(lastClickSentAt); replayFullChain(target, e); })
      .catch(() => { lastClickSentAt = Date.now(); setLastClickTimestamp(lastClickSentAt); replayFullChain(target, e); });
  }
}

function handleClick(e: MouseEvent) {
  if (isReplayingClick) return;
  if (!isRecording || isEditMode()) return;
  const rawTarget = e.target as Element;
  const toolbar = getToolbarHost();
  if (!rawTarget || (toolbar && toolbar.contains(rawTarget))) return;

  const target = resolveClickTarget(rawTarget);
  if (!target) return;

  const now = Date.now();

  if (lastPointerCapture && now - lastPointerCapture.time < 800) {
    e.preventDefault();
    e.stopPropagation();

    if (lastPointerCapture.didPrevent) {
      lastPointerCapture = null;
      return;
    }

    const capture = lastPointerCapture;
    lastPointerCapture = null;
    capture.promise
      .then(() => { lastClickSentAt = Date.now(); setLastClickTimestamp(lastClickSentAt); replayClick(target); })
      .catch(() => { lastClickSentAt = Date.now(); setLastClickTimestamp(lastClickSentAt); replayClick(target); });
    return;
  }

  if (capturePaused) return;

  lastPointerCapture = null;
  const info = resolveElement(target);
  if (isDuplicateClick(info.selector, now)) return;

  const capturedEvent = buildClickEvent(target, e, info, getDomEdits());
  lastClickSentAt = Date.now();
  setLastClickTimestamp(lastClickSentAt);

  e.preventDefault();
  e.stopPropagation();

  const replayTarget = target;
  safeSendMessage({ type: 'EVENT_CAPTURED', payload: capturedEvent })
    .then(() => { lastClickSentAt = Date.now(); setLastClickTimestamp(lastClickSentAt); replayClick(replayTarget); })
    .catch(() => { lastClickSentAt = Date.now(); setLastClickTimestamp(lastClickSentAt); replayClick(replayTarget); });
}

function handleBlur(e: FocusEvent) {
  if (!isRecording || isEditMode() || capturePaused) return;
  const target = e.target as Element;
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;

  const info = resolveElement(target);
  flushPendingInput(info.selector, sendEvent);

  const value = target.value;
  if (!value || value.length === 0) return;

  sendEvent(buildInputEvent(target, info));
}

function handleChange(e: Event) {
  if (!isRecording || isEditMode() || capturePaused) return;
  const target = e.target as Element;
  if (target instanceof HTMLSelectElement) {
    const info = resolveElement(target);
    sendEvent(buildSelectEvent(target, info));
    return;
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const info = resolveElement(target);
    debounceInput(buildInputEvent(target, info), info.selector, sendEvent);
  }
}

function handleSubmit(e: Event) {
  if (!isRecording || isEditMode() || capturePaused) return;
  const form = e.target as HTMLFormElement;
  if (!(form instanceof HTMLFormElement)) return;
  flushAllPending(sendEvent);
  sendEvent(buildSubmitEvent(form));
}

// ── Start/Stop Recording ──

const isTopFrame = window === window.top;

function startRecording() {
  if (isRecording) return;
  isRecording = true;
  capturePaused = false;
  lastPointerCapture = null;
  lastClickSentAt = 0;

  document.addEventListener('pointerdown', handlePointerdown, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('blur', handleBlur, true);
  document.addEventListener('change', handleChange, true);
  document.addEventListener('submit', handleSubmit, true);

  if (isTopFrame) {
    startSpaObserver({
      sendEvent,
      isCapturePaused: () => capturePaused,
    });
    createFloatingToolbar(isEditMode(), () => {
      safeSendMessage({ type: isEditMode() ? 'EXIT_EDIT_MODE' : 'ENTER_EDIT_MODE' });
    });
    startToolbarTimer();
    startEditGuard();
    loadEditsFromStorage();
  }
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;

  if (isTopFrame) {
    stopEditGuard();
    if (isEditMode()) exitEditMode();
  }

  lastPointerCapture = null;
  capturePaused = false;
  document.removeEventListener('pointerdown', handlePointerdown, true);
  document.removeEventListener('click', handleClick, true);
  document.removeEventListener('blur', handleBlur, true);
  document.removeEventListener('change', handleChange, true);
  document.removeEventListener('submit', handleSubmit, true);

  if (isTopFrame) {
    stopSpaObserver();
    flushAllPending(sendEvent);
    resetFilters();
    stopToolbarTimer();
    destroyFloatingToolbar();
  }
}

// ── Message Handler ──

function messageHandler(message: ExtensionMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) {
  switch (message.type) {
    case 'START_RECORDING':
      startRecording();
      sendResponse({ ok: true });
      break;
    case 'STOP_RECORDING':
    case 'CANCEL_RECORDING':
      stopRecording();
      sendResponse({ ok: true });
      break;
    case 'ENTER_EDIT_MODE':
      enterEditMode();
      sendResponse({ ok: true });
      break;
    case 'EXIT_EDIT_MODE':
      exitEditMode();
      sendResponse({ ok: true });
      break;
    case 'PAUSE_CAPTURE':
      capturePaused = true;
      sendResponse({ ok: true });
      break;
    case 'RESUME_CAPTURE':
      capturePaused = false;
      sendResponse({ ok: true });
      break;
    case 'TOGGLE_THEME': {
      const payload = message.payload as { theme: string } | undefined;
      if (payload) {
        const html = document.documentElement;
        if (payload.theme === 'dark') {
          html.classList.add('dark');
          html.setAttribute('data-theme', 'dark');
          html.style.colorScheme = 'dark';
        } else if (payload.theme === 'light') {
          html.classList.remove('dark');
          html.setAttribute('data-theme', 'light');
          html.style.colorScheme = 'light';
        } else {
          html.classList.remove('dark');
          html.removeAttribute('data-theme');
          html.style.colorScheme = '';
        }
      }
      sendResponse({ ok: true });
      break;
    }
    case 'RECORDING_STATE': {
      const s = message.payload as RecordingState;
      if (s) updateToolbar(s);
      sendResponse({ ok: true });
      break;
    }
    case 'HIDE_TOOLBAR':
      hideToolbar();
      sendResponse({ ok: true });
      break;
    case 'SHOW_TOOLBAR':
      showToolbar();
      sendResponse({ ok: true });
      break;
    case 'GET_STATE':
      sendResponse({ isRecording, editMode: isEditMode() });
      break;
  }
  return true;
}
