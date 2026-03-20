import type {
  RecordedEvent,
  RecordingState,
  ClickMeta,
  InputMeta,
  SelectMeta,
  NavigateMeta,
  SubmitMeta,
  ModalMeta,
  DomEdit,
  ExtensionMessage,
} from '@docext/shared';
import { resolveElement, isInteractiveElement, isStrongInteractive, type ElementInfo } from './lib/element-resolver.js';
import {
  isDuplicateClick,
  debounceInput,
  flushPendingInput,
  flushAllPending,
  resetFilters,
} from './lib/event-filter.js';

const LOGO_SVG_HTML = `
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false" style="display:block">
    <circle cx="12" cy="12" r="10" fill="#6366f1"></circle>
    <path
      d="M9 7.5h4a4.5 4.5 0 0 1 0 9H9"
      fill="none"
      stroke="#ffffff"
      stroke-width="2.2"
      stroke-linecap="round"
      stroke-linejoin="round"
    ></path>
  </svg>
`;

// ── State ──

let isRecording = false;
let editMode = false;
let isReplayingClick = false;
let capturePaused = false;
let lastClickSentAt = 0;
let urlObserverInterval: ReturnType<typeof setInterval> | null = null;
let mutationObserver: MutationObserver | null = null;
let lastUrl = location.href;

const CLICK_COOLDOWN_MS = 4000;

