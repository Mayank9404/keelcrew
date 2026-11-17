/**
 * The board's live state: the windows of the database the page subscribes to, plus what the helper reports from this
 * Mac. `buildState` turns it into the view model; `publish` hands it to React once per frame.
 */
import { AGENTS } from '../lib/agentCatalog';
import type { HelperInfo } from '../lib/compat';
import { modelFor } from '../lib/models';
import { DAY } from '../lib/format';
import { schedulesNow } from '../lib/schedule';
import { DIFFICULTIES, orgSettingsOf } from '../lib/org';
import { writeAccess } from '../lib/owner';
import { CLOSED_STATUSES, mergeById } from '../lib/paging';
import { crewStore, pushEvent } from '../lib/store';
import { deepMerge, isObj, versionOf } from '../lib/versions';
import type { Costs, CrewConfig, CrewState, Difficulty, Feed, FeedName, HealthState, Metrics, ModelChoice, OrgInfo, Session, SpendState, Task, Usage } from '../types';
import { type Member, type Row, memberSession, num, str, toChat, toInbox, toRequest, toSchedule, toTask } from './convert';
import type { DocSnap, QuerySnap } from './runtime';

export const S = {
  tasksOpen: new Map<string, Row>(),
  tasksClosed: new Map<string, Row>(),
  tasksClosedFull: false,
  inboxOpen: new Map<string, Row>(),
  inboxRecent: new Map<string, Row>(),
  chat: new Map<string, Row>(),
  decisions: new Map<string, Row>(),
  requests: new Map<string, Row>(),
  lead: null as Row | null,
  usage: null as Row | null,
  /** The plan's windows as the Mate session last read them on this Mac (crew_state's `usage`); fresher than `crew/usage`. */
  macUsage: null as Record<string, unknown> | null,
  /** The Mate's panel's last Jira scan on this Mac (`crew_state.scan`, its scan.json). */
  macScan: null as Record<string, unknown> | null,
  schedules: null as Row | null,
  settings: null as Row | null,
  settingsSeen: false,
  /** The helper's Mac-side config (config_get). */
  local: null as Record<string, unknown> | null,
  members: [] as Member[],
  overlaps: {} as Record<string, string[]>,
  /** The helper's `costs`, kept from the last good answer. */
  costs: null as Costs | null,
  /** The helper's `org`, and the allowances from `crew_state`, kept from the last good answer. */
  org: null as OrgInfo | null,
  spend: null as SpendState | null,
  health: null as HealthState | null,
  /** When the panel in the Mate session last read the board (crew_state's `panel`). */
  panelAt: null as number | null,
  /** When each helper feed last loaded, and its error since then. */
  feeds: { crew: freshFeed(), costs: freshFeed(), org: freshFeed() } as Record<FeedName, Feed>,
  seen: new Map<string, number>(),
  hasDb: false,
  isOwner: false,
  helper: { status: 'unknown', version: null, schema: null } as HelperInfo,
};

function freshFeed(): Feed {
  return { at: null, error: null, missing: false };
}

export const rowOf = (s: DocSnap, id = s.id): Row => ({ ...(s.data() ?? {}), _id: id, _v: versionOf(s) });
export const rowsOf = (snap: QuerySnap): Map<string, Row> => new Map(snap.docs.map((d) => [d.id, rowOf(d)]));
export const docRow = (s: DocSnap, id: string): Row | null => (s.exists ? rowOf(s, id) : null);

/** Every task row, open and recently closed. */
export const taskRows = (): Map<string, Row> => mergeById(S.tasksOpen, S.tasksClosed);
export const inboxRows = (): Map<string, Row> => mergeById(S.inboxRecent, S.inboxOpen);

/* ---------- settings ---------- */

