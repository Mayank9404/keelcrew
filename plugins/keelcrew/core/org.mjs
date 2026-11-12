// @ts-check
// The company: this captain's department and role switches, seats, approved models, budgets and goals, as the Mate's
// panel mirrors them from the board's settings/main.org into ~/.keelcrew/org.json (the board changes only by the captain's
// clicks), merged with the manifests' defaults. Plus the staffing the crew command does from it: whether a fresh
// engineer or a contractor takes a ticket, and which model that role runs on once the captain approved one.
import { agentById, DIFFICULTIES, EFFORTS, listAgents } from './agents.mjs';
import { BUSY_STALE_MS, crewDirs, readRegistry } from './crew.mjs';
import { listDepartments } from './departments.mjs';
import { isObject, readJsonLoose, readJsonStrict } from './fsx.mjs';
import { readRecord } from './ledger.mjs';
import { paths } from './paths.mjs';

/** How long an idle engineer keeps its seat, so one waiting between turns or on a quick answer isn't replaced. */
const SEAT_IDLE_MS = 15 * 60_000;

/**
 * @typedef {{ model: string, effort: string }} ModelChoice
 * @typedef {{ id: string, title: string, metric: string, target: string, weight: number }} Goal
 */

/** The org thresholds in rules.json. @returns {Record<string, any>} */
export const orgRules = () => readJsonStrict(paths.rules(), {})?.org ?? {};

/** The raw mirror of settings/main.org ({} until the panel wrote one, or when it is damaged). @returns {Record<string, any>} */
export const readOrgFile = () => {
  const f = readJsonLoose(paths.org(), {});
  return isObject(f) ? f : {};
};

/**
 * The resolved company: what is on, the seats, approved models, budgets and goals.
 * @param {{ file?: Record<string, any> }} [opts] (tests pass the file)
 */
export function readOrg({ file } = {}) {
  const f = file ?? readOrgFile();
  const r = orgRules();
  const departments = listDepartments().map((d) => {
    const own = f.departments?.[d.id]?.enabled;
    return { ...d, enabled: !d.switchable ? true : typeof own === 'boolean' ? own : d.defaultEnabled };
  });
  const on = new Set(departments.filter((d) => d.enabled).map((d) => d.id));
  const roles = listAgents().map((a) => {
    // The role's switch in Settings → Crew (`org.roles`), else `agents[id].enabled`, else the manifest's default.
    const own = f.roles?.[a.id]?.enabled ?? f.agents?.[a.id]?.enabled;
    const deptOn = !a.department || on.has(a.department);
    return { id: a.id, department: a.department ?? null, memberKind: a.memberKind ?? 'agent', enabled: deptOn && (typeof own === 'boolean' ? own : a.defaultEnabled) };
  });
  return {
    ceo: on.has('ceo'),
    departments,
    roles,
    // The board's "Engineers at once" (the panel mirrors it as maxWorkers), else the rules'.
    seats: Number.isInteger(f.maxWorkers) && f.maxWorkers > 0 ? f.maxWorkers : Number(r.seats ?? 4),
    approved: isObject(f.models?.approved) ? f.models.approved : {},
    budgets: isObject(f.budgets) ? f.budgets : {},
    /** Goals count only with the CEO seat on. @type {Goal[]} */
    goals: on.has('ceo') && Array.isArray(f.goals) ? f.goals.filter((g) => isObject(g) && typeof g.id === 'string') : [],
  };
}

/**
 * The captain's choice for a role in Settings → Crew (per difficulty for the engineer), or null when there is none and
 * modelFor falls back. A proposed model is never used.
 * @param {ReturnType<typeof readOrg>} org @param {string} roleId @param {string | null} [difficulty]
 * @returns {ModelChoice | null}
 */
export function approvedModel(org, roleId, difficulty) {
  const a = org.approved[roleId];
  if (!isObject(a)) return null;
  const pick = isObject(a.byDifficulty) ? (difficulty ? a.byDifficulty[difficulty] : null) : a;
  return isObject(pick) && typeof pick.model === 'string' && typeof pick.effort === 'string' ? { model: pick.model, effort: pick.effort } : null;
}

/**
 * What a role runs on when neither the captain nor its manifest says: the engineer ladder, effort by difficulty. The board
 * keeps the same values (board/src/lib/models.ts); scripts/check-consistency.mjs checks they agree.
 */
