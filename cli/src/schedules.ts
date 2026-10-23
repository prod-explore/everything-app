import type Database from 'better-sqlite3';
import { Cron } from 'croner';

/**
 * Scheduled agent tasks: a prompt that is run by an agent on a cron schedule, with nobody watching. This file holds the
 * data (two tables, created by migration 2 in db.ts) and everything about *when*; scheduler.ts decides what to start
 * and server.ts knows how to run a turn.
 */

export const MAX_SCHEDULES = 50;
export const MAX_NAME = 80;
export const MAX_PROMPT = 8000;
/** A schedule that fires more often than this would burn through a provider's limit unnoticed. */
export const MIN_INTERVAL_MS = 15 * 60_000;
/** Runs kept per schedule; older rows are removed after each run. */
export const KEEP_RUNS = 100;
/** Most automatic runs a schedule can be limited to, and the longest a run may wait for an approval. */
export const MAX_RUN_LIMIT = 1000;
export const MAX_APPROVAL_WAIT_MIN = 720;
/**
 * Wake-ups: the agent waking itself up later in the same chat (schedule_wakeup). They are schedules too — one time, bound to a
 * chat — but kept apart from the user's own 50: a few per chat, and a chain of them without a word from the user is cut.
 */
export const MAX_WAKEUPS_PER_CHAT = 5;
export const MAX_WAKEUPS = 100;
export const MAX_WAKE_CHAIN = 10;
export const MAX_WAKE_MINUTES = 14 * 24 * 60;
/** How long a wake-up run waits for an approval before it goes on without the call. */
export const WAKE_APPROVAL_WAIT_MIN = 30;

export class ScheduleError extends Error {}

export type RunTrigger = 'schedule' | 'catchup' | 'manual';
export type RunStatus = 'running' | 'done' | 'error' | 'skipped';

export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  /** Model id, or null = the "agents" slot / a free model. */
  model: string | null;
  projectId: string | null;
  /** Without this a run only uses models tagged `free` (the same guard as agents). */
  allowPaid: boolean;
  enabled: boolean;
  /** Stop after this many automatic runs (null = go on). A "Run now" does not count. */
  maxRuns: number | null;
  /** Automatic runs that have started so far. */
  runCount: number;
  /** 0 = a call that needs approval is refused at once and the run goes on; N = the run waits up to N minutes for an answer in Gazeta. */
  approvalWaitMin: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  /** A one-time or limited schedule that has used up its runs: nothing more will happen unless it is edited. */
  finished: boolean;
  /** Set for a wake-up: the chat it continues (null = an ordinary task that starts a fresh chat each time). */
  conversationId: string | null;
  /** Wake-ups only: how many wake-ups in a row led here without a message from the user. */
  chain: number;
  createdAt: string;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  conversationId: string | null;
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  summary: string | null;
  error: string | null;
}

export interface ScheduleInput {
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  model?: string | null;
  projectId?: string | null;
  allowPaid?: boolean;
  enabled?: boolean;
  maxRuns?: number | null;
  approvalWaitMin?: number;
  /** A wake-up of this chat (see MAX_WAKEUPS_PER_CHAT), not a task of its own. */
  conversationId?: string | null;
  chain?: number;
}

// ─── when ────────────────────────────────────────────────────────────────────

const ALIASES = new Set(['@hourly', '@daily', '@midnight', '@weekly', '@monthly']);

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A one-time schedule is written as a local date and time ("2026-10-24T08:30"), read in the schedule's time zone. */
const ONCE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

export function isOnce(expr: string): boolean {
  return ONCE_RE.test(expr.trim());
}

/** The text stored for a schedule: trimmed, and a one-time moment always with seconds. */
export function normalizeCron(expr: string): string {
  const t = expr.trim();
  return isOnce(t) && t.length === 16 ? `${t}:00` : t;
}

function cronOf(expr: string, timezone: string): Cron {
  return new Cron(normalizeCron(expr), { timezone, paused: true });
}

/**
 * Throws a ScheduleError with a sentence for the user when `expr` is not a usable schedule: five fields (or one of the
 * @aliases), a real time zone, something that happens at all, and not more often than every 15 minutes.
 */
