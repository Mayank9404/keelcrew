/** How a card reads once it's answered, and the tone of a QA verdict. */
import type { InboxItem } from '../types';
import { clock } from './format';

/** Resolved automatically rather than by the captain; shown calmly, never as needing attention. */
export const isAutoApproved = (item: InboxItem): boolean => item.status === 'approved' && /^auto-approved/i.test(item.answer ?? '');

/** Where an answer given away from the Mac stands: waiting for the Mac, or done there. Empty for any other card. */
export function macLine(item: Pick<InboxItem, 'grantPending' | 'grantResult'>): string {
  if (item.grantPending) return ' Waiting for your Mac: it carries this out within a minute while the Mate session is open.';
  // The panel's outcome reads "done (low risk, until …)": the details are what's left to say.
  return item.grantResult ? ` Done on your Mac: ${item.grantResult.replace(/^done\s*/i, '').replace(/^\((.*)\)$/, '$1') || 'done'}.` : '';
}

/** One line describing how a resolved card ended. */
export function outcome(item: InboxItem): string {
  const text = outcomeText(item);
  return text && !item.withdrawn ? `${text}${macLine(item)}` : text;
}

/** The outcome itself, before where an answer from the phone stands. */
function outcomeText(item: InboxItem): string {
  const at = item.resolvedAt ? ` at ${clock(item.resolvedAt)}` : '';
  if (item.withdrawn) return `Withdrawn by the Mate: ${item.withdrawn}`;
  if (isAutoApproved(item)) return `Auto-approved${at}.`;
  const posted = item.postGrant ? ' Approved to post once.' : '';
  switch (item.status) {
    case 'approved':
      return item.answer ? `You chose ${item.answer}${at}.${posted}` : `Approved${at}.${posted}`;
    case 'rejected':
      return item.kind === 'ship' ? `Not yet${at}${item.note ? `: “${item.note}”` : '.'}` : item.answer ? `Rejected${at}: “${item.answer}”` : `Rejected${at}.`;
    case 'answered':
      if (item.batch) return `All ${item.items.length} answered${at}.`;
      if (item.kind === 'start' && (item.answer ?? 'Started') === 'Started') return `Started${at}.`;
      if (item.autoStarted) return `Started by the Mate, within your auto-start settings${at}.`;
      return item.answer ? `You answered “${item.answer}”${at}.${posted}` : `Answered${at}.`;
    case 'dismissed':
      return `Dismissed${at}.`;
    default:
      return '';
  }
}

export type Tone = 'ok' | 'warn' | 'block' | 'muted';

/** A QA verdict's tone: PASS ok, FAIL block, PARTIAL and the rest warn. */
export function verdictTone(verdict: string | null): Tone {
  const v = (verdict ?? '').toLowerCase();
  if (v.startsWith('pass')) return 'ok';
  if (v.startsWith('fail')) return 'block';
  return v ? 'warn' : 'muted';
}