const DEFAULT_CONFIG: CrewConfig = {
  owner: { name: 'You' },
  maxWorkers: 4,
  workingHours: { start: '09:30' },
  repos: {},
  intake: {
    jiraSite: '',
    jql: '',
    autoStartMaxDifficulty: 'moderate',
    skipKeys: [],
  },
  usageGuard: { enabled: true, maxFiveHourPct: 85, maxSevenDayPct: 90 },
  editor: 'vscode',
  shipMode: 'free',
  codeReview: { args: 'high --fix' },
  terminal: 'desktop',
  agents: {},
  budgets: { perTicketUsd: null, perRoleUsd: {} },
  questionWindows: [],
  sessions: { startMethod: 'card' },
  org: {},
  merges: { autoStatus: false },
  ledger: { enabled: true },
  phoneApprovals: true,
  harbourLook: true,
  pushNotifications: false,
};

const START_METHODS: CrewConfig['sessions']['startMethod'][] = ['card', 'routine'];

/** Keys that live on the Mac (the helper's config.json), not in the shared board. */
export const LOCAL_KEYS = ['editor', 'terminal', 'repos', 'owner', 'compactWindow', 'shipMode'] as const;

/** The shared settings document without the board's own bookkeeping fields. */
export function sharedSettings(): Record<string, unknown> {
  const { _id: _i, _v: _v2, ...rest } = S.settings ?? ({} as Row);
  void _i;
  void _v2;
  return rest;
}

export function configOf(): CrewConfig {
  const c = deepMerge(DEFAULT_CONFIG, sharedSettings());
  if (!START_METHODS.includes(c.sessions?.startMethod)) c.sessions = { ...DEFAULT_CONFIG.sessions };
  c.org = orgSettingsOf(c.org);
  const l = S.local;
  c.compactWindow = typeof l?.compactWindow === 'number' && Number.isFinite(l.compactWindow) ? l.compactWindow : 'auto';
  // This Mac's: a shipMode in the shared settings is ignored.
  c.shipMode = l?.shipMode === 'free' || l?.shipMode === 'card' ? l.shipMode : DEFAULT_CONFIG.shipMode;
  if (l) {
    const ide = isObj(l.ide) ? l.ide : {};
    const editor = str(ide.editor);
    const terminal = str(ide.terminal);
    if (editor) c.editor = editor as CrewConfig['editor'];
    if (terminal) c.terminal = terminal as CrewConfig['terminal'];
    if (typeof l.owner === 'string' && l.owner) c.owner = { name: l.owner };
    if (isObj(l.repos)) {
      c.repos = Object.fromEntries(
        Object.entries(l.repos)
          .filter(([, r]) => isObj(r))
          .map(([name, r]) => {
            const o = r as Record<string, unknown>;
            return [name, { path: str(o.path), baseBranch: str(o.baseBranch, 'main'), enabled: o.enabled !== false, prGate: str(o.prGate) || null }];
          }),
      );
    }
  }
  return c;
}

/* ---------- view model ---------- */

const memberFor = (key: string): Member | undefined => S.members.find((m) => m.key === key && (m.role === 'engineer' || m.agent === 'engineer'));

/** What a role runs on (`lead`, or an agent id) at a ticket's difficulty, as Settings → Crew resolves it (lib/models.ts). */
function inUse(roleId: string, difficulty: unknown): ModelChoice {
  const d = DIFFICULTIES.includes(difficulty as Difficulty) ? (difficulty as Difficulty) : null;
  const { model, effort } = modelFor(orgSettingsOf(sharedSettings().org), roleId, AGENTS.find((a) => a.id === roleId) ?? null, d);
  return { model, effort };
}

/** A member's fallback model: the Mate's, else its agent's (an engineer is `engineer`, a contractor `contractor`). */
const memberInUse = (m: Member, row: Row | undefined): ModelChoice => inUse(m.role === 'lead' ? 'lead' : (m.agent ?? 'engineer'), row?.difficulty);
const NOW = (): number => Date.now();

export const tasksNow = (): Task[] => [...taskRows().values()].map((r) => toTask(r, { member: memberFor(r._id), overlaps: S.overlaps, now: NOW() }));