// Guard against duplicate script injection
const INJECTED_KEY = '__docext_injected';
if ((window as any)[INJECTED_KEY]) {
  // Already injected — skip re-initializing listeners.
  // The background will send START_RECORDING which the existing listener handles.
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

// DOM edit mode state
let domSnapshot: WeakMap<Node, string> = new WeakMap();
let activeEditable: HTMLElement | null = null;
let domEdits: DomEdit[] = [];

const persistedEdits: Map<string, string> = new Map();
let editGuardObserver: MutationObserver | null = null;
let applyingEdits = false;

// Floating toolbar
let toolbarHost: HTMLElement | null = null;
let toolbarShadow: ShadowRoot | null = null;
let toolbarTimer: ReturnType<typeof setInterval> | null = null;

// ── Persistent Edit Guard ──

function applyPersistedEdits() {
  if (persistedEdits.size === 0 || applyingEdits) return;
  applyingEdits = true;
  try {
    for (const [selector, text] of persistedEdits) {
      try {
        const el = document.querySelector(selector);
        if (el && el.textContent !== text) {
          el.textContent = text;
        }
      } catch { /* invalid selector */ }
    }
  } finally {
    applyingEdits = false;
  }
}

function startEditGuard() {
  if (editGuardObserver) return;
  editGuardObserver = new MutationObserver(() => {
    if (!applyingEdits) applyPersistedEdits();
  });
  editGuardObserver.observe(document.body, { childList: true, subtree: true });
}

function stopEditGuard() {
  if (editGuardObserver) {
    editGuardObserver.disconnect();
    editGuardObserver = null;
  }
  persistedEdits.clear();
}

// ── Crop & Layout Helpers ──

const SECTION_TAGS = new Set([
  'section', 'article', 'aside', 'nav', 'main', 'header', 'footer',
  'form', 'dialog', 'details', 'fieldset', 'figure', 'table',
]);

const SECTION_ROLES = new Set([
  'dialog', 'navigation', 'complementary', 'region', 'toolbar',
  'tabpanel', 'group', 'list', 'listbox', 'menu', 'menubar',
  'banner', 'contentinfo', 'form', 'search', 'alertdialog',
]);

function findCropContainer(el: Element): DOMRect {
  // For popup triggers (dropdowns/menus), crop tightly around the trigger itself.
  // Cropping to ancestor containers (e.g. <menu>, <nav>) makes highlights look like
  // the entire sidebar/list was clicked.
  try {
    const isPopupTrigger =
      el.hasAttribute('aria-haspopup') ||
      el.getAttribute('aria-expanded') !== null ||
      el.getAttribute('data-state') !== null;
    if (isPopupTrigger) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const r = el.getBoundingClientRect();
      const pad = 16;
      return new DOMRect(
        Math.max(0, r.left - pad),
        Math.max(0, r.top - pad),
        Math.min(vw, r.width + pad * 2),
        Math.min(vh, r.height + pad * 2),
      );
    }
  } catch { /* ignore */ }

  const dialog = el.closest('dialog, [role="dialog"], [role="alertdialog"]');
  if (dialog && dialog !== el) {
    const dr = dialog.getBoundingClientRect();
    if (dr.width > 1 && dr.height > 1) return dr;
  }

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const minW = Math.min(400, vw * 0.35);
  const minH = Math.min(300, vh * 0.3);
  const maxW = vw * 0.85;
  const maxH = vh * 0.85;

  let node: Element | null = el.parentElement;
  let best: DOMRect | null = null;

  let depth = 0;
  while (node && node !== document.documentElement && depth < 20) {
    depth++;
    const rect = node.getBoundingClientRect();

    if (rect.width < 1 || rect.height < 1) { node = node.parentElement; continue; }

    const tag = node.tagName.toLowerCase();
    const role = node.getAttribute('role');
    const isSemantic = SECTION_TAGS.has(tag) || (role != null && SECTION_ROLES.has(role));

    // Avoid cropping to huge navigation/menu containers when the clicked element
    // is a small control inside them (sidebars, dropdown menus, etc).
    if (
      role &&
      (role === 'navigation' || role === 'menu' || role === 'menubar' || role === 'list' || role === 'listbox') &&
      (rect.width > vw * 0.55 || rect.height > vh * 0.55)
    ) {
      node = node.parentElement;
      continue;
    }

    let hasVisualBoundary = false;
    try {
      const cs = getComputedStyle(node);
      hasVisualBoundary =
        (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') ||
        (cs.borderWidth !== '0px' && cs.borderStyle !== 'none') ||
        cs.boxShadow !== 'none' ||
        cs.borderRadius !== '0px';
    } catch { /* cross-origin or detached */ }

    const bigEnough = rect.width >= minW && rect.height >= minH;
    const notTooLarge = rect.width <= maxW && rect.height <= maxH;

    if (bigEnough && notTooLarge && (isSemantic || hasVisualBoundary)) {
      best = rect;
      break;
    }

    if (bigEnough && !best) {
      best = rect;
    }

    if (rect.width > maxW && rect.height > maxH) break;

    node = node.parentElement;
  }

  if (best) return best;

  const elRect = el.getBoundingClientRect();
  const padX = Math.max(160, (minW - elRect.width) / 2);
  const padY = Math.max(120, (minH - elRect.height) / 2);
  return new DOMRect(
    Math.max(0, elRect.left - padX),
    Math.max(0, elRect.top - padY),
    Math.min(vw, elRect.width + padX * 2),
    Math.min(vh, elRect.height + padY * 2),
  );
}

// ── Interactive Element Resolution ──

function findInteractiveAncestor(el: Element): Element | null {
  let node: Element | null = el;
  let depth = 0;
  let weakMatch: Element | null = null;

  const containerRoles = new Set(['menu', 'menubar', 'listbox', 'tablist', 'navigation']);
  const containerTags = new Set(['menu', 'nav', 'ul', 'ol']);
  const hasActionableHints = (n: Element) =>
    n.hasAttribute('aria-haspopup') ||
    n.hasAttribute('onclick') ||
    n.hasAttribute('data-action') ||
    n.getAttribute('role') === 'button' ||
    n.tagName.toLowerCase() === 'button' ||
    n.tagName.toLowerCase() === 'a';

  while (node && depth < 10) {
    if (isStrongInteractive(node)) {
      const role = node.getAttribute('role');
      const tag = node.tagName.toLowerCase();
      // Skip focusable containers (e.g. role="menu" with tabindex) so we don't
      // end up targeting the entire menu/sidebar instead of the actual item.
      if ((role && containerRoles.has(role)) || containerTags.has(tag)) {
        if (!hasActionableHints(node)) {
          if (!weakMatch && isInteractiveElement(node)) weakMatch = node;
          node = node.parentElement;
          depth++;
          continue;
        }
      }
      return node;
    }
    if (!weakMatch && isInteractiveElement(node)) weakMatch = node;
    node = node.parentElement;
    depth++;
  }

  return weakMatch;
}

const FORM_FIELD_TAGS = new Set(['input', 'select', 'textarea']);

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

function resolveClickTarget(rawTarget: Element): Element | null {
  const popupTrigger = findPopupTriggerAncestor(rawTarget);
  const target = popupTrigger || findInteractiveAncestor(rawTarget) || rawTarget;
  const tag = target.tagName.toLowerCase();
  if (tag === 'html' || tag === 'body') return null;
  if (FORM_FIELD_TAGS.has(tag)) return null;
  return target;
}

// ── Utilities ──

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

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

const SENSITIVE_RE = /password|secret|token|ssn|credit.?card|cvv|pin|social.?security/i;

// ── Event Builders ──

function buildClickEvent(el: Element, e: MouseEvent | PointerEvent, info: ElementInfo): RecordedEvent {
  const r = el.getBoundingClientRect();
  const cr = findCropContainer(el);
  const meta: ClickMeta = {
    elementTag: info.tag,
    elementText: info.text,
    ariaLabel: info.ariaLabel,
    role: info.role,
    selector: info.selector,
    coordinates: { x: e.clientX, y: e.clientY },
    elementRect: { x: r.left, y: r.top, width: r.width, height: r.height },
    cropRect: { x: cr.x, y: cr.y, width: cr.width, height: cr.height },
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
    nearestHeading: info.nearestHeading,
    sectionLabel: info.sectionLabel,
    containerRole: info.containerRole,
    href: info.href,
    title: info.title,
    parentText: info.parentText,
    fieldLabel: info.fieldLabel,
    breadcrumb: info.breadcrumb,
    tooltipText: info.tooltipText,
    inputValue: info.inputValue,
  };
  return {
    id: generateId(),
    type: 'click',
    timestamp: Date.now(),
    url: location.href,
    pageTitle: document.title,
    metadata: meta,
    domEdits: domEdits.length > 0 ? [...domEdits] : undefined,
  };
}

function buildInputEvent(el: Element, info: ElementInfo): RecordedEvent {
  const label = info.fieldLabel || info.ariaLabel || info.placeholder || info.tag;
  const fieldType = info.fieldType || 'text';
  let value = '';
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    value = el.value;
  }
  if (fieldType === 'password' || SENSITIVE_RE.test(label)) value = '••••••';

  const r = el.getBoundingClientRect();
  const cr = findCropContainer(el);
  const meta: InputMeta = {
    fieldLabel: label,
    fieldType,
    value,
    selector: info.selector,
    placeholder: info.placeholder,
    nearestHeading: info.nearestHeading,
    sectionLabel: info.sectionLabel,
    containerRole: info.containerRole,
    breadcrumb: info.breadcrumb,
    elementRect: { x: r.left, y: r.top, width: r.width, height: r.height },
    cropRect: { x: cr.x, y: cr.y, width: cr.width, height: cr.height },
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
  };
  return {
    id: generateId(),
    type: 'input',
    timestamp: Date.now(),
    url: location.href,
    pageTitle: document.title,
    metadata: meta,
  };
}

