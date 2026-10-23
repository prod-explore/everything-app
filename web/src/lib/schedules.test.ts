import { describe, expect, it } from 'vitest';
import { CRON_PRESETS, describeCron, formatWhen, nextLine, presetFor, timeZoneChoices } from './schedules';

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
