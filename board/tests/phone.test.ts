import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boardBackend } from '../src/board/backend';
import type { Row } from '../src/board/convert';
import { toInbox } from '../src/board/convert';
import { S } from '../src/board/state';
import { helperNote, helperStatus } from '../src/lib/compat';
import { outcome } from '../src/lib/inbox';
import { approveGate } from '../src/lib/risk';
import { card } from './build';

const m = vi.hoisted(() => {
  class HelperError extends Error {
    readonly code: string;
    readonly ambiguous = false;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  return { HelperError, addDoc: vi.fn(), updatePinned: vi.fn(), updateWith: vi.fn(), updateFresh: vi.fn(), createOrUpdate: vi.fn(), helper: vi.fn(), toast: vi.fn() };
});
vi.mock('../src/lib/toast', () => ({ toast: m.toast }));
vi.mock('../src/board/runtime', () => ({ helper: m.helper, helperAvailable: () => false, HelperError: m.HelperError }));
vi.mock('../src/board/db', () => ({ addDoc: m.addDoc, createOrUpdate: m.createOrUpdate, reader: vi.fn(), updateFresh: m.updateFresh, updatePinned: m.updatePinned, updateWith: m.updateWith, writer: vi.fn() }));

const HEAD = 'a'.repeat(40);
const ship = (p: Parameters<typeof card>[1] = {}) => card('ship-1', { kind: 'ship', taskKey: 'D-1', version: 'v7', receipts: { head: HEAD } as never, ...p });
const draft = card('draft-1', { kind: 'question', taskKey: 'D-2', version: 'v3', options: ['Post it', 'Drop it'], post: { tool: 'mcp__x__send_message', match: 'Release 1.2' } });
const row = (id: string, body: Record<string, unknown>): Row => ({ ...body, _id: id, _v: `v-${id}` });
const onPhone = () => void (S.helper = { status: 'missing', version: null, schema: null, reason: 'server_not_connected' });
const onMac = () => void (S.helper = { status: 'ok', version: '1', schema: 2 });
/** The card writes after the first (pinned) one: a reopen, or the hand-off to the Mac. */
const laterWrites = () => m.updateFresh.mock.calls.map((c) => c[1]);

beforeEach(() => {
  m.updatePinned.mockResolvedValue(undefined);
  m.updateFresh.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.resetAllMocks();
  S.settings = null;
  onMac();
});

describe('answering from a phone, where the helper is out of reach', () => {
  it("a launch card takes the answer and grantPending, the captain's snapshot of what it showed, calls no helper and stays answered", async () => {
    onPhone();
    for (const [decision, choice, status] of [['approve', 'Open PR', 'approved'], ['draft', 'Draft PR', 'approved'], ['push', 'Push only', 'approved'], ['reject', 'Not yet', 'rejected']] as const) {
      m.updatePinned.mockClear();
      const r = await boardBackend().decideInbox(ship(), decision, decision === 'reject' ? 'later' : undefined);
      expect(m.updatePinned.mock.calls).toEqual([['inbox/ship-1', 'v7', { status, answer: choice, ...(decision === 'reject' ? { note: 'later' } : {}), answeredAt: expect.any(Number), resolvedAt: expect.any(Number), grantPending: { choice, at: expect.any(Number), key: 'D-1', head: HEAD } }, 'That card']]);
      const patch = m.updatePinned.mock.calls[0][2];
      expect(patch.grantPending.at).toBe(patch.answeredAt);
      expect(m.helper).not.toHaveBeenCalled();
      expect(laterWrites()).toEqual([]);
      expect([r.status, r.answer, r.grantPending]).toEqual([status, choice, true]);
    }
    // A card that names no commit: nothing that ships is approved (it would bind to whatever the worktree holds later); Not yet still goes.
    m.updatePinned.mockClear();
    await expect(boardBackend().decideInbox(ship({ receipts: null }), 'push')).rejects.toThrow(/names no commit/);
    expect(m.updatePinned).not.toHaveBeenCalled();
    await boardBackend().decideInbox(ship({ receipts: null }), 'reject');
    expect(m.updatePinned.mock.calls[0][2].grantPending).toEqual({ choice: 'Not yet', at: expect.any(Number), key: 'D-1' });
  });

  it('an Approve and post card does the same, with the post target it showed and no approve_post call', async () => {
    onPhone();
    const r = await boardBackend().decideInbox(draft, 'post', 'Post it');
    expect(m.updatePinned.mock.calls[0][2]).toEqual({ status: 'answered', answer: 'Post it', answeredAt: expect.any(Number), resolvedAt: expect.any(Number), grantPending: { choice: 'Post it', at: expect.any(Number), key: 'D-2', post: { tool: 'mcp__x__send_message', match: 'Release 1.2' } } });
    expect(m.helper).not.toHaveBeenCalled();
    expect(laterWrites()).toEqual([]);
    expect(r.grantPending).toBe(true);
  });

  it('a helper that turns out to be out of reach hands the answer to the Mac instead of reopening the card', async () => {
    m.helper.mockRejectedValue(new m.HelperError('not here', 'server_not_connected'));
    const r = await boardBackend().decideInbox(ship(), 'push');
    expect(m.helper).toHaveBeenCalledWith('approve', { key: 'D-1', choice: 'Push only', head: HEAD });
    const answeredAt = m.updatePinned.mock.calls[0][2].answeredAt;
    expect(laterWrites()).toEqual([{ grantPending: { choice: 'Push only', at: answeredAt, key: 'D-1', head: HEAD } }]);
    const check = m.updateFresh.mock.calls[0][2] as (d: Record<string, unknown>) => boolean;
    expect([check({ answeredAt }), check({ answeredAt: answeredAt + 1 })]).toEqual([true, false]);
    expect(r.grantPending).toBe(true);
    const p = await boardBackend().decideInbox(draft, 'post', 'Post it');
    expect(laterWrites().at(-1)).toEqual({ grantPending: { choice: 'Post it', at: expect.any(Number), key: 'D-2', post: { tool: 'mcp__x__send_message', match: 'Release 1.2' } } });
    expect(p.grantPending).toBe(true);
  });

  it('with phone approvals off in Settings, a missing helper reopens the card', async () => {
    onPhone();
    S.settings = row('main', { phoneApprovals: false });
    m.helper.mockRejectedValue(new m.HelperError('not here', 'no_mcp'));
    await expect(boardBackend().decideInbox(ship(), 'approve')).rejects.toThrow(/Nothing was approved/);
    expect(m.updatePinned.mock.calls[0][2]).not.toHaveProperty('grantPending');
    expect(laterWrites()).toEqual([{ status: 'open', answer: null, note: null, answeredAt: null, resolvedAt: null }]);
  });
});

describe('answering on the Mac, with the helper', () => {
  it('a launch card is approved through the helper, with no grantPending', async () => {
    m.helper.mockResolvedValue({ ok: true });
    const r = await boardBackend().decideInbox(ship(), 'approve');
    expect(m.updatePinned.mock.calls[0][2]).toEqual({ status: 'approved', answer: 'Open PR', answeredAt: expect.any(Number), resolvedAt: expect.any(Number) });
    expect(m.helper).toHaveBeenCalledWith('approve', { key: 'D-1', choice: 'Open PR', head: HEAD });
    expect(laterWrites()).toEqual([]);
    expect(r.grantPending).toBe(false);
  });

  it('a helper that fails for another reason reopens the card', async () => {
    m.helper.mockRejectedValue(new m.HelperError("The card's commit isn't in the history", 'tool_error'));
    await expect(boardBackend().decideInbox(ship(), 'approve')).rejects.toThrow(/Nothing was approved/);
    expect(laterWrites()).toEqual([{ status: 'open', answer: null, note: null, answeredAt: null, resolvedAt: null }]);
    m.helper.mockRejectedValue(new m.HelperError('declined', 'cancelled'));
    await expect(boardBackend().decideInbox(draft, 'post', 'Post it')).rejects.toThrow(/declined it/);
    expect(laterWrites().at(-1)).toEqual({ status: 'open', answer: null, answeredAt: null, resolvedAt: null });
  });

  it("a call the captain declined, or this view isn't granted, approves nothing and reopens the card, never handing it to the Mac", async () => {
    onMac();
    for (const code of ['not_granted', 'user_changed', 'cancelled', 'not_in_manifest', 'capability_disabled', 'blocked_by_policy']) {
      m.updateFresh.mockClear();
      m.helper.mockRejectedValue(new m.HelperError('no', code));
      await expect(boardBackend().decideInbox(ship(), 'approve'), code).rejects.toThrow(/Nothing was approved|declined it/);
      expect(laterWrites(), code).toEqual([{ status: 'open', answer: null, note: null, answeredAt: null, resolvedAt: null }]);
      await expect(boardBackend().decideInbox(draft, 'post', 'Post it'), code).rejects.toThrow(/Nothing was approved|declined it/);
      expect(laterWrites().at(-1), code).toEqual({ status: 'open', answer: null, answeredAt: null, resolvedAt: null });
    }
  });

  it('an Approve and post card records the grant the helper made', async () => {
    m.helper.mockResolvedValue({ post: { id: 'p1', expires: 99 } });
    const r = await boardBackend().decideInbox(draft, 'post', 'Post it');
    expect(m.helper).toHaveBeenCalledWith('approve_post', { key: 'D-2', tool: 'mcp__x__send_message', match: 'Release 1.2' });
    expect(laterWrites()).toEqual([{ postGrant: { id: 'p1', at: expect.any(Number), expires: 99 } }]);
    expect([r.grantPending, r.postGrant?.id]).toEqual([false, 'p1']);
  });
});

describe('where an answer from the phone stands', () => {
  it('waiting for the Mac, then done there', () => {
    const waiting = toInbox(row('ship-1', { kind: 'ship', status: 'approved', answer: 'Open PR', answeredAt: 5, grantPending: { choice: 'Open PR', at: 5, key: 'D-1' } }));
    expect(waiting.status).toBe('approved');
    expect(outcome(waiting)).toMatch(/You chose Open PR at .*\. Waiting for your Mac: it carries this out within a minute while the Mate session is open\./);
    const done = toInbox(row('ship-1', { kind: 'ship', status: 'approved', answer: 'Open PR', answeredAt: 5, grantPending: false, grantResult: 'done (low risk, until 2026-11-04 10:00)' }));
    expect(outcome(done)).toContain('Done on your Mac: low risk, until 2026-11-04 10:00.');
  });

  it('a grantError opens the card again with working buttons, and the next answer clears it', async () => {
    const failed = toInbox(row('ship-1', { kind: 'ship', taskKey: 'D-1', status: 'approved', answer: 'Open PR', answeredAt: 5, grantPending: false, grantError: 'the card changed', handledAt: 6, receipts: { head: HEAD, review: { head: HEAD } } }));
    expect([failed.status, failed.grantError]).toEqual(['open', 'the card changed']);
    expect(approveGate(failed, false).canApprove).toBe(true);
    onPhone();
    await boardBackend().decideInbox(failed, 'approve');
    expect(m.updatePinned.mock.calls[0][2]).toEqual({ status: 'approved', answer: 'Open PR', answeredAt: expect.any(Number), resolvedAt: expect.any(Number), grantError: null, grantResult: null, handledAt: null, grantPending: { choice: 'Open PR', at: expect.any(Number), key: 'D-1', head: HEAD } });
    const pending = toInbox(row('ship-1', { kind: 'ship', status: 'approved', answer: 'Open PR', grantPending: { choice: 'Open PR', at: 5 }, grantError: 'the card changed' }));
    expect([pending.status, pending.grantPending]).toEqual(['approved', true]);
  });

  it('the helper note says approvals go through the Mac, unless phone approvals are off', () => {
    const missing = helperStatus(null, 2, 'server_not_connected');
    expect(helperNote(missing)).toMatch(/Approvals from here go through your Mac within a minute while the Mate session is open/);
    expect(helperNote(missing)).toMatch(/diffs and transcripts are off/);
    expect(helperNote(missing, false)).toMatch(/Approvals need your Mac too/);
  });
});
