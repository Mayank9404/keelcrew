import { describe, expect, it } from 'vitest';
import { PROPOSAL_OPTIONS, memberOf, memoryOf, receiptsOf, resultLine, retroOf, toChat, toInbox, toRequest, toTask, toSchedule, type Row } from '../src/board/convert';

const row = (id: string, body: Record<string, unknown>): Row => ({ ...body, _id: id, _v: 'v1' });
const ctx = { overlaps: {}, now: 1000 };

describe('tasks', () => {
  it('reads kind, falling back by key and source', () => {
    expect(toTask(row('T-3', { status: 'queued' }), ctx).kind).toBe('adhoc');
    expect(toTask(row('BRIN-2', { status: 'queued', source: 'user' }), ctx).kind).toBe('adhoc');
    expect(toTask(row('BRIN-1', { status: 'active' }), ctx).kind).toBe('ticket');
    expect(toTask(row('BRIN-1', { status: 'active', kind: 'adhoc' }), ctx).kind).toBe('adhoc');
  });

  it('shows parked tasks as active and keeps the Mate row fields', () => {
    const t = toTask(row('BRIN-1', { status: 'parked', cabin: 2, sessionId: 's1', agents: { qa: { status: 'running', verdict: 'FAIL', round: 2, result: 'AC2 fails' } } }), ctx);
    expect(t.status).toBe('active');
    expect(t.sessionId).toBe('s1');
    expect(t.agents).toEqual([{ id: 'qa', status: 'running', verdict: 'FAIL', round: 2, result: 'AC2 fails', resultStatus: null, sessionId: null, sessionLink: null, at: null, paused: false, pauseReasons: [] }]);
  });

  it('shows a KEEL_RESULT line as its status and summary', () => {
    expect(resultLine('KEEL_RESULT agent=reviewer key=D-1 status=DONE_WITH_CONCERNS summary="two nits, \\"minor\\""')).toBe('DONE_WITH_CONCERNS: two nits, "minor"');
    expect(resultLine('plain words ')).toBe('plain words');
  });

  it('reads the shepherd watch as pairs', () => {
    const t = toTask(row('BRIN-1', { status: 'pr', shepherd: { ci: 'green', reviewState: 'approved', nested: { x: 1 } } }), ctx);
    expect(t.shepherd).toEqual([
      { label: 'ci', value: 'green' },
      { label: 'review state', value: 'approved' },
    ]);
  });
});

describe('receipts', () => {
  it('reads {head, review: {status, at}, tests: {status, at}}', () => {
    expect(receiptsOf({ head: 'abc', review: { status: 'pass', at: 5 }, tests: { status: 'fail', at: 6 } })).toEqual({
      head: 'abc',
      review: { status: 'pass', at: 5, head: null, detail: '' },
      tests: { status: 'fail', at: 6, head: null, detail: '' },
      stale: false,
    });
  });

  it('flags a receipt bound to another commit, and counts open findings', () => {
    const r = receiptsOf({ head: 'new', review: { status: 'concerns', head: 'old', findings: [{ state: 'open' }, { state: 'fixed' }] } })!;
    expect(r.stale).toBe(true);
    expect(r.review?.detail).toBe('1 finding open');
  });

  it('is null without receipts', () => {
    expect(receiptsOf(undefined)).toBeNull();
    expect(receiptsOf({})).toBeNull();
  });
});

describe('inbox cards', () => {
  it('reads launch cards from the engineer', () => {
    const c = toInbox(row('ship-1', { kind: 'ship', from: 'engineer', taskKey: 'D-1', title: 'Push & PR', body: 'Adds X', checks: [{ name: 'lint', status: 'pass' }], receipts: { head: 'abc' }, status: 'open' }));
    expect(c).toMatchObject({ kind: 'ship', from: 'engineer', body: 'Adds X', checks: [{ name: 'lint', status: 'pass' }], version: 'v1' });
    expect(c.receipts?.head).toBe('abc');
  });

  it('reads a decision brief with at most 4 options and a never-ask key', () => {
    const c = toInbox(row('q-1', { kind: 'question', from: 'lead', summary: 'Which way?', recommendation: 'A, because', options: ['A', 'B', 'C', 'D', 'E'], neverAskKey: 'pr-monitor' }));
    expect(c).toMatchObject({ kind: 'question', body: 'Which way?', recommendation: 'A, because', options: ['A', 'B', 'C', 'D'], neverAskKey: 'pr-monitor' });
  });

  it('gives proposals the Mate’s options when they have none', () => {
    expect(toInbox(row('p-1', { kind: 'proposal', title: 'Start D-1?' })).options).toEqual(PROPOSAL_OPTIONS);
    expect(toInbox(row('p-2', { kind: 'proposal', options: ['Review it', 'Not now'], proposal: { agent: 'reviewer', prUrl: 'https://x/pull/1' } })).proposal).toMatchObject({ agent: 'reviewer', prUrl: 'https://x/pull/1' });
  });

  it('reads QA cards: verdict, cases with evidence, where it ran', () => {
    const c = toInbox(row('qa-1', { kind: 'qa', from: 'qa', verdict: 'FAIL', url: 'https://dev.example.com', cases: [{ id: 'AC1', ac: 'Shows totals', verdict: 'pass' }, { id: 'AC2', ac: 'Filters', verdict: 'fail', note: 'wrong count', expected: '3', actual: '5', evidenceId: 'qa-1-AC2' }] }));
    expect(c.kind).toBe('qa');
    expect(c.from).toBe('qa');
    expect(c.cases.map((s) => [s.id, s.verdict])).toEqual([['AC1', 'pass'], ['AC2', 'fail']]);
    expect(c.cases[1]).toMatchObject({ note: 'wrong count', expected: '3', actual: '5', evidenceId: 'qa-1-AC2' });
    expect(c.url).toBe('https://dev.example.com');
  });

  it('reads conflict cards with two lessons and their commands', () => {
    const c = toInbox(row('conflict-1', { kind: 'conflict', from: 'learner', lessons: [{ key: 'tabs', text: 'Use tabs', confidence: 0.9 }, { key: 'spaces', text: 'Use spaces' }], commands: { 'Keep the new one': ['keelctl memory forget tabs'] } }));
    expect(c.lessons.map((l) => l.key)).toEqual(['tabs', 'spaces']);
    expect(c.commands).toEqual([{ option: 'Keep the new one', commands: ['keelctl memory forget tabs'] }]);
  });

  it('reads drafts and the comms digest', () => {
    const c = toInbox(row('comms-1', { kind: 'question', from: 'comms', draft: { channel: 'email', destination: 'a@b', body: 'Hi' }, items: [{ subject: 'Budget', from: 'Mia', ask: 'Approve?', due: 'today' }] }));
    expect(c.draft).toMatchObject({ channel: 'email', destination: 'a@b', body: 'Hi' });
    expect(c.items[0]).toMatchObject({ title: 'Budget', from: 'Mia', ask: 'Approve?', due: 'today' });
  });
});

