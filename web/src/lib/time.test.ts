import { describe, expect, it } from 'vitest';
import { formatStoredTime } from './time';

describe('formatStoredTime', () => {
  const warsaw = { timeZone: 'Europe/Warsaw', locale: 'en-GB' };

  it('reads the zone-less SQLite time as UTC, not as local time', () => {
    // 20:47 UTC is 22:47 in Poland during summer time
    expect(formatStoredTime('2026-10-22 20:47:39', warsaw)).toBe('22/10/2026, 22:47:39');
  });

  it('shows an ISO time the same way', () => {
    expect(formatStoredTime('2026-10-22T20:47:39.000Z', warsaw)).toBe('22/10/2026, 22:47:39');
  });

  it('follows the winter offset too', () => {
    expect(formatStoredTime('2026-12-01 20:47:39', warsaw)).toBe('01/12/2026, 21:47:39');
  });

  it('gives back the text it cannot read, and nothing for nothing', () => {
    expect(formatStoredTime('yesterday-ish', warsaw)).toBe('yesterday-ish');
    expect(formatStoredTime(null, warsaw)).toBe('');
    expect(formatStoredTime(undefined, warsaw)).toBe('');
  });
});