export function validateSchedule(expr: string, timezone: string, now: Date = new Date()): void {
  const trimmed = expr.trim();
  if (!validTimezone(timezone)) throw new ScheduleError(`"${timezone}" is not a time zone (use a name such as Europe/Warsaw or UTC).`);
  if (isOnce(trimmed)) {
    let at: Date | null;
    try {
      at = cronOf(trimmed, timezone).nextRun(now);
    } catch (err) {
      throw new ScheduleError(`That is not a valid date and time: ${(err as Error).message}`);
    }
    if (!at) throw new ScheduleError('That moment has already passed. Pick a time in the future.');
    return;
  }
  const fields = trimmed.split(/\s+/);
  if (!ALIASES.has(trimmed.toLowerCase()) && fields.length !== 5) {
    throw new ScheduleError('A schedule has five fields: minute hour day-of-month month day-of-week (for example "30 8 * * 1-5").');
  }
  let runs: Date[];
  try {
    runs = cronOf(trimmed, timezone).nextRuns(2, now);
  } catch (err) {
    throw new ScheduleError(`That is not a valid schedule: ${(err as Error).message}`);
  }
  if (runs.length === 0) throw new ScheduleError('That schedule never happens (for example a day that does not exist in that month).');
  if (runs.length === 2 && runs[1]!.getTime() - runs[0]!.getTime() < MIN_INTERVAL_MS) {
    throw new ScheduleError('That schedule fires more often than every 15 minutes. Pick a calmer one: scheduled runs use up the provider\'s limit.');
  }
}

/** The first moment after `from` the schedule fires, or null when it never does again. */
export function nextRunAfter(expr: string, timezone: string, from: Date): Date | null {
  return cronOf(expr.trim(), timezone).nextRun(from);
}

/** The next `count` moments, for the preview in the form. */
export function upcomingRuns(expr: string, timezone: string, count: number, from: Date = new Date()): Date[] {
  return cronOf(expr.trim(), timezone).nextRuns(count, from);
}

// ─── rows ────────────────────────────────────────────────────────────────────

interface ScheduleDbRow {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  model: string | null;
  project_id: string | null;
  allow_paid: number;
  enabled: number;
  max_runs: number | null;
  run_count: number;
  approval_wait_min: number;
  conversation_id: string | null;
  chain: number;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
}

/** Nothing more is going to happen: a one-time moment that came, or a limit that was reached. */
const isFinished = (r: ScheduleDbRow): boolean =>
  r.enabled === 1 && r.next_run_at === null && (isOnce(r.cron) || (r.max_runs !== null && r.run_count >= r.max_runs));

const toSchedule = (r: ScheduleDbRow): Schedule => ({
  id: r.id,
  name: r.name,
  prompt: r.prompt,
  cron: r.cron,
  timezone: r.timezone,
  model: r.model,
  projectId: r.project_id,
  allowPaid: r.allow_paid === 1,
  enabled: r.enabled === 1,
  maxRuns: r.max_runs,
  runCount: r.run_count,
  approvalWaitMin: r.approval_wait_min,
  nextRunAt: r.next_run_at,
  lastRunAt: r.last_run_at,
  finished: isFinished(r),
  conversationId: r.conversation_id,
  chain: r.chain,
  createdAt: r.created_at,
});

interface RunDbRow {
  id: string;
  schedule_id: string;
  conversation_id: string | null;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  summary: string | null;
  error: string | null;
}

const toRun = (r: RunDbRow): ScheduleRun => ({
  id: r.id,
  scheduleId: r.schedule_id,
  conversationId: r.conversation_id,
  trigger: r.trigger as RunTrigger,
  status: r.status as RunStatus,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  summary: r.summary,
  error: r.error,
});

const iso = (d: Date): string => d.toISOString();

function cleanText(label: string, raw: unknown, max: number): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new ScheduleError(`${label} is required.`);
  const t = raw.trim();
  if (t.length > max) throw new ScheduleError(`${label} is too long (at most ${max} characters).`);
  return t;
}

function cleanLimit(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_RUN_LIMIT) {
    throw new ScheduleError(`The number of runs must be a whole number from 1 to ${MAX_RUN_LIMIT}.`);
  }
  return raw;
}

function cleanWait(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_APPROVAL_WAIT_MIN) {
    throw new ScheduleError(`The wait for an approval must be a whole number of minutes from 0 to ${MAX_APPROVAL_WAIT_MIN}.`);
  }
  return raw;
}

export function getSchedule(db: Database.Database, id: string): Schedule | null {
  const row = db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id) as ScheduleDbRow | undefined;
  return row ? toSchedule(row) : null;
}

export function listSchedules(db: Database.Database): Schedule[] {
  return (db.prepare(`SELECT * FROM schedules ORDER BY created_at, rowid`).all() as ScheduleDbRow[]).map(toSchedule);
}

