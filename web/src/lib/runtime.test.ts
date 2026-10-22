import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { sendFailureMessage } from './runtime';

describe('sendFailureMessage', () => {
  it('explains a 409 (turn still running) in plain words', () => {
    expect(sendFailureMessage(new ApiError('a turn is already running in this conversation', 409))).toMatch(/still working on this chat.*wasn't sent/);
  });

  it('passes other failures on with their reason', () => {
    expect(sendFailureMessage(new ApiError('request failed (500)', 500))).toBe("Your message wasn't sent: request failed (500).");
    expect(sendFailureMessage('weird')).toBe("Your message wasn't sent: unknown error.");
  });
});
