import fs from 'fs';
import archiver from 'archiver';
import { Writable } from 'stream';
import type { Step, Session } from '@docext/shared';
import { getScreenshotPath } from './screenshot-store.js';
import { db, schema } from '../db/index.js';
import { inArray } from 'drizzle-orm';

interface ExportData {
  session: Session;
  steps: Step[];
}

export async function exportZip(data: ExportData): Promise<Buffer> {
  const mainImageNameByStep = new Map<number, string>();
  const altImageNameByStep = new Map<number, string>();
  const totalSteps = data.steps.length;
  const padWidth = Math.max(2, String(totalSteps).length);
  for (let i = 0; i < data.steps.length; i++) {
    const stepNo = i + 1;
    const stepLabel = String(stepNo).padStart(padWidth, '0');
    if (data.steps[i].screenshotId) mainImageNameByStep.set(i, `step${stepLabel}-light.webp`);
    if (data.steps[i].altScreenshotId) altImageNameByStep.set(i, `step${stepLabel}-dark.webp`);
  }

  const content = buildMarkdownForZip(data, mainImageNameByStep, altImageNameByStep);

  const idToZipName = new Map<string, string>();
  for (let i = 0; i < data.steps.length; i++) {
    const step = data.steps[i];
    const mainName = mainImageNameByStep.get(i);
    const altName = altImageNameByStep.get(i);
    if (step.screenshotId && mainName) idToZipName.set(step.screenshotId, mainName);
    if (step.altScreenshotId && altName) idToZipName.set(step.altScreenshotId, altName);
  }

  const screenshotIds = [...idToZipName.keys()];
  const screenshotRows = screenshotIds.length > 0
    ? await db
      .select({ id: schema.screenshots.id, filePath: schema.screenshots.filePath })
      .from(schema.screenshots)
      .where(inArray(schema.screenshots.id, screenshotIds))
    : [];

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', reject);
    writable.on('finish', () => resolve(Buffer.concat(chunks)));

    archive.pipe(writable);

    archive.append(content, { name: 'documentation.md' });

    // Add screenshot files with friendly names (step01-light.webp / step01-dark.webp).
    for (const row of screenshotRows) {
      const zipName = idToZipName.get(row.id);
      if (!zipName) continue;
      const fullPath = getScreenshotPath(row.filePath);
      if (fs.existsSync(fullPath)) {
        archive.file(fullPath, {
          name: `screenshots/${zipName}`,
        });
      }
    }

    archive.finalize();
  });
}

function buildMarkdownForZip(
  data: ExportData,
  mainImageNameByStep: Map<number, string>,
  altImageNameByStep: Map<number, string>,
): string {
  const lines: string[] = [];
  lines.push(`# ${data.session.title}`);
  lines.push('');
  lines.push(`> Recorded from [${data.session.startUrl}](${data.session.startUrl})`);
  lines.push(`> Date: ${new Date(data.session.createdAt).toLocaleDateString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (let i = 0; i < data.steps.length; i++) {
    const step = data.steps[i];
    lines.push(`## Step ${i + 1}: ${step.title}`);
    lines.push('');

    if (step.description) {
      lines.push(step.description);
      lines.push('');
    }

    const mainImageName = mainImageNameByStep.get(i);
    if (mainImageName) {
      lines.push(`![Step ${i + 1} - Light](screenshots/${mainImageName})`);
      lines.push('');
    }

    const altImageName = altImageNameByStep.get(i);
    if (altImageName) {
      lines.push(`![Step ${i + 1} - Dark](screenshots/${altImageName})`);
      lines.push('');
    }
  }

  return lines.join('\n');
}
