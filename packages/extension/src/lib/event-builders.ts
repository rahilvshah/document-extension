import type {
  RecordedEvent,
  ClickMeta,
  InputMeta,
  SelectMeta,
  NavigateMeta,
  SubmitMeta,
  ModalMeta,
  ScreenshotMeta,
  DomEdit,
} from '@docext/shared';
import { type ElementInfo } from './element-resolver.js';
import {
  extractElementLayers,
  extractPageFrame,
  extractControl,
  extractDialogCropRect,
  extractDialogCrop,
  computeAccessibleName,
  getElementStates,
  type ExtractOptions,
} from './page-extractor.js';

const SENSITIVE_RE = /password|secret|token|ssn|credit.?card|cvv|pin|social.?security/i;

const TEXT_LIKE_TAGS = new Set([
  'span', 'p', 'label', 'strong', 'em', 'b', 'i', 'small', 'svg', 'path', 'img', 'text',
]);
const CONTROL_ROLES = new Set([
  'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'row',
]);

function isHighlightContainer(node: Element, rect: DOMRect): boolean {
  const role = node.getAttribute('role') || '';
  const tag = node.tagName.toLowerCase();
  if (
    role === 'dialog' || role === 'alertdialog' || role === 'menu' || role === 'listbox' ||
    role === 'navigation' || role === 'complementary' || role === 'presentation'
  ) return true;
  if (tag === 'dialog' || tag === 'nav' || tag === 'aside' || tag === 'main' || tag === 'header') return true;
  if (rect.width > window.innerWidth * 0.92 || rect.height > window.innerHeight * 0.5) return true;
  return false;
}

/** Expand a text or icon hit to the full control row, stopping before dialogs and sidebars. */
function pickBestHighlightTarget(hit: Element): Element {
  const actionable = hit.closest(
    'button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="tab"], [role="treeitem"], [role="link"], a'
  );
  let best: Element = actionable || hit;
  let bestRect = best.getBoundingClientRect();
  const startTag = best.tagName.toLowerCase();
  const startRole = best.getAttribute('role') || '';
  const startIsControl =
    (startTag === 'button' || startTag === 'a' || CONTROL_ROLES.has(startRole)) &&
    bestRect.height >= 24 &&
    bestRect.width >= 48;
  if (startIsControl && !TEXT_LIKE_TAGS.has(startTag)) return best;

  let node: Element | null = best.parentElement;
  let depth = 0;
  while (node && depth < 6) {
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) {
      node = node.parentElement;
      depth++;
      continue;
    }
    if (isHighlightContainer(node, rect)) break;

    const role = node.getAttribute('role') || '';
    const tag = node.tagName.toLowerCase();
    let cursor = '';
    try { cursor = getComputedStyle(node).cursor; } catch { /* detached */ }

    const rowLike =
      rect.height >= 28 &&
      rect.height <= 72 &&
      rect.width >= Math.max(bestRect.width * 1.25, 48) &&
      rect.width <= window.innerWidth * 0.85;
    const isControl = tag === 'button' || tag === 'a' || CONTROL_ROLES.has(role);
    const pointerRow = cursor === 'pointer' && rowLike;
    const textWrap = TEXT_LIKE_TAGS.has(best.tagName.toLowerCase()) && rowLike && rect.width <= window.innerWidth * 0.55;

    if ((isControl && rect.height <= window.innerHeight * 0.35) || pointerRow || textWrap) {
      best = node;
      bestRect = rect;
      if (isControl && rect.height >= 28) break;
      if (pointerRow || textWrap) break;
    }

    node = node.parentElement;
    depth++;
  }

  return best;
}

