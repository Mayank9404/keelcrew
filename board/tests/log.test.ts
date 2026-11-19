import { describe, expect, it } from 'vitest';
import { byDay, logEntries } from '../src/lib/log';
import { agent, card, crew, task } from './build';

const HOUR = 3_600_000;
const T0 = new Date(2026, 0, 12, 9, 0).getTime();

describe('the log', () => {
  it('lists what happened newest first, from the times on tasks and waiting items', () => {
    const c = crew({
      tasks: [task('K-1', { title: 'Fix the export', createdAt: T0, startedAt: T0 + HOUR, agents: [agent('engineer', { result: 'DONE: export fixed', at: T0 + 3 * HOUR }), agent('qa', { result: '', at: T0 + 4 * HOUR })] })],
      inbox: [card('ship-1', { kind: 'ship', title: 'Push K-1', from: 'engineer', taskKey: 'K-1', createdAt: T0 + 5 * HOUR })],
    });
    const log = logEntries(c);
    expect(log.map((e) => e.id)).toEqual(['i:ship-1:new', 't:K-1:engineer:0', 't:K-1:start']);
    expect(log[0]).toMatchObject({ who: 'engineer', text: 'Sign-off: Push K-1', taskKey: 'K-1', waitingId: 'ship-1', tone: 'you' });
    expect(log[2]).toMatchObject({ who: 'lead', text: 'Started: Fix the export' });
  });

  it('marks only open items as waiting, and records who answered', () => {
    const answered = card('q-1', { title: 'Stream or paginate?', status: 'answered', answer: 'Stream', createdAt: T0, resolvedAt: T0 + HOUR });
    const auto = card('s-1', { kind: 'ship', title: 'Bump', status: 'approved', answer: 'auto-approved: low risk', createdAt: T0, resolvedAt: T0 + 2 * HOUR });
    const log = logEntries(crew({ inbox: [answered, auto] }));
    expect(log.every((e) => e.waitingId === null)).toBe(true);
    expect(log.find((e) => e.id === 'i:q-1:done')).toMatchObject({ who: 'you' });
    expect(log.find((e) => e.id === 'i:s-1:done')).toMatchObject({ who: 'lead' });
  });

  it('shows a blocked agent result in the blocked tone, and a merge once', () => {
    const c = crew({ tasks: [task('K-2', { createdAt: T0, mergedAt: T0 + 2 * HOUR, closedAt: T0 + 2 * HOUR, status: 'done', agents: [agent('engineer', { result: 'BLOCKED: no access', resultStatus: 'BLOCKED', at: T0 + HOUR })] })] });
    const log = logEntries(c);
    expect(log.find((e) => e.who === 'engineer')?.tone).toBe('block');
    expect(log.filter((e) => e.id.startsWith('t:K-2:merged') || e.id.startsWith('t:K-2:closed')).map((e) => e.text)).toEqual(['Pull request merged']);
  });

  it('groups entries by calendar day', () => {
    const c = crew({ inbox: [card('a', { createdAt: T0 }), card('b', { createdAt: T0 + HOUR }), card('c', { createdAt: T0 + 24 * HOUR })] });
    const days = byDay(logEntries(c));
    expect(days.map((d) => d.entries.map((e) => e.id))).toEqual([['i:c:new'], ['i:b:new', 'i:a:new']]);
  });
});
