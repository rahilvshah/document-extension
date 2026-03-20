import { v4 as uuid } from 'uuid';
import type {
  RecordedEvent,
  ClickMeta,
  InputMeta,
  SelectMeta,
  NavigateMeta,
  SubmitMeta,
  ModalMeta,
  Step,
} from '@docext/shared';

interface RawStep {
  title: string;
  description: string;
  screenshotId?: string;
  altScreenshotId?: string;
  sourceEventIds: string[];
  timestamp: number;
}

function truncate(text: string, max = 50): string {
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function quote(text: string): string {
  return `"${truncate(text)}"`;
}

function cleanLabel(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function locationHint(meta: { containerRole?: string; sectionLabel?: string; nearestHeading?: string }): string {
  if (meta.sectionLabel) return ` in the ${cleanLabel(meta.sectionLabel)} section`;
  if (meta.containerRole === 'navigation') return ' in the navigation';
  if (meta.containerRole === 'toolbar') return ' in the toolbar';
  if (meta.containerRole === 'dialog') return ' in the dialog';
  if (meta.containerRole === 'menu') return ' from the menu';
  if (meta.containerRole === 'header') return ' in the header';
  if (meta.containerRole === 'footer') return ' in the footer';
  if (meta.containerRole === 'sidebar') return ' in the sidebar';
  if (meta.containerRole === 'form') return ' in the form';
  if (meta.containerRole === 'search') return ' in the search area';
  return '';
}

const SENSITIVE_FIELDS = /password|secret|token|ssn|credit.?card|cvv|pin|social.?security/i;

function bestLabel(m: ClickMeta): string {
  if (m.ariaLabel) return m.ariaLabel;
  if (m.elementText && m.elementText.length > 1 && m.elementText !== m.elementTag) return m.elementText;
  if (m.fieldLabel) return m.fieldLabel;
  if (m.title) return m.title;
  if (m.tooltipText) return m.tooltipText;
  if (m.parentText && m.parentText.length > 1) return m.parentText;
  return '';
}

function titleForClick(m: ClickMeta): string {
  const label = bestLabel(m);
  const loc = locationHint(m);

  if (m.elementTag === 'a' || m.href) {
    if (label) return `Click the ${quote(label)} link${loc}`;
    return `Click a link${loc}`;
  }

  if (m.elementTag === 'button' || m.role === 'button') {
    if (label) return `Click the ${quote(label)} button${loc}`;
    return `Click a button${loc}`;
  }

  if (m.role === 'tab') {
    return `Select the ${quote(label || 'tab')} tab${loc}`;
  }

  if (m.role === 'menuitem' || m.role === 'menuitemcheckbox' || m.role === 'menuitemradio') {
    return `Choose ${quote(label || 'item')} from the menu`;
  }

  if (m.role === 'checkbox' || m.role === 'switch') {
    const fieldHint = m.fieldLabel ? quote(m.fieldLabel) : quote(label || 'option');
    return `Toggle the ${fieldHint} checkbox${loc}`;
  }

  if (m.role === 'radio') {
    const fieldHint = m.fieldLabel ? quote(m.fieldLabel) : quote(label || 'option');
    return `Select the ${fieldHint} option${loc}`;
  }

  if (m.elementTag === 'input' || m.elementTag === 'select' || m.elementTag === 'textarea') {
    const fieldName = m.fieldLabel || m.ariaLabel || m.title || 'field';
    return `Click the ${quote(fieldName)} field${loc}`;
  }

  if (['img', 'svg', 'icon'].includes(m.elementTag)) {
    if (m.ariaLabel) return `Click the ${quote(m.ariaLabel)} icon${loc}`;
    if (m.tooltipText) return `Click the ${quote(m.tooltipText)} icon${loc}`;
    if (m.parentText) return `Click the ${quote(m.parentText)} icon${loc}`;
    if (m.nearestHeading) return `Click an icon near ${quote(m.nearestHeading)}${loc}`;
    return `Click an icon${loc}`;
  }

  if (!label || label === m.elementTag) {
    if (m.nearestHeading) return `Click near ${quote(m.nearestHeading)}${loc}`;
    return `Click an element${loc}`;
  }

  return `Click ${quote(label)}${loc}`;
}

function titleForInput(m: InputMeta, group: RecordedEvent[]): string {
  const rawLabel = m.fieldLabel && m.fieldLabel !== m.selector ? cleanLabel(m.fieldLabel) : '';
  const label = rawLabel || m.placeholder || 'field';
  const loc = locationHint(m);
  const lastEvent = group[group.length - 1];
  const lastMeta = lastEvent.metadata as InputMeta;
  const finalValue = lastMeta.value || m.value;

  if (m.fieldType === 'password' || SENSITIVE_FIELDS.test(label) || SENSITIVE_FIELDS.test(m.selector)) {
    return `Enter a password in the ${quote(label)} field${loc}`;
  }

  if (m.fieldType === 'email' || /email/i.test(label)) {
    if (finalValue && !SENSITIVE_FIELDS.test(finalValue)) return `Enter email ${quote(finalValue)} in the ${quote(label)} field${loc}`;
    return `Enter an email address in the ${quote(label)} field${loc}`;
  }

  if (m.fieldType === 'search' || /search/i.test(label)) {
    if (finalValue) return `Search for ${quote(finalValue)}${loc}`;
    return `Type in the search field${loc}`;
  }

  if (m.fieldType === 'textarea') {
    if (finalValue) {
      const preview = truncate(finalValue, 40);
      return `Type ${quote(preview)} in the ${quote(label)} text area${loc}`;
    }
    return `Type in the ${quote(label)} text area${loc}`;
  }

  if (finalValue) {
    return `Type ${quote(finalValue)} in the ${quote(label)} field${loc}`;
  }

  return `Type in the ${quote(label)} field${loc}`;
}

function titleForSelect(m: SelectMeta): string {
  const label = m.fieldLabel && m.fieldLabel !== m.selector ? cleanLabel(m.fieldLabel) : 'dropdown';
  const loc = locationHint(m);
  return `Select ${quote(m.selectedOption)} from the ${quote(label)} dropdown${loc}`;
}

function titleForNavigate(m: NavigateMeta, isFinal: boolean): string {
  if (isFinal) return 'Final state';
  return !m.fromUrl ? 'Page loaded' : 'Navigate to a new page';
}

function titleForSubmit(m: SubmitMeta): string {
  if (m.formName) {
    return `Submit the ${quote(m.formName)} form`;
  }
  const loc = m.nearestHeading ? ` (${truncate(m.nearestHeading, 30)})` : '';
  return `Submit the form${loc}`;
}

function titleForModal(m: ModalMeta): string {
  if (m.action === 'close') return 'Close the dialog';
  if (m.dialogText) return `A dialog appears: ${quote(m.dialogText)}`;
  return 'A dialog appears';
}

function descriptionForEvent(event: RecordedEvent): string {
  const parts: string[] = [];
  const meta = event.metadata;

  switch (event.type) {
    case 'click': {
      const m = meta as ClickMeta;
      if (m.breadcrumb) parts.push(`Location: ${m.breadcrumb}`);
      if (m.tooltipText && m.tooltipText !== m.ariaLabel) parts.push(`Tooltip: "${truncate(m.tooltipText, 60)}"`);
      const elType = m.role || m.elementTag;
      if (elType && !['div', 'span', 'p'].includes(elType)) parts.push(`Element: <${elType}>`);
      break;
    }
    case 'input': {
      const m = meta as InputMeta;
      if (m.breadcrumb) parts.push(`Location: ${m.breadcrumb}`);
      if (m.placeholder) parts.push(`Placeholder: "${m.placeholder}"`);
      if (m.fieldType && m.fieldType !== 'text') parts.push(`Type: ${m.fieldType}`);
      break;
    }
    case 'select': {
      const m = meta as SelectMeta;
      if (m.breadcrumb) parts.push(`Location: ${m.breadcrumb}`);
      break;
    }
    case 'submit': {
      const m = meta as SubmitMeta;
      if (m.fieldCount > 0) parts.push(`${m.fieldCount} field${m.fieldCount > 1 ? 's' : ''}`);
      break;
    }
    case 'modal': {
      const m = meta as ModalMeta;
      if (m.dialogText) parts.push(truncate(m.dialogText, 80));
      break;
    }
  }

  return parts.join(' · ');
}

function mergeConsecutiveInputs(events: RecordedEvent[]): RecordedEvent[][] {
  const groups: RecordedEvent[][] = [];
  let currentGroup: RecordedEvent[] = [];

  for (const event of events) {
    if (event.type === 'input') {
      const meta = event.metadata as InputMeta;
      if (
        currentGroup.length > 0 &&
        currentGroup[0].type === 'input' &&
        (currentGroup[0].metadata as InputMeta).selector === meta.selector
      ) {
        currentGroup.push(event);
        continue;
      }
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }
    currentGroup = [event];
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[""'']/g, '"').replace(/\s+/g, ' ').trim();
}

export function generateSteps(
  sessionId: string,
  events: RecordedEvent[]
): Step[] {
  if (events.length === 0) return [];

  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const groups = mergeConsecutiveInputs(sorted);

  const rawSteps: RawStep[] = [];
  let prevEvent: RecordedEvent | null = null;
  for (const group of groups) {
    const primaryEvent = group[0];

    if (primaryEvent.type === 'input') {
      const lastMeta = (group[group.length - 1].metadata as InputMeta);
      const finalValue = lastMeta.value || (primaryEvent.metadata as InputMeta).value || '';
      if (finalValue.length === 0) { prevEvent = primaryEvent; continue; }
    }

    if (primaryEvent.type === 'modal' && (primaryEvent.metadata as ModalMeta).action === 'open') {
      if (prevEvent && prevEvent.type === 'click') {
        continue;
      }
    }

    prevEvent = primaryEvent;

    let title: string;
    switch (primaryEvent.type) {
      case 'click':
        title = titleForClick(primaryEvent.metadata as ClickMeta);
        break;
      case 'input':
        title = titleForInput(primaryEvent.metadata as InputMeta, group);
        break;
      case 'select':
        title = titleForSelect(primaryEvent.metadata as SelectMeta);
        break;
      case 'navigate':
        title = titleForNavigate(primaryEvent.metadata as NavigateMeta, primaryEvent.id.startsWith('final-'));
        break;
      case 'submit':
        title = titleForSubmit(primaryEvent.metadata as SubmitMeta);
        break;
      case 'modal':
        title = titleForModal(primaryEvent.metadata as ModalMeta);
        break;
      default:
        title = `Action: ${primaryEvent.type}`;
    }

    const lastEvent = group[group.length - 1];
    const screenshotId = lastEvent.screenshotId ?? primaryEvent.screenshotId;
    const altScreenshotId = lastEvent.altScreenshotId ?? primaryEvent.altScreenshotId;
    const description = descriptionForEvent(primaryEvent);

    rawSteps.push({
      title,
      description,
      screenshotId,
      altScreenshotId,
      sourceEventIds: group.map((e) => e.id),
      timestamp: primaryEvent.timestamp,
    });
  }

  // Deduplicate identical adjacent steps (same normalized title, close timing, redundant screenshots)
  const deduped: RawStep[] = [];
  for (const step of rawSteps) {
    if (deduped.length > 0) {
      const prev = deduped[deduped.length - 1];
      const sameTitleExact = prev.title === step.title;
      const sameTitleNorm = normalizeTitle(prev.title) === normalizeTitle(step.title);
      const timeDiff = Math.abs(step.timestamp - prev.timestamp);
      const bothHaveScreenshots = prev.screenshotId && step.screenshotId;

      if (sameTitleExact && timeDiff < 1000 && !bothHaveScreenshots) {
        prev.sourceEventIds.push(...step.sourceEventIds);
        if (step.screenshotId) prev.screenshotId = step.screenshotId;
        if (step.altScreenshotId) prev.altScreenshotId = step.altScreenshotId;
        continue;
      }

      if (sameTitleNorm && timeDiff < 500 && !bothHaveScreenshots) {
        prev.sourceEventIds.push(...step.sourceEventIds);
        if (step.screenshotId) prev.screenshotId = step.screenshotId;
        if (step.altScreenshotId) prev.altScreenshotId = step.altScreenshotId;
        if (step.title.length > prev.title.length) prev.title = step.title;
        continue;
      }
    }
    deduped.push(step);
  }

  return deduped.map((raw, idx) => ({
    id: uuid(),
    sessionId,
    sortOrder: idx,
    title: raw.title,
    description: raw.description,
    screenshotId: raw.screenshotId,
    altScreenshotId: raw.altScreenshotId,
    sourceEventIds: raw.sourceEventIds,
    isEdited: false,
  }));
}
