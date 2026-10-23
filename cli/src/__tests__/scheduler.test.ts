import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, runMigrations, createConversation } from '../db.js';
import { Scheduler, type RunOutcome } from '../scheduler.js';
import { createSchedule, getSchedule, hasActiveRun, listRuns, setNextRun, startRun, type RunTrigger, type Schedule } from '../schedules.js';

const T0 = new Date('2026-10-23T08:00:00Z');
const base = { name: 'Stocks', prompt: 'Report.', cron: '0 9 * * *', timezone: 'UTC' };

function setup(opts: { maxConcurrent?: number; outcome?: (s: Schedule) => Promise<RunOutcome> } = {}) {
  const db = openDb(':memory:');
  runMigrations(db);
  let clock = T0;
  const started: Array<{ name: string; trigger: RunTrigger }> = [];
  const convs = new Map<string, string>();
  const changed: string[] = [];
  const scheduler = new Scheduler({
    db,
    now: () => clock,
    maxConcurrent: opts.maxConcurrent,
    onChange: id => changed.push(id),
    run: (s, trigger, attach) => {
      started.push({ name: s.name, trigger });
      const conv = createConversation(db, { title: s.name }).id;
      convs.set(s.name, conv);
      attach(conv);
      return opts.outcome ? opts.outcome(s) : Promise.resolve({ status: 'done', conversationId: conv, summary: 'ok' });
    },
  });
  return { db, scheduler, started, convs, changed, at: (iso: string) => { clock = new Date(iso); } };
}

