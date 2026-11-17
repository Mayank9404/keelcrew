/**
 * Three questions: what's waiting on the captain (items ranked by urgency and risk), what's moving, and what's
 * stuck. Pure: everything comes from the crew state, so it's unit tested.
 */
import type { CrewState, InboxItem, ScheduleInfo, Task } from '../types';
import { budgetLevel } from './costs';
import { engineerSession, isOpen, leadSession, needsYouInbox } from './derive';
import { ceoOn } from './org';
import { gateTier } from './risk';
import { gridSummary, validationGrid } from './validation';

/** What a card is, as the captain sees it. */
export type CardVariant = 'ship' | 'qa' | 'proposal' | 'start' | 'playbook' | 'conflict' | 'batch' | 'digest' | 'draft' | 'question' | 'info';

export function cardVariant(i: Pick<InboxItem, 'kind' | 'batch' | 'items' | 'draft' | 'from'>): CardVariant {
  switch (i.kind) {
    case 'ship':
    case 'qa':
    case 'proposal':
    case 'start':
    case 'playbook':
    case 'conflict':
    case 'info':
      return i.kind;
    default:
      if (i.batch) return 'batch';
      if (i.items.length && (i.from === 'comms' || i.items.some((x) => !!x.channel))) return 'digest';
      if (i.draft) return 'draft';
      return 'question';
  }
}

export const VARIANT_LABEL: Record<CardVariant, string> = {
  ship: 'Sign-off',
  qa: 'QA verdict',
  proposal: 'Proposal',
  start: 'Start session',
  playbook: 'Standing orders',
  conflict: 'Memory conflict',
  batch: 'Questions',
  digest: 'Inbox digest',
  draft: 'Draft',
  question: 'Question',
  info: 'Note',
};

/** How much a card should pull the eye: drives its stripe and its place in the list. */
export type Severity = 'critical' | 'high' | 'medium' | 'normal' | 'low';
export const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, normal: 3, low: 4 };

export function cardSeverity(i: InboxItem): Severity {
  if (i.urgent || (i.batch && i.items.some((x) => x.urgent && !x.answer))) return 'critical';
  const v = cardVariant(i);
  if (v === 'ship') {
    const t = gateTier(i.risk);
    return t === 'high' ? 'high' : t === 'medium' ? 'medium' : 'normal';
  }
  if (v === 'qa') return /^fail/i.test(i.verdict ?? '') ? 'high' : 'normal';
  if (v === 'question' || v === 'batch') return 'normal';
  if (v === 'draft' || v === 'conflict') return 'normal';
  return 'low';
}

/** Within one severity, the order the captain usually wants to clear them. */
const VARIANT_ORDER: CardVariant[] = ['ship', 'qa', 'question', 'batch', 'draft', 'conflict', 'start', 'proposal', 'playbook', 'digest', 'info'];

/** Unranked urgent cards, then the Chief of Staff's order (`rank`), then the rest. */
const rankBand = (i: InboxItem): number => (i.rank !== null ? 1 : cardSeverity(i) === 'critical' ? 0 : 2);

/**
 * Urgent first, then by severity, then by kind, then oldest first (it has waited longest). Cards the Chief of Staff
 * ranked keep its order, after urgent ones it hasn't seen yet.
 */
export function rankCards(items: InboxItem[]): InboxItem[] {
  return [...items].sort(
    (a, b) =>
      rankBand(a) - rankBand(b) ||
      (a.rank ?? 0) - (b.rank ?? 0) ||
      SEVERITY_RANK[cardSeverity(a)] - SEVERITY_RANK[cardSeverity(b)] ||
      VARIANT_ORDER.indexOf(cardVariant(a)) - VARIANT_ORDER.indexOf(cardVariant(b)) ||
      a.createdAt - b.createdAt ||
      a.id.localeCompare(b.id),
  );
}

