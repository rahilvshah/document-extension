import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { exportZip } from '../lib/exporter.js';
import { toStep, sanitizeFilename } from '../lib/mappers.js';
import type { Session } from '@docext/shared';

export const exportRouter = Router();

exportRouter.get('/:id/export', async (req, res) => {
  try {
    const session = await db.query.sessions.findFirst({
      where: eq(schema.sessions.id, req.params.id),
    });
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const stepRows = await db
      .select()
      .from(schema.steps)
      .where(eq(schema.steps.sessionId, req.params.id))
      .orderBy(schema.steps.sortOrder);

    const steps = stepRows.map(toStep);
    const safeName = sanitizeFilename(session.title);

    const exportSession: Session = {
      id: session.id,
      title: session.title,
      startUrl: session.startUrl,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };

    const data = { session: exportSession, steps };
    const buffer = await exportZip(data, 'markdown');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);
    res.send(buffer);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Failed to export' });
  }
});