describe('Scheduler', () => {
  it('starts what is due, moves the next time forward first, and records the outcome', async () => {
    const t = setup();
    const s = createSchedule(t.db, base, T0); // next: today 09:00Z
    assert.equal(s.nextRunAt, '2026-10-23T09:00:00.000Z');
    t.at('2026-10-23T09:00:10Z');
    await t.scheduler.tick();
    await t.scheduler.idle();
    assert.deepEqual(t.started, [{ name: 'Stocks', trigger: 'schedule' }]);
    const after = getSchedule(t.db, s.id)!;
    assert.equal(after.nextRunAt, '2026-10-24T09:00:00.000Z');
    assert.equal(after.lastRunAt, '2026-10-23T09:00:10.000Z');
    const [run] = listRuns(t.db, s.id);
    assert.equal(run!.status, 'done');
    assert.equal(run!.conversationId, t.convs.get('Stocks'));
    assert.equal(run!.summary, 'ok');
    assert.ok(t.changed.includes(s.id));
    // Nothing more is due: a second look does not start it again.
    await t.scheduler.tick();
    assert.equal(t.started.length, 1);
  });

  it('does nothing before the time, and never for a disabled schedule', async () => {
    const t = setup();
    createSchedule(t.db, base, T0);
    createSchedule(t.db, { ...base, name: 'off', enabled: false }, T0);
    t.at('2026-10-23T08:59:00Z');
    await t.scheduler.tick();
    t.at('2026-10-23T09:30:00Z');
    await t.scheduler.tick();
    await t.scheduler.idle();
    assert.deepEqual(t.started.map(s => s.name), ['Stocks']);
  });

  it('a run that failed is recorded as an error with its message', async () => {
    const t = setup({ outcome: async () => ({ status: 'error', error: 'model is down' }) });
    const s = createSchedule(t.db, base, T0);
    t.at('2026-10-23T09:00:05Z');
    await t.scheduler.tick();
    await t.scheduler.idle();
    const [run] = listRuns(t.db, s.id);
    assert.deepEqual([run!.status, run!.error], ['error', 'model is down']);
  });

  it('a run that throws is an error too, never a crash', async () => {
    const t = setup({ outcome: async () => { throw new Error('exploded'); } });
    const s = createSchedule(t.db, base, T0);
    t.at('2026-10-23T09:00:05Z');
    await t.scheduler.tick();
    await t.scheduler.idle();
    assert.equal(listRuns(t.db, s.id)[0]!.error, 'exploded');
  });

  it('a slot missed while the app was down is run once if it is recent, skipped (with the reason) if it is old', async () => {
    const recent = setup();
    const a = createSchedule(recent.db, base, T0);
    recent.at('2026-10-23T10:30:00Z'); // 1.5 h late: inside the 2 h window
    await recent.scheduler.tick();
    await recent.scheduler.idle();
    assert.deepEqual(recent.started, [{ name: 'Stocks', trigger: 'catchup' }]);
    assert.equal(getSchedule(recent.db, a.id)!.nextRunAt, '2026-10-24T09:00:00.000Z');

    const old = setup();
    const b = createSchedule(old.db, base, T0);
    old.at('2026-10-23T14:00:00Z'); // 5 h late
    await old.scheduler.tick();
    await old.scheduler.idle();
    assert.equal(old.started.length, 0);
    const [run] = listRuns(old.db, b.id);
    assert.deepEqual([run!.status, run!.summary], ['skipped', 'The app was not running at the time.']);
    assert.equal(getSchedule(old.db, b.id)!.nextRunAt, '2026-10-24T09:00:00.000Z');
  });

  it('skips a slot while the previous run of the same schedule is still going', async () => {
    const t = setup({ outcome: () => new Promise(() => { /* never ends */ }) });
    const s = createSchedule(t.db, { ...base, cron: '0 * * * *' }, T0);
    t.at('2026-10-23T09:00:05Z');
    await t.scheduler.tick();
    assert.equal(hasActiveRun(t.db, s.id), true);
    t.at('2026-10-23T10:00:05Z');
    await t.scheduler.tick();
    assert.equal(t.started.length, 1);
    assert.deepEqual(listRuns(t.db, s.id).map(r => r.status), ['skipped', 'running']);
    assert.match(listRuns(t.db, s.id)[0]!.summary!, /previous run was still going/);
  });

  it('limits how many scheduled runs go at once', async () => {
    const t = setup({ maxConcurrent: 1, outcome: () => new Promise(() => {}) });
    createSchedule(t.db, { ...base, name: 'one' }, T0);
    const two = createSchedule(t.db, { ...base, name: 'two' }, T0);
    t.at('2026-10-23T09:00:05Z');
    await t.scheduler.tick();
    assert.deepEqual(t.started.map(s => s.name), ['one']);
    assert.match(listRuns(t.db, two.id)[0]!.summary!, /Too many/);
  });

  it('"run now" starts a manual run without moving the timetable, and refuses a second one', async () => {
    const t = setup({ outcome: () => new Promise(() => {}) });
    const s = createSchedule(t.db, base, T0);
    const before = getSchedule(t.db, s.id)!.nextRunAt;
    assert.deepEqual(t.scheduler.runNow(s.id), { ok: true });
    assert.deepEqual(t.started, [{ name: 'Stocks', trigger: 'manual' }]);
    assert.equal(getSchedule(t.db, s.id)!.nextRunAt, before);
    assert.deepEqual(t.scheduler.runNow(s.id), { ok: false, error: 'This schedule is already running.' });
    assert.deepEqual(t.scheduler.runNow('missing'), { ok: false, error: 'No such schedule.' });
  });

  it('start() closes runs a previous process left "running"', async () => {
    const t = setup();
    const s = createSchedule(t.db, base, T0);
    startRun(t.db, s.id, 'schedule');
    setNextRun(t.db, s.id, null);
    t.scheduler.start();
    t.scheduler.stop();
    assert.equal(listRuns(t.db, s.id)[0]!.status, 'error');
  });

  it('a schedule limited to N runs runs N times and then stops by itself', async () => {
    const t = setup();
    const s = createSchedule(t.db, { ...base, maxRuns: 2 }, T0);
    for (const at of ['2026-10-23T09:00:10Z', '2026-10-24T09:00:10Z', '2026-10-25T09:00:10Z']) {
      t.at(at);
      await t.scheduler.tick();
      await t.scheduler.idle();
    }
    assert.equal(t.started.length, 2);
    const after = getSchedule(t.db, s.id)!;
    assert.deepEqual([after.runCount, after.nextRunAt, after.finished], [2, null, true]);
  });

  it('a slot that is skipped does not use up one of the runs', async () => {
    const t = setup();
    const s = createSchedule(t.db, { ...base, maxRuns: 1 }, T0);
    startRun(t.db, s.id, 'manual'); // still going from before
    t.at('2026-10-23T09:00:10Z');
    await t.scheduler.tick();
    assert.equal(t.started.length, 0);
    assert.equal(listRuns(t.db, s.id).find(r => r.status === 'skipped')?.summary, 'The previous run was still going.');
    const mid = getSchedule(t.db, s.id)!;
    assert.deepEqual([mid.runCount, mid.finished, mid.nextRunAt], [0, false, '2026-10-24T09:00:00.000Z']);
  });

  it('"run now" does not count against the limit', async () => {
    const t = setup();
    const s = createSchedule(t.db, { ...base, maxRuns: 1 }, T0);
    t.scheduler.runNow(s.id);
    await t.scheduler.idle();
    const after = getSchedule(t.db, s.id)!;
    assert.deepEqual([after.runCount, after.finished], [0, false]);
    t.at('2026-10-23T09:00:10Z');
    await t.scheduler.tick();
    await t.scheduler.idle();
    assert.equal(t.started.filter(x => x.trigger === 'schedule').length, 1);
  });

  it('a one-time schedule runs once at its moment and never again', async () => {
    const t = setup();
    const s = createSchedule(t.db, { ...base, cron: '2026-10-23T12:00' }, T0); // 12:00 UTC
    t.at('2026-10-23T11:59:00Z');
    await t.scheduler.tick();
    assert.equal(t.started.length, 0);
    t.at('2026-10-23T12:00:05Z');
    await t.scheduler.tick();
    await t.scheduler.idle();
    assert.deepEqual(t.started, [{ name: 'Stocks', trigger: 'schedule' }]);
    assert.equal(getSchedule(t.db, s.id)!.finished, true);
    t.at('2026-10-24T12:00:05Z');
    await t.scheduler.tick();
    assert.equal(t.started.length, 1);
  });

  it('a one-time schedule whose moment passed while the app was down is skipped with a reason, not run a day late', async () => {
    const t = setup();
    const s = createSchedule(t.db, { ...base, cron: '2026-10-23T12:00' }, T0);
    t.at('2026-10-23T16:00:00Z');
    await t.scheduler.tick();
    assert.equal(t.started.length, 0);
    assert.match(listRuns(t.db, s.id)[0]!.summary ?? '', /not running at the time/);
    assert.equal(getSchedule(t.db, s.id)!.nextRunAt, null);
  });
});
