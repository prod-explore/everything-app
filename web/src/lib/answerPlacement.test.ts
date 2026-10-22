import { describe, expect, it } from 'vitest';
import { AT_END, parseStoredTime, placeAnswers, type PlacedMessage } from './answerPlacement';

const t = (s: string) => Date.parse(`${s}Z`);
const msg = (id: string, role: string, at: string | null): PlacedMessage => ({ id, role, at: at ? t(at) : null });

describe('parseStoredTime', () => {
  it('reads SQLite UTC times and ISO strings', () => {
    expect(parseStoredTime('2026-10-22 20:47:39')).toBe(Date.parse('2026-10-22T20:47:39Z'));
    expect(parseStoredTime('2026-10-22T20:47:39.000Z')).toBe(Date.parse('2026-10-22T20:47:39Z'));
  });
  it('returns null for nothing or garbage', () => {
    expect(parseStoredTime(null)).toBeNull();
    expect(parseStoredTime('')).toBeNull();
    expect(parseStoredTime('not a time')).toBeNull();
  });
});

describe('placeAnswers', () => {
  const thread = [
    msg('u1', 'user', '2026-10-22T10:00:00'),
    msg('a1', 'assistant', '2026-10-22T10:00:30'),
    msg('u2', 'user', '2026-10-22T11:00:00'),
    msg('a2', 'assistant', '2026-10-22T11:00:40'),
  ];

  it('puts an answer under the reply of the turn that asked it, not at the bottom', () => {
    const placed = placeAnswers(thread, [{ id: 'q1', askedAt: t('2026-10-22T10:00:10'), answeredAt: t('2026-10-22T10:00:20') }]);
    expect(placed.get('a1')).toEqual(['q1']);
    expect(placed.has(AT_END)).toBe(false);
  });

  it('keeps an answer to the newest turn at the end', () => {
    const placed = placeAnswers(thread, [{ id: 'q2', askedAt: t('2026-10-22T11:00:10'), answeredAt: t('2026-10-22T11:00:20') }]);
    expect(placed.get(AT_END)).toEqual(['q2']);
  });

  it('orders several answers of one turn by when they were answered', () => {
    const placed = placeAnswers(thread, [
      { id: 'late', askedAt: t('2026-10-22T10:00:05'), answeredAt: t('2026-10-22T10:00:25') },
      { id: 'early', askedAt: t('2026-10-22T10:00:06'), answeredAt: t('2026-10-22T10:00:15') },
    ]);
    expect(placed.get('a1')).toEqual(['early', 'late']);
  });

  it('skips a compaction notice and messages without a stored time', () => {
    const withNotice = [msg('u1', 'user', '2026-10-22T10:00:00'), msg('a1', 'assistant', null), msg('n', 'system', null), msg('u2', 'user', '2026-10-22T11:00:00')];
    const placed = placeAnswers(withNotice, [{ id: 'q', askedAt: t('2026-10-22T10:30:00'), answeredAt: null }]);
    expect(placed.get('a1')).toEqual(['q']);
  });

  it('falls back to the end when the question is older than every user message or has no time', () => {
    const placed = placeAnswers(thread, [
      { id: 'old', askedAt: t('2026-10-22T09:00:00'), answeredAt: 1 },
      { id: 'none', askedAt: null, answeredAt: 2 },
    ]);
    expect(placed.get(AT_END)).toEqual(['old', 'none']);
  });
});
