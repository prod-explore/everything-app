import type Database from 'better-sqlite3';
import {
  attachConversation,
  dueSchedules,
  finishRun,
  getSchedule,
  hasActiveRun,
  interruptRunning,
  markRan,
  nextRunAfter,
  pruneRuns,
  recordSkipped,
  setNextRun,
  startRun,
  type RunTrigger,
  type Schedule,
  type ScheduleRun,
} from './schedules.js';

/** What a finished scheduled run reports back. */
export interface RunOutcome {
  status: 'done' | 'error';
  conversationId?: string | null;
  /** One line shown in the run history. */
  summary?: string | null;
  error?: string | null;
}

export interface SchedulerDeps {
  db: Database.Database;
  /**
   * Runs one schedule to completion (a chat turn without anybody watching) and resolves when it is over. It must not
   * throw for an ordinary failure: return `status: 'error'`. `attach` links the run to its chat while it is going.
   */
  run: (schedule: Schedule, trigger: RunTrigger, attach: (conversationId: string) => void) => Promise<RunOutcome>;
  /** A schedule or its history changed (the UI refreshes). */
  onChange?: (scheduleId: string) => void;
  now?: () => Date;
  /** How often to look for due schedules. */
  tickMs?: number;
  /** A run missed by more than this (the app was down) is skipped instead of run late. */
  catchUpWindowMs?: number;
  /** Scheduled runs at the same time, across all schedules. */
  maxConcurrent?: number;
  log?: (message: string) => void;
}

export type RunNowResult = { ok: true } | { ok: false; error: string };

/**
 * Looks at the clock and starts what is due. A schedule's next time is moved forward *before* its run starts, so a crash
 * or a slow run can never make the same slot fire twice; a run that is still going when the next slot comes is skipped
 * (and the history says so) rather than stacked.
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly tickMs: number;
  private readonly catchUpWindowMs: number;
  private readonly maxConcurrent: number;

  constructor(private readonly deps: SchedulerDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date());
    this.tickMs = deps.tickMs ?? 30_000;
    this.catchUpWindowMs = deps.catchUpWindowMs ?? 2 * 60 * 60_000;
    this.maxConcurrent = deps.maxConcurrent ?? 2;
  }

  start(): void {
    if (this.timer) return;
    const stale = interruptRunning(this.db, this.now());
    if (stale > 0) this.deps.log?.(`[schedules] ${stale} run(s) were cut off by the last shutdown`);
    const safeTick = () => this.tick().catch(err => this.deps.log?.(`[schedules] tick failed: ${(err as Error).message}`));
    this.timer = setInterval(safeTick, this.tickMs);
    this.timer.unref?.();
    void safeTick();
  }

  /** Stops looking for due schedules. Runs already going are left to finish (the server waits for its turns at shutdown). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Resolves when every scheduled run that is going now has ended. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  async tick(): Promise<void> {
    const now = this.now();
    for (const s of dueSchedules(this.db, now)) {
      const overdueMs = now.getTime() - new Date(s.nextRunAt!).getTime();
      let next: Date | null = null;
      try { next = nextRunAfter(s.cron, s.timezone, now); } catch { /* an unusable stored schedule is left without a next time */ }
      setNextRun(this.db, s.id, next);
      const trigger: RunTrigger = overdueMs > 2 * this.tickMs ? 'catchup' : 'schedule';

      let skip: string | null = null;
      if (hasActiveRun(this.db, s.id)) skip = 'The previous run was still going.';
      else if (overdueMs > this.catchUpWindowMs) skip = 'The app was not running at the time.';
      else if (this.inFlight.size >= this.maxConcurrent) skip = 'Too many scheduled runs were going at once.';

      if (skip) {
        recordSkipped(this.db, s.id, trigger, skip, now);
        this.deps.onChange?.(s.id);
        continue;
      }
      this.launch(s, trigger);
    }
  }

  /** "Run now": starts a run immediately without touching the schedule's timetable. */
  runNow(id: string): RunNowResult {
    const s = getSchedule(this.db, id);
    if (!s) return { ok: false, error: 'No such schedule.' };
    if (hasActiveRun(this.db, id)) return { ok: false, error: 'This schedule is already running.' };
    if (this.inFlight.size >= this.maxConcurrent) return { ok: false, error: 'Other scheduled runs are going; try again in a moment.' };
    this.launch(s, 'manual');
    return { ok: true };
  }

  private launch(s: Schedule, trigger: RunTrigger): void {
    const run: ScheduleRun = startRun(this.db, s.id, trigger, this.now());
    this.deps.onChange?.(s.id);
    const done = (async () => {
      let outcome: RunOutcome;
      try {
        outcome = await this.deps.run(s, trigger, conversationId => {
          attachConversation(this.db, run.id, conversationId);
          this.deps.onChange?.(s.id);
        });
      } catch (err) {
        outcome = { status: 'error', error: (err as Error).message };
      }
      const at = this.now();
      finishRun(this.db, run.id, { status: outcome.status, conversationId: outcome.conversationId ?? null, summary: outcome.summary ?? null, error: outcome.error ?? null }, at);
      markRan(this.db, s.id, at);
      pruneRuns(this.db, s.id);
      this.deps.onChange?.(s.id);
    })().finally(() => this.inFlight.delete(done));
    this.inFlight.add(done);
  }
}
