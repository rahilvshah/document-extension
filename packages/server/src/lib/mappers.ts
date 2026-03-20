import type { Step } from '@docext/shared';
import type { schema } from '../db/index.js';

export function toStep(r: typeof schema.steps.$inferSelect): Step {
  return {
    ...r,
    screenshotId: r.screenshotId ?? undefined,
    altScreenshotId: r.altScreenshotId ?? undefined,
    sourceEventIds: JSON.parse(r.sourceEventIds) as string[],
    isEdited: !!r.isEdited,
  };
}

export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  return cleaned.length > 0 ? cleaned : 'export';
}
