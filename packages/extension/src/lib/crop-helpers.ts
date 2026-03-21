export const SECTION_TAGS = new Set([
  'section', 'article', 'aside', 'nav', 'main', 'header', 'footer',
  'form', 'dialog', 'details', 'fieldset', 'figure', 'table',
]);

export const SECTION_ROLES = new Set([
  'dialog', 'navigation', 'complementary', 'region', 'toolbar',
  'tabpanel', 'group', 'list', 'listbox', 'menu', 'menubar',
  'banner', 'contentinfo', 'form', 'search', 'alertdialog',
]);

export function findCropContainer(el: Element): DOMRect {
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
    if (bigEnough && !best) best = rect;
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