function buildSelectEvent(el: HTMLSelectElement, info: ElementInfo): RecordedEvent {
  const selectedOption = el.options[el.selectedIndex]?.text || el.value;
  const label = info.fieldLabel || info.ariaLabel || info.placeholder || 'dropdown';
  const r = el.getBoundingClientRect();
  const cr = findCropContainer(el);
  const meta: SelectMeta = {
    fieldLabel: label,
    selectedOption,
    selector: info.selector,
    breadcrumb: info.breadcrumb,
    elementRect: { x: r.left, y: r.top, width: r.width, height: r.height },
    cropRect: { x: cr.x, y: cr.y, width: cr.width, height: cr.height },
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
  };
  return {
    id: generateId(),
    type: 'select',
    timestamp: Date.now(),
    url: location.href,
    pageTitle: document.title,
    metadata: meta,
  };
}

function buildNavigateEvent(fromUrl: string, toUrl: string): RecordedEvent {
  const meta: NavigateMeta = { fromUrl, toUrl, newTitle: document.title };
  return {
    id: generateId(),
    type: 'navigate',
    timestamp: Date.now(),
    url: toUrl,
    pageTitle: document.title,
    metadata: meta,
  };
}

function buildSubmitEvent(form: HTMLFormElement): RecordedEvent {
  const meta: SubmitMeta = {
    formName: form.name || form.getAttribute('aria-label') || undefined,
    formAction: form.action || undefined,
    fieldCount: form.elements.length,
  };
  return {
    id: generateId(),
    type: 'submit',
    timestamp: Date.now(),
    url: location.href,
    pageTitle: document.title,
    metadata: meta,
  };
}

