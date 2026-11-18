import { afterEach, describe, expect, it, vi } from 'vitest';
import { boardBackend, closeFinishedRequests } from '../src/board/backend';
import type { Member, Row } from '../src/board/convert';
import { S } from '../src/board/state';

const m = vi.hoisted(() => ({ addDoc: vi.fn(), updatePinned: vi.fn() }));
vi.mock('../src/board/runtime', () => ({ helper: vi.fn(), helperAvailable: () => true, HelperError: class extends Error {} }));
vi.mock('../src/board/db', () => ({ addDoc: m.addDoc, createOrUpdate: vi.fn(), reader: vi.fn(), updateFresh: vi.fn(), updatePinned: m.updatePinned, updateWith: vi.fn(), writer: vi.fn() }));

const AT = Date.UTC(2026, 9, 19, 9, 0);
const row = (id: string, body: Record<string, unknown>): Row => ({ status: 'open', at: AT, ...body, _id: id, _v: `v-${id}` });
/** HH:MM in this machine's time zone, as the result says it. */
const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);

afterEach(() => {
  vi.clearAllMocks();
  S.requests = new Map();
  S.members = [];
  S.isOwner = false;
});

describe('requests the Mac finishes without the Mate', () => {
  it('closes an open compact request once its session compacted, or says to type /compact when it could not', async () => {
    S.isOwner = true;
    S.requests = new Map([
      ['c1', row('c1', { kind: 'compact', key: 'D-1', ready: true })],
      ['c2', row('c2', { kind: 'compact', key: 'D-2', ready: true })],
      ['c3', row('c3', { kind: 'compact', key: 'D-3', ready: true })],
    ]);
    const done = AT + 5 * 60_000;
    await closeFinishedRequests({ compacted: [{ id: 'c1', key: 'D-1', at: done }, { id: 'c2', key: 'D-2', at: done, error: 'refused' }, { id: 'gone', key: 'D-9', at: done }, 'junk'] });
    expect(m.updatePinned.mock.calls).toEqual([
      ['requests/c1', 'v-c1', { status: 'done', result: `compacted at ${hhmm(done)}`, handledAt: expect.any(Number) }, 'That request'],
      ['requests/c2', 'v-c2', { status: 'done', result: 'type /compact in that session', handledAt: expect.any(Number) }, 'That request'],
    ]);
  });

  it('closes an open scan request with the counts once the panel scanned after it, or with the error', async () => {
    S.isOwner = true;
    S.requests = new Map([['s1', row('s1', { kind: 'scan', key: null })]]);
    await closeFinishedRequests({ scan: { at: AT - 1000, ok: true, new: [{ key: 'D-1' }], changed: [], updated: [] } });
    expect(m.updatePinned).not.toHaveBeenCalled();
    await closeFinishedRequests({ scan: { at: AT + 1000, ok: true, new: [{ key: 'D-1' }, { key: 'D-2' }], changed: [{ key: 'D-3' }], updated: [] } });
    expect(m.updatePinned).toHaveBeenCalledWith('requests/s1', 'v-s1', { status: 'done', result: '2 new, 1 changed, 0 updated', handledAt: expect.any(Number) }, 'That request');
    m.updatePinned.mockClear();
    await closeFinishedRequests({ scan: { at: AT + 1000, ok: false, error: 'no Jira cloud id', new: [], changed: [], updated: [] } });
    expect(m.updatePinned).toHaveBeenCalledWith('requests/s1', 'v-s1', expect.objectContaining({ result: 'Jira scan failed: no Jira cloud id' }), 'That request');
  });

  it('leaves everything alone for a viewer who is not the captain, and a write that lost a race for the next poll', async () => {
    S.requests = new Map([['c1', row('c1', { kind: 'compact', key: 'D-1', ready: true })]]);
    await closeFinishedRequests({ compacted: [{ id: 'c1', key: 'D-1', at: AT }] });
    expect(m.updatePinned).not.toHaveBeenCalled();
    S.isOwner = true;
    m.updatePinned.mockRejectedValueOnce(new Error('changed meanwhile'));
    await closeFinishedRequests({ compacted: [{ id: 'c1', key: 'D-1', at: AT }] });
    await closeFinishedRequests({ compacted: [{ id: 'c1', key: 'D-1', at: AT }] });
    expect(m.updatePinned).toHaveBeenCalledTimes(2);
  });
});

describe('the Compact button', () => {
  const member = (sessionId: string, role: string, key: string | null, agent: string | null) => ({ sessionId, role, key, agent, dir: `/w/${sessionId}` }) as unknown as Member;

  it('asks a session with a ticket to compact itself, ready at once; the Mate still gets one without a ticket', async () => {
    S.members = [member('s-eng', 'engineer', 'D-1', 'engineer'), member('s-qa', 'agent', 'D-1', 'qa'), member('s-lead', 'lead', null, null)];
    for (const id of ['s-eng', 's-qa', 's-lead']) await boardBackend().compactSession(id).catch(() => undefined);
    expect(m.addDoc.mock.calls.map(([, d]) => d)).toEqual([
      { kind: 'compact', key: 'D-1', ready: true, status: 'open', at: expect.any(Number) },
      { kind: 'compact', key: 'D-1', agent: 'qa', ready: true, status: 'open', at: expect.any(Number) },
      { kind: 'compact', key: null, status: 'open', at: expect.any(Number) },
    ]);
  });
});
