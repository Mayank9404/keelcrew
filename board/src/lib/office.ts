/**
 * The Deck as data: the fleet, one boat per department, and every agent at its own post on its department's boat,
 * worked out from the crew state alone. The 3D harbour and the muster list both draw this, so they always agree. Pure,
 * so it is unit tested.
 *
 * Every agent of a department that is on has a post: a session or a watch at work there, an idle hand, or (switched
 * off) an empty seat. Engineers get one post per session. Whoever has something waiting for you stays at its post and
 * waves; a department that is off is a covered boat with nobody aboard.
 */
import { LEAD, fromLabel, sessionRole } from '../labels';
import type { CrewState, InboxItem, Role, ScheduleInfo, Session } from '../types';
import { AGENTS } from './agentCatalog';
import { agentOn, type AgentManifest } from './agents';
import { DEPARTMENTS } from './departmentCatalog';
import { ACTIVITY, leadSession } from './derive';
import { clock, percent } from './format';
import { departmentOn } from './org';
import { cardsForYou, jobLight, stuckItems, type StuckItem } from './triage';

/** Posts on the flagship (bridge to rounds), then one per other boat. */
export type StationId = 'bridge' | 'engine' | 'lookout' | 'chart' | 'rounds' | 'yacht' | 'skiff' | 'tug' | 'lifeboat' | 'launch';
export type BoatId = 'flagship' | 'yacht' | 'skiff' | 'tug' | 'lifeboat' | 'launch';
/** How a sailor is doing. `waiting` always means waiting for you. */
export type Mood = 'waiting' | 'stuck' | 'working' | 'thinking' | 'done' | 'idle';

/** Each department's boat, with the department's colour from its definition (plugins/keelcrew/departments). */
export const BOATS: { id: BoatId; dept: string; name: string; deptName: string; colour: string }[] = [
  { id: 'flagship', dept: 'engineering', name: 'Flagship', deptName: 'Engineering', colour: '#4A7BD0' },
  { id: 'yacht', dept: 'product', name: 'Yacht', deptName: 'Product & Design', colour: '#8A5CC7' },
  { id: 'tug', dept: 'operations', name: 'Tug', deptName: 'Operations', colour: '#7A8494' },
  { id: 'skiff', dept: 'marketing', name: 'Skiff', deptName: 'Marketing', colour: '#D0784A' },
  { id: 'lifeboat', dept: 'support', name: 'Lifeboat', deptName: 'Support', colour: '#3F9E7A' },
  { id: 'launch', dept: 'ceo', name: 'Launch', deptName: 'CEO office', colour: '#B08D57' },
];

export const STATIONS: { id: StationId; boat: BoatId; name: string; blurb: string }[] = [
  { id: 'bridge', boat: 'flagship', name: 'Bridge', blurb: 'The Mate and the scout' },
  { id: 'engine', boat: 'flagship', name: 'Engine room', blurb: 'Engineers, one per task' },
  { id: 'lookout', boat: 'flagship', name: 'Lookout', blurb: 'Review and QA' },
  { id: 'chart', boat: 'flagship', name: 'Chart room', blurb: 'Engineering agents without a set post' },
  { id: 'rounds', boat: 'flagship', name: 'Rounds', blurb: "Engineering's watches" },
  { id: 'yacht', boat: 'yacht', name: 'Yacht', blurb: 'Product & Design' },
  { id: 'tug', boat: 'tug', name: 'Tug', blurb: 'Operations: the watches on their rounds' },
  { id: 'skiff', boat: 'skiff', name: 'Skiff', blurb: 'Marketing' },
  { id: 'lifeboat', boat: 'lifeboat', name: 'Lifeboat', blurb: 'Support' },
  { id: 'launch', boat: 'launch', name: 'Launch', blurb: 'CEO office' },
];

const BOAT_OF_DEPT: Record<string, StationId> = { product: 'yacht', marketing: 'skiff', operations: 'tug', support: 'lifeboat', ceo: 'launch' };