function buildModalEvent(action: 'open' | 'close', el?: Element): RecordedEvent {
  const meta: ModalMeta = {
    action,
    dialogText: el ? (el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 80)) : undefined,
    selector: el ? resolveElement(el).selector : undefined,
  };
  return {
    id: generateId(),
    type: 'modal',
    timestamp: Date.now(),
    url: location.href,
    pageTitle: document.title,
    metadata: meta,
  };
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
  if (!isRecording || editMode || capturePaused) return;
  const rawTarget = e.target as Element;
  if (!rawTarget || (toolbarHost && toolbarHost.contains(rawTarget))) return;

  const target = resolveClickTarget(rawTarget);
  if (!target) return;

  const info = resolveElement(target);
  if (isDuplicateClick(info.selector, Date.now())) return;

  const needsPrevent = needsPointerdownPrevention(target);
  if (needsPrevent) {
    e.stopPropagation();
    e.preventDefault();
  }

  const capturedEvent = buildClickEvent(target, e, info);
  lastClickSentAt = Date.now();
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
      .then(() => { lastClickSentAt = Date.now(); replayFullChain(target, e); })
      .catch(() => { lastClickSentAt = Date.now(); replayFullChain(target, e); });
  }
}

function handleClick(e: MouseEvent) {
  if (isReplayingClick) return;
  if (!isRecording || editMode) return;
  const rawTarget = e.target as Element;
  if (!rawTarget || (toolbarHost && toolbarHost.contains(rawTarget))) return;

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
      .then(() => { lastClickSentAt = Date.now(); replayClick(target); })
      .catch(() => { lastClickSentAt = Date.now(); replayClick(target); });
    return;
  }

  if (capturePaused) return;

  lastPointerCapture = null;
  const info = resolveElement(target);
  if (isDuplicateClick(info.selector, now)) return;

  const capturedEvent = buildClickEvent(target, e, info);
  lastClickSentAt = Date.now();

  e.preventDefault();
  e.stopPropagation();

  const replayTarget = target;
  safeSendMessage({ type: 'EVENT_CAPTURED', payload: capturedEvent })
    .then(() => { lastClickSentAt = Date.now(); replayClick(replayTarget); })
    .catch(() => { lastClickSentAt = Date.now(); replayClick(replayTarget); });
}

function handleBlur(e: FocusEvent) {
  if (!isRecording || editMode || capturePaused) return;
  const target = e.target as Element;
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;

  const info = resolveElement(target);
  flushPendingInput(info.selector, sendEvent);

  const value = target.value;
  if (!value || value.length === 0) return;

  sendEvent(buildInputEvent(target, info));
}

function handleChange(e: Event) {
  if (!isRecording || editMode || capturePaused) return;
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
  if (!isRecording || editMode || capturePaused) return;
  const form = e.target as HTMLFormElement;
  if (!(form instanceof HTMLFormElement)) return;
  flushAllPending(sendEvent);
  sendEvent(buildSubmitEvent(form));
}

// ── SPA Navigation Detection ──

function checkUrlChange() {
  const currentUrl = location.href;
  if (currentUrl !== lastUrl) {
    const fromUrl = lastUrl;
    lastUrl = currentUrl;
    // Suppress navigate events shortly after a click — the click already captured the action
    if (Date.now() - lastClickSentAt < CLICK_COOLDOWN_MS) return;
    sendEvent(buildNavigateEvent(fromUrl, currentUrl));
  }
}

const HISTORY_PATCHED = '__docext_history_patched';
let savedPushState: typeof history.pushState | null = null;
let savedReplaceState: typeof history.replaceState | null = null;

