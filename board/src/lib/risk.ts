/**
 * Risk on launch cards. A high-risk card (or one whose tier is unknown, which counts as high) can be approved only after
 * the captain expanded its diff; "Not yet" is always available. Everything else that should give pause is a warning.
 */
import type { InboxItem, Risk, RiskTier } from '../types';
import { gridSummary, validationGrid } from './validation';

/** The tier the gate goes by: an unknown tier counts as high. Null when the card has no risk at all. */
export function gateTier(risk: Risk | null): Exclude<RiskTier, 'unknown'> | null {
  if (!risk) return null;
  return risk.tier === 'unknown' ? 'high' : risk.tier;
}

/** A full commit id (what `git rev-parse HEAD` prints), the only kind the helper pins an approval to. */
export const isFullSha = (s: string): boolean => /^[0-9a-f]{40,64}$/.test(s);

export const RISK_LABEL: Record<RiskTier, string> = { low: 'Low risk', medium: 'Medium risk', high: 'High risk', unknown: 'Risk unknown' };

export interface ApproveGate {
  /** Open PR, Draft PR and Push only are enabled. */
  canApprove: boolean;
  /** The captain must tick "I've checked the risk" first. */
  needsAck: boolean;
  /** Why approving is off, in words; null when it's on. */
  reason: string | null;
  /** Things to look at before approving (they don't block). */
  warnings: string[];
}

/**
 * Whether the captain may approve a launch card now. `acknowledged`: the captain ticked "I've checked the risk" on this card.
 * The contract is the task's (the card's validation snapshot is matched against it).
 */
export function approveGate(item: Pick<InboxItem, 'status' | 'withdrawn' | 'risk' | 'validation' | 'receipts' | 'checks'>, acknowledged: boolean, contract: { id: string; text: string; kind: 'positive' | 'negative' }[] = []): ApproveGate {
  const warnings: string[] = [];
  if (item.validation || contract.length) {
    const s = gridSummary(validationGrid(contract, item.validation));
    if (s.fail) warnings.push(`${s.fail} assertion${s.fail === 1 ? '' : 's'} fail${s.fail === 1 ? 's' : ''}.`);
    if (s.unexplained) warnings.push(`${s.unexplained} untested assertion${s.unexplained === 1 ? '' : 's'} without a reason.`);
  }
  const r = item.receipts;
  if (!r) warnings.push('No receipts: nothing says what was reviewed and tested.');
  else {
    if (r.stale) warnings.push('A receipt covers a different commit than the one shipping.');
    if (!r.review) warnings.push('No review receipt.');
    else if (r.review.head && r.head && r.review.head !== r.head) warnings.push('The review is for another commit.');
  }
  const failing = item.checks.filter((c) => c.status === 'fail').length;
  if (failing) warnings.push(`${failing} check${failing === 1 ? '' : 's'} failing.`);
  if (item.status !== 'open') return { canApprove: false, needsAck: false, reason: 'Already answered.', warnings };
  if (item.withdrawn) return { canApprove: false, needsAck: false, reason: `Withdrawn by the Mate: ${item.withdrawn}`, warnings };
  if (r?.head && !isFullSha(r.head)) return { canApprove: false, needsAck: false, reason: `The card names commit ${r.head.slice(0, 12)}, not a full commit id, so it can’t be pinned. Ask for a new launch card.`, warnings };
  if (gateTier(item.risk) === 'high' && !acknowledged) return { canApprove: false, needsAck: true, reason: 'High risk: tick “I’ve checked the risk” to approve.', warnings };
  return { canApprove: true, needsAck: false, reason: null, warnings };
}
