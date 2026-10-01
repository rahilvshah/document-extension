import type {
  AfterOutcome,
  ElementStates,
  ParentContext,
  Rect,
} from '@docext/shared';
import {
  buildSelector,
  getNearestHeading,
  isStrongInteractive,
} from './element-resolver.js';

export interface ControlSnapshot {
  accessibleName: string;
  accessibleDescription?: string;
  role?: string;
  tag: string;
  selector: string;
  states: ElementStates;
  rect: Rect;
  href?: string;
  target?: string;
  buttonType?: string;
  value?: string;
  visible: boolean;
}

export interface RegionSnapshot {
  parent?: ParentContext;
  breadcrumb: string[]; // named regions only
  nearestHeading?: string;
  sectionLabel?: string;
  containerRole?: string;
}

export interface PageFrameSnapshot {
  title: string;
  url: string;
  pageHeading?: string;
  openOverlays: string[];
  currentNav?: string;
  viewportSize: { width: number; height: number };
  scrollPosition: { x: number; y: number };
}

export interface ExtractOptions {
  /** When true, only do hot-path fields (name, rect, selector, states, ephemeral). Skip region/page-frame heavy walks. */
  hotPath?: boolean;
}

const OVERLAY_ROLES = new Set(['dialog', 'alertdialog', 'menu', 'listbox', 'tree']);
const LANDMARK_ROLES = new Set([
  'navigation', 'banner', 'main', 'complementary', 'contentinfo',
  'form', 'search', 'region', 'toolbar', 'menubar', 'tablist',
]);
const SEMANTIC_LANDMARKS: Record<string, string> = {
  nav: 'navigation',
  header: 'banner',
  footer: 'contentinfo',
  main: 'main',
  aside: 'complementary',
  form: 'form',
  section: 'region',
  article: 'article',
};
const SR_ONLY_RE = /\b(sr-only|visually-hidden|screen-reader-only|a11y-hidden|clipped)\b/i;
const NESTED_SKIP_TAGS = new Set(['button', 'a', 'script', 'style', 'noscript', 'template']);
const NESTED_SKIP_ROLES = new Set(['button', 'link', 'tooltip', 'presentation', 'none']);
const REGION_AREA_CAP = 0.45;

