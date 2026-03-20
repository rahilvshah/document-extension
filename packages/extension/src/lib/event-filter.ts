import type { RecordedEvent } from '@docext/shared';

interface PendingInput {
  selector: string;
  timer: ReturnType<typeof setTimeout>;
  event: RecordedEvent;
}

const DOUBLE_CLICK_MS = 400;
const INPUT_DEBOUNCE_MS = 1500;

let lastClickSelector = '';
let lastClickTime = 0;
const pendingInputs = new Map<string, PendingInput>();

export function isDuplicateClick(selector: string, timestamp: number): boolean {
  if (selector === lastClickSelector && timestamp - lastClickTime < DOUBLE_CLICK_MS) {
    return true;
  }
  lastClickSelector = selector;
  lastClickTime = timestamp;
  return false;
}

export function isRecentClick(timestamp: number): boolean {
  return timestamp - lastClickTime < DOUBLE_CLICK_MS;
}

export function debounceInput(
  event: RecordedEvent,
  selector: string,
  flush: (event: RecordedEvent) => void
): void {
  const existing = pendingInputs.get(selector);
  if (existing) {
    clearTimeout(existing.timer);
  }

  const timer = setTimeout(() => {
    pendingInputs.delete(selector);
    flush(event);
  }, INPUT_DEBOUNCE_MS);

  pendingInputs.set(selector, { selector, timer, event });
}

export function flushPendingInput(selector: string, flush: (event: RecordedEvent) => void): void {
  const existing = pendingInputs.get(selector);
  if (existing) {
    clearTimeout(existing.timer);
    pendingInputs.delete(selector);
    flush(existing.event);
  }
}

export function flushAllPending(flush: (event: RecordedEvent) => void): void {
  for (const [, pending] of pendingInputs) {
    clearTimeout(pending.timer);
    flush(pending.event);
  }
  pendingInputs.clear();
}

export function resetFilters(): void {
  lastClickSelector = '';
  lastClickTime = 0;
  for (const [, pending] of pendingInputs) {
    clearTimeout(pending.timer);
  }
  pendingInputs.clear();
}