function highlightRectFor(el: Element, clientX: number, clientY: number): DOMRect {
  // Stay on the control that was clicked. A larger row under the pointer
  // (the next list item, a stretched parent) pulls the box off the label.
  const target = pickBestHighlightTarget(el);
  const rect = target.getBoundingClientRect();
  const containsClick = clientX >= rect.left - 4 && clientX <= rect.right + 4
    && clientY >= rect.top - 4 && clientY <= rect.bottom + 4;
  if (rect.width >= 8 && rect.height >= 8 && rect.width <= window.innerWidth * 0.85 && containsClick) {
    return rect;
  }
  const own = el.getBoundingClientRect();
  return own.width >= 2 && own.height >= 2 ? own : rect;
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function enrichFromLayers(
  el: Element,
  opts?: ExtractOptions,
): {
  accessibleName?: string;
  accessibleDescription?: string;
  states?: ReturnType<typeof getElementStates>;
  parent?: ReturnType<typeof extractElementLayers>['region'] extends infer R
    ? R extends { parent?: infer P } ? P : undefined
    : undefined;
  breadcrumb?: string;
  nearestHeading?: string;
  sectionLabel?: string;
  containerRole?: string;
  pageHeading?: string;
  openOverlays?: string[];
  href?: string;
  target?: string;
  buttonType?: string;
} {
  try {
    const layers = extractElementLayers(el, opts);
    const parent = layers.region?.parent;
    return {
      accessibleName: layers.control.accessibleName || undefined,
      accessibleDescription: layers.control.accessibleDescription,
      states: layers.control.states,
      parent,
      breadcrumb: layers.region?.breadcrumb.length
        ? layers.region.breadcrumb.join(' > ')
        : undefined,
      nearestHeading: layers.region?.nearestHeading,
      sectionLabel: layers.region?.sectionLabel,
      containerRole: layers.region?.containerRole,
      pageHeading: layers.page?.pageHeading,
      openOverlays: layers.page?.openOverlays.length ? layers.page.openOverlays : undefined,
      href: layers.control.href,
      target: layers.control.target,
      buttonType: layers.control.buttonType,
    };
  } catch {
    return {
      accessibleName: computeAccessibleName(el) || undefined,
      states: getElementStates(el),
    };
  }
}

export function buildClickEvent(
  el: Element,
  e: MouseEvent | PointerEvent,
  info: ElementInfo,
  domEdits: DomEdit[],
  opts?: { inEphemeralUI?: boolean; hotPath?: boolean },
): RecordedEvent {
  const highlightRect = highlightRectFor(el, e.clientX, e.clientY);
  const dialog = extractDialogCrop(el);

  const layers = enrichFromLayers(el, { hotPath: opts?.hotPath });
  const accessibleName = layers.accessibleName || info.ariaLabel || info.text || undefined;
  let openOverlays = layers.openOverlays;
  if (!openOverlays) {
    try {
      const names = extractPageFrame().openOverlays;
      openOverlays = names.length ? names : undefined;
    } catch { /* detached */ }
  }

  const meta: ClickMeta = {
    elementTag: info.tag,
    elementText: info.text,
    ariaLabel: info.ariaLabel,
    role: info.role,
    selector: info.selector,
    coordinates: { x: e.clientX, y: e.clientY },
    elementRect: { x: highlightRect.left, y: highlightRect.top, width: highlightRect.width, height: highlightRect.height },
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
    nearestHeading: layers.nearestHeading || info.nearestHeading,
    sectionLabel: layers.sectionLabel || info.sectionLabel,
    containerRole: layers.containerRole || info.containerRole,
    href: layers.href || info.href,
    target: layers.target,
    title: info.title,
    parentText: layers.parent?.text || info.parentText,
    fieldLabel: info.fieldLabel,
    breadcrumb: layers.breadcrumb || info.breadcrumb,
    tooltipText: info.tooltipText,
    inputValue: info.inputValue,
    parentId: info.parentId,
    parentName: layers.parent?.name || info.parentName,
    parent: layers.parent,
    listPosition: info.listPosition,
    nearbyText: info.nearbyText,
    viewportHint: info.viewportHint,
    semanticClasses: info.semanticClasses,
    inEphemeralUI: opts?.inEphemeralUI || undefined,
    scrollPosition: { x: window.scrollX, y: window.scrollY },
    accessibleName,
    accessibleDescription: layers.accessibleDescription,
    states: layers.states,
    pageHeading: layers.pageHeading,
    openOverlays,
    buttonType: layers.buttonType,
    cropRect: dialog?.cropRect,
    dialogName: dialog?.dialogName,
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

export function buildInputEvent(el: Element, info: ElementInfo): RecordedEvent {
  const layers = enrichFromLayers(el);
  const label =
    layers.accessibleName ||
    info.fieldLabel ||
    info.ariaLabel ||
    info.placeholder ||
    info.tag;
  const fieldType = info.fieldType || 'text';
  let value = '';
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    value = el.value;
  }
  if (fieldType === 'password' || SENSITIVE_RE.test(label)) value = '••••••';

  const r = el.getBoundingClientRect();
  const meta: InputMeta = {
    fieldLabel: label,
    fieldType,
    value,
    selector: info.selector,
    placeholder: info.placeholder,
    nearestHeading: layers.nearestHeading || info.nearestHeading,
    sectionLabel: layers.sectionLabel || info.sectionLabel,
    containerRole: layers.containerRole || info.containerRole,
    breadcrumb: layers.breadcrumb || info.breadcrumb,
    elementRect: { x: r.left, y: r.top, width: r.width, height: r.height },
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
    parentId: info.parentId,
    parentName: layers.parent?.name || info.parentName,
    parentText: layers.parent?.text || info.parentText,
    parent: layers.parent,
    listPosition: info.listPosition,
    scrollPosition: { x: window.scrollX, y: window.scrollY },
    tooltipText: info.tooltipText,
    viewportHint: info.viewportHint,
    nearbyText: info.nearbyText,
    semanticClasses: info.semanticClasses,
    accessibleName: layers.accessibleName,
    accessibleDescription: layers.accessibleDescription,
    states: layers.states,
    pageHeading: layers.pageHeading,
    openOverlays: layers.openOverlays,
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

export function buildSelectEvent(el: HTMLSelectElement, info: ElementInfo): RecordedEvent {
  const layers = enrichFromLayers(el);
  const selectedOption = el.options[el.selectedIndex]?.text || el.value;
  const label =
    layers.accessibleName ||
    info.fieldLabel ||
    info.ariaLabel ||
    info.placeholder ||
    'dropdown';
  const r = el.getBoundingClientRect();
  const meta: SelectMeta = {
    fieldLabel: label,
    selectedOption,
    selector: info.selector,
    nearestHeading: layers.nearestHeading || info.nearestHeading,
    sectionLabel: layers.sectionLabel || info.sectionLabel,
    containerRole: layers.containerRole || info.containerRole,
    breadcrumb: layers.breadcrumb || info.breadcrumb,
    elementRect: { x: r.left, y: r.top, width: r.width, height: r.height },
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
    parentId: info.parentId,
    parentName: layers.parent?.name || info.parentName,
    parentText: layers.parent?.text || info.parentText,
    parent: layers.parent,
    listPosition: info.listPosition,
    scrollPosition: { x: window.scrollX, y: window.scrollY },
    tooltipText: info.tooltipText,
    viewportHint: info.viewportHint,
    nearbyText: info.nearbyText,
    semanticClasses: info.semanticClasses,
    accessibleName: layers.accessibleName,
    accessibleDescription: layers.accessibleDescription,
    states: layers.states,
    pageHeading: layers.pageHeading,
    openOverlays: layers.openOverlays,
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

export function buildNavigateEvent(fromUrl: string, toUrl: string): RecordedEvent {
  let pageHeading: string | undefined;
  let openOverlays: string[] | undefined;
  try {
    const frame = extractPageFrame();
    pageHeading = frame.pageHeading;
    openOverlays = frame.openOverlays.length ? frame.openOverlays : undefined;
  } catch { /* ignore */ }
  const meta: NavigateMeta = {
    fromUrl,
    toUrl,
    newTitle: document.title,
    pageHeading,
    openOverlays,
  };
  return {
    id: generateId(),
    type: 'navigate',
    timestamp: Date.now(),
    url: toUrl,
    pageTitle: document.title,
    metadata: meta,
  };
}

export function buildSubmitEvent(form: HTMLFormElement): RecordedEvent {
  const layers = enrichFromLayers(form);
  const r = form.getBoundingClientRect();
  const meta: SubmitMeta = {
    formName: form.name || form.getAttribute('aria-label') || layers.accessibleName || undefined,
    formAction: form.action || undefined,
    fieldCount: form.elements.length,
    nearestHeading: layers.nearestHeading,
    selector: layers.parent ? undefined : undefined,
    elementRect: { x: r.left, y: r.top, width: r.width, height: r.height },
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
    accessibleName: layers.accessibleName,
    parent: layers.parent,
    pageHeading: layers.pageHeading,
    openOverlays: layers.openOverlays,
    breadcrumb: layers.breadcrumb,
  };
  try {
    meta.selector = extractControl(form).selector;
  } catch { /* ignore */ }
  return {
    id: generateId(),
    type: 'submit',
    timestamp: Date.now(),
    url: location.href,
    pageTitle: document.title,
    metadata: meta,
  };
}

export function buildModalEvent(action: 'open' | 'close', el?: Element): RecordedEvent {
  let selector: string | undefined;
  let accessibleName: string | undefined;
  let elementRect: ModalMeta['elementRect'];
  let pageHeading: string | undefined;
  let openOverlays: string[] | undefined;
  let nearestHeading: string | undefined;
  try {
    if (el) {
      const layers = extractElementLayers(el);
      selector = layers.control.selector;
      accessibleName = layers.control.accessibleName || undefined;
      elementRect = layers.control.rect;
      pageHeading = layers.page?.pageHeading;
      openOverlays = layers.page?.openOverlays.length ? layers.page.openOverlays : undefined;
      nearestHeading = layers.region?.nearestHeading;
    } else {
      const frame = extractPageFrame();
      pageHeading = frame.pageHeading;
      openOverlays = frame.openOverlays.length ? frame.openOverlays : undefined;
    }
  } catch { /* detached element */ }
  const meta: ModalMeta = {
    action,
    dialogText:
      accessibleName ||
      (el ? (el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 80)) : undefined),
    selector,
    nearestHeading,
    accessibleName,
    elementRect,
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
    pageHeading,
    openOverlays,
    cropRect: el ? extractDialogCropRect(el) : extractDialogCropRect(),
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

export function buildScreenshotEvent(label?: string): RecordedEvent {
  let pageHeading: string | undefined;
  let openOverlays: string[] | undefined;
  try {
    const frame = extractPageFrame();
    pageHeading = frame.pageHeading;
    openOverlays = frame.openOverlays.length ? frame.openOverlays : undefined;
  } catch { /* ignore */ }
  const meta: ScreenshotMeta = {
    label,
    pageHeading,
    openOverlays,
    skipHighlight: true,
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
    scrollPosition: { x: window.scrollX, y: window.scrollY },
    cropRect: extractDialogCropRect(),
  };
  return {
    id: generateId(),
    type: 'screenshot',
    timestamp: Date.now(),
    url: location.href,
    pageTitle: document.title,
    metadata: meta,
  };
}