export function createSchedule(db: Database.Database, input: ScheduleInput, now: Date = new Date()): Schedule {
  const name = cleanText('The name', input.name, MAX_NAME);
  const prompt = cleanText('The task', input.prompt, MAX_PROMPT);
  validateSchedule(input.cron, input.timezone, now);
  const maxRuns = isOnce(input.cron) ? null : cleanLimit(input.maxRuns);
  const approvalWaitMin = cleanWait(input.approvalWaitMin);
  const conversationId = input.conversationId || null;
  if (conversationId) {
    const mine = (db.prepare(`SELECT COUNT(*) AS n FROM schedules WHERE conversation_id = ? AND next_run_at IS NOT NULL`).get(conversationId) as { n: number }).n;
    if (mine >= MAX_WAKEUPS_PER_CHAT) throw new ScheduleError(`This chat already has ${MAX_WAKEUPS_PER_CHAT} wake-ups waiting. Let one of them happen first.`);
    const all = (db.prepare(`SELECT COUNT(*) AS n FROM schedules WHERE conversation_id IS NOT NULL`).get() as { n: number }).n;
    if (all >= MAX_WAKEUPS) throw new ScheduleError(`At most ${MAX_WAKEUPS} wake-ups at once.`);
  } else {
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM schedules WHERE conversation_id IS NULL`).get() as { n: number }).n;
    if (count >= MAX_SCHEDULES) throw new ScheduleError(`At most ${MAX_SCHEDULES} schedules.`);
  }
  const enabled = input.enabled !== false;
  const next = enabled ? nextRunAfter(input.cron, input.timezone, now) : null;
  const row = db
    .prepare(
      `INSERT INTO schedules (name, prompt, cron, timezone, model, project_id, allow_paid, enabled, max_runs, approval_wait_min, conversation_id, chain, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(name, prompt, normalizeCron(input.cron), input.timezone, input.model || null, input.projectId || null, input.allowPaid ? 1 : 0, enabled ? 1 : 0, maxRuns, approvalWaitMin, conversationId, Math.max(0, Math.trunc(input.chain ?? 0)), next ? iso(next) : null) as ScheduleDbRow;
  return toSchedule(row);
}

export type SchedulePatch = Partial<ScheduleInput>;

export function updateSchedule(db: Database.Database, id: string, patch: SchedulePatch, now: Date = new Date()): Schedule | null {
  const cur = getSchedule(db, id);
  if (!cur) return null;
  const merged = {
    name: patch.name !== undefined ? cleanText('The name', patch.name, MAX_NAME) : cur.name,
    prompt: patch.prompt !== undefined ? cleanText('The task', patch.prompt, MAX_PROMPT) : cur.prompt,
    cron: patch.cron !== undefined ? normalizeCron(patch.cron) : cur.cron,
    timezone: patch.timezone !== undefined ? patch.timezone : cur.timezone,
    model: patch.model !== undefined ? patch.model || null : cur.model,
    projectId: patch.projectId !== undefined ? patch.projectId || null : cur.projectId,
    allowPaid: patch.allowPaid !== undefined ? patch.allowPaid === true : cur.allowPaid,
    enabled: patch.enabled !== undefined ? patch.enabled === true : cur.enabled,
    maxRuns: patch.maxRuns !== undefined ? cleanLimit(patch.maxRuns) : cur.maxRuns,
    approvalWaitMin: patch.approvalWaitMin !== undefined ? cleanWait(patch.approvalWaitMin) : cur.approvalWaitMin,
  };
  // A moment in time has no run limit; it simply happens once.
  if (isOnce(merged.cron)) merged.maxRuns = null;
  // Only a changed timetable has to be valid *now* (a one-time moment that has come is allowed to stay as the record of what ran).
  const retimed = patch.cron !== undefined || patch.timezone !== undefined;
  if (retimed || !isOnce(merged.cron)) validateSchedule(merged.cron, merged.timezone, now);
  // A new timetable is a new plan: its run counter starts again.
  const runCount = retimed ? 0 : cur.runCount;
  const exhausted = merged.maxRuns !== null && runCount >= merged.maxRuns;
  // The next run is recomputed when the timing changed or the schedule was switched on or its limit changed; otherwise it stays as it was.
  const retime = retimed || merged.enabled !== cur.enabled || merged.maxRuns !== cur.maxRuns;
  const next = !merged.enabled || exhausted ? null : retime || !cur.nextRunAt ? nextRunAfter(merged.cron, merged.timezone, now) : new Date(cur.nextRunAt);
  db.prepare(
    `UPDATE schedules SET name = ?, prompt = ?, cron = ?, timezone = ?, model = ?, project_id = ?, allow_paid = ?, enabled = ?, max_runs = ?, run_count = ?, approval_wait_min = ?, next_run_at = ? WHERE id = ?`,
  ).run(merged.name, merged.prompt, merged.cron, merged.timezone, merged.model, merged.projectId, merged.allowPaid ? 1 : 0, merged.enabled ? 1 : 0, merged.maxRuns, runCount, merged.approvalWaitMin, next ? iso(next) : null, id);
  return getSchedule(db, id);
}

export function deleteSchedule(db: Database.Database, id: string): boolean {
  return db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id).changes > 0;
}

export function setNextRun(db: Database.Database, id: string, next: Date | null): void {
  db.prepare(`UPDATE schedules SET next_run_at = ? WHERE id = ?`).run(next ? iso(next) : null, id);
}

/** One more automatic run has started (a manual "Run now" is not counted). */
export function countRun(db: Database.Database, id: string): void {
  db.prepare(`UPDATE schedules SET run_count = run_count + 1 WHERE id = ?`).run(id);
}

export function markRan(db: Database.Database, id: string, at: Date): void {
  db.prepare(`UPDATE schedules SET last_run_at = ? WHERE id = ?`).run(iso(at), id);
}

/** Enabled schedules whose time has come. */
export function dueSchedules(db: Database.Database, now: Date): Schedule[] {
  return (db.prepare(`SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at`).all(iso(now)) as ScheduleDbRow[]).map(toSchedule);
}

// ─── runs ────────────────────────────────────────────────────────────────────

export function startRun(db: Database.Database, scheduleId: string, trigger: RunTrigger, now: Date = new Date()): ScheduleRun {
  const row = db
    .prepare(`INSERT INTO schedule_runs (schedule_id, trigger, status, started_at) VALUES (?, ?, 'running', ?) RETURNING *`)
    .get(scheduleId, trigger, iso(now)) as RunDbRow;
  return toRun(row);
}

/** A run that did not happen, with the reason — so the history explains a gap. */
export function recordSkipped(db: Database.Database, scheduleId: string, trigger: RunTrigger, reason: string, now: Date = new Date()): ScheduleRun {
  const row = db
    .prepare(`INSERT INTO schedule_runs (schedule_id, trigger, status, started_at, finished_at, summary) VALUES (?, ?, 'skipped', ?, ?, ?) RETURNING *`)
    .get(scheduleId, trigger, iso(now), iso(now), reason) as RunDbRow;
  return toRun(row);
}

export function finishRun(
  db: Database.Database,
  runId: string,
  r: { status: 'done' | 'error'; conversationId?: string | null; summary?: string | null; error?: string | null },
  now: Date = new Date(),
): void {
  db.prepare(`UPDATE schedule_runs SET status = ?, finished_at = ?, conversation_id = COALESCE(?, conversation_id), summary = ?, error = ? WHERE id = ?`)
    .run(r.status, iso(now), r.conversationId ?? null, r.summary?.slice(0, 600) ?? null, r.error?.slice(0, 600) ?? null, runId);
}

/** Records the chat a running run works in, so the history links to it while it is still going. */
export function attachConversation(db: Database.Database, runId: string, conversationId: string): void {
  db.prepare(`UPDATE schedule_runs SET conversation_id = ? WHERE id = ?`).run(conversationId, runId);
}

export function hasActiveRun(db: Database.Database, scheduleId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM schedule_runs WHERE schedule_id = ? AND status = 'running' LIMIT 1`).get(scheduleId);
}

export function getRun(db: Database.Database, runId: string): ScheduleRun | null {
  const row = db.prepare(`SELECT * FROM schedule_runs WHERE id = ?`).get(runId) as RunDbRow | undefined;
  return row ? toRun(row) : null;
}

export function listRuns(db: Database.Database, scheduleId: string, limit = 20): ScheduleRun[] {
  const n = Math.max(1, Math.min(KEEP_RUNS, Math.trunc(limit) || 20));
  return (db.prepare(`SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?`).all(scheduleId, n) as RunDbRow[]).map(toRun);
}

/** The newest run of each schedule, for the list. */
export function lastRuns(db: Database.Database): Map<string, ScheduleRun> {
  const rows = db
    .prepare(
      `SELECT r.* FROM schedule_runs r
       WHERE r.rowid = (SELECT r2.rowid FROM schedule_runs r2 WHERE r2.schedule_id = r.schedule_id ORDER BY r2.started_at DESC, r2.rowid DESC LIMIT 1)`,
    )
    .all() as RunDbRow[];
  return new Map(rows.map(r => [r.schedule_id, toRun(r)]));
}

/** At startup: a run still marked `running` belongs to a process that no longer exists. */
export function interruptRunning(db: Database.Database, now: Date = new Date()): number {
  return db
    .prepare(`UPDATE schedule_runs SET status = 'error', finished_at = ?, error = 'The app was restarted while this run was going.' WHERE status = 'running'`)
    .run(iso(now)).changes;
}

export function pruneRuns(db: Database.Database, scheduleId: string): void {
  db.prepare(
    `DELETE FROM schedule_runs WHERE schedule_id = ? AND rowid NOT IN
       (SELECT rowid FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?)`,
  ).run(scheduleId, scheduleId, KEEP_RUNS);
}
