import type {
  RecordedEvent,
  ClickMeta,
  InputMeta,
  SelectMeta,
  NavigateMeta,
  SubmitMeta,
  ModalMeta,
  DomEdit,
} from '@docext/shared';
import { resolveElement, type ElementInfo } from './element-resolver.js';
import { findCropContainer } from './crop-helpers.js';

const SENSITIVE_RE = /password|secret|token|ssn|credit.?card|cvv|pin|social.?security/i;

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function buildClickEvent(
  el: Element,
  e: MouseEvent | PointerEvent,
  info: ElementInfo,
  domEdits: DomEdit[],
): RecordedEvent {
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
    parentId: info.parentId,
    parentName: info.parentName,
    listPosition: info.listPosition,
    nearbyText: info.nearbyText,
    viewportHint: info.viewportHint,
    semanticClasses: info.semanticClasses,
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
    parentId: info.parentId,
    listPosition: info.listPosition,
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
  const selectedOption = el.options[el.selectedIndex]?.text || el.value;
  const label = info.fieldLabel || info.ariaLabel || info.placeholder || 'dropdown';
  const r = el.getBoundingClientRect();
  const cr = findCropContainer(el);
  const meta: SelectMeta = {
    fieldLabel: label,
    selectedOption,
    selector: info.selector,
    nearestHeading: info.nearestHeading,
    sectionLabel: info.sectionLabel,
    containerRole: info.containerRole,
    breadcrumb: info.breadcrumb,
    elementRect: { x: r.left, y: r.top, width: r.width, height: r.height },
    cropRect: { x: cr.x, y: cr.y, width: cr.width, height: cr.height },
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
    parentId: info.parentId,
    listPosition: info.listPosition,
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

export function buildSubmitEvent(form: HTMLFormElement): RecordedEvent {
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

export function buildModalEvent(action: 'open' | 'close', el?: Element): RecordedEvent {
  let selector: string | undefined;
  try {
    if (el) selector = resolveElement(el).selector;
  } catch { /* detached element */ }
  const meta: ModalMeta = {
    action,
    dialogText: el ? (el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 80)) : undefined,
    selector,
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
