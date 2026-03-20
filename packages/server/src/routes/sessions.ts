import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { eq, desc, inArray, count } from 'drizzle-orm';
import multer from 'multer';
import { db, schema } from '../db/index.js';
import { generateSteps } from '../lib/step-generator.js';
import { saveScreenshot, deleteSessionScreenshots } from '../lib/screenshot-store.js';
import { toStep } from '../lib/mappers.js';
import type {
  RecordedEvent,
  CreateSessionRequest,
  BatchEventsRequest,
  UpdateStepsRequest,
  Step,
} from '@docext/shared';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export const sessionsRouter = Router();

// List all sessions with step count via LEFT JOIN
sessionsRouter.get('/', async (_req, res) => {
  try {
    const rows = await db
      .select({
        id: schema.sessions.id,
        title: schema.sessions.title,
        startUrl: schema.sessions.startUrl,
        createdAt: schema.sessions.createdAt,
        updatedAt: schema.sessions.updatedAt,
        stepCount: count(schema.steps.id),
      })
      .from(schema.sessions)
      .leftJoin(schema.steps, eq(schema.sessions.id, schema.steps.sessionId))
      .groupBy(schema.sessions.id)
      .orderBy(desc(schema.sessions.createdAt));

    res.json({ sessions: rows });
  } catch (err) {
    console.error('List sessions error:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// Create a session
sessionsRouter.post('/', async (req, res) => {
  try {
    const body = req.body as CreateSessionRequest;
    const now = Date.now();
    const session = {
      id: uuid(),
      title: body.title || `Recording ${new Date(now).toLocaleString()}`,
      startUrl: body.startUrl || '',
      createdAt: now,
      updatedAt: now,
    };

    await db.insert(schema.sessions).values(session);
    res.status(201).json({ session });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Get a session with steps
sessionsRouter.get('/:id', async (req, res) => {
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

    res.json({ session, steps: stepRows.map(toStep) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// Delete a session
sessionsRouter.delete('/:id', async (req, res) => {
  try {
    const session = await db.query.sessions.findFirst({
      where: eq(schema.sessions.id, req.params.id),
    });
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    deleteSessionScreenshots(req.params.id);
    await db.delete(schema.sessions).where(eq(schema.sessions.id, req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// Update session title
sessionsRouter.patch('/:id', async (req, res) => {
  try {
    const { title } = req.body;
    if (!title) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }

    await db
      .update(schema.sessions)
      .set({ title, updatedAt: Date.now() })
      .where(eq(schema.sessions.id, req.params.id));

    const session = await db.query.sessions.findFirst({
      where: eq(schema.sessions.id, req.params.id),
    });

    res.json({ session });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update session' });
  }
});

// Batch upload events — use COUNT instead of fetching all rows
sessionsRouter.post('/:id/events', async (req, res) => {
  try {
    const { events } = req.body as BatchEventsRequest;
    if (!events || !Array.isArray(events)) {
      res.status(400).json({ error: 'Events array is required' });
      return;
    }

    const [{ value: existingCount }] = await db
      .select({ value: count() })
      .from(schema.events)
      .where(eq(schema.events.sessionId, req.params.id));

    const startOrder = existingCount;

    const rows = events.map((e: RecordedEvent, i: number) => ({
      id: e.id,
      sessionId: req.params.id,
      type: e.type,
      timestamp: e.timestamp,
      url: e.url,
      pageTitle: e.pageTitle,
      metadata: JSON.stringify(e.metadata),
      screenshotId: e.screenshotId ?? null,
      altScreenshotId: e.altScreenshotId ?? null,
      sortOrder: startOrder + i,
    }));

    if (rows.length > 0) {
      await db.insert(schema.events).values(rows);
    }

    await db
      .update(schema.sessions)
      .set({ updatedAt: Date.now() })
      .where(eq(schema.sessions.id, req.params.id));

    res.json({ inserted: rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to upload events' });
  }
});

// Upload screenshot
sessionsRouter.post('/:id/screenshots', upload.single('screenshot'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Screenshot file is required' });
      return;
    }

    const sessionId = req.params.id as string;
    const screenshotId = uuid();
    const filePath = await saveScreenshot(sessionId, screenshotId, req.file.buffer);

    await db.insert(schema.screenshots).values({
      id: screenshotId,
      sessionId,
      filePath,
      createdAt: Date.now(),
    });

    res.status(201).json({ screenshotId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to upload screenshot' });
  }
});

// Finalize session: generate steps from events
sessionsRouter.post('/:id/finalize', async (req, res) => {
  try {
    const eventRows = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.sessionId, req.params.id))
      .orderBy(schema.events.sortOrder);

    const events: RecordedEvent[] = eventRows.map((r) => ({
      id: r.id,
      type: r.type as RecordedEvent['type'],
      timestamp: r.timestamp,
      url: r.url,
      pageTitle: r.pageTitle,
      screenshotId: r.screenshotId ?? undefined,
      altScreenshotId: r.altScreenshotId ?? undefined,
      metadata: JSON.parse(r.metadata),
    }));

    await db.delete(schema.steps).where(eq(schema.steps.sessionId, req.params.id));

    const steps = generateSteps(req.params.id, events);

    if (steps.length > 0) {
      await db.insert(schema.steps).values(
        steps.map((s) => ({
          ...s,
          sourceEventIds: JSON.stringify(s.sourceEventIds),
          isEdited: s.isEdited,
        }))
      );
    }

    await db
      .update(schema.sessions)
      .set({ updatedAt: Date.now() })
      .where(eq(schema.sessions.id, req.params.id));

    res.json({ steps });
  } catch (err) {
    console.error('Finalize error:', err);
    res.status(500).json({ error: 'Failed to finalize session' });
  }
});

// Update steps (reorder, edit text, delete) — batch operations
sessionsRouter.put('/:id/steps', async (req, res) => {
  try {
    const { steps, deletedStepIds } = req.body as UpdateStepsRequest;

    // Batch delete with inArray
    if (deletedStepIds && deletedStepIds.length > 0) {
      await db.delete(schema.steps).where(inArray(schema.steps.id, deletedStepIds));
    }

    // Batch updates (still individual but unavoidable without raw SQL)
    if (steps && steps.length > 0) {
      for (const step of steps) {
        await db
          .update(schema.steps)
          .set({
            sortOrder: step.sortOrder,
            title: step.title,
            description: step.description,
            isEdited: true,
          })
          .where(eq(schema.steps.id, step.id));
      }
    }

    await db
      .update(schema.sessions)
      .set({ updatedAt: Date.now() })
      .where(eq(schema.sessions.id, req.params.id));

    const updatedSteps = await db
      .select()
      .from(schema.steps)
      .where(eq(schema.steps.sessionId, req.params.id))
      .orderBy(schema.steps.sortOrder);

    res.json({ steps: updatedSteps.map(toStep) });
  } catch (err) {
    console.error('Update steps error:', err);
    res.status(500).json({ error: 'Failed to update steps' });
  }
});