export const ENGINEER_LADDER = { model: 'claude-sonnet-5-5', effort: { simple: 'high', moderate: 'xhigh', complex: 'xhigh', critical: 'xhigh' } };

/** The Agent tool's name for a model: its family (opus, sonnet, haiku, fable); null for a model outside them. @param {string} model */
export const aliasOf = (model) => /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-|$)/.exec(String(model))?.[1] ?? null;

/**
 * The model and effort a role runs on, and where they come from: the captain's choice in Settings → Crew (per
 * difficulty for the engineer), else the role's manifest, else the engineer ladder's default. `lead` and `subagents`
 * have no manifest. No difficulty reads as moderate. `alias` is the model's family, the form the Agent tool takes.
 * @param {ReturnType<typeof readOrg>} org @param {string} roleId @param {string | null} [difficulty]
 * @returns {ModelChoice & { source: 'approved' | 'manifest' | 'default', alias: string | null }}
 */
export function modelFor(org, roleId, difficulty) {
  const d = difficulty && DIFFICULTIES.includes(difficulty) ? difficulty : 'moderate';
  const approved = approvedModel(org, roleId, d);
  if (approved) return { ...approved, source: 'approved', alias: aliasOf(approved.model) };
  const m = roleId === 'lead' || roleId === 'subagents' ? null : agentById(roleId);
  const model = typeof m?.model === 'string' && m.model ? m.model : null;
  const effort = typeof m?.effort === 'string' && EFFORTS.includes(m.effort) ? m.effort : null;
  const use = model ?? ENGINEER_LADDER.model;
  return { model: use, effort: effort ?? ENGINEER_LADDER.effort[/** @type {keyof typeof ENGINEER_LADDER.effort} */ (d)], source: model || effort ? 'manifest' : 'default', alias: aliasOf(use) };
}

/**
 * Who a file belongs to for proposals: the login with the most of its recent commits (bots aside), the newest commit
 * breaking a tie; null when no person committed to it. Every crew asks the same question and gets the same answer.
 * @param {{ login?: string | null }[]} commits newest first
 * @returns {string | null}
 */
export function mainAuthor(commits) {
  /** @type {Map<string, number>} */
  const n = new Map();
  for (const c of commits) if (c.login && !c.login.endsWith('[bot]')) n.set(c.login, (n.get(c.login) ?? 0) + 1);
  let top = null;
  for (const [login, k] of n) if (top === null || k > (n.get(top) ?? 0)) top = login;
  return top;
}

/**
 * Who takes a ticket: a fresh engineer, or a contractor for a mechanical ticket when that role is on. With every seat
 * taken the ticket waits.
 * @param {{ mechanical?: boolean }} t
 * @param {ReturnType<typeof readOrg>} org
 * @param {{ seatsUsed?: number }} [load] (tests; else from the registry)
 */
export function staff(t, org, load) {
  const now = Date.now();
  // A seat is an engineer at work: its session busy (a stuck busy flag goes stale), or active in the last 15 minutes,
  // whatever its ticket's status. A parked, PR or QA ticket whose engineer sits idle holds none, a closed one none at all.
  const working = (/** @type {any} */ m) => {
    let r = null;
    try {
      r = m.key ? readRecord(String(m.key)) : null;
    } catch {
      /* a damaged record counts as unknown */
    }
    if (r?.status === 'done' || r?.status === 'cancelled') return false;
    const last = Math.max(Number(m.at) || 0, Number(m.lastAt) || 0);
    return (m.busy === true && now - last < BUSY_STALE_MS) || now - last < SEAT_IDLE_MS;
  };
  const seatsUsed = load?.seatsUsed ?? crewDirs(readRegistry()).filter((m) => m.role === 'engineer' && working(m)).length;
  const seatFree = seatsUsed < org.seats;
  const contractor = !!t.mechanical && org.roles.some((r) => r.id === 'contractor' && r.enabled);
  const reason = !seatFree ? 'every seat is taken' : contractor ? 'a mechanical ticket goes to a contractor' : 'a fresh engineer';
  return { role: contractor ? 'contractor' : 'engineer', wait: !seatFree, reason };
}

/** The role a staffing result runs as, for the model: the contractor's manifest, else the engineer's. @param {{ role: string }} s */
export const roleIdOf = (s) => (s.role === 'contractor' && agentById('contractor') ? 'contractor' : 'engineer');