function patchHistory() {
  if ((history as any)[HISTORY_PATCHED]) return;
  savedPushState = history.pushState;
  savedReplaceState = history.replaceState;
  history.pushState = function (...args) {
    savedPushState!.apply(this, args);
    setTimeout(checkUrlChange, 50);
  };
  history.replaceState = function (...args) {
    savedReplaceState!.apply(this, args);
    setTimeout(checkUrlChange, 50);
  };
  (history as any)[HISTORY_PATCHED] = true;
}

function unpatchHistory() {
  if (savedPushState) history.pushState = savedPushState;
  if (savedReplaceState) history.replaceState = savedReplaceState;
  savedPushState = null;
  savedReplaceState = null;
  delete (history as any)[HISTORY_PATCHED];
}

// ── Modal Detection (MutationObserver) ──

function isModalElement(node: HTMLElement): boolean {
  if (node.tagName === 'DIALOG') return true;
  const role = node.getAttribute('role');
  if (role === 'dialog' || role === 'alertdialog') return true;
  if (node.getAttribute('aria-modal') === 'true') return true;
  if (node.classList.contains('modal') || node.classList.contains('Modal')) return true;

  // Detect overlay-style modals (fixed/absolute position covering viewport)
  try {
    const cs = getComputedStyle(node);
    const isOverlay = (cs.position === 'fixed' || cs.position === 'absolute') &&
      parseInt(cs.zIndex || '0') > 100;
    if (isOverlay && node.offsetWidth > window.innerWidth * 0.5 && node.offsetHeight > window.innerHeight * 0.3) {
      return true;
    }
  } catch { /* detached or cross-origin */ }

  return false;
}

function setupMutationObserver() {
  if (mutationObserver) return;
  mutationObserver = new MutationObserver((mutations) => {
    if (capturePaused) return;
    // Suppress modal events shortly after a click — the click already captured the action
    if (Date.now() - lastClickSentAt < CLICK_COOLDOWN_MS) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (isModalElement(node)) {
          sendEvent(buildModalEvent('open', node));
          return;
        }
        const dialog = node.querySelector('[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"]');
        if (dialog instanceof HTMLElement && isModalElement(dialog)) {
          sendEvent(buildModalEvent('open', dialog));
          return;
        }
      }

      // Detect modals shown via attribute changes (e.g., dialog[open])
      if (mutation.type === 'attributes' && mutation.target instanceof HTMLElement) {
        const target = mutation.target;
        if (mutation.attributeName === 'open' && target.tagName === 'DIALOG' && target.hasAttribute('open')) {
          sendEvent(buildModalEvent('open', target));
        }
      }
    }
  });
  mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
}

// ── Floating Toolbar ──