describe('chat', () => {
  it('reads "lead" as the Mate', () => {
    expect(toChat(row('c2', { who: 'lead', text: 'hi', ts: 1 })).who).toBe('lead');
    expect(toChat(row('c3', { who: 'me', text: 'hi', ts: 1 })).who).toBe('me');
    expect(toChat(row('c4', { who: 'hq', text: 'note', ts: 1 })).who).toBe('system');
  });

  it('reads a retro', () => {
    const r = retroOf({ week: '2026-W41', metrics: { finished: { thisWeek: 5, lastWeek: 3, change: '+2' }, usage: 'unavailable' }, recommendations: ['Smaller PRs', { text: 'Faster QA', status: 'open' }] })!;
    expect(r.metrics).toEqual([
      { label: 'finished', value: '5 (3, +2)' },
      { label: 'usage', value: 'unavailable' },
    ]);
    expect(r.recommendations).toEqual(['Smaller PRs', 'Faster QA · open']);
    expect(toChat(row('c5', { who: 'lead', text: 'x', ts: 1 })).retro).toBeNull();
  });
});

describe('requests, schedules, members, memory', () => {
  it('reads memory and agent requests by `action`, or `op` when `action` is missing', () => {
    expect(toRequest(row('r1', { kind: 'memory', key: 'tabs', action: 'pin', at: 3 }))).toMatchObject({ kind: 'memory', key: 'tabs', action: 'pin', at: 3 });
    expect(toRequest(row('r2', { kind: 'memory', key: 'tabs', op: 'forget' })).action).toBe('forget');
    expect(toRequest(row('r3', { kind: 'agent', id: 'qa', action: 'run' })).agent).toBe('qa');
    expect(toRequest(row('r4', { kind: 'task', text: 'Look into X', agent: 'analyst' }))).toMatchObject({ text: 'Look into X', agent: 'analyst' });
  });

  it('reads crew/schedules items keyed by agent', () => {
    expect(toSchedule({ id: 'keel-scan', agent: 'scan', label: 'Jira scan', cadence: 'every 30 min', lastResult: 'DONE: 2 new', openIssues: 1 })).toMatchObject({ agent: 'scan', lastResult: 'DONE: 2 new', openIssues: 1, enabled: true });
    expect(toSchedule({ id: 'health', openIssues: { 'silent:D-1': 5, 'budget:D-2': 6 }, lastResult: 'KEEL_RESULT agent=health key=- status=BLOCKED summary="no helper"', handoff: { state: 's', next: 'retry' } })).toMatchObject({ openIssues: 2, openIssueKeys: ['silent:D-1', 'budget:D-2'], lastResult: 'BLOCKED: no helper', handoff: { next: 'retry' } });
    expect(toSchedule({})).toBeNull();
  });

  it('reads helper members, with and without `agent` and `aliveAt`', () => {
    expect(memberOf({ dir: '/w', role: 'engineer', key: 'D-1' })).toMatchObject({ role: 'engineer', agent: 'engineer', aliveAt: null });
    expect(memberOf({ dir: '/w2', role: 'agent', key: 'D-1', agent: 'qa' })).toMatchObject({ role: 'agent', agent: 'qa' });
    expect(memberOf({ role: 'lead' })).toBeNull();
  });

  it('reads memory_list answers', () => {
    const m = memoryOf({ lessons: [{ id: '1', key: 'tabs', text: 'Use tabs', type: 'style', confidence: 0.9, status: 'pinned', scope: { repo: 'brinewick-api' }, evidence: [{ source: 'chat', ref: 'c1' }] }], playbook: '# Crew standing orders' });
    expect(m.playbook).toBe('# Crew standing orders');
    expect(m.lessons[0]).toMatchObject({ key: 'tabs', status: 'pinned', confidence: 0.9, scope: { repo: 'brinewick-api' } });
    expect(memoryOf(undefined)).toEqual({ lessons: [], playbook: '' });
  });
});
