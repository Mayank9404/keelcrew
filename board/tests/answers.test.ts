import { describe, expect, it } from 'vitest';
import { answerItem, batchProgress, isPostingOption, unanswerItem } from '../src/lib/answers';
import { card, item } from './build';

describe('posting options', () => {
  it('knows which answers let the crew post a draft once', () => {
    expect(['Post it', 'Accept and post the Jira note', 'Approve it'].map(isPostingOption)).toEqual([true, true, true]);
    expect(["I'll post it", 'I’ll send it', 'Approve', 'Accept', 'Change it', 'Drop it'].map(isPostingOption)).toEqual([false, false, false, false, false, false]);
  });
});

describe('batch answers', () => {
  const raw = [
    { id: 'q1', title: 'Rename the flag?', options: ['Yes', 'No'], sessionId: 's1' },
    { id: 'q2', title: 'Ship before Friday?', options: ['Yes', 'No'] },
  ];

  it('answers one item, keeping the fields the board doesn’t know', () => {
    const r = answerItem(raw, 'q1', 'Yes', 100)!;
    expect(r.items[0]).toEqual({ ...raw[0], answer: 'Yes', answeredAt: 100 });
    expect(r.items[1]).toEqual(raw[1]);
    expect(r.allAnswered).toBe(false);
    expect(raw[0]).not.toHaveProperty('answer');
  });

  it('says when the last item is answered, and refuses an item answered meanwhile', () => {
    const first = answerItem(raw, 'q1', 'Yes', 100)!;
    const second = answerItem(first.items, 'q2', 'No', 101)!;
    expect(second.allAnswered).toBe(true);
    expect(answerItem(first.items, 'q1', 'No', 102)).toBeNull();
    expect(answerItem(raw, 'nope', 'No', 102)).toBeNull();
    expect(answerItem('not a list', 'q1', 'No', 102)).toBeNull();
  });

  it('counts only answerable digest items, and can take an answer back', () => {
    const digest = [{ id: 'a', subject: 'FYI' }, { id: 'b', subject: 'Reply on D-1', options: ['Post it', 'Skip'], post: { tool: 't', match: 'D-1' } }];
    expect(answerItem(digest, 'b', 'Post it', 5, { batch: false })!.allAnswered).toBe(true);
    expect(unanswerItem(answerItem(digest, 'b', 'Post it', 5, { batch: false })!.items, 'b')![1]).toMatchObject({ answer: null, answeredAt: null });
  });

  it('tracks progress and the next open item', () => {
    const c = card('q-batch', { batch: true, items: [item('q1', { answer: 'Yes' }), item('q2'), item('q3')] });
    const p = batchProgress(c);
    expect(p).toMatchObject({ answered: 1, total: 3, done: false });
    expect(p.next?.id).toBe('q2');
    expect(batchProgress(card('d', { items: [item('x'), item('y', { options: ['Post it'], answer: 'Post it' })] }))).toMatchObject({ answered: 1, total: 1, done: true });
  });
});

