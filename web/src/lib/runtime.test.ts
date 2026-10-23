import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { imagesOf, sendFailureMessage } from './runtime';

describe('sendFailureMessage', () => {
  it('explains a 409 (turn still running) in plain words', () => {
    expect(sendFailureMessage(new ApiError('a turn is already running in this conversation', 409))).toMatch(/still working on this chat.*wasn't sent/);
  });

  it('passes other failures on with their reason', () => {
    expect(sendFailureMessage(new ApiError('request failed (500)', 500))).toBe("Your message wasn't sent: request failed (500).");
    expect(sendFailureMessage('weird')).toBe("Your message wasn't sent: unknown error.");
  });
});

describe('imagesOf', () => {
  const png = 'data:image/png;base64,AAAA';
  const message = (content: unknown[], attachments?: unknown[]) => ({ content, attachments }) as never;

  it('finds an image the composer put on the attachment, which is where it arrives', () => {
    const m = message([{ type: 'text', text: 'what is this?' }], [{ id: 'a', type: 'image', name: 'x.png', status: { type: 'complete' }, content: [{ type: 'image', image: png }] }]);
    expect(imagesOf(m)).toEqual([png]);
  });

  it('still finds one placed in the content, and several in order', () => {
    const m = message([{ type: 'image', image: png }], [{ content: [{ type: 'image', image: 'data:image/jpeg;base64,BBBB' }] }]);
    expect(imagesOf(m)).toEqual([png, 'data:image/jpeg;base64,BBBB']);
  });

  it('is empty for a text-only message', () => {
    expect(imagesOf(message([{ type: 'text', text: 'hi' }], []))).toEqual([]);
    expect(imagesOf(message([{ type: 'text', text: 'hi' }]))).toEqual([]);
  });
});