function safeGetBoundingRect(el: Element): Rect {
  try {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  } catch {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
}

function isVisible(el: Element): boolean {
  try {
    const html = el as HTMLElement;
    if (html.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  } catch {
    return false;
  }
}

function isHeadingElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return true;
  return el.getAttribute('role') === 'heading';
}

function headingText(el: Element): string | undefined {
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (text && text.length < 80) return text;
  return undefined;
}

function resolveLabelledByText(el: Element): string | undefined {
  const ids = el.getAttribute('aria-labelledby');
  if (!ids) return undefined;
  const parts = ids
    .split(/\s+/)
    .map((id) => {
      try {
        const ref = document.getElementById(id);
        if (!ref) return undefined;
        return visibleNameText(ref) || (ref.textContent || '').replace(/\s+/g, ' ').trim();
      } catch {
        return undefined;
      }
    })
    .filter((t): t is string => Boolean(t));
  if (parts.length === 0) return undefined;
  return parts.join(' ').trim() || undefined;
}

function resolveDescribedByText(el: Element): string | undefined {
  const ids = el.getAttribute('aria-describedby');
  if (!ids) return undefined;
  const parts = ids
    .split(/\s+/)
    .map((id) => {
      try {
        return document.getElementById(id)?.textContent?.replace(/\s+/g, ' ').trim();
      } catch {
        return undefined;
      }
    })
    .filter((t): t is string => Boolean(t));
  if (parts.length === 0) return undefined;
  return parts.join(' ').trim() || undefined;
}

function isSrOnlyClass(el: Element): boolean {
  try {
    return SR_ONLY_RE.test(el.className?.toString?.() || '');
  } catch {
    return false;
  }
}

/** Visible + sr-only text for accessible name; skips nested buttons/tooltips. */
function visibleNameText(el: Element): string {
  let result = '';
  const walk = (node: Node) => {
    if (result.length > 130) return;
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent || '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as Element;
    if (child !== el) {
      const tag = child.tagName.toLowerCase();
      if (NESTED_SKIP_TAGS.has(tag)) return;
      const role = child.getAttribute('role');
      if (role && NESTED_SKIP_ROLES.has(role)) return;
      if (child.getAttribute('aria-hidden') === 'true' && !isSrOnlyClass(child)) return;
      try {
        const style = window.getComputedStyle(child);
        // Include sr-only / visually-hidden; skip truly hidden non-a11y content
        if (style.display === 'none') return;
        if (
          style.visibility === 'hidden' &&
          !isSrOnlyClass(child) &&
          style.position !== 'absolute' &&
          style.clip !== 'rect(0px, 0px, 0px, 0px)' &&
          style.clipPath !== 'inset(100%)'
        ) {
          return;
        }
      } catch {
        /* ignore */
      }
    }
    for (const c of child.childNodes) walk(c);
  };
  walk(el);
  return result.replace(/\s+/g, ' ').trim();
}

function nativeLabelText(el: Element): string | undefined {
  const id = el.getAttribute('id');
  if (id) {
    try {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label) {
        const text = visibleNameText(label) || (label.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
    } catch {
      /* invalid selector */
    }
  }
  const parentLabel = el.closest('label');
  if (parentLabel) {
    try {
      const clone = parentLabel.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('input, select, textarea, button').forEach((c) => c.remove());
      const text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) return text;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function nearbySiblingText(el: Element): string | undefined {
  try {
    const prev = el.previousElementSibling;
    if (prev && !isStrongInteractive(prev)) {
      const t = (prev.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 0 && t.length < 60) return t;
    }
    const next = el.nextElementSibling;
    if (next && !isStrongInteractive(next)) {
      const t = (next.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 0 && t.length < 60) return t;
    }
    // Parent direct text (icon button with sibling span)
    const parent = el.parentElement;
    if (parent) {
      for (const child of parent.children) {
        if (child === el || isStrongInteractive(child)) continue;
        const t = (child.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length > 0 && t.length < 60) return t;
      }
    }
  } catch {
    /* detached */
  }
  return undefined;
}

export function computeAccessibleName(el: Element): string {
  try {
    const labelledBy = resolveLabelledByText(el);
    if (labelledBy) return labelledBy.slice(0, 120);

    const ariaLabel = el.getAttribute('aria-label')?.trim();
    if (ariaLabel) return ariaLabel.slice(0, 120);

    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button' || tag === 'output' || tag === 'meter' || tag === 'progress') {
      const native = nativeLabelText(el);
      if (native) return native.slice(0, 120);
    } else {
      const native = nativeLabelText(el);
      if (native) return native.slice(0, 120);
    }

    const text = visibleNameText(el);
    if (text) return text.length > 120 ? text.slice(0, 119) + '…' : text;

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const ph = el.placeholder?.trim();
      if (ph) return ph.slice(0, 120);
    }

    const title = el.getAttribute('title')?.trim();
    if (title) return title.slice(0, 120);

    const svgTitle = el.querySelector('svg title');
    if (svgTitle) {
      const t = (svgTitle.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t.slice(0, 120);
    }

    if (el instanceof HTMLImageElement && el.alt) {
      return el.alt.slice(0, 120);
    }
    const img = el.querySelector('img[alt]') as HTMLImageElement | null;
    if (img?.alt) return img.alt.slice(0, 120);

    const nearby = nearbySiblingText(el);
    if (nearby) return nearby.slice(0, 120);
  } catch {
    /* detached or cross-origin */
  }
  return '';
}

export function getElementStates(el: Element): ElementStates {
  const states: ElementStates = {};
  try {
    const expanded = el.getAttribute('aria-expanded');
    if (expanded === 'true') states.expanded = true;
    else if (expanded === 'false') states.expanded = false;

    const pressed = el.getAttribute('aria-pressed');
    if (pressed === 'true') states.pressed = true;
    else if (pressed === 'false') states.pressed = false;

    const checkedAttr = el.getAttribute('aria-checked');
    if (checkedAttr === 'true') states.checked = true;
    else if (checkedAttr === 'false') states.checked = false;
    else if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      states.checked = el.checked;
    }

    const selected = el.getAttribute('aria-selected');
    if (selected === 'true') states.selected = true;
    else if (selected === 'false') states.selected = false;

    if (
      el.hasAttribute('disabled') ||
      el.getAttribute('aria-disabled') === 'true' ||
      (el instanceof HTMLInputElement && el.disabled) ||
      (el instanceof HTMLButtonElement && el.disabled) ||
      (el instanceof HTMLSelectElement && el.disabled) ||
      (el instanceof HTMLTextAreaElement && el.disabled)
    ) {
      states.disabled = true;
    }

    const current = el.getAttribute('aria-current');
    if (current && current !== 'false') states.current = current;
  } catch {
    /* detached */
  }
  return states;
}

function regionAreaOk(rect: Rect): boolean {
  try {
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    return (rect.width * rect.height) / (vw * vh) <= REGION_AREA_CAP;
  } catch {
    return true;
  }
}

function namedRegionLabel(el: Element): string | undefined {
  const labelledBy = resolveLabelledByText(el);
  if (labelledBy) return labelledBy.slice(0, 80);
  const aria = el.getAttribute('aria-label')?.trim();
  if (aria) return aria.slice(0, 80);
  return undefined;
}

function childHeadingLabel(el: Element): string | undefined {
  // Only scan direct / shallow children — not large ancestor querySelector
  try {
    for (const child of el.children) {
      if (isHeadingElement(child)) {
        const t = headingText(child);
        if (t) return t;
      }
      for (const grand of child.children) {
        if (isHeadingElement(grand)) {
          const t = headingText(grand);
          if (t) return t;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function toParentContext(el: Element, name: string, landmark?: string): ParentContext | undefined {
  try {
    const rect = safeGetBoundingRect(el);
    if (!regionAreaOk(rect) && rect.width * rect.height > 0) {
      // Still return context without oversized rect
      return {
        selector: buildSelector(el),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || undefined,
        name,
        text: visibleNameText(el).slice(0, 80) || undefined,
        landmark,
      };
    }
    return {
      selector: buildSelector(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || undefined,
      name,
      text: visibleNameText(el).slice(0, 80) || undefined,
      rect: rect.width > 0 || rect.height > 0 ? rect : undefined,
      landmark,
    };
  } catch {
    return undefined;
  }
}

function pointInRect(x: number, y: number, rect: DOMRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function isOpenOverlay(el: Element): boolean {
  try {
    const role = el.getAttribute('role');
    const tag = el.tagName.toLowerCase();
    if (tag === 'dialog') {
      const dlg = el as HTMLDialogElement;
      if (typeof dlg.open === 'boolean') return dlg.open;
      return isVisible(el);
    }
    if (role && OVERLAY_ROLES.has(role)) {
      if (el.getAttribute('aria-hidden') === 'true') return false;
      const hidden = el.getAttribute('data-state');
      if (hidden === 'closed' || hidden === 'hide') return false;
      return isVisible(el);
    }
    // Radix / portal wrappers
    if (
      el.hasAttribute('data-radix-portal') ||
      el.getAttribute('data-state') === 'open' ||
      el.classList.contains('modal') ||
      el.classList.contains('popover-content')
    ) {
      const r = el.getAttribute('role');
      if (r && (OVERLAY_ROLES.has(r) || r === 'presentation')) return isVisible(el);
      if (el.querySelector('[role="dialog"], [role="menu"], [role="listbox"], dialog')) {
        return isVisible(el);
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function overlayName(el: Element): string {
  return (
    namedRegionLabel(el) ||
    childHeadingLabel(el) ||
    el.getAttribute('role') ||
    el.tagName.toLowerCase()
  );
}

function isDialogElement(el: Element): boolean {
  try {
    const role = el.getAttribute('role') || '';
    const tag = el.tagName.toLowerCase();
    if (tag === 'dialog' || role === 'dialog' || role === 'alertdialog') return true;
    if (el.getAttribute('aria-modal') === 'true') return true;
    if (el.hasAttribute('data-radix-dialog-content')) return true;
    return false;
  } catch {
    return false;
  }
}

const GENERIC_DIALOG_NAMES = new Set([
  'dialog',
  'alertdialog',
  'div',
  'section',
  'form',
  'menu',
  'listbox',
  'tooltip',
]);

function usefulDialogName(dialog: Element): string | undefined {
  const name = overlayName(dialog).replace(/\s+/g, ' ').trim();
  if (!name || GENERIC_DIALOG_NAMES.has(name.toLowerCase())) return undefined;
  return name;
}

function isBackdropRect(rect: DOMRect): boolean {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return rect.width >= vw * 0.9 && rect.height >= vh * 0.9;
}

function isOpaqueSurface(el: Element): boolean {
  try {
    const bg = getComputedStyle(el).backgroundColor;
    if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') return false;
    const match = bg.match(/rgba?\(([^)]+)\)/);
    if (!match) return true;
    const parts = match[1].split(',').map((part) => parseFloat(part.trim()));
    if (parts.length === 4 && parts[3] < 0.85) return false;
    return true;
  } catch {
    return false;
  }
}

function unionClientRects(rects: DOMRect[]): DOMRect | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    if (r.width < 80 || r.height < 48) continue;
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  if (!Number.isFinite(left) || right - left < 80 || bottom - top < 80) return null;
  return new DOMRect(left, top, right - left, bottom - top);
}

/** Sidebar + content panes under one modal wrapper, ignoring a stretched empty column. */
function opaquePaneUnion(parent: Element): DOMRect | null {
  const panes: DOMRect[] = [];
  for (const child of Array.from(parent.children)) {
    if (!isVisible(child)) continue;
    const rect = child.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 64 || isBackdropRect(rect)) continue;
    if (isOpaqueSurface(child)) {
      panes.push(rect);
      continue;
    }
    const inner = Array.from(child.children).find((node) => {
      if (!isVisible(node) || !isOpaqueSurface(node)) return false;
      const innerRect = node.getBoundingClientRect();
      return innerRect.width >= 100 && innerRect.height >= 64 && !isBackdropRect(innerRect);
    });
    if (inner) panes.push(inner.getBoundingClientRect());
  }
  if (panes.length < 2) return panes[0] ?? null;
  // Drop a pane that hangs well below the others — that is the empty page slab.
  const shortest = Math.min(...panes.map((pane) => pane.height));
  const fitted = panes.filter((pane) => pane.height <= shortest + 80);
  return unionClientRects(fitted.length >= 2 ? fitted : panes);
}

/** App chrome. A persistent sidebar is not a modal, even when it is an opaque card. */
function isPageChrome(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role') || '';
  if (tag === 'nav' || tag === 'aside' || tag === 'header' || tag === 'main') return true;
  return role === 'navigation' || role === 'complementary' || role === 'banner' || role === 'main';
}

/** Full modal box: the dialog card, or the sidebar and content panes inside a backdrop. */
function modalBounds(shell: Element, dialog: Element | null): DOMRect {
  const dialogRect = dialog?.getBoundingClientRect();
  if (dialog && dialogRect && !isBackdropRect(dialogRect) && dialogRect.width >= 160 && dialogRect.height >= 120) {
    return dialogRect;
  }

  const backdrop = dialog && dialogRect && isBackdropRect(dialogRect) ? dialog : null;
  const backdropUnion = backdrop ? opaquePaneUnion(backdrop) : null;
  if (backdropUnion && !isBackdropRect(backdropUnion)) return backdropUnion;

  let node: Element | null = shell;
  for (let depth = 0; node && depth < 5; depth++) {
    const nodeRect = node.getBoundingClientRect();
    if (isBackdropRect(nodeRect)) {
      const union = opaquePaneUnion(node);
      if (union && !isBackdropRect(union)) return union;
    }
    const parentEl: Element | null = node.parentElement;
    if (!parentEl || parentEl === document.body || parentEl === document.documentElement) break;
    const parentRect = parentEl.getBoundingClientRect();
    const union = opaquePaneUnion(parentEl);
    if (
      union &&
      union.width >= nodeRect.width + 36 &&
      !isBackdropRect(union) &&
      union.height <= window.innerHeight * 0.94
    ) {
      return union;
    }
    if (
      !isBackdropRect(parentRect) &&
      parentRect.width >= nodeRect.width + 48 &&
      parentRect.height <= nodeRect.height + 64 &&
      parentRect.height <= window.innerHeight * 0.94
    ) {
      return parentRect;
    }
    if (isBackdropRect(parentRect)) break;
    node = parentEl;
  }

  return shell.getBoundingClientRect();
}

const DIALOG_SELECTOR =
  'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [data-radix-dialog-content]';

const MENU_SELECTOR =
  '[role="menu"], [role="listbox"], [data-radix-menu-content], [data-radix-dropdown-menu-content]';

/** Persistent left nav. A dropdown that overlaps it is shorter than this. */
function isAppSidebarRect(rect: DOMRect): boolean {
  return rect.left <= 28 && rect.top <= 28 && rect.width <= 420 && rect.height >= window.innerHeight * 0.72;
}

function isModalCardRect(rect: DOMRect): boolean {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (rect.width < 200 || rect.height < 160) return false;
  if (isBackdropRect(rect) || isAppSidebarRect(rect)) return false;
  if (rect.width >= vw * 0.92 && rect.height >= vh * 0.92) return false;
  return (rect.width >= vw * 0.38 && rect.height >= vh * 0.3) || (rect.width >= 520 && rect.height >= 280);
}

function isExplicitMenu(el: Element): boolean {
  const role = el.getAttribute('role') || '';
  return role === 'menu' || role === 'listbox'
    || el.hasAttribute('data-radix-menu-content')
    || el.hasAttribute('data-radix-dropdown-menu-content');
}

function listDialogElements(): Element[] {
  const dialogs: Element[] = [];
  for (const el of document.querySelectorAll(DIALOG_SELECTOR)) {
    if (!isVisible(el) || isPageChrome(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 80) continue;
    dialogs.push(el);
  }
  return dialogs;
}

function largestModalCard(root: Element): Element | null {
  let best: Element | null = null;
  let bestArea = 0;
  const consider = (node: Element) => {
    if (!isVisible(node) || isPageChrome(node)) return;
    const rect = node.getBoundingClientRect();
    if (!isModalCardRect(rect)) return;
    const area = rect.width * rect.height;
    if (area > bestArea) {
      best = node;
      bestArea = area;
    }
  };
  consider(root);
  for (const node of root.querySelectorAll('div, section, form')) consider(node);
  return best;
}

/** Largest real modal on the page, including the card sitting behind a confirm dialog. */
function findBackingModal(): Element | null {
  const dialogs = listDialogElements();
  let best: Element | null = null;
  let bestArea = 0;
  const take = (el: Element | null) => {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (!isModalCardRect(rect)) return;
    const area = rect.width * rect.height;
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  };
  for (const el of dialogs) {
    const rect = el.getBoundingClientRect();
    if (isModalCardRect(rect)) take(el);
    else if (isBackdropRect(rect)) take(largestModalCard(el));
  }
  if (best) return best;
  if (dialogs.length === 0) return null;
  return findVisualModalCard();
}

function findVisualModalCard(): Element | null {
  let best: Element | null = null;
  let bestArea = 0;
  const visit = (el: Element, depth: number) => {
    if (depth > 8) return;
    for (const child of Array.from(el.children)) {
      if (!isVisible(child) || isPageChrome(child)) continue;
      const rect = child.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 160) continue;
      let position = '';
      try { position = getComputedStyle(child).position; } catch { /* detached */ }
      const floating = position === 'fixed' || position === 'absolute' || child.tagName.toLowerCase() === 'dialog';
      if (floating && isModalCardRect(rect)) {
        const area = rect.width * rect.height;
        if (area > bestArea) {
          best = child;
          bestArea = area;
        }
        continue;
      }
      if (rect.width >= 400 && rect.height >= 240) visit(child, depth + 1);
    }
  };
  visit(document.body, 0);
  return best;
}

function rectsOverlap(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right - 8 && a.right > b.left + 8 && a.top < b.bottom - 8 && a.bottom > b.top + 8;
}

function clickBelongsToModal(fromEl: Element | null | undefined, modal: Element): boolean {
  if (!fromEl) return true;
  if (modal.contains(fromEl)) return true;
  const target = fromEl.getBoundingClientRect();
  const modalRect = modal.getBoundingClientRect();
  const cx = target.left + target.width / 2;
  const cy = target.top + target.height / 2;
  return pointInRect(cx, cy, modalRect) || rectsOverlap(target, modalRect);
}

function looksLikeMenuPanel(el: Element): boolean {
  if (!isVisible(el) || isPageChrome(el)) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 160 || rect.height < 88 || rect.width > 480) return false;
  if (rect.height > window.innerHeight * 0.78) return false;
  if (isAppSidebarRect(rect) || isBackdropRect(rect) || isModalCardRect(rect)) return false;
  if (isExplicitMenu(el)) return true;
  const items = el.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="option"], a, button');
  return items.length >= 3 && items.length <= 24;
}

/** Dropdown that contains the click: heading and options, not the page sidebar. */
function findMenuPanel(fromEl: Element, backing: Element | null): Element | null {
  let node: Element | null = fromEl;
  let best: Element | null = null;
  for (let depth = 0; node && node !== document.body && depth < 14; depth++) {
    if (looksLikeMenuPanel(node)) {
      const insideModal = !!backing && backing.contains(node);
      if (!insideModal || isExplicitMenu(node)) best = node;
    }
    const rect = node.getBoundingClientRect();
    if (isAppSidebarRect(rect) || isModalCardRect(rect) || isBackdropRect(rect)) break;
    node = node.parentElement;
  }
  if (best) {
    const parent = best.parentElement;
    if (parent && looksLikeMenuPanel(parent) && (!backing || !backing.contains(parent) || isExplicitMenu(parent))) {
      return parent;
    }
    const parentRect = parent?.getBoundingClientRect();
    const menuRect = best.getBoundingClientRect();
    if (
      parent &&
      parentRect &&
      !isAppSidebarRect(parentRect) &&
      !isBackdropRect(parentRect) &&
      !isModalCardRect(parentRect) &&
      parentRect.width <= menuRect.width + 48 &&
      parentRect.width <= 520 &&
      parentRect.height <= menuRect.height + 180 &&
      parentRect.height >= menuRect.height - 4
    ) {
      return parent;
    }
    return best;
  }

  const anchor = fromEl.getBoundingClientRect();
  const cx = anchor.left + anchor.width / 2;
  const cy = anchor.top + anchor.height / 2;
  let tight: Element | null = null;
  let tightArea = Infinity;
  for (const candidate of document.querySelectorAll(MENU_SELECTOR)) {
    if (!isVisible(candidate) || isPageChrome(candidate)) continue;
    const rect = candidate.getBoundingClientRect();
    if (!pointInRect(cx, cy, rect) || isAppSidebarRect(rect) || isBackdropRect(rect)) continue;
    if (rect.width < 140 || rect.height < 72 || rect.width > 520) continue;
    const area = rect.width * rect.height;
    if (area < tightArea) {
      tight = candidate;
      tightArea = area;
    }
  }
  return tight;
}

function finishCrop(
  rect: DOMRect,
  source: Element,
  kind: 'modal' | 'menu',
): { cropRect: Rect; dialogName?: string } | undefined {
  const pad = kind === 'menu' ? 8 : 14;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(0, rect.left - pad);
  const top = Math.max(0, rect.top - pad);
  const right = Math.min(vw, rect.right + pad);
  const bottom = Math.min(vh, rect.bottom + pad);
  const width = right - left;
  const height = bottom - top;
  if (width < 80 || height < 64) return undefined;
  if (width >= vw * 0.92 && height >= vh * 0.92) return undefined;
  if (kind === 'modal' && !isModalCardRect(new DOMRect(left, top, width, height))) return undefined;
  if (kind === 'menu' && (isAppSidebarRect(new DOMRect(left, top, width, height)) || width > 560)) return undefined;
  return {
    cropRect: { x: left, y: top, width, height },
    dialogName: usefulDialogName(source),
  };
}

/**
 * Crop a stacked confirm to the modal behind it, or a dropdown to its own panel.
 * The app sidebar and the bare page stay full-frame.
 */
export function extractDialogCrop(fromEl?: Element | null): { cropRect: Rect; dialogName?: string } | undefined {
  try {
    const backing = findBackingModal();
    if (fromEl) {
      const menu = findMenuPanel(fromEl, backing);
      if (menu) {
        const cropped = finishCrop(menu.getBoundingClientRect(), menu, 'menu');
        if (cropped) return cropped;
      }
    }
    if (backing && clickBelongsToModal(fromEl, backing)) {
      return finishCrop(modalBounds(backing, backing), backing, 'modal');
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Content box of the open dialog around `fromEl`, or the largest open modal shell. */
export function extractDialogCropRect(fromEl?: Element | null): Rect | undefined {
  return extractDialogCrop(fromEl)?.cropRect;
}

function findOpenDialog(fromEl?: Element | null): Element | null {
  const candidates: Element[] = [];
  const seen = new Set<Element>();

  const push = (el: Element) => {
    if (seen.has(el)) return;
    if (!isDialogElement(el) || !isVisible(el)) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 80 || rect.height < 80) return;
    seen.add(el);
    candidates.push(el);
  };

  if (fromEl) {
    let current: Element | null = fromEl.parentElement;
    let depth = 0;
    while (current && depth < 25) {
      push(current);
      current = current.parentElement;
      depth++;
    }

    const anchor = fromEl.getBoundingClientRect();
    const cx = anchor.left + anchor.width / 2;
    const cy = anchor.top + anchor.height / 2;
    for (const candidate of document.querySelectorAll(DIALOG_SELECTOR)) {
      const rect = candidate.getBoundingClientRect();
      if (!candidate.contains(fromEl) && !pointInRect(cx, cy, rect)) continue;
      push(candidate);
    }
  } else {
    for (const candidate of document.querySelectorAll(DIALOG_SELECTOR)) push(candidate);
  }

  const shells = candidates.filter((el) => !isBackdropRect(el.getBoundingClientRect()));
  const pool = shells.length > 0 ? shells : candidates;
  let best: Element | null = null;
  let bestArea = 0;
  for (const el of pool) {
    const rect = el.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best;
}

function findOpenOverlayContaining(el: Element): Element | null {
  try {
    // Ancestor walk first
    let current: Element | null = el;
    let depth = 0;
    while (current && depth < 20) {
      if (isOpenOverlay(current) && current !== el) return current;
      current = current.parentElement;
      depth++;
    }

    // Portals: find open overlays whose rect contains the control's center
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const candidates = document.querySelectorAll(
      'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-state="open"], [data-radix-portal]',
    );
    for (const candidate of candidates) {
      if (!isOpenOverlay(candidate)) continue;
      if (candidate.contains(el)) return candidate;
      try {
        const cr = candidate.getBoundingClientRect();
        if (cr.width > 0 && cr.height > 0 && pointInRect(cx, cy, cr)) {
          return candidate;
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* detached */
  }
  return null;
}

function findSelectedTabName(tabpanel: Element): string | undefined {
  try {
    const labelledBy = tabpanel.getAttribute('aria-labelledby');
    if (labelledBy) {
      const tab = document.getElementById(labelledBy.split(/\s+/)[0]!);
      if (tab) {
        return computeAccessibleName(tab) || (tab.textContent || '').replace(/\s+/g, ' ').trim() || undefined;
      }
    }
    const id = tabpanel.getAttribute('id');
    if (id) {
      const tab = document.querySelector(`[role="tab"][aria-controls="${CSS.escape(id)}"]`);
      if (tab) {
        return computeAccessibleName(tab) || (tab.textContent || '').replace(/\s+/g, ' ').trim() || undefined;
      }
    }
    const selected = document.querySelector('[role="tab"][aria-selected="true"]');
    if (selected && tabpanel.closest('[role="tabpanel"]') === tabpanel) {
      return computeAccessibleName(selected) || undefined;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function tableContext(el: Element): { name: string; node: Element } | null {
  try {
    const table = el.closest('table, [role="table"], [role="grid"]');
    if (!table) return null;
    const caption = table.querySelector('caption');
    if (caption) {
      const t = (caption.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return { name: t.slice(0, 80), node: table };
    }
    const cell = el.closest('td, th, [role="cell"], [role="gridcell"]');
    if (cell && cell.parentElement) {
      const row = cell.parentElement;
      const idx = Array.from(row.children).indexOf(cell);
      const thead = table.querySelector('thead tr');
      if (thead && idx >= 0) {
        const th = thead.children[idx];
        if (th) {
          const t = (th.textContent || '').replace(/\s+/g, ' ').trim();
          if (t) return { name: t.slice(0, 80), node: th };
        }
      }
      // row header
      const th = row.querySelector('th');
      if (th) {
        const t = (th.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) return { name: t.slice(0, 80), node: th };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function collectNamedBreadcrumb(el: Element): string[] {
  const parts: string[] = [];
  try {
    let current: Element | null = el.parentElement;
    let depth = 0;
    while (current && depth < 12) {
      const tag = current.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') break;

      let label = namedRegionLabel(current);
      if (!label) {
        const role = current.getAttribute('role');
        if (role && (LANDMARK_ROLES.has(role) || OVERLAY_ROLES.has(role))) {
          label = role.charAt(0).toUpperCase() + role.slice(1);
        }
      }
      if (!label && tag in SEMANTIC_LANDMARKS) {
        label = namedRegionLabel(current) || SEMANTIC_LANDMARKS[tag];
        if (label === SEMANTIC_LANDMARKS[tag]) {
          const human = label.charAt(0).toUpperCase() + label.slice(1);
          label = human;
        }
      }
      if (!label && (tag === 'fieldset' || tag === 'dialog' || tag === 'section' || tag === 'article')) {
        label = childHeadingLabel(current) || (tag === 'fieldset'
          ? (current.querySelector(':scope > legend')?.textContent || '').replace(/\s+/g, ' ').trim()
          : undefined) || undefined;
      }

      if (label && !parts.includes(label)) {
        parts.unshift(label);
      }
      current = current.parentElement;
      depth++;
    }
  } catch {
    /* ignore */
  }
  return parts;
}

export function extractControl(el: Element, _opts?: ExtractOptions): ControlSnapshot {
  const tag = el.tagName.toLowerCase();
  const rect = safeGetBoundingRect(el);
  const states = getElementStates(el);
  const role = el.getAttribute('role') || undefined;
  const accessibleName = computeAccessibleName(el);
  const accessibleDescription =
    resolveDescribedByText(el) || el.getAttribute('title')?.trim() || undefined;

  const snap: ControlSnapshot = {
    accessibleName,
    accessibleDescription,
    role,
    tag,
    selector: buildSelector(el),
    states,
    rect,
    visible: isVisible(el),
  };

  try {
    if (tag === 'a' || role === 'link') {
      const a = el as HTMLAnchorElement;
      snap.href = a.href || el.getAttribute('href') || undefined;
      snap.target = a.target || el.getAttribute('target') || undefined;
    }
    if (tag === 'button' || role === 'button') {
      const type = (el as HTMLButtonElement).type || el.getAttribute('type') || undefined;
      if (type) snap.buttonType = type;
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      snap.value = el.type === 'password' ? '••••••' : el.value;
    } else if (el instanceof HTMLSelectElement) {
      snap.value = el.options[el.selectedIndex]?.text || el.value;
    }
  } catch {
    /* detached */
  }

  return snap;
}

export function extractRegion(el: Element): RegionSnapshot {
  const breadcrumb = collectNamedBreadcrumb(el);
  const nearestHeading = getNearestHeading(el);
  let parent: ParentContext | undefined;
  let sectionLabel: string | undefined;
  let containerRole: string | undefined;

  try {
    // 1. Open overlay containing control
    const overlay = findOpenOverlayContaining(el);
    if (overlay) {
      const name = overlayName(overlay);
      parent = toParentContext(overlay, name, overlay.getAttribute('role') || 'dialog');
      sectionLabel = name;
      containerRole = overlay.getAttribute('role') || overlay.tagName.toLowerCase();
      return { parent, breadcrumb, nearestHeading, sectionLabel, containerRole };
    }

    // 2. fieldset → legend
    const fieldset = el.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector(':scope > legend');
      const name =
        (legend?.textContent || '').replace(/\s+/g, ' ').trim() ||
        namedRegionLabel(fieldset) ||
        'fieldset';
      parent = toParentContext(fieldset, name, 'group');
      sectionLabel = name;
      containerRole = 'group';
      return { parent, breadcrumb, nearestHeading, sectionLabel, containerRole };
    }

    // 3. Named landmark
    let current: Element | null = el.parentElement;
    let depth = 0;
    while (current && depth < 12) {
      const role = current.getAttribute('role');
      const tag = current.tagName.toLowerCase();
      const landmark =
        (role && LANDMARK_ROLES.has(role) ? role : undefined) ||
        SEMANTIC_LANDMARKS[tag];
      if (landmark) {
        const name =
          namedRegionLabel(current) ||
          childHeadingLabel(current) ||
          landmark.charAt(0).toUpperCase() + landmark.slice(1);
        if (namedRegionLabel(current) || childHeadingLabel(current) || landmark !== 'main') {
          parent = toParentContext(current, name, landmark);
          sectionLabel = namedRegionLabel(current) || (landmark !== 'main' ? name : undefined);
          containerRole = landmark;
          if (namedRegionLabel(current) || childHeadingLabel(current)) {
            return { parent, breadcrumb, nearestHeading, sectionLabel, containerRole };
          }
          // Keep unnamed main/nav as fallback; continue looking for better region
          if (!parent) parent = toParentContext(current, name, landmark);
        }
      }
      current = current.parentElement;
      depth++;
    }

    // 4. Card/section with child heading
    current = el.parentElement;
    depth = 0;
    while (current && depth < 10) {
      const tag = current.tagName.toLowerCase();
      if (tag === 'section' || tag === 'article' || current.getAttribute('role') === 'group' ||
          /\b(card|panel|tile)\b/i.test(current.className?.toString?.() || '')) {
        const heading = childHeadingLabel(current) || namedRegionLabel(current);
        if (heading) {
          parent = toParentContext(current, heading, tag === 'section' ? 'region' : undefined);
          sectionLabel = heading;
          containerRole = current.getAttribute('role') || tag;
          return { parent, breadcrumb, nearestHeading, sectionLabel, containerRole };
        }
      }
      current = current.parentElement;
      depth++;
    }

    // 5. tabpanel + selected tab name
    const tabpanel = el.closest('[role="tabpanel"]');
    if (tabpanel) {
      const tabName = findSelectedTabName(tabpanel) || namedRegionLabel(tabpanel) || 'Tab panel';
      parent = toParentContext(tabpanel, tabName, 'tabpanel');
      sectionLabel = tabName;
      containerRole = 'tabpanel';
      return { parent, breadcrumb, nearestHeading, sectionLabel, containerRole };
    }

    // 6. table th/caption
    const tableCtx = tableContext(el);
    if (tableCtx) {
      parent = toParentContext(tableCtx.node, tableCtx.name, 'table');
      sectionLabel = tableCtx.name;
      containerRole = 'table';
      return { parent, breadcrumb, nearestHeading, sectionLabel, containerRole };
    }

    // Fallback: use first landmark found during walk if we had one without a name
    if (!parent) {
      current = el.parentElement;
      depth = 0;
      while (current && depth < 10) {
        const role = current.getAttribute('role');
        const tag = current.tagName.toLowerCase();
        const landmark =
          (role && LANDMARK_ROLES.has(role) ? role : undefined) || SEMANTIC_LANDMARKS[tag];
        if (landmark && landmark !== 'main') {
          const name = namedRegionLabel(current) || landmark.charAt(0).toUpperCase() + landmark.slice(1);
          parent = toParentContext(current, name, landmark);
          sectionLabel = namedRegionLabel(current);
          containerRole = landmark;
          break;
        }
        current = current.parentElement;
        depth++;
      }
    }
  } catch {
    /* detached */
  }

  return { parent, breadcrumb, nearestHeading, sectionLabel, containerRole };
}

function listOpenOverlays(): string[] {
  const names: string[] = [];
  try {
    const candidates = document.querySelectorAll(
      'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-state="open"]',
    );
    for (const el of candidates) {
      if (!isOpenOverlay(el)) continue;
      const name = overlayName(el);
      if (name && !names.includes(name)) names.push(name);
    }
  } catch {
    /* ignore */
  }
  return names;
}

function findPageHeading(): string | undefined {
  try {
    const main =
      document.querySelector('main, [role="main"]') || document.body;
    if (!main) return undefined;
    // Prefer visible h1 inside main (shallow-ish: first few h1 matches)
    const h1s = main.querySelectorAll('h1, [role="heading"][aria-level="1"]');
    for (const h of h1s) {
      if (!isVisible(h)) continue;
      const t = headingText(h);
      if (t) return t;
    }
    const anyH1 = document.querySelector('h1');
    if (anyH1 && isVisible(anyH1)) return headingText(anyH1);
  } catch {
    /* ignore */
  }
  return undefined;
}

function findCurrentNav(): string | undefined {
  try {
    const current =
      document.querySelector('[aria-current="page"]') ||
      document.querySelector('nav [aria-current="true"], [role="navigation"] [aria-current="true"]');
    if (!current) return undefined;
    return (
      computeAccessibleName(current) ||
      (current.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) ||
      undefined
    );
  } catch {
    return undefined;
  }
}

export function extractPageFrame(): PageFrameSnapshot {
  let title = '';
  let url = '';
  try {
    title = document.title || '';
    url = location.href;
  } catch {
    /* cross-origin */
  }

  return {
    title,
    url,
    pageHeading: findPageHeading(),
    openOverlays: listOpenOverlays(),
    currentNav: findCurrentNav(),
    viewportSize: {
      width: typeof window !== 'undefined' ? window.innerWidth : 0,
      height: typeof window !== 'undefined' ? window.innerHeight : 0,
    },
    scrollPosition: {
      x: typeof window !== 'undefined' ? window.scrollX : 0,
      y: typeof window !== 'undefined' ? window.scrollY : 0,
    },
  };
}

export function extractElementLayers(
  el: Element,
  opts?: ExtractOptions,
): {
  control: ControlSnapshot;
  region?: RegionSnapshot;
  page?: PageFrameSnapshot;
} {
  const control = extractControl(el, opts);
  if (opts?.hotPath) {
    return { control };
  }
  return {
    control,
    region: extractRegion(el),
    page: extractPageFrame(),
  };
}

export function extractAfterState(
  el: Element | null,
  beforeStates: ElementStates,
  beforeUrl: string,
  beforeOverlays: string[] = [],
): AfterOutcome {
  try {
    let afterUrl = '';
    try {
      afterUrl = location.href;
    } catch {
      /* ignore */
    }

    const afterStates = el && el.isConnected ? getElementStates(el) : {};
    const overlays = listOpenOverlays();
    const heading = findPageHeading();

    if (afterUrl && beforeUrl && afterUrl !== beforeUrl) {
      return {
        outcome: 'navigated',
        states: afterStates,
        newUrl: afterUrl,
        newHeading: heading,
      };
    }

    if (
      beforeStates.expanded === false &&
      afterStates.expanded === true
    ) {
      return { outcome: 'expanded', states: afterStates, openOverlayName: overlays[0] };
    }
    if (
      beforeStates.expanded === true &&
      afterStates.expanded === false
    ) {
      return { outcome: 'collapsed', states: afterStates };
    }

    if (
      (beforeStates.pressed !== undefined &&
        afterStates.pressed !== undefined &&
        beforeStates.pressed !== afterStates.pressed) ||
      (beforeStates.checked !== undefined &&
        afterStates.checked !== undefined &&
        beforeStates.checked !== afterStates.checked) ||
      (beforeStates.selected !== undefined &&
        afterStates.selected !== undefined &&
        beforeStates.selected !== afterStates.selected)
    ) {
      return { outcome: 'toggled', states: afterStates };
    }

    const beforeSet = new Set(
      beforeOverlays.map((n) => n.trim().toLowerCase()).filter(Boolean),
    );
    const newlyOpened = overlays.filter((n) => n.trim() && !beforeSet.has(n.trim().toLowerCase()));
    if (newlyOpened.length > 0) {
      return {
        outcome: 'opened-dialog',
        states: afterStates,
        openOverlayName: newlyOpened[0],
      };
    }

    if (el) {
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type');
      if (tag === 'form' || type === 'submit' || (tag === 'button' && type === 'submit')) {
        return { outcome: 'submitted', states: afterStates, newUrl: afterUrl || undefined };
      }
    }

    return { outcome: 'unknown', states: afterStates, newHeading: heading };
  } catch {
    return { outcome: 'unknown' };
  }
}