export function sessionsOf(tasks: Task[]): Session[] {
  const now = NOW();
  const rows = taskRows();
  const out: Session[] = S.members.map((m) => {
    const row = m.key ? rows.get(m.key) : undefined;
    return memberSession(m, row, now, memberInUse(m, row));
  });
  // Without the helper (a phone, another viewer), sessions come from what the crew wrote to the board.
  const lead = S.lead;
  if (!out.some((s) => s.role === 'lead') && lead) {
    const at = num(lead.heartbeatAt) ?? 0;
    const working = lead.status === 'working';
    const use = inUse('lead', null);
    out.push({
      id: str(lead.sessionId) || 'keel-lead', taskKey: null, role: 'lead', agent: null, job: false, model: use.model, effort: use.effort,
      status: now - at < 45 * 60_000 ? (working ? 'running' : 'idle') : 'parked', activity: working ? 'thinking' : 'idle', lastTool: null, lastText: str(lead.note) || null,
      costUsd: 0, turns: 0, cwd: '', createdAt: at, updatedAt: at, lastEventAt: at, contextTokens: null, contextMax: null, paused: false,
    });
  }
  for (const t of tasks) {
    if (!t.sessionId || out.some((s) => s.id === t.sessionId)) continue;
    if (t.agents.length && !t.agents.some((a) => a.id === 'engineer')) continue;
    const row = rows.get(t.key);
    const parked = t.parked || t.status !== 'active';
    const act = ({ working: 'typing', thinking: 'thinking', waiting: 'waiting' } as Record<string, Session['activity']>)[str(row?.activity)] ?? 'typing';
    const use = inUse('engineer', t.difficulty);
    out.push({
      id: t.sessionId, taskKey: t.key, role: 'engineer', agent: 'engineer', job: false, model: str(row?.model) || use.model, effort: (row?.effort as Session['effort']) ?? use.effort,
      status: parked ? 'parked' : 'running', activity: parked ? 'idle' : act, lastTool: null, lastText: t.lastSummary || null, costUsd: t.costUsd, turns: 0,
      cwd: t.worktree ?? '', createdAt: t.createdAt, updatedAt: t.updatedAt, lastEventAt: t.updatedAt, contextTokens: null, contextMax: null,
      paused: t.agents.some(a => a.id === 'engineer' && a.paused),
    });
  }
  return out;
}

function usageOf(): Usage {
  const u: Record<string, unknown> = S.usage ?? {};
  // The panel in the Mate session reads the plan's windows every few minutes (the Mac's copy); `crew/usage` holds the Mate's
  // guard, and sometimes windows of its own. The more recent windows win, and a full window is the plan's limit reached.
  const own = u.fiveHour || u.sevenDay ? u : null;
  const mac = S.macUsage && (!own || (num(S.macUsage.updatedAt) ?? 0) > (num(u.updatedAt) ?? 0)) ? S.macUsage : null;
  const w: Record<string, unknown> = mac ?? own ?? {};
  const full = [w.fiveHour, w.sevenDay].some((x) => (num((x as Record<string, unknown> | null)?.utilization) ?? 0) >= 1);
  const status: Usage['status'] = full ? 'rejected' : mac ? 'allowed' : own ? ((u.status as Usage['status']) ?? 'unknown') : 'unknown';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayCostUsd = S.members.filter((m) => (m.lastAt ?? 0) >= today.getTime()).reduce((a, m) => a + m.costUsd, 0);
  return {
    status, fiveHour: (w.fiveHour as Usage['fiveHour']) ?? null, sevenDay: (w.sevenDay as Usage['sevenDay']) ?? null,
    todayCostUsd: Math.round(todayCostUsd * 100) / 100, updatedAt: num(w.updatedAt) ?? 0, guarded: u.guarded === true, guardReason: (u.guardReason as string) ?? null,
  };
}

