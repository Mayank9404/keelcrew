import { describe, expect, it } from 'vitest';
import { approveGate, gateTier } from '../src/lib/risk';
import { card } from './build';

const SHA = 'a3f9c2e17b4d8e6f0a1b2c3d4e5f60718293a4b5';
const receipts = { head: SHA, review: { status: 'pass', at: 1, head: SHA, detail: '' }, tests: { status: 'pass', at: 1, head: null, detail: '' }, stale: false };
const ship = (p: Parameters<typeof card>[1] = {}) => card('ship-1', { kind: 'ship', from: 'engineer', taskKey: 'D-1', receipts, ...p });

describe('risk gating on launch cards', () => {
  it('locks a high-risk card until the captain acknowledges the risk', () => {
    const c = ship({ risk: { tier: 'high', reasons: ['migrations'], files: 4, added: 300, deleted: 2 } });
    expect(approveGate(c, false)).toMatchObject({ canApprove: false, needsAck: true });
    expect(approveGate(c, true)).toMatchObject({ canApprove: true, needsAck: false, reason: null });
  });

  it('treats an unknown tier as high, and low or medium as one click', () => {
    expect(gateTier({ tier: 'unknown', reasons: [], files: null, added: null, deleted: null })).toBe('high');
    expect(approveGate(ship({ risk: { tier: 'unknown', reasons: [], files: null, added: null, deleted: null } }), false).needsAck).toBe(true);
    expect(approveGate(ship({ risk: { tier: 'medium', reasons: [], files: 1, added: 500, deleted: 0 } }), false).canApprove).toBe(true);
    expect(approveGate(ship(), false).canApprove).toBe(true);
    expect(gateTier(null)).toBeNull();
  });

  it('never approves a withdrawn or answered card', () => {
    expect(approveGate(ship({ withdrawn: 'review receipt is for an older head' }), true)).toMatchObject({ canApprove: false, reason: 'Withdrawn by the Mate: review receipt is for an older head' });
    // The helper pins approvals to a full commit id only; a short one would be refused on the Mac after the card changed.
    expect(approveGate(ship({ receipts: { ...receipts, head: 'a3f9c2e' } }), true).canApprove).toBe(false);
    expect(approveGate(ship({ status: 'approved' }), true).canApprove).toBe(false);
  });

  it('warns about failing assertions, unexplained untested ones, stale receipts and failing checks', () => {
    const g = approveGate(
      ship({
        validation: { 'VAL-D-01': { status: 'fail', by: 'engineer', evidence: 'e: 500', at: 1 }, 'VAL-D-02': { status: 'untested', by: 'engineer', evidence: '', at: 1 } },
        receipts: { ...receipts, stale: true },
        checks: [{ name: 'lint', status: 'fail' }],
      }),
      true,
    );
    expect(g.canApprove).toBe(true);
    expect(g.warnings).toEqual(['1 assertion fails.', '1 untested assertion without a reason.', 'A receipt covers a different commit than the one shipping.', '1 check failing.']);
    expect(approveGate(ship({ receipts: null }), false).warnings).toEqual(['No receipts: nothing says what was reviewed and tested.']);
  });
});
