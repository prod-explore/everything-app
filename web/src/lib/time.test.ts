import { describe, expect, it } from 'vitest';
import { formatMessageTime, formatStoredTime, relativeTime } from './time';

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

describe('relativeTime', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  it('counts in the largest sensible unit', () => {
    expect(relativeTime('2026-11-08T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2026-11-08T11:55:00Z', now)).toBe('5 min ago');
    expect(relativeTime('2026-11-08 09:00:00', now)).toBe('3 h ago');
    expect(relativeTime('2026-11-06T12:00:00Z', now)).toBe('2 d ago');
  });
  it('handles nothing and unreadable text', () => {
    expect(relativeTime(null, now)).toBe('');
    expect(relativeTime('soon', now)).toBe('soon');
  });
});

describe('formatMessageTime', () => {
  const o = { timeZone: 'Europe/Warsaw', locale: 'en-GB' };
  const now = new Date('2026-11-17T12:00:00Z');
  it('is just the clock for today', () => {
    expect(formatMessageTime(new Date('2026-11-17T09:05:00Z'), now, o)).toBe('10:05');
  });
  it('adds the date for another day this year, and the year before that', () => {
    expect(formatMessageTime(new Date('2026-10-02T09:05:00Z'), now, o)).toBe('2 Oct, 11:05');
    expect(formatMessageTime(new Date('2025-12-31T09:05:00Z'), now, o)).toBe('31 Dec 2025, 10:05');
  });
  it('judges the day in the given zone, not UTC', () => {
    expect(formatMessageTime(new Date('2026-11-16T23:30:00Z'), now, o)).toBe('00:30');
  });
});
