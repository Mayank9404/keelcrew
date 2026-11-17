/**
 * The log: what happened, newest first, built from the times the board already records on tasks, on waiting items and
 * on the Mate's own decisions. It holds nothing of its own.
 */
import type { CrewState, InboxItem } from '../types';
import { toMs } from './format';
import { isAutoApproved, outcome } from './inbox';
import { VARIANT_LABEL, cardVariant, cardsForYou } from './triage';

export interface LogEntry {
  id: string;
  ts: number;
  /** Who did it: an agent id, `lead`, `you`, or `keelcrew` for the board itself. */
  who: string;
  text: string;
  taskKey: string | null;
  /** The waiting item to open, when this entry is one still waiting for the captain. */
  waitingId: string | null;
  tone: 'you' | 'block' | 'muted' | 'plain';
}

const kindOf = (i: InboxItem): string => VARIANT_LABEL[cardVariant(i)];

export function logEntries(crew: Pick<CrewState, 'tasks' | 'inbox' | 'config' | 'org'>): LogEntry[] {
  const out: LogEntry[] = [];
  // The same set the Sign-offs count uses: open, not with the Mate, not held.
  const waiting = new Set(cardsForYou(crew).map((i) => i.id));
  for (const t of crew.tasks) {
    const base = { taskKey: t.key, waitingId: null };
    if (t.startedAt) out.push({ ...base, id: `t:${t.key}:start`, ts: t.startedAt, who: 'lead', text: `Started: ${t.title}`, tone: 'plain' });
    else out.push({ ...base, id: `t:${t.key}:new`, ts: t.createdAt, who: 'keelcrew', text: `Added: ${t.title}`, tone: 'muted' });
    for (const a of t.agents) {
      if (!a.at || !a.result) continue;
      const blocked = a.paused || a.resultStatus === 'BLOCKED' || a.resultStatus === 'NEEDS_CONTEXT';
      out.push({ ...base, id: `t:${t.key}:${a.id}:${a.round ?? 0}`, ts: a.at, who: a.id, text: a.result, tone: blocked ? 'block' : 'plain' });
    }
    if (t.mergedAt) out.push({ ...base, id: `t:${t.key}:merged`, ts: t.mergedAt, who: 'keelcrew', text: 'Pull request merged', tone: 'plain' });
    if (t.closedAt && t.closedAt !== t.mergedAt) out.push({ ...base, id: `t:${t.key}:closed`, ts: t.closedAt, who: 'keelcrew', text: t.status === 'cancelled' ? 'Cancelled' : 'Finished', tone: 'muted' });
  }
  for (const i of crew.inbox) {
    const open = i.status === 'open';
    const waits = waiting.has(i.id);
    out.push({ id: `i:${i.id}:new`, ts: i.createdAt, who: i.from, text: `${kindOf(i)}: ${i.title}`, taskKey: i.taskKey, waitingId: waits ? i.id : null, tone: waits ? 'you' : 'plain' });
    if (!open && i.resolvedAt) {
      const alone = isAutoApproved(i) || i.autoStarted || !!i.withdrawn;
      out.push({ id: `i:${i.id}:done`, ts: i.resolvedAt, who: alone ? 'lead' : 'you', text: `${i.title}: ${outcome(i)}`, taskKey: i.taskKey, waitingId: null, tone: 'plain' });
    }
  }
  for (const e of out) e.ts = toMs(e.ts);
  return out.sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1));
}

/** Entries grouped by calendar day, newest day first, in the order given. */
export function byDay(entries: LogEntry[]): { day: number; entries: LogEntry[] }[] {
  const days: { day: number; entries: LogEntry[] }[] = [];
  for (const e of entries) {
    const d = new Date(e.ts);
    d.setHours(0, 0, 0, 0);
    const day = d.getTime();
    const last = days[days.length - 1];
    if (last && last.day === day) last.entries.push(e);
    else days.push({ day, entries: [e] });
  }
  return days;
}
