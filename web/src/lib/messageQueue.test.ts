import { describe, expect, it } from 'vitest';
import { dequeue, editQueued, enqueue, promoteQueued, queueOf, removeQueued, requeueFirst, type MessageQueues } from './messageQueue';

const texts = (q: MessageQueues, c = 'c1') => queueOf(q, c).map(m => m.text);

function filled(): MessageQueues {
  let q: MessageQueues = {};
  q = enqueue(q, 'c1', { id: 'a', text: 'first' });
  q = enqueue(q, 'c1', { id: 'b', text: 'second' });
  q = enqueue(q, 'c2', { id: 'c', text: 'other chat' });
  return q;
}

describe('message queue', () => {
  it('keeps messages in order, per conversation', () => {
    const q = filled();
    expect(texts(q)).toEqual(['first', 'second']);
    expect(texts(q, 'c2')).toEqual(['other chat']);
    expect(queueOf(q, null)).toEqual([]);
  });

  it('ignores blank messages', () => {
    expect(enqueue({}, 'c1', { id: 'x', text: '  \n ' })).toEqual({});
  });

  it('edits a waiting message and drops it when emptied', () => {
    const edited = editQueued(filled(), 'c1', 'a', 'first, reworded');
    expect(texts(edited)).toEqual(['first, reworded', 'second']);
    expect(texts(editQueued(edited, 'c1', 'a', '   '))).toEqual(['second']);
    expect(editQueued(edited, 'c1', 'nope', 'x')).toBe(edited);
  });

  it('removes one message and forgets an emptied conversation', () => {
    const q = removeQueued(removeQueued(filled(), 'c1', 'a'), 'c1', 'b');
    expect(texts(q)).toEqual([]);
    expect(Object.keys(q)).toEqual(['c2']);
  });

  it('promotes a message to the front without touching the rest', () => {
    expect(texts(promoteQueued(filled(), 'c1', 'b'))).toEqual(['second', 'first']);
  });

  it('takes messages off one at a time, oldest first', () => {
    const first = dequeue(filled(), 'c1');
    expect(first.next?.text).toBe('first');
    const second = dequeue(first.queues, 'c1');
    expect(second.next?.text).toBe('second');
    expect(dequeue(second.queues, 'c1').next).toBeNull();
  });

  it('puts a refused message back at the front', () => {
    const { next, queues } = dequeue(filled(), 'c1');
    expect(texts(requeueFirst(queues, 'c1', next!))).toEqual(['first', 'second']);
  });
});
