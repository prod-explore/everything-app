import { describe, expect, it } from 'vitest';
import { activityLabel, formatElapsed, SILENCE_AFTER_MS, thoughtLabel } from './activity';

describe('formatElapsed', () => {
  it('counts seconds, then minutes and seconds', () => {
    expect(formatElapsed(0)).toBe('0 s');
    expect(formatElapsed(12_900)).toBe('12 s');
    expect(formatElapsed(65_000)).toBe('1 min 5 s');
    expect(formatElapsed(-5)).toBe('0 s');
  });
});

describe('activityLabel', () => {
  const base = { running: true, parts: [], startedAt: 1000, lastEventAt: 1000, now: 13_000, awaitingApproval: false };

  it('counts up while nothing has arrived', () => {
    expect(activityLabel(base)).toBe('Thinking… 12 s');
  });

  it('says nothing when idle, not started, or waiting for the person', () => {
    expect(activityLabel({ ...base, running: false })).toBeNull();
    expect(activityLabel({ ...base, startedAt: null })).toBeNull();
    expect(activityLabel({ ...base, awaitingApproval: true })).toBeNull();
  });

  it('says nothing while text flows or a tool runs', () => {
    const text = [{ type: 'text' as const, text: 'x' }];
    expect(activityLabel({ ...base, parts: text, lastEventAt: 12_000 })).toBeNull();
    const tool = [{ type: 'tool' as const, call: { label: 'Running' } }];
    expect(activityLabel({ ...base, parts: tool, lastEventAt: 1000, now: 100_000 })).toBeNull();
  });

  it('says the model went quiet after the silence limit', () => {
    const text = [{ type: 'text' as const, text: 'x' }];
    expect(activityLabel({ ...base, parts: text, lastEventAt: 2000, now: 2000 + SILENCE_AFTER_MS - 1 })).toBeNull();
    expect(activityLabel({ ...base, parts: text, lastEventAt: 2000, now: 2000 + SILENCE_AFTER_MS + 5000 })).toBe('No response for 20 s');
  });
});

describe('thoughtLabel', () => {
  it('names the duration, or falls back when unknown', () => {
    expect(thoughtLabel(8200)).toBe('Thought for 8 s');
    expect(thoughtLabel(400)).toBe('Thought for <1 s');
    expect(thoughtLabel(null)).toBe('Thought process');
    expect(thoughtLabel(undefined)).toBe('Thought process');
  });
});
