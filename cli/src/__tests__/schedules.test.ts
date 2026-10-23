import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, runMigrations, createConversation } from '../db.js';
import {
  KEEP_RUNS, MAX_SCHEDULES, ScheduleError, createSchedule, deleteSchedule, dueSchedules, finishRun, getSchedule, hasActiveRun, interruptRunning,
  lastRuns, listRuns, nextRunAfter, pruneRuns, recordSkipped, setNextRun, startRun, updateSchedule, upcomingRuns, validateSchedule,
} from '../schedules.js';

const fresh = () => {
  const db = openDb(':memory:');
  runMigrations(db);
  return db;
};
const base = { name: 'Stocks', prompt: 'Report AAPL and MSFT.', cron: '30 8 * * 1-5', timezone: 'Europe/Warsaw' };
// Friday 2026-10-23, 10:00 in Warsaw (08:00Z).
const FRI = new Date('2026-10-23T08:00:00Z');

describe('validateSchedule', () => {
  it('accepts five fields and the @aliases', () => {
    for (const cron of ['30 8 * * 1-5', '0 */2 * * *', '@daily', '@weekly', '15 6 1 * *']) validateSchedule(cron, 'UTC', FRI);
  });

  it('explains what is wrong in a sentence', () => {
    assert.throws(() => validateSchedule('* * *', 'UTC', FRI), /five fields/);
    assert.throws(() => validateSchedule('0 0 8 * * *', 'UTC', FRI), /five fields/); // six fields (seconds) are not offered
    assert.throws(() => validateSchedule('61 8 * * *', 'UTC', FRI), ScheduleError);
    assert.throws(() => validateSchedule('0 8 * * *', 'Mars/Olympus', FRI), /not a time zone/);
    assert.throws(() => validateSchedule('0 0 30 2 *', 'UTC', FRI), /never happens/);
  });

  it('refuses anything that fires more often than every 15 minutes', () => {
    assert.throws(() => validateSchedule('* * * * *', 'UTC', FRI), /every 15 minutes/);
    assert.throws(() => validateSchedule('*/10 * * * *', 'UTC', FRI), /every 15 minutes/);
    validateSchedule('*/15 * * * *', 'UTC', FRI);
  });
});

describe('next run times', () => {
  it('follow the time zone, including the switch to winter time on 2026-10-25', () => {
    // 08:30 in Warsaw: UTC+2 until Sunday 25 Oct, UTC+1 after.
    assert.equal(nextRunAfter('30 8 * * *', 'Europe/Warsaw', new Date('2026-10-24T05:00:00Z'))!.toISOString(), '2026-10-24T06:30:00.000Z');
    assert.equal(nextRunAfter('30 8 * * *', 'Europe/Warsaw', new Date('2026-10-24T07:00:00Z'))!.toISOString(), '2026-10-25T07:30:00.000Z');
  });

  it('weekday schedules skip the weekend', () => {
    // After Friday 08:30 the next weekday slot is Monday.
    assert.equal(nextRunAfter('30 8 * * 1-5', 'Europe/Warsaw', new Date('2026-10-23T07:00:00Z'))!.toISOString(), '2026-10-26T07:30:00.000Z');
  });

  it('upcomingRuns lists several', () => {
    const next = upcomingRuns('0 9 * * *', 'UTC', 3, FRI).map(d => d.toISOString());
    assert.deepEqual(next, ['2026-10-23T09:00:00.000Z', '2026-10-24T09:00:00.000Z', '2026-10-25T09:00:00.000Z']);
  });
});

