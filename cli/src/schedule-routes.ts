import express from 'express';
import type Database from 'better-sqlite3';
import { getProject } from './db.js';
import type { Scheduler } from './scheduler.js';
import {
  ScheduleError,
  createSchedule,
  deleteSchedule,
  getSchedule,
  lastRuns,
  listRuns,
  listSchedules,
  updateSchedule,
  upcomingRuns,
  validateSchedule,
  type ScheduleInput,
  type SchedulePatch,
} from './schedules.js';

export interface ScheduleRoutesDeps {
  db: Database.Database;
  scheduler: Scheduler;
  /** True for an id the model catalog knows (a chat model that can use tools). */
  modelKnown: (modelId: string) => boolean;
  /** A schedule or its settings changed (the UI refreshes). */
  onChange?: (scheduleId: string | null) => void;
}

const isString = (v: unknown): v is string => typeof v === 'string';

/** Reads the fields of a request body that are present and of the right type; a wrong type is a 400, not silently dropped. */
function readFields(body: unknown): SchedulePatch {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: SchedulePatch = {};
  for (const k of ['name', 'prompt', 'cron', 'timezone'] as const) {
    if (b[k] === undefined) continue;
    if (!isString(b[k])) throw new ScheduleError(`"${k}" must be text.`);
    out[k] = b[k] as string;
  }
  for (const k of ['model', 'projectId'] as const) {
    if (b[k] === undefined) continue;
    if (b[k] !== null && !isString(b[k])) throw new ScheduleError(`"${k}" must be text or null.`);
    out[k] = (b[k] as string | null) || null;
  }
  for (const k of ['allowPaid', 'enabled'] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== 'boolean') throw new ScheduleError(`"${k}" must be true or false.`);
    out[k] = b[k] as boolean;
  }
  return out;
}

export function createScheduleRoutes(deps: ScheduleRoutesDeps): express.Router {
  const { db, scheduler } = deps;
  const router = express.Router();

  /** Checks that the model and project a schedule points at exist and may be used unattended. */
  function checkTargets(model: string | null | undefined, projectId: string | null | undefined): void {
    if (model && !deps.modelKnown(model)) throw new ScheduleError(`"${model}" is not a model of this app (pick one from the list).`);
    if (projectId) {
      const project = getProject(db, projectId);
      if (!project) throw new ScheduleError('That project does not exist.');
      if (project.ghost) throw new ScheduleError('A ghost project cannot have scheduled tasks: nothing runs there without you.');
    }
  }

  const fail = (res: express.Response, err: unknown) => {
    if (err instanceof ScheduleError) { res.status(400).json({ error: err.message }); return; }
    throw err;
  };

  router.get('/schedules', (_req, res) => {
    const last = lastRuns(db);
    res.json({ schedules: listSchedules(db).map(s => ({ ...s, lastRun: last.get(s.id) ?? null })) });
  });

  // Declared before "/schedules/:id" so "preview" is not taken for an id.
  router.get('/schedules/preview', (req, res) => {
    const cron = isString(req.query['cron']) ? req.query['cron'] : '';
    const timezone = isString(req.query['timezone']) ? req.query['timezone'] : 'UTC';
    try {
      validateSchedule(cron, timezone);
      res.json({ ok: true, next: upcomingRuns(cron, timezone, 5).map(d => d.toISOString()) });
    } catch (err) {
      if (err instanceof ScheduleError) { res.json({ ok: false, error: err.message }); return; }
      throw err;
    }
  });

  router.post('/schedules', (req, res) => {
    try {
      const f = readFields(req.body);
      checkTargets(f.model, f.projectId);
      const created = createSchedule(db, { timezone: 'UTC', ...f } as ScheduleInput);
      deps.onChange?.(created.id);
      res.status(201).json(created);
    } catch (err) { fail(res, err); }
  });

  router.patch('/schedules/:id', (req, res) => {
    try {
      const f = readFields(req.body);
      checkTargets(f.model, f.projectId);
      const updated = updateSchedule(db, req.params['id']!, f);
      if (!updated) { res.status(404).json({ error: 'No such schedule.' }); return; }
      deps.onChange?.(updated.id);
      res.json(updated);
    } catch (err) { fail(res, err); }
  });

  router.delete('/schedules/:id', (req, res) => {
    const id = req.params['id']!;
    if (!deleteSchedule(db, id)) { res.status(404).json({ error: 'No such schedule.' }); return; }
    deps.onChange?.(id);
    res.json({ ok: true });
  });

  router.post('/schedules/:id/run', (req, res) => {
    const r = scheduler.runNow(req.params['id']!);
    if (!r.ok) { res.status(r.error === 'No such schedule.' ? 404 : 409).json({ error: r.error }); return; }
    res.status(202).json({ ok: true });
  });

  router.get('/schedules/:id/runs', (req, res) => {
    const id = req.params['id']!;
    if (!getSchedule(db, id)) { res.status(404).json({ error: 'No such schedule.' }); return; }
    res.json({ runs: listRuns(db, id, Number(req.query['limit'] ?? 20)) });
  });

  return router;
}