function createFloatingToolbar() {
  if (toolbarHost) return;

  toolbarHost = document.createElement('div');
  toolbarHost.id = 'docext-toolbar';
  toolbarHost.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:auto;';
  toolbarShadow = toolbarHost.attachShadow({ mode: 'open' });

  toolbarShadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      .bar {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 16px;
        background: #fff;
        border: 1px solid #e2e8f0;
        border-radius: 16px;
        box-shadow: 0 4px 24px rgba(99,102,241,0.12), 0 1px 3px rgba(0,0,0,0.06);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        color: #334155;
        user-select: none;
      }
      .logo { width: 24px; height: 24px; flex-shrink: 0; }
      .rec-dot {
        width: 8px; height: 8px;
        border-radius: 50%;
        background: #ef4444;
        box-shadow: 0 0 0 3px rgba(239,68,68,0.15);
        animation: pulse 1.5s ease-in-out infinite;
        flex-shrink: 0;
      }
      @keyframes pulse {
        0%, 100% { opacity: 1; box-shadow: 0 0 0 3px rgba(239,68,68,0.15); }
        50% { opacity: 0.5; box-shadow: 0 0 0 5px rgba(239,68,68,0.08); }
      }
      .info {
        font-variant-numeric: tabular-nums;
        color: #64748b;
        font-size: 12px;
        font-weight: 500;
        min-width: 90px;
      }
      .sep {
        width: 1px;
        height: 18px;
        background: #e2e8f0;
        flex-shrink: 0;
      }
      button {
        background: #f8fafc;
        color: #475569;
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        padding: 5px 12px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        font-family: inherit;
        transition: all 0.15s;
      }
      button:hover { background: #f1f5f9; border-color: #cbd5e1; }
      button.stop {
        background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
        border-color: transparent;
        color: #fff;
        font-weight: 600;
        box-shadow: 0 2px 8px rgba(239,68,68,0.2);
      }
      button.stop:hover { opacity: 0.9; }
      button.edit-active {
        background: linear-gradient(135deg, #818cf8 0%, #6366f1 100%);
        border-color: transparent;
        color: #fff;
        box-shadow: 0 2px 8px rgba(99,102,241,0.2);
      }
    </style>
    <div class="bar">
      <span class="logo">${LOGO_SVG_HTML}</span>
      <span class="rec-dot"></span>
      <span class="info" id="info">0:00 · 0 actions</span>
      <div class="sep"></div>
      <button id="edit">✎ Edit Page</button>
      <div class="sep"></div>
      <button id="stop" class="stop">■ Stop</button>
    </div>
  `;

  toolbarShadow.getElementById('stop')!.addEventListener('click', () => {
    safeSendMessage({ type: 'STOP_RECORDING' });
  });
  toolbarShadow.getElementById('edit')!.addEventListener('click', () => {
    safeSendMessage({ type: editMode ? 'EXIT_EDIT_MODE' : 'ENTER_EDIT_MODE' });
  });

  document.documentElement.appendChild(toolbarHost);
}

function destroyFloatingToolbar() {
  if (toolbarHost) {
    toolbarHost.remove();
    toolbarHost = null;
    toolbarShadow = null;
  }
}

function updateToolbar(s: RecordingState) {
  if (!toolbarShadow) return;

  const infoEl = toolbarShadow.getElementById('info');
  if (infoEl && s.startedAt) {
    const elapsed = Date.now() - s.startedAt;
    const totalSec = Math.floor(elapsed / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    infoEl.textContent = `${min}:${sec.toString().padStart(2, '0')} · ${s.eventCount} actions`;
  }

  const editBtn = toolbarShadow.getElementById('edit');
  if (editBtn) {
    editBtn.className = s.editMode ? 'edit-active' : '';
    editBtn.textContent = s.editMode ? '✎ Done Editing' : '✎ Edit Page';
  }
}

function startToolbarTimer() {
  if (toolbarTimer) return;
  toolbarTimer = setInterval(() => {
    try {
      chrome.runtime.sendMessage({ type: 'GET_STATE' }, (s: RecordingState) => {
        if (chrome.runtime.lastError) return;
        if (s) updateToolbar(s);
      });
    } catch { /* extension context invalidated */ }
  }, 1000);
}

function stopToolbarTimer() {
  if (toolbarTimer) {
    clearInterval(toolbarTimer);
    toolbarTimer = null;
  }
}

// ── Edit Mode ──

function enterEditMode() {
  editMode = true;
  domSnapshot = new WeakMap();

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    domSnapshot.set(walker.currentNode, walker.currentNode.textContent || '');
  }
  document.addEventListener('click', handleEditClick, true);
  document.addEventListener('keydown', handleEditKeydown, true);
}

function handleEditKeydown(e: KeyboardEvent) {
  if (!editMode || !activeEditable) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    commitActiveEditable();
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (activeEditable.firstChild && domSnapshot.has(activeEditable.firstChild)) {
      activeEditable.textContent = domSnapshot.get(activeEditable.firstChild)!;
    }
    activeEditable.contentEditable = 'false';
    activeEditable.style.outline = '';
    activeEditable = null;
  }
}

function commitActiveEditable() {
  if (!activeEditable) return;
  const info = resolveElement(activeEditable);
  const original = (activeEditable.firstChild ? domSnapshot.get(activeEditable.firstChild) : null) || '';
  const modified = activeEditable.textContent || '';
  if (original !== modified) {
    domEdits.push({ selector: info.selector, original, modified });
    persistedEdits.set(info.selector, modified);
    if (activeEditable.firstChild) {
      domSnapshot.set(activeEditable.firstChild, modified);
    }
  }
  activeEditable.contentEditable = 'false';
  activeEditable.style.outline = '';
  activeEditable = null;
}

const TEXT_LEAF_TAGS = new Set([
  'p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'button', 'label',
  'td', 'th', 'li', 'dt', 'dd', 'figcaption', 'legend', 'summary', 'em',
  'strong', 'b', 'i', 'u', 'small', 'mark', 'del', 'ins', 'sub', 'sup', 'cite',
]);

function findTextTarget(x: number, y: number, clicked: HTMLElement): HTMLElement | null {
  try {
    const range = document.caretRangeFromPoint(x, y);
    if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
      const parent = range.startContainer.parentElement;
      if (parent && parent !== document.body && parent !== document.documentElement) {
        return parent;
      }
    }
  } catch { /* caretRangeFromPoint not supported */ }

  let el: HTMLElement | null = clicked;
  while (el && el !== document.body) {
    if (TEXT_LEAF_TAGS.has(el.tagName.toLowerCase())) return el;
    const text = (el.textContent || '').trim();
    if (text.length > 0 && text.length < 500 && el.children.length <= 2) return el;
    el = el.parentElement as HTMLElement | null;
  }
  return null;
}

function handleEditClick(e: MouseEvent) {
  if (!editMode) return;
  const clicked = e.target as HTMLElement;
  if (!clicked) return;
  if (toolbarHost && (toolbarHost.contains(clicked) || clicked === toolbarHost)) return;

  e.preventDefault();
  e.stopPropagation();

  const target = findTextTarget(e.clientX, e.clientY, clicked);
  if (!target) return;

  if (activeEditable && activeEditable !== target) {
    commitActiveEditable();
  }

  target.contentEditable = 'true';
  target.style.outline = '2px solid #6366f1';
  target.focus();
  activeEditable = target;
}

function exitEditMode() {
  editMode = false;

  if (activeEditable) {
    commitActiveEditable();
  }

  domSnapshot = new WeakMap();
  document.removeEventListener('click', handleEditClick, true);
  document.removeEventListener('keydown', handleEditKeydown, true);
}

// ── Start/Stop Recording ──

const isTopFrame = window === window.top;

function startRecording() {
  if (isRecording) return;
  isRecording = true;
  lastUrl = location.href;
  capturePaused = false;
  lastPointerCapture = null;
  lastClickSentAt = 0;

  document.addEventListener('pointerdown', handlePointerdown, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('blur', handleBlur, true);
  document.addEventListener('change', handleChange, true);
  document.addEventListener('submit', handleSubmit, true);

  if (isTopFrame) {
    window.addEventListener('popstate', checkUrlChange);
    window.addEventListener('hashchange', checkUrlChange);
    patchHistory();
    setupMutationObserver();
    urlObserverInterval = setInterval(checkUrlChange, 500);
    createFloatingToolbar();
    startToolbarTimer();
    startEditGuard();
  }
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;

  if (isTopFrame) {
    stopEditGuard();
    if (editMode) exitEditMode();
  }

  lastPointerCapture = null;
  capturePaused = false;
  document.removeEventListener('pointerdown', handlePointerdown, true);
  document.removeEventListener('click', handleClick, true);
  document.removeEventListener('blur', handleBlur, true);
  document.removeEventListener('change', handleChange, true);
  document.removeEventListener('submit', handleSubmit, true);

  if (isTopFrame) {
    window.removeEventListener('popstate', checkUrlChange);
    window.removeEventListener('hashchange', checkUrlChange);
    unpatchHistory();

    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    if (urlObserverInterval) {
      clearInterval(urlObserverInterval);
      urlObserverInterval = null;
    }

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
      if (toolbarHost) toolbarHost.style.display = 'none';
      sendResponse({ ok: true });
      break;
    case 'SHOW_TOOLBAR':
      if (toolbarHost) toolbarHost.style.display = '';
      sendResponse({ ok: true });
      break;
    case 'GET_STATE':
      sendResponse({ isRecording, editMode });
      break;
  }
  return true;
}