describe('schedules', () => {
  it('create stores the schedule with its next run; disabled ones have none', () => {
    const db = fresh();
    const a = createSchedule(db, base, FRI);
    assert.equal(a.enabled, true);
    assert.equal(a.nextRunAt, '2026-10-26T07:30:00.000Z'); // Friday 08:30 Warsaw has passed; Monday 08:30 is already winter time (UTC+1)
    assert.equal(a.allowPaid, false);
    assert.equal(a.model, null);
    const b = createSchedule(db, { ...base, name: 'Off', enabled: false }, FRI);
    assert.equal(b.nextRunAt, null);
  });

  it('rejects an empty or oversized name and task, and a bad schedule', () => {
    const db = fresh();
    assert.throws(() => createSchedule(db, { ...base, name: '  ' }, FRI), /name is required/);
    assert.throws(() => createSchedule(db, { ...base, prompt: 'x'.repeat(8001) }, FRI), /too long/);
    assert.throws(() => createSchedule(db, { ...base, cron: '* * * * *' }, FRI), /every 15 minutes/);
  });

  it('caps how many there can be', () => {
    const db = fresh();
    for (let i = 0; i < MAX_SCHEDULES; i++) createSchedule(db, { ...base, name: `s${i}` }, FRI);
    assert.throws(() => createSchedule(db, base, FRI), /At most/);
  });

  it('update recomputes the next run when the timing or the on/off state changes, and keeps it otherwise', () => {
    const db = fresh();
    const s = createSchedule(db, base, FRI);
    const renamed = updateSchedule(db, s.id, { name: 'Renamed' }, new Date('2026-10-24T12:00:00Z'))!;
    assert.equal(renamed.nextRunAt, s.nextRunAt);
    const retimed = updateSchedule(db, s.id, { cron: '0 20 * * *' }, FRI)!;
    assert.equal(retimed.nextRunAt, '2026-10-23T18:00:00.000Z');
    const off = updateSchedule(db, s.id, { enabled: false }, FRI)!;
    assert.equal(off.nextRunAt, null);
    const on = updateSchedule(db, s.id, { enabled: true }, FRI)!;
    assert.equal(on.nextRunAt, '2026-10-23T18:00:00.000Z');
    assert.throws(() => updateSchedule(db, s.id, { cron: 'nope' }, FRI), ScheduleError);
    assert.equal(updateSchedule(db, 'missing', { name: 'x' }, FRI), null);
  });

  it('dueSchedules returns enabled schedules whose time has come, oldest first', () => {
    const db = fresh();
    const a = createSchedule(db, { ...base, name: 'a' }, FRI);
    const b = createSchedule(db, { ...base, name: 'b' }, FRI);
    const off = createSchedule(db, { ...base, name: 'off', enabled: false }, FRI);
    setNextRun(db, a.id, new Date('2026-10-23T09:00:00Z'));
    setNextRun(db, b.id, new Date('2026-10-23T08:30:00Z'));
    setNextRun(db, off.id, new Date('2026-10-23T08:00:00Z'));
    assert.deepEqual(dueSchedules(db, new Date('2026-10-23T09:30:00Z')).map(s => s.name), ['b', 'a']);
    assert.deepEqual(dueSchedules(db, new Date('2026-10-23T08:45:00Z')).map(s => s.name), ['b']);
  });

  it('deleting a schedule removes its runs but keeps the chats they made', () => {
    const db = fresh();
    const s = createSchedule(db, base, FRI);
    const conv = createConversation(db, { title: 'from a run' }).id;
    const run = startRun(db, s.id, 'schedule');
    finishRun(db, run.id, { status: 'done', conversationId: conv });
    assert.equal(deleteSchedule(db, s.id), true);
    assert.equal(listRuns(db, s.id).length, 0);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE id = ?`).get(conv) as { n: number }).n, 1);
    assert.equal(deleteSchedule(db, s.id), false);
  });
});

describe('runs', () => {
  it('track a run from start to finish, newest first', () => {
    const db = fresh();
    const s = createSchedule(db, base, FRI);
    const r1 = startRun(db, s.id, 'schedule', new Date('2026-10-23T08:00:00Z'));
    assert.equal(hasActiveRun(db, s.id), true);
    finishRun(db, r1.id, { status: 'done', summary: 'AAPL up' }, new Date('2026-10-23T08:01:00Z'));
    assert.equal(hasActiveRun(db, s.id), false);
    const r2 = startRun(db, s.id, 'manual', new Date('2026-10-23T09:00:00Z'));
    finishRun(db, r2.id, { status: 'error', error: 'boom' }, new Date('2026-10-23T09:01:00Z'));
    const runs = listRuns(db, s.id);
    assert.deepEqual(runs.map(r => [r.trigger, r.status]), [['manual', 'error'], ['schedule', 'done']]);
    assert.equal(runs[1]!.summary, 'AAPL up');
    assert.equal(lastRuns(db).get(s.id)!.id, r2.id);
  });

  it('a skipped run is recorded with its reason and counts as not running', () => {
    const db = fresh();
    const s = createSchedule(db, base, FRI);
    const r = recordSkipped(db, s.id, 'schedule', 'The app was not running at the time.');
    assert.equal(r.status, 'skipped');
    assert.equal(r.summary, 'The app was not running at the time.');
    assert.equal(hasActiveRun(db, s.id), false);
  });

  it('a run left "running" by a restart is closed as an error', () => {
    const db = fresh();
    const s = createSchedule(db, base, FRI);
    startRun(db, s.id, 'schedule');
    assert.equal(interruptRunning(db), 1);
    const [r] = listRuns(db, s.id);
    assert.equal(r!.status, 'error');
    assert.match(r!.error!, /restarted/);
    assert.equal(interruptRunning(db), 0);
  });

  it('only the newest KEEP_RUNS are kept', () => {
    const db = fresh();
    const s = createSchedule(db, base, FRI);
    for (let i = 0; i < KEEP_RUNS + 5; i++) recordSkipped(db, s.id, 'schedule', `r${i}`, new Date(Date.UTC(2026, 9, 1, 0, i)));
    pruneRuns(db, s.id);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM schedule_runs WHERE schedule_id = ?`).get(s.id) as { n: number }).n, KEEP_RUNS);
    assert.equal(listRuns(db, s.id, 1)[0]!.summary, `r${KEEP_RUNS + 4}`);
  });
});

describe('getSchedule', () => {
  it('is null for an unknown id', () => {
    assert.equal(getSchedule(fresh(), 'nope'), null);
  });
});