/** Open cards that need the captain, ranked; held cards wait apart. */
export const cardsForYou = (crew: Pick<CrewState, 'inbox' | 'config' | 'org'>): InboxItem[] => rankCards(needsYouInbox(crew));

/** Open cards the Chief of Staff held until tomorrow, ranked; none with the CEO seat off (nobody would clear them). */
export const heldCards = (crew: Pick<CrewState, 'inbox' | 'config' | 'org'>): InboxItem[] => (ceoOn(crew) ? rankCards(crew.inbox.filter((i) => isOpen(i) && i.held)) : []);

/* ---------- stuck ---------- */

export type StuckKind = 'paused' | 'blocked' | 'failing' | 'stale' | 'budget' | 'job' | 'lead' | 'silent';

export interface StuckItem {
  id: string;
  kind: StuckKind;
  title: string;
  detail: string;
  taskKey: string | null;
  agent: string | null;
  sessionId: string | null;
  /** The denials that paused a session, when known. */
  reasons: string[];
}

const OPEN = new Set<Task['status']>(['active', 'pr', 'qa']);
const SILENT_MS = 45 * 60_000;

/**
 * What can't move without someone: paused sessions, blocked agents, failing assertions, stale receipts, budgets over
 * their limit, watches that ended BLOCKED, requests the Mate hasn't picked up, and engineers gone silent.
 */
