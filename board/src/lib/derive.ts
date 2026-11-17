import { fromLabel } from '../labels';
import type { Activity, CrewState, InboxItem, Phase, Session, Task } from '../types';
import { toMs } from './format';
import { ceoOn } from './org';

/** Where a task sits on the board and in the Tasks list. */
export type Group = 'need' | 'work' | 'review' | 'qa' | 'proposed' | 'queued' | 'done';
export type ColorVar = '--work' | '--you' | '--block' | '--ok' | '--qa' | '--muted' | '--warn' | '--agent';

export const ACTIVITY: Record<Activity, { tag: string; label: string }> = {
  typing: { tag: 'coding', label: 'Writing code' },
  reading: { tag: 'reading', label: 'Reading code' },
  terminal: { tag: 'running commands', label: 'Running commands' },
  thinking: { tag: 'thinking', label: 'Thinking' },
  waiting: { tag: 'waiting', label: 'Waiting' },
  idle: { tag: 'idle', label: 'Idle' },
};

export const PHASES = ['Plan', 'Build', 'Verify', 'Review', 'Ship', 'QA'] as const;

const PHASE_INDEX: Record<Phase, number> = { spec: 0, plan: 0, build: 1, verify: 2, review: 3, approval: 4, pr: 4, qa: 5, done: 6 };
export const phaseIndex = (p: Phase): number => PHASE_INDEX[p] ?? 0;

export { isJiraKey, shortKey } from './keys';

export const isOpen = (i: InboxItem): boolean => i.status === 'open';
export const openInbox = (crew: CrewState): InboxItem[] => crew.inbox.filter(isOpen);
/** Open cards that need the captain; ones the Chief of Staff held wait apart while the CEO seat is on. */
export const needsYouInbox = (crew: Pick<CrewState, 'inbox' | 'config' | 'org'>): InboxItem[] => {
  const ceo = ceoOn(crew);
  return crew.inbox.filter((i) => isOpen(i) && !(ceo && i.held));
};
export const isLive = (s: Session | undefined): boolean => !!s && (s.status === 'running' || s.status === 'starting');

export function sessionById(crew: CrewState, id: string | null | undefined): Session | undefined {
  return id ? crew.sessions.find(s => s.id === id) : undefined;
}

/** The task's current engineer session. */
export function engineerSession(crew: CrewState, task: Task): Session | undefined {
  const byId = sessionById(crew, task.sessionId);
  if (byId) return byId;
  let best: Session | undefined;
  for (const s of crew.sessions) if (s.taskKey === task.key && s.role === 'engineer' && (!best || s.updatedAt > best.updatedAt)) best = s;
  return best;
}

export function leadSession(crew: CrewState): Session | undefined {
  const byId = sessionById(crew, crew.leadSessionId);
  if (byId) return byId;
  let best: Session | undefined;
  for (const s of crew.sessions) if (s.role === 'lead' && (!best || s.updatedAt > best.updatedAt)) best = s;
  return best;
}

const ACTIVE_LIKE = new Set<Task['status']>(['active', 'pr', 'qa']);

export interface TaskView {
  task: Task;
  group: Group;
  color: ColorVar;
  /** Status line for lists and the drawer. */
  label: string;
  /** Short status, a word or two. */
  tag: string;
  /** First open inbox item for this task that needs you. */
  need: InboxItem | null;
  /** In config.intake.skipKeys. */
  skipped: boolean;
  session: Session | undefined;
  activity: Activity;
}

function needLabel(item: InboxItem | null): { label: string; tag: string } {
  switch (item?.kind) {
    case 'ship':
      return { label: 'Needs your approval', tag: 'needs approval' };
    case 'question':
      return { label: 'Has a question', tag: 'has a question' };
    case 'qa':
      return { label: 'QA verdict to review', tag: 'QA verdict' };
    case 'conflict':
      return { label: 'Memory conflict', tag: 'memory conflict' };
    case 'proposal':
      return { label: 'Waiting for your OK', tag: 'waiting for OK' };
    case 'start':
      return { label: 'Ready to start', tag: 'start session' };
    case 'playbook':
      return { label: 'Standing order changes', tag: 'standing orders' };
    default:
      return { label: 'Needs a decision', tag: 'needs you' };
  }
}

function sessionLabel(s: Session | undefined): { label: string; tag: string; live: boolean } {
  if (!s) return { label: 'Starting', tag: 'starting', live: false };
  switch (s.status) {
    case 'starting':
      return { label: 'Starting', tag: 'starting', live: true };
    case 'parked':
      return { label: 'Parked', tag: 'parked', live: false };
    case 'stopped':
      return { label: 'Stopped', tag: 'stopped', live: false };
    case 'interrupted':
      return { label: 'Interrupted', tag: 'interrupted', live: false };
    case 'error':
      return { label: 'Session error', tag: 'error', live: false };
    default: {
      const a = ACTIVITY[s.activity] ?? ACTIVITY.idle;
      return { label: a.label, tag: a.tag, live: s.status === 'running' && s.activity !== 'idle' && s.activity !== 'waiting' };
    }
  }
}