export const MOOD_LABEL: Record<Mood, string> = { waiting: 'Waiting for you', stuck: 'Stuck', working: 'Working', thinking: 'Thinking', done: 'Done', idle: 'Idle' };
/** The neckerchief each mood wears on the ship and in its legend. Thinking shares Working's colour; the pose tells them apart. */
export const SCARF: Record<Mood, string> = { waiting: '#B4237F', stuck: '#C8321F', working: '#2E8C9E', thinking: '#2E8C9E', done: '#4E9BD0', idle: '#8A9AA6' };
const MOOD_ORDER: Mood[] = ['waiting', 'stuck', 'working', 'thinking', 'done', 'idle'];

export interface Sailor {
  /** Stable while the sailor exists: `lead`, `s:<session>`, `job:<agent>`, `a:<agent>` (idle), `off:<agent>` (switched off), `from:<sender>`. */
  id: string;
  /** The agent id, or `lead` / `engineer`: it picks the sailor's outfit. */
  agent: string;
  name: string;
  station: StationId;
  /** Kept for the outfit, which follows the post; always the same as `station`. */
  home: StationId;
  mood: Mood;
  /** Switched off: an empty seat with a folded cap. */
  off: boolean;
  /** One line on what it is doing. */
  detail: string;
  taskKey: string | null;
  sessionId: string | null;
  /** The first waiting item of its own, and how many it has. */
  cardId: string | null;
  cards: number;
}

export interface Station {
  id: StationId;
  boat: BoatId;
  name: string;
  blurb: string;
  sailors: Sailor[];
}

export interface Boat {
  id: BoatId;
  name: string;
  dept: string;
  colour: string;
  deptName: string;
  /** Whether its department is on; an off boat is moored under a cover. */
  on: boolean;
  /** Its department's agents that are switched on, of all of them. */
  agentsOn: number;
  agents: number;
}

/** What the harbour's props show: the harbour board, the radio cabinet, the signal mast and the lighthouse. */
export interface Harbour {
  /** Share of the usage windows used, 0 to 100, or null when unknown. */
  fiveHour: number | null;
  sevenDay: number | null;
  spendToday: number;
  waiting: number;
  stuck: number;
  nextRound: number | null;
  /** Signals: all work paused, notifications muted, the usage guard holding new work. */
  paused: boolean;
  quiet: boolean;
  guarded: boolean;
  /** The Mac helper: up to date, out of date, or not reachable. */
  helper: 'ok' | 'old' | 'down';
}

export interface Office {
  harbour: Harbour;
  boats: Boat[];
  stations: Station[];
  sailors: Sailor[];
  /** Items waiting for you (the same count as the Sign-offs badge), sailors at work, sailors stuck, empty seats. */
  waiting: number;
  working: number;
  stuck: number;
  off: number;
  /** When the next scheduled round is due, or null when none is (or schedules are paused). */
  nextRound: number | null;
}

/** Agents whose post their department and kind don't give. */
const POSTED: Record<string, StationId> = { scout: 'bridge', reviewer: 'lookout', qa: 'lookout', contractor: 'engine', engineer: 'engine' };

/** The post an agent belongs to: a few by name, the rest by their department's boat (on the flagship, by kind). */
export function homeStation(role: Role, agent: string | null, manifests: AgentManifest[] = AGENTS): StationId {
  if (role === 'lead') return 'bridge';
  const id = agent ?? 'engineer';
  if (POSTED[id]) return POSTED[id];
  const m = manifests.find((x) => x.id === id);
  if (!m) return role === 'engineer' ? 'engine' : 'chart';
  if (m.department && BOAT_OF_DEPT[m.department]) return BOAT_OF_DEPT[m.department];
  return m.kind === 'scheduled' ? 'rounds' : 'chart';
}

export const boatOf = (station: StationId): BoatId => STATIONS.find((s) => s.id === station)!.boat;

