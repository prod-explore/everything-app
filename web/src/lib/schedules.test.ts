import { describe, expect, it } from 'vitest';
import { CRON_PRESETS, defaultOnce, describeCron, formatWhen, isOnceCron, nextLine, onceInputValue, presetFor, timeZoneChoices } from './schedules';

describe('describeCron', () => {
  it('names the presets and the aliases', () => {
    expect(describeCron('0 8 * * *')).toBe('Every day, 08:00');
    expect(describeCron('  0   8 * * 1-5 ')).toBe('Weekdays, 08:00');
    expect(describeCron('@hourly')).toBe('Every hour');
  });
  it('falls back to the expression itself', () => {
    expect(describeCron('*/20 9-17 * * 1-5')).toBe('*/20 9-17 * * 1-5');
  });
  it('every preset is recognised as itself', () => {
    for (const p of CRON_PRESETS) expect(presetFor(p.cron)).toBe(p);
  });
});

describe('formatWhen', () => {
  it('shows the instant in the zone of the schedule, not the viewer\'s', () => {
    const warsaw = formatWhen('2026-07-01T06:00:00.000Z', 'Europe/Warsaw');
    const utc = formatWhen('2026-07-01T06:00:00.000Z', 'UTC');
    expect(warsaw).toContain('08:00');
    expect(utc).toContain('06:00');
  });
  it('survives nothing, nonsense and an unknown zone', () => {
    expect(formatWhen(null, 'UTC')).toBe('—');
    expect(formatWhen('not a date', 'UTC')).toBe('not a date');
    expect(formatWhen('2026-07-01T06:00:00.000Z', 'Mars/Olympus')).not.toBe('');
  });
});

describe('nextLine', () => {
  it('says paused, next time or nothing', () => {
    expect(nextLine({ enabled: false, nextRunAt: '2026-07-01T06:00:00.000Z', timezone: 'UTC' })).toBe('Paused');
    expect(nextLine({ enabled: true, nextRunAt: null, timezone: 'UTC' })).toBe('No upcoming run');
    expect(nextLine({ enabled: true, nextRunAt: '2026-07-01T06:00:00.000Z', timezone: 'UTC' })).toMatch(/^Next: .*06:00/);
  });
});

describe('timeZoneChoices', () => {
  it('puts the given zone first and has no duplicates', () => {
    const list = timeZoneChoices('Asia/Tokyo');
    expect(list[0]).toBe('Asia/Tokyo');
    expect(new Set(list).size).toBe(list.length);
    expect(list).toContain('UTC');
  });
});

describe('one-time and limited schedules', () => {
  it('recognises a local date and time as a one-time schedule', () => {
    expect(isOnceCron('2026-12-24T08:30')).toBe(true);
    expect(isOnceCron(' 2026-12-24T08:30:00 ')).toBe(true);
    expect(isOnceCron('0 8 * * *')).toBe(false);
    expect(isOnceCron('@daily')).toBe(false);
  });
  it('shows a one-time schedule as its date, and hands a datetime-local input the value without seconds', () => {
    expect(describeCron('2026-12-24T08:30:00')).toBe('Once, 2026-12-24 08:30');
    expect(onceInputValue('2026-12-24T08:30:00')).toBe('2026-12-24T08:30');
  });
  it('defaults to tomorrow 09:00 on the viewer\'s clock', () => {
    expect(defaultOnce(new Date(2026, 9, 23, 13, 0))).toBe('2026-10-24T09:00');
  });
  it('tells which run is next, and when nothing is left', () => {
    const base = { enabled: true, nextRunAt: '2026-07-01T06:00:00.000Z', timezone: 'UTC' };
    expect(nextLine({ ...base, maxRuns: 3, runCount: 1 })).toMatch(/run 2 of 3$/);
    expect(nextLine({ ...base, nextRunAt: null, finished: true, maxRuns: 3, runCount: 3 })).toBe('Finished — 3 of 3 runs done');
    expect(nextLine({ ...base, nextRunAt: null, finished: true, cron: '2026-12-24T08:30:00' })).toBe('Finished — it ran once');
    expect(nextLine({ ...base, enabled: false, finished: true })).toBe('Paused');
  });
});