export function taskView(crew: CrewState, task: Task, open: InboxItem[]): TaskView {
  const items = open.filter(i => i.taskKey === task.key);
  const need = items.find(i => i.kind === 'ship') ?? items[0] ?? null;
  const session = engineerSession(crew, task);
  const activity: Activity = session?.activity ?? 'idle';
  const skipped = crew.config.intake.skipKeys?.includes(task.key) ?? false;
  const base = { task, need, session, activity, skipped };
  switch (task.status) {
    case 'done':
      return { ...base, group: 'done', color: '--ok', label: task.closedAt ? 'Done' : 'Done', tag: 'done' };
    case 'cancelled':
      return { ...base, group: 'done', color: '--muted', label: 'Cancelled', tag: 'cancelled' };
    case 'proposed':
      return need
        ? { ...base, group: 'proposed', color: '--warn', label: 'Waiting for your OK', tag: 'proposed' }
        : { ...base, group: 'proposed', color: '--warn', label: 'Proposed', tag: 'proposed' };
    case 'queued':
      // A task stays queued until its new session joins, so an open start card is what it waits on.
      return need?.kind === 'start'
        ? { ...base, group: 'need', color: '--you', ...needLabel(need) }
        : { ...base, group: 'queued', color: '--muted', label: 'Queued', tag: 'queued' };
    default:
      break;
  }
  if (ACTIVE_LIKE.has(task.status) && (need || task.needsDecision)) {
    const n = needLabel(need);
    return { ...base, group: 'need', color: '--you', ...n };
  }
  if (task.status === 'pr') return { ...base, group: 'review', color: '--ok', label: 'PR open', tag: 'PR open' };
  if (task.status === 'qa') return { ...base, group: 'qa', color: '--qa', label: !task.jiraStatus ? 'Waiting on QA' : /^in qa$/i.test(task.jiraStatus) ? 'In QA' : `In QA · ${task.jiraStatus}`, tag: 'in QA' };
  const eng = task.agents.find(a => a.id === 'engineer');
  const other = !eng ? task.agents.find(a => /^(run|active|work|start|wait)/i.test(a.status)) : undefined;
  if (other) {
    const name = fromLabel(other.id);
    return /^wait/i.test(other.status)
      ? { ...base, group: 'work', color: '--muted', label: `${name} waiting`, tag: 'waiting' }
      : { ...base, group: 'work', color: '--work', label: `${name} at work`, tag: 'working' };
  }
  const s = sessionLabel(session);
  if (eng?.paused || session?.paused) return { ...base, group: 'work', color: '--block', label: 'Paused by crew policy', tag: 'paused' };
  if (eng && (eng.resultStatus === 'BLOCKED' || eng.resultStatus === 'NEEDS_CONTEXT')) return { ...base, group: 'work', color: '--block', label: eng.resultStatus === 'BLOCKED' ? 'Blocked' : 'Needs context', tag: 'blocked' };
  if (task.reopened) return { ...base, group: 'qa', color: '--qa', label: `QA reopened · ${s.label.toLowerCase()}`, tag: 'QA reopened' };
  return { ...base, group: 'work', color: s.live ? '--work' : '--muted', label: s.label, tag: s.tag };
}

export type Grouped = Record<Group, TaskView[]>;

export function groupTasks(crew: CrewState): Grouped {
  const open = openInbox(crew);
  const g: Grouped = { need: [], work: [], review: [], qa: [], proposed: [], queued: [], done: [] };
  for (const t of crew.tasks) {
    const v = taskView(crew, t, open);
    // Skipped tickets never show up as proposals.
    if (v.skipped && (v.group === 'proposed' || v.group === 'queued')) continue;
    g[v.group].push(v);
  }
  const bySlot = (a: TaskView, b: TaskView) => (a.task.slot ?? 99) - (b.task.slot ?? 99) || a.task.createdAt - b.task.createdAt;
  g.work.sort(bySlot);
  g.need.sort((a, b) => (a.need?.createdAt ?? a.task.updatedAt) - (b.need?.createdAt ?? b.task.updatedAt));
  g.review.sort((a, b) => b.task.updatedAt - a.task.updatedAt);
  g.qa.sort((a, b) => b.task.updatedAt - a.task.updatedAt);
  g.proposed.sort((a, b) => b.task.createdAt - a.task.createdAt);
  g.queued.sort((a, b) => a.task.updatedAt - b.task.updatedAt);
  g.done.sort((a, b) => toMs(b.task.closedAt ?? b.task.updatedAt) - toMs(a.task.closedAt ?? a.task.updatedAt));
  return g;
}

export interface LeadStatus {
  word: 'online' | 'busy' | 'ready' | 'offline' | 'starting' | 'asked you';
  color: ColorVar;
  /** Short status, a word or two. */
  short: string;
}

/** The Mate's latest chat message ends with a question you haven't replied to. */
export function leadAsked(crew: CrewState): boolean {
  for (let i = crew.chat.length - 1; i >= 0; i--) {
    const m = crew.chat[i];
    if (m.who === 'system') continue;
    if (m.who !== 'lead') return false;
    const last = m.text.trim().split('\n').filter(l => l.trim()).pop() ?? '';
    return /\?[*_)\s]*$/.test(last);
  }
  return false;
}

export function leadStatus(crew: CrewState): LeadStatus {
  const s = leadSession(crew);
  const working = !!s && (s.status === 'starting' || (s.status === 'running' && s.activity !== 'idle' && s.activity !== 'waiting'));
  if (!working && leadAsked(crew)) return { word: 'asked you', color: '--you', short: 'asked you' };
  if (!s) return { word: 'ready', color: '--muted', short: 'ready' };
  switch (s.status) {
    case 'parked':
    case 'interrupted':
    case 'stopped':
      return { word: 'ready', color: '--muted', short: 'ready' };
    case 'starting':
      return { word: 'starting', color: '--work', short: 'starting' };
    case 'error':
      return { word: 'offline', color: '--block', short: 'error' };
    default:
      break;
  }
  const busy = s.status === 'running' && s.activity !== 'idle' && s.activity !== 'waiting';
  return busy
    ? { word: 'busy', color: '--work', short: s.activity === 'thinking' ? 'thinking' : s.activity === 'reading' ? 'reading' : s.activity === 'terminal' ? 'running a command' : 'writing' }
    : { word: 'online', color: '--ok', short: s.activity === 'waiting' ? 'waiting' : 'listening' };
}