export function stuckItems(crew: CrewState, now: number): StuckItem[] {
  const out: StuckItem[] = [];
  const seenPaused = new Set<string>();
  const openCardTasks = new Set(crew.inbox.filter((i) => i.status === 'open' && i.kind === 'ship').map((i) => i.taskKey));
  for (const t of crew.tasks) {
    if (!OPEN.has(t.status)) continue;
    for (const a of t.agents) {
      if (a.paused) {
        seenPaused.add(`${t.key}:${a.id}`);
        out.push({ id: `paused:${t.key}:${a.id}`, kind: 'paused', title: `${t.key} · ${a.id} paused`, detail: a.pauseReasons.length ? a.pauseReasons.join(' · ') : 'Crew policy paused it after repeated denials.', taskKey: t.key, agent: a.id, sessionId: a.sessionId, reasons: a.pauseReasons });
      } else if (a.resultStatus === 'BLOCKED' || a.resultStatus === 'NEEDS_CONTEXT' || /^block/i.test(a.status)) {
        out.push({ id: `blocked:${t.key}:${a.id}`, kind: 'blocked', title: `${t.key} · ${a.id} ${a.resultStatus === 'NEEDS_CONTEXT' ? 'needs context' : 'is blocked'}`, detail: a.result.replace(/^(BLOCKED|NEEDS_CONTEXT):\s*/, '') || 'No reason given yet.', taskKey: t.key, agent: a.id, sessionId: a.sessionId, reasons: [] });
      }
    }
    if (t.status === 'active') {
      const s = gridSummary(validationGrid(t.contract, t.validation));
      if (s.fail && !openCardTasks.has(t.key)) out.push({ id: `failing:${t.key}`, kind: 'failing', title: `${t.key} · ${s.fail} assertion${s.fail === 1 ? '' : 's'} failing`, detail: validationGrid(t.contract, t.validation).filter((r) => r.status === 'fail').map((r) => r.id).join(', '), taskKey: t.key, agent: 'engineer', sessionId: t.sessionId, reasons: [] });
      if (t.receipts?.stale) out.push({ id: `stale:${t.key}`, kind: 'stale', title: `${t.key} · receipts out of date`, detail: 'The review or tests cover an older commit; the engineer has to verify again before shipping.', taskKey: t.key, agent: 'engineer', sessionId: t.sessionId, reasons: [] });
      const s2 = engineerSession(crew, t);
      if (!t.parked && crew.feeds.crew.at && s2 && s2.status === 'parked' && now - Math.max(t.updatedAt, s2.lastEventAt) > SILENT_MS && !t.needsDecision) {
        out.push({ id: `silent:${t.key}`, kind: 'silent', title: `${t.key} · engineer silent`, detail: `No activity for ${Math.round((now - Math.max(t.updatedAt, s2.lastEventAt)) / 60_000)} minutes.`, taskKey: t.key, agent: 'engineer', sessionId: s2.id, reasons: [] });
      }
    }
  }
  for (const s of crew.sessions) {
    if (!s.paused) continue;
    const id = `${s.taskKey}:${s.agent ?? s.role}`;
    if (seenPaused.has(id)) continue;
    out.push({ id: `paused:${s.id}`, kind: 'paused', title: `${s.taskKey ?? 'Crew'} · ${s.agent ?? s.role} paused`, detail: 'Crew policy paused it after repeated denials.', taskKey: s.taskKey, agent: s.agent ?? s.role, sessionId: s.id, reasons: [] });
  }
  if (crew.costs) {
    for (const [key, t] of Object.entries(crew.costs.tickets)) {
      const budget = crew.tasks.find((x) => x.key === key)?.budgetUsd ?? crew.config.budgets.perTicketUsd;
      const b = budgetLevel(t.costUsd, budget);
      if (b.level === 'over') out.push({ id: `budget:${key}`, kind: 'budget', title: `${key} · over budget`, detail: `$${t.costUsd.toFixed(2)} of $${budget?.toFixed(2)}`, taskKey: key, agent: null, sessionId: null, reasons: [] });
    }
  }
  for (const j of crew.schedules) {
    if (j.enabled && /^BLOCKED\b/.test(j.lastResult)) out.push({ id: `job:${j.id}`, kind: 'job', title: `${j.label} ended blocked`, detail: j.handoff?.next ? `Next: ${j.handoff.next}` : j.lastResult.replace(/^BLOCKED:\s*/, ''), taskKey: null, agent: j.agent, sessionId: null, reasons: [] });
  }
  const waiting = crew.requests.filter((r) => now - r.at > 10 * 60_000);
  const lead = leadSession(crew);
  if (waiting.length && (!lead || lead.status === 'parked' || lead.status === 'stopped' || lead.status === 'error')) {
    out.push({ id: 'lead', kind: 'lead', title: 'The Mate hasn’t picked up your requests', detail: `${waiting.length} waiting, the oldest for ${Math.round((now - Math.min(...waiting.map((r) => r.at))) / 60_000)} minutes. Open the Mate session and say “start the crew”.`, taskKey: null, agent: 'lead', sessionId: lead?.id ?? null, reasons: [] });
  }
  const order: StuckKind[] = ['paused', 'lead', 'blocked', 'budget', 'failing', 'job', 'stale', 'silent'];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.id.localeCompare(b.id));
}

/* ---------- question windows ---------- */

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The next question window at or after `now` (today's, else tomorrow's first); null without valid windows. */
export function nextWindow(windows: string[], now: number): { at: number; label: string } | null {
  const valid = windows.map((w) => w.trim()).filter((w) => TIME.test(w)).sort();
  if (!valid.length) return null;
  const at = (w: string, dayOffset: number) => {
    const [h, m] = w.split(':').map(Number);
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  for (const w of valid) if (at(w, 0) >= now) return { at: at(w, 0), label: w };
  return { at: at(valid[0], 1), label: `tomorrow ${valid[0]}` };
}

/** A schedule's light on the jobs board. */
export type JobLight = 'ok' | 'warn' | 'fail' | 'off' | 'idle';

export function jobLight(j: ScheduleInfo, paused: boolean): JobLight {
  if (!j.enabled || paused) return 'off';
  if (/^(BLOCKED|NEEDS_CONTEXT)\b/.test(j.lastResult)) return 'fail';
  if (/^DONE_WITH_CONCERNS\b/.test(j.lastResult) || (j.openIssues ?? 0) > 0) return 'warn';
  return j.lastRun ? 'ok' : 'idle';
}