const oneLine = (text: string | null | undefined, max = 90): string => {
  const line = (text ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

function sessionMood(s: Session): Mood {
  if (s.paused || s.status === 'error') return 'stuck';
  if (s.status === 'starting') return 'thinking';
  if (s.status !== 'running') return 'idle';
  if (s.activity === 'thinking') return 'thinking';
  return s.activity === 'idle' || s.activity === 'waiting' ? 'idle' : 'working';
}

const hand = (p: Pick<Sailor, 'id' | 'agent' | 'name' | 'station'> & Partial<Sailor>): Sailor => ({ mood: 'idle', off: false, detail: '', taskKey: null, sessionId: null, cardId: null, cards: 0, home: p.station, ...p });

function fromSession(s: Session, manifests: AgentManifest[]): Sailor {
  const agent = s.role === 'agent' ? (s.agent ?? 'agent') : s.role;
  const station = homeStation(s.role, s.role === 'agent' ? s.agent : null, manifests);
  const doing = oneLine(s.lastText) || (s.paused ? 'Paused by crew policy' : s.status === 'starting' ? 'Starting' : s.status === 'parked' ? 'Parked' : ACTIVITY[s.activity]?.label || 'Idle');
  return hand({ id: s.role === 'lead' ? 'lead' : `s:${s.id}`, agent, name: sessionRole(s), station, mood: sessionMood(s), detail: doing, taskKey: s.taskKey, sessionId: s.id });
}

/** One sailor for an agent's watches: the one most worth a look (blocked, then just done, then the next due). */
function fromSchedules(agent: string, jobs: ScheduleInfo[], paused: boolean, now: number, manifests: AgentManifest[]): Sailor {
  const read = (j: ScheduleInfo): { mood: Mood; detail: string } => {
    const light = jobLight(j, paused);
    const result = oneLine(j.lastResult.replace(/^(KEEL_RESULT\s*)?(DONE_WITH_CONCERNS|DONE|BLOCKED|NEEDS_CONTEXT)\b[:\s]*/, ''));
    if (light === 'fail') return { mood: 'stuck', detail: result || 'The last round ended blocked' };
    if (j.lastRun && now - j.lastRun < 60 * 60_000 && light !== 'off') return { mood: 'done', detail: `Done ${clock(j.lastRun)}${result ? `: ${result}` : ''}` };
    return { mood: 'idle', detail: paused ? 'Schedules are paused' : j.nextRun ? `Next round ${clock(j.nextRun)}` : j.cadence };
  };
  const all = jobs.map(read);
  const best = all.reduce((a, b) => (MOOD_ORDER.indexOf(b.mood) < MOOD_ORDER.indexOf(a.mood) ? b : a));
  return hand({ id: `job:${agent}`, agent, name: manifests.find((m) => m.id === agent)?.name ?? jobs[0].label, station: homeStation('agent', agent, manifests), mood: best.mood, detail: best.detail });
}

/** The sailor a waiting item belongs to: its session, else the same sender on the same task, else the same sender. */
function ownerOf(card: InboxItem, sailors: Sailor[]): Sailor | undefined {
  if (card.from === 'lead') return sailors.find((s) => s.id === 'lead');
  const live = sailors.filter((s) => !s.off);
  // Never hand an item about one task to a sailor busy on another.
  const fits = (s: Sailor) => s.agent === card.from && (card.taskKey === null || s.taskKey === null || s.taskKey === card.taskKey);
  return (
    (card.sessionId ? live.find((s) => s.sessionId === card.sessionId) : undefined) ??
    live.find((s) => s.agent === card.from && s.taskKey !== null && s.taskKey === card.taskKey) ??
    live.find((s) => fits(s) && s.sessionId === null) ??
    live.find(fits) ??
    // An agent switched off since it posted: its empty seat fills again while the item waits.
    sailors.find((s) => s.off && s.agent === card.from)
  );
}

function ownerOfStuck(item: StuckItem, sailors: Sailor[]): Sailor | undefined {
  if (item.kind === 'lead') return sailors.find((s) => s.id === 'lead');
  if (item.kind === 'job') return sailors.find((s) => s.id === `job:${item.agent ?? item.id.replace(/^job:/, '')}`);
  const onTask = (s: Sailor) => item.taskKey !== null && s.taskKey === item.taskKey;
  // Its session; else the same agent on the task; else (a budget or a stale task) the task's engineer, or anyone on it.
  return (
    (item.sessionId ? sailors.find((s) => s.sessionId === item.sessionId) : undefined) ??
    (item.agent ? sailors.find((s) => s.agent === item.agent && onTask(s)) : undefined) ??
    sailors.find((s) => s.agent === 'engineer' && onTask(s)) ??
    sailors.find(onTask)
  );
}

/** Whether a department is on, as Settings → Crew has it; a department the catalog does not know counts as on. */
function deptOn(crew: CrewState, id: string): boolean {
  const d = DEPARTMENTS.find((x) => x.id === id);
  return !d || departmentOn(crew.config.org, d);
}

/** The whole Deck at one moment. */
export function officeModel(crew: CrewState, now: number, manifests: AgentManifest[] = AGENTS): Office {
  const sailors: Sailor[] = [];
  const lead = leadSession(crew);
  sailors.push(lead ? fromSession(lead, manifests) : hand({ id: 'lead', agent: 'lead', name: LEAD, station: 'bridge', detail: 'Ready' }));
  // A watch's round that has ended (parked) is not aboard: its watch sailor stands for it.
  for (const s of crew.sessions) if (s.id !== lead?.id && s.status !== 'stopped' && s.role !== 'lead' && !(s.job && s.status === 'parked')) sailors.push(fromSession(s, manifests));

  // Watches: one sailor per agent, unless a round of it is running right now (then its session is aboard).
  const jobs = new Map<string, ScheduleInfo[]>();
  // A schedule without an agent stands on its own, under its schedule id.
  for (const j of crew.schedules) if (j.enabled) jobs.set(j.agent ?? j.id, [...(jobs.get(j.agent ?? j.id) ?? []), j]);
  for (const [agent, list] of jobs) {
    if (crew.sessions.some((s) => s.job && s.agent === agent && (s.status === 'running' || s.status === 'starting'))) continue;
    sailors.push(fromSchedules(agent, list, crew.schedulesPaused, now, manifests));
  }

  // Every other agent of a department that is on: an idle hand when it is switched on, an empty seat when not.
  const cfg = { org: crew.config.org, agents: crew.config.agents };
  const aboard = new Set(sailors.map((s) => (s.agent === 'engineer' ? 'engineer' : s.agent)));
  for (const m of manifests) {
    if (aboard.has(m.id) || (m.department && !deptOn(crew, m.department))) continue;
    const on = agentOn(cfg, m);
    sailors.push(hand({ id: on ? `a:${m.id}` : `off:${m.id}`, agent: m.id, name: m.name, station: homeStation(m.id === 'engineer' ? 'engineer' : 'agent', m.id, manifests), off: !on, detail: on ? 'Ready, nothing to do yet' : 'Switched off' }));
  }

  for (const item of stuckItems(crew, now)) {
    const who = ownerOfStuck(item, sailors);
    if (!who) continue;
    who.mood = 'stuck';
    who.detail = oneLine(item.detail) || item.title;
  }

  const forYou = cardsForYou(crew);
  for (const card of forYou) {
    let who = ownerOf(card, sailors);
    if (!who) {
      const station = homeStation(card.from === 'engineer' ? 'engineer' : 'agent', card.from === 'engineer' ? null : card.from, manifests);
      who = hand({ id: `from:${card.from}:${card.taskKey ?? ''}`, agent: card.from, name: fromLabel(card.from), station, taskKey: card.taskKey });
      sailors.push(who);
    }
    who.cards++;
    who.off = false;
    if (who.cardId) continue;
    who.cardId = card.id;
    if (who.id === 'lead' || who.mood === 'stuck') continue;
    who.mood = 'waiting';
    who.detail = oneLine(card.title);
  }

  const rank = (s: Sailor): number => (s.off ? 99 : MOOD_ORDER.indexOf(s.mood));
  sailors.sort((a, b) => Number(b.id === 'lead') - Number(a.id === 'lead') || rank(a) - rank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const live = sailors.filter((s) => !s.off);
  const boats: Boat[] = BOATS.map((b) => {
    const team = manifests.filter((m) => (m.department ?? 'engineering') === b.dept);
    const name = crew.org?.departments.find((d) => d.id === b.dept)?.name ?? b.deptName;
    return { id: b.id, name: b.name, dept: b.dept, colour: b.colour, deptName: name, on: deptOn(crew, b.dept), agentsOn: team.filter((m) => agentOn(cfg, m)).length, agents: team.length };
  });
  const pct = (w: { utilization: number } | null) => (w ? Math.round(percent(w.utilization)) : null);
  const nextRound = crew.schedulesPaused ? null : crew.schedules.reduce<number | null>((min, j) => (j.enabled && j.nextRun && j.nextRun > now && (min === null || j.nextRun < min) ? j.nextRun : min), null);
  const stuck = live.filter((s) => s.mood === 'stuck').length;
  const harbour: Harbour = {
    fiveHour: pct(crew.usage.fiveHour),
    sevenDay: pct(crew.usage.sevenDay),
    spendToday: crew.usage.todayCostUsd,
    waiting: forYou.length,
    stuck,
    nextRound,
    paused: crew.paused,
    quiet: crew.dndUntil !== null && crew.dndUntil > now,
    guarded: crew.usage.guarded,
    helper: crew.helper.status === 'missing' ? 'down' : crew.helper.status === 'old' ? 'old' : 'ok',
  };
  return {
    harbour,
    boats,
    stations: STATIONS.map((st) => ({ ...st, sailors: sailors.filter((s) => s.station === st.id) })),
    sailors,
    waiting: forYou.length,
    working: live.filter((s) => s.mood === 'working' || s.mood === 'thinking').length,
    stuck,
    off: sailors.length - live.length,
    nextRound,
  };
}

/** The sailors a station has room to draw, and how many are left over for the list. */
export function berths(station: Station, room: number): { shown: Sailor[]; more: number } {
  const shown = station.sailors.slice(0, Math.max(0, room));
  return { shown, more: station.sailors.length - shown.length };
}

/** The Deck in one sentence, for the page header and for screen readers. */
export function officeSummary(o: Office): string {
  const parts = [`${o.working} at work`];
  if (o.waiting) parts.push(`${o.waiting} waiting for you`);
  if (o.stuck) parts.push(`${o.stuck} stuck`);
  if (o.off) parts.push(`${o.off} switched off`);
  return parts.join(', ');
}

export type SailorAction = { kind: 'card'; id: string } | { kind: 'task'; key: string } | { kind: 'transcript'; id: string } | { kind: 'chat' } | { kind: 'agent' } | { kind: 'crew' };

/** What the sailor card offers, most useful first: its waiting item, its task, the Mate chat, its transcript; idle or switched off, its settings; else Muster. */
export function sailorActions(s: Sailor): SailorAction[] {
  const out: SailorAction[] = [];
  if (s.cardId) out.push({ kind: 'card', id: s.cardId });
  if (s.taskKey) out.push({ kind: 'task', key: s.taskKey });
  if (s.id === 'lead') out.push({ kind: 'chat' });
  if (s.sessionId) out.push({ kind: 'transcript', id: s.sessionId });
  if (s.off || s.id.startsWith('a:')) out.push({ kind: 'agent' });
  if (!out.length) out.push({ kind: 'crew' });
  return out;
}
