import { describe, expect, it } from 'vitest';
import { cardVariant, cardsForYou, jobLight, nextWindow, rankCards, stuckItems } from '../src/lib/triage';
import { agent, card, crew, item, session, task } from './build';

const risk = (tier: 'low' | 'medium' | 'high') => ({ tier, reasons: [], files: 1, added: 1, deleted: 0 });

describe('card variants', () => {
  it('tells drafts, batches and digests apart from plain questions', () => {
    expect(cardVariant(card('a', { batch: true, items: [item('q1')] }))).toBe('batch');
    expect(cardVariant(card('b', { from: 'comms', items: [item('t1', { channel: 'email' })] }))).toBe('digest');
    expect(cardVariant(card('c', { draft: { channel: 'confluence', destination: 'p', mode: 'update', subject: '', body: 'x', evidenceId: null, comments: [] } }))).toBe('draft');
    expect(cardVariant(card('d'))).toBe('question');
    expect(cardVariant(card('e', { kind: 'playbook' }))).toBe('playbook');
  });
});

describe('ranking what needs you', () => {
  it('puts urgent cards first, then high risk, then oldest first', () => {
    const list = [
      card('proposal', { kind: 'proposal', createdAt: 1 }),
      card('ship-low', { kind: 'ship', risk: risk('low'), createdAt: 2 }),
      card('q-old', { createdAt: 3 }),
      card('ship-high', { kind: 'ship', risk: risk('high'), createdAt: 9 }),
      card('urgent', { urgent: true, createdAt: 10 }),
      card('qa-fail', { kind: 'qa', verdict: 'FAIL', createdAt: 8 }),
      card('q-new', { createdAt: 4 }),
    ];
    expect(rankCards(list).map((c) => c.id)).toEqual(['urgent', 'ship-high', 'qa-fail', 'ship-low', 'q-old', 'q-new', 'proposal']);
  });

  it('leaves answered cards out', () => {
    const c = crew({ inbox: [card('mine'), card('done', { status: 'answered' })] });
    expect(cardsForYou(c).map((x) => x.id)).toEqual(['mine']);
  });
});

describe('stuck', () => {
  it('finds paused and blocked agents, failing assertions and blocked jobs', () => {
    const c = crew({
      tasks: [
        task('D-1', { agents: [agent('engineer', { paused: true, pauseReasons: ['git push to develop', 'psql update'] })] }),
        task('D-2', { agents: [agent('engineer', { status: 'waiting', resultStatus: 'BLOCKED', result: 'BLOCKED: no dev data for the case' })] }),
        task('D-3', { contract: [{ id: 'VAL-D-3-01', text: 't', kind: 'positive' }], validation: { 'VAL-D-3-01': { status: 'fail', by: 'engineer', evidence: 'e: 500', at: 1 } } }),
        task('D-4', { status: 'done', agents: [agent('engineer', { paused: true })] }),
      ],
      schedules: [{ id: 'health', agent: 'health', label: 'Health check', cadence: '', enabled: true, lastRun: 1, nextRun: null, lastResult: 'BLOCKED: helper down', openIssues: null, openIssueKeys: [], handoff: { state: '', decisions: [], deadEnds: [], next: 'Restart the app', questions: [] } }],
    });
    const s = stuckItems(c, 10);
    expect(s.map((x) => [x.kind, x.taskKey])).toEqual([
      ['paused', 'D-1'],
      ['blocked', 'D-2'],
      ['failing', 'D-3'],
      ['job', null],
    ]);
    expect(s[0].reasons).toEqual(['git push to develop', 'psql update']);
    expect(s[1].detail).toBe('no dev data for the case');
    expect(s[3].detail).toBe('Next: Restart the app');
  });

  it('notices paused sessions the rows don’t mention, and requests the Mate hasn’t picked up', () => {
    const now = 60 * 60_000;
    const c = crew({ sessions: [session('s1', { taskKey: 'T-4', role: 'agent', agent: 'analyst', paused: true })], requests: [{ id: 'r', kind: 'start', key: 'D-1', action: null, agent: null, text: '', at: 0 }] });
    expect(stuckItems(c, now).map((x) => x.kind)).toEqual(['paused', 'lead']);
  });

  it('does not count a failing assertion twice while its launch card is open', () => {
    const t = task('D-3', { contract: [{ id: 'V1', text: 't', kind: 'positive' }], validation: { V1: { status: 'fail', by: 'engineer', evidence: '', at: 1 } } });
    expect(stuckItems(crew({ tasks: [t], inbox: [card('ship', { kind: 'ship', taskKey: 'D-3' })] }), 1)).toEqual([]);
  });
});

describe('question windows and job lights', () => {
  it('finds the next window today, else tomorrow’s first', () => {
    const at = (h: number, m: number) => new Date(2026, 9, 15, h, m).getTime();
    expect(nextWindow(['16:30', '11:30'], at(9, 0))?.label).toBe('11:30');
    expect(nextWindow(['16:30', '11:30'], at(12, 0))).toEqual({ at: at(16, 30), label: '16:30' });
    expect(nextWindow(['16:30', '11:30'], at(17, 0))?.label).toBe('tomorrow 11:30');
    expect(nextWindow(['nope'], at(9, 0))).toBeNull();
  });

  it('lights jobs by their last result', () => {
    const j = { id: 'x', agent: 'x', label: 'x', cadence: '', enabled: true, lastRun: 1, nextRun: null, lastResult: 'DONE: fine', openIssues: null, openIssueKeys: [], handoff: null };
    expect(jobLight(j, false)).toBe('ok');
    expect(jobLight({ ...j, lastResult: 'BLOCKED: x' }, false)).toBe('fail');
    expect(jobLight({ ...j, openIssues: 2 }, false)).toBe('warn');
    expect(jobLight(j, true)).toBe('off');
    expect(jobLight({ ...j, lastRun: null, lastResult: '' }, false)).toBe('idle');
  });
});
