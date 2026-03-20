import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getScreenshotPath, screenshotExists } from '../lib/screenshot-store.js';

export const screenshotsRouter = Router();

screenshotsRouter.get('/:id', async (req, res) => {
  try {
    const row = await db.query.screenshots.findFirst({
      where: eq(schema.screenshots.id, req.params.id),
    });

    if (!row || !screenshotExists(row.filePath)) {
      res.status(404).json({ error: 'Screenshot not found' });
      return;
    }

    const fullPath = getScreenshotPath(row.filePath);
    res.type('image/webp').sendFile(fullPath);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get screenshot' });
  }
});