export function buildState(): CrewState {
  const tasks = tasksNow();
  const sessions = sessionsOf(tasks);
  const lead = sessions.find((s) => s.role === 'lead');
  const closed = tasks.filter((t) => (CLOSED_STATUSES as readonly string[]).includes(t.status)).length;
  return {
    tasks,
    sessions,
    inbox: [...inboxRows().values()].map(toInbox),
    chat: [...S.chat.values()].map(toChat).sort((a, b) => a.ts - b.ts),
    usage: usageOf(),
    paused: S.lead?.paused === true,
    dndUntil: num(S.lead?.dndUntil),
    schedules: schedulesNow((Array.isArray(S.schedules?.items) ? S.schedules.items : []).map(toSchedule).filter((x): x is NonNullable<typeof x> => !!x), AGENTS, configOf(), S.macScan),
    schedulesPaused: S.schedules?.paused === true || (S.settings?.schedule as { paused?: unknown } | undefined)?.paused === true,
    leadSessionId: lead?.id ?? null,
    heldQuestions: heldOf(S.lead?.heldQuestions),
    costs: S.costs,
    feeds: { crew: { ...S.feeds.crew }, costs: { ...S.feeds.costs }, org: { ...S.feeds.org } },
    org: S.org,
    spend: S.spend,
    health: S.health,
    archivedCount: closed,
    archivedMore: S.tasksClosedFull,
    requests: [...S.requests.values()].map(toRequest).sort((a, b) => a.at - b.at),
    config: configOf(),
    settingsVersion: settingsVersion(),
    access: writeAccess({ hasDb: S.hasDb, isOwner: S.hasDb ? S.isOwner : null }),
    helper: S.helper,
    // Only while the helper answers and a Mate is registered: otherwise a quiet panel isn't the Mate's.
    panelAt: S.feeds.crew.error || !S.members.some((m) => m.role === 'lead') ? null : S.panelAt,
    now: NOW(),
  };
}

/** `crew/lead.heldQuestions`: a list of held cards, or a count. */
const heldOf = (v: unknown): number => (Array.isArray(v) ? v.length : num(v) ?? 0);

let raf = 0;
let timer = 0;
/**
 * Hands the state to React once per frame. A timer backs the frame up, since a page the viewer can't see paints no
 * frames: the data still lands, at most a few times a second.
 */
export function publish(): void {
  if (raf || timer) return;
  const run = () => {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    raf = 0;
    timer = 0;
    crewStore.set((s) => ({ ...s, crew: buildState(), conn: S.hasDb ? 'open' : s.conn }));
  };
  raf = requestAnimationFrame(run);
  timer = window.setTimeout(run, 250);
}

/** The settings document's version as last seen (null before it exists). */
export const settingsVersion = (): string | null => (S.settings ? S.settings._v : S.settingsSeen ? 'missing' : null);

/** New steps from the helper become activity events. */
export function emitActivity(m: Member): void {
  const id = m.dir;
  if (!m.lastAt || S.seen.get(id) === m.lastAt) return;
  const first = !S.seen.has(id);
  S.seen.set(id, m.lastAt);
  if (first || !m.lastText) return;
  const sid = memberSession(m, undefined, NOW(), memberInUse(m, undefined)).id;
  pushEvent({ id: m.lastAt, sessionId: sid, taskKey: m.key, ts: m.lastAt, kind: m.lastTool ? 'tool' : 'turn_end', tool: m.lastTool, summary: m.lastText, isError: false });
}

export function metrics(): Metrics {
  const now = NOW();
  const rows = taskRows();
  const tasks = tasksNow();
  const done = tasks.filter((t) => t.status === 'done' && t.closedAt);
  const startOf = (t: Task) => t.startedAt ?? t.createdAt;
  const cycles = done.map((t) => (t.closedAt! - startOf(t)) / 3_600_000).filter((x) => x >= 0);
  const waits = tasks.map((t) => (num(rows.get(t.key)?.waitOnYouMs) ?? 0) / 3_600_000).filter((w) => w > 0);
  const daily = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(now - (13 - i) * DAY);
    d.setHours(0, 0, 0, 0);
    return { date: new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10), done: done.filter((t) => t.closedAt! >= d.getTime() && t.closedAt! < d.getTime() + DAY).length };
  });
  return {
    totals: {
      done7d: done.filter((t) => now - t.closedAt! < 7 * DAY).length,
      done30d: done.filter((t) => now - t.closedAt! < 30 * DAY).length,
      avgCycleHours: cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null,
      avgWaitOnYouHours: waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : null,
      reopenRate: done.length ? tasks.filter((t) => t.reopened).length / done.length : null,
    },
    daily,
  };
}
