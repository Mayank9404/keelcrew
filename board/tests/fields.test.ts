import { describe, expect, it } from 'vitest';
import { contractOf, costsOf, memoryOf, riskOf, toEvidence, toInbox, toTask, type Row } from '../src/board/convert';

const row = (id: string, body: Record<string, unknown>): Row => ({ ...body, _id: id, _v: 'v1' });
const ctx = { overlaps: {}, now: 1000 };

describe('contract and validation fields on tasks', () => {
  it('reads the contract, validation and paused agents', () => {
    const t = toTask(
      row('D-1', {
        status: 'active',
        contract: [{ id: 'VAL-D-1-01', text: 'Returns totals', kind: 'positive' }, 'VAL-D-1-02: unknown id returns 404'],
        validation: { 'VAL-D-1-01': { status: 'PASS', by: 'engineer', evidence: 'e1: ok', at: 3 }, 'VAL-D-1-02': 'skip' },
        agents: { engineer: { status: 'paused', denials: { reasons: ['git push to develop'], paused: true }, result: 'KEEL_RESULT agent=engineer key=D-1 status=BLOCKED summary="paused"' } },
      }),
      ctx,
    );
    expect(t.contract).toEqual([
      { id: 'VAL-D-1-01', text: 'Returns totals', kind: 'positive' },
      { id: 'VAL-D-1-02', text: 'unknown id returns 404', kind: 'negative' },
    ]);
    expect(t.validation['VAL-D-1-01']).toEqual({ status: 'pass', by: 'engineer', evidence: 'e1: ok', at: 3 });
    expect(t.validation['VAL-D-1-02'].status).toBe('untested');
    expect(t.agents[0]).toMatchObject({ paused: true, pauseReasons: ['git push to develop'], resultStatus: 'BLOCKED', result: 'BLOCKED: paused' });
    expect(contractOf('nope')).toEqual([]);
  });
});

describe('risk and validation fields on cards', () => {
  it('reads a launch card’s risk, notes, validation snapshot and walkthrough', () => {
    const c = toInbox(
      row('ship-1', {
        kind: 'ship', taskKey: 'D-1', urgent: false, risk: { tier: 'high', reasons: [{ pattern: 'x', why: 'migrations' }, 'raw SQL'], files: ['a', 'b'], added: 40, deleted: 2 },
        riskNotes: { migrations: 'adds a nullable column only' }, validation: { V1: { status: 'fail' } }, walkthroughId: 'walkthrough-17',
      }),
    );
    expect(c.risk).toEqual({ tier: 'high', reasons: ['migrations', 'raw SQL'], files: 2, added: 40, deleted: 2 });
    expect(c.riskNotes).toEqual(['migrations: adds a nullable column only']);
    expect(c.validation?.V1.status).toBe('fail');
    expect(c.walkthroughId).toBe('walkthrough-17');
    expect(riskOf('weird')?.tier).toBe('unknown');
  });

  it('reads drafts with where they post, grants and withdrawals', () => {
    const c = toInbox(row('draft-1', { kind: 'question', from: 'writer', draft: { channel: 'confluence', destination: 'Release notes', mode: 'update', body: '# Notes' }, post: { tool: 'mcp__atlassian__updateConfluenceContent', match: '1234' }, postGrant: { id: 'p1', expires: 9 }, options: ['Post it', 'Change it', 'Drop it'], status: 'dismissed', withdrawn: 'superseded' }));
    expect(c.post).toEqual({ tool: 'mcp__atlassian__updateConfluenceContent', match: '1234' });
    expect(c.postGrant).toEqual({ id: 'p1', at: null, expires: 9 });
    expect(c.withdrawn).toBe('superseded');
    expect(c.draft).toMatchObject({ mode: 'update', body: '# Notes' });
  });

  it('reads batch items, standing-orders cards and proposals with rationale', () => {
    const b = toInbox(row('q-batch', { kind: 'question', batch: true, items: [{ id: 'q1', title: 'A?', options: ['Yes', 'No'], urgent: true }] }));
    expect(b.batch).toBe(true);
    expect(b.items[0]).toMatchObject({ id: 'q1', options: ['Yes', 'No'], urgent: true });
    const p = toInbox(row('playbook-1', { kind: 'playbook', diff: '+ Use tabs', lessons: [{ key: 'tabs', text: 'Use tabs', status: 'candidate', scope: { repo: 'r' }, evidence: [{ source: 'chat', ref: 'c1' }] }], commands: { Approve: ['keelctl memory promote tabs', 'keelctl memory approve'] } }));
    expect(p).toMatchObject({ from: 'learner', options: ['Approve', 'Not now'], diff: '+ Use tabs' });
    expect(p.lessons[0]).toMatchObject({ key: 'tabs', status: 'candidate', scope: 'repo r', evidence: ['c1'] });
    const s = toInbox(row('proposal-suggest-1', { kind: 'proposal', from: 'suggest', rationale: 'Recurring 500', confidence: 0.8, fingerprint: 'suggest:errors:/x:KeyError', proposal: { title: 'Fix', repo: 'r', difficulty: 'simple', description: 'd' } }));
    expect(s).toMatchObject({ kind: 'proposal', rationale: 'Recurring 500', confidence: 0.8, fingerprint: 'suggest:errors:/x:KeyError' });
    expect(toInbox(row('qa', { kind: 'qa', flakeRate: 12, cases: [{ id: 'V1', verdict: 'flaky' }, { id: 'V2', verdict: 'env' }] }))).toMatchObject({ flakeRate: 0.12, cases: [{ verdict: 'flaky' }, { verdict: 'env' }] });
  });
});

describe('evidence and crew documents', () => {
  it('reads handoffs and walkthroughs from objects or JSON text, and eval-case tags', () => {
    const h = toEvidence(row('handoff-engineer-1', { kind: 'handoff', content: { state: 'HEAD abc, tests pass', decisions: ['Kept the old index'], deadEnds: 'Tried a CTE\nTried caching', next: 'Ask QA', questions: [] } }), 'D-1');
    expect(h.handoff).toEqual({ state: 'HEAD abc, tests pass', decisions: ['Kept the old index'], deadEnds: ['Tried a CTE', 'Tried caching'], next: 'Ask QA', questions: [] });
    expect(h.content).toContain('"state"');
    const w = toEvidence(row('walkthrough-1', { kind: 'walkthrough', content: JSON.stringify({ groups: [{ intent: '404 for unknown ids', files: ['routes.py:10-40'], notes: 'n', severity: 'minor' }, { intent: 'x', severity: 'weird' }] }) }), 'D-1');
    expect(w.walkthrough).toEqual([
      { intent: '404 for unknown ids', files: ['routes.py:10-40'], notes: 'n', severity: 'minor' },
      { intent: 'x', files: [], notes: '', severity: 'none' },
    ]);
    expect(toEvidence(row('eval-1', { kind: 'note', tags: ['eval-case'] }), 'D-1').tags).toEqual(['eval-case']);
  });

  it('reads costs and lesson statuses', () => {
    expect(costsOf({ tickets: { 'D-1': { costUsd: 3, byRole: { engineer: 3 } } }, roles: { engineer: { costUsd: 3 } }, members: [{ key: 'D-1', role: 'engineer', costUsd: 3 }] })).toMatchObject({ totalUsd: 3, tickets: { 'D-1': { costUsd: 3, byRole: { engineer: 3 } } } });
    expect(memoryOf({ lessons: [{ key: 'a', status: 'candidate' }, { key: 'b', status: 'weird' }] }).lessons.map((l) => l.status)).toEqual(['candidate', 'active']);
  });
});
