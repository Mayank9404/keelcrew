// @ts-check
// The agent catalog: agents/<id>.json manifests, checked against the contract in docs/architecture.md.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isObject } from './fsx.mjs';
import { paths } from './paths.mjs';

export const AGENT_KINDS = ['ticket', 'scheduled', 'on-demand'];
export const AGENT_RUN_AS = ['session', 'subagent', 'schedule'];
/** Who fills a role: the captain, an engineer, a contractor, or a plain agent. */
export const MEMBER_KINDS = ['human', 'engineer', 'contractor', 'agent'];
/** The policy profile a role's sessions run under. `agent` is the standard agent rules. */
export const POLICY_PROFILES = ['lead', 'code', 'agent', 'docs', 'reader', 'drafts'];
/** Measures of a role's work the ledger can give. */
export const METRICS = ['bugs', 'reverts', 'qa-first-pass', 'owner-edits', 'cost', 'speed', 'avoidable-questions', 'accepted', 'edited', 'impact', 'hit-rate', 'triage-correct', 'time-to-triage'];
/** The board's existing inbox card kinds a role may raise: no role adds a new kind. */
export const CARD_SHAPES = ['ship', 'proposal', 'question', 'qa', 'info', 'start'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const DIFFICULTIES = ['simple', 'moderate', 'complex', 'critical'];
const ID = /^[a-z][a-z0-9-]*$/;

/**
 * @typedef {{ cron: string, label?: string }} AgentSchedule
 * @typedef {{ model: string, effort: string }} ModelChoice
 * @typedef {ModelChoice | { byDifficulty: Record<string, ModelChoice> }} ProposedModel
 * @typedef {{
 *   id: string, name: string, summary: string, kind: 'ticket' | 'scheduled' | 'on-demand',
 *   runAs: 'session' | 'subagent' | 'schedule', skill: string, defaultEnabled: boolean,
 *   trigger?: string, schedule?: AgentSchedule | AgentSchedule[], model?: string, effort?: string, canShip?: boolean,
 *   settings?: Record<string, { type: string, default?: unknown, label?: string }>,
 *   department?: string, reportsTo?: string, memberKind?: string, policy?: string, reads?: string[], drafts?: string[],
 *   outputs?: { id: string, label: string }[], metrics?: string[], cards?: string[], budgetShare?: number,
 *   proposedModel?: ProposedModel
 * }} AgentManifest
 * @typedef {{ file: string, problems: string[] }} InvalidAgent
 */

/** @param {unknown} v */
const text = (v) => typeof v === 'string' && v.trim().length > 0;

/** @param {any} s */
const scheduleOk = (s) => s && typeof s === 'object' && text(s.cron) && (s.label === undefined || typeof s.label === 'string');

/** @param {any} v */
const textList = (v) => Array.isArray(v) && v.every(text);

/** @param {any} c */
const choiceOk = (c) => isObject(c) && text(c.model) && EFFORTS.includes(c.effort);

/**
 * What's wrong with a manifest's org fields (all optional: a manifest without them is a standard agent). Shared by the
 * agent check and the tests.
 * @param {any} m
 * @returns {string[]}
 */
function orgProblems(m) {
  /** @type {string[]} */
  const out = [];
  for (const k of ['department', 'reportsTo']) if (m[k] !== undefined && !(typeof m[k] === 'string' && ID.test(m[k]))) out.push(`${k} must be an id`);
  if (m.memberKind !== undefined && !MEMBER_KINDS.includes(m.memberKind)) out.push(`memberKind must be one of ${MEMBER_KINDS.join(', ')}`);
  if (m.policy !== undefined && !POLICY_PROFILES.includes(m.policy)) out.push(`policy must be one of ${POLICY_PROFILES.join(', ')}`);
  for (const k of ['reads', 'drafts']) if (m[k] !== undefined && !textList(m[k])) out.push(`${k} must be a list of names`);
  if (m.outputs !== undefined && !(Array.isArray(m.outputs) && m.outputs.every((o) => isObject(o) && text(o.id) && text(o.label)))) out.push('outputs must be a list of {id, label}');
  if (m.metrics !== undefined && !(Array.isArray(m.metrics) && m.metrics.every((x) => METRICS.includes(x)))) out.push(`metrics must come from ${METRICS.join(', ')}`);
  if (m.cards !== undefined && !(Array.isArray(m.cards) && m.cards.every((x) => CARD_SHAPES.includes(x)))) out.push(`cards must come from ${CARD_SHAPES.join(', ')}`);
  if (m.budgetShare !== undefined && !(typeof m.budgetShare === 'number' && m.budgetShare >= 0 && m.budgetShare <= 1)) out.push('budgetShare must be a number from 0 to 1');
  if (m.proposedModel !== undefined) {
    const p = m.proposedModel;
    const byDifficulty = isObject(p) && isObject(p.byDifficulty);
    const ok = byDifficulty ? DIFFICULTIES.every((d) => choiceOk(p.byDifficulty[d])) : choiceOk(p);
    if (!ok) out.push(`proposedModel must be {model, effort} or {byDifficulty} covering ${DIFFICULTIES.join(', ')}, effort one of ${EFFORTS.join(', ')}`);
  }
  return out;
}

/**
 * What's wrong with a manifest; empty when it is valid. `id` must match the file name when one is given.
 * @param {any} m @param {string} [fileId]
 * @returns {string[]}
 */
export function agentProblems(m, fileId) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['not a JSON object'];
  /** @type {string[]} */
  const out = [];
  if (typeof m.id !== 'string' || !ID.test(m.id)) out.push('id must be lowercase letters, digits and dashes');
  else if (fileId && m.id !== fileId) out.push(`id "${m.id}" doesn't match the file name`);
  for (const k of ['name', 'summary', 'skill']) if (!text(m[k])) out.push(`${k} is required`);
  if (!AGENT_KINDS.includes(m.kind)) out.push(`kind must be one of ${AGENT_KINDS.join(', ')}`);
  if (!AGENT_RUN_AS.includes(m.runAs)) out.push(`runAs must be one of ${AGENT_RUN_AS.join(', ')}`);
  if (typeof m.defaultEnabled !== 'boolean') out.push('defaultEnabled must be true or false');
  if (m.canShip !== undefined && typeof m.canShip !== 'boolean') out.push('canShip must be true or false');
  for (const k of ['trigger', 'model', 'effort']) if (m[k] !== undefined && typeof m[k] !== 'string') out.push(`${k} must be text`);
  if (m.schedule !== undefined && !(Array.isArray(m.schedule) ? m.schedule.length && m.schedule.every(scheduleOk) : scheduleOk(m.schedule))) {
    out.push('schedule needs a cron');
  }
  if (m.settings !== undefined) {
    if (!m.settings || typeof m.settings !== 'object' || Array.isArray(m.settings)) out.push('settings must be an object');
    else for (const [k, s] of Object.entries(m.settings)) if (!s || typeof s !== 'object' || !text(s.type)) out.push(`setting "${k}" needs a type`);
  }
  out.push(...orgProblems(m));
  return out;
}

/**
 * Every manifest in a folder (the plugin's agents/ by default): valid ones sorted by id, invalid ones with what's wrong.
 * @param {string} [dir]
 * @returns {{ agents: AgentManifest[], invalid: InvalidAgent[] }}
 */
export function scanAgents(dir = paths.agents()) {
  /** @type {string[]} */
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    /* no agents yet */
  }
  /** @type {AgentManifest[]} */
  const agents = [];
  /** @type {InvalidAgent[]} */
  const invalid = [];
  for (const file of files) {
    let m;
    try {
      m = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (e) {
      invalid.push({ file, problems: [`not valid JSON (${/** @type {Error} */ (e).message})`] });
      continue;
    }
    const problems = agentProblems(m, basename(file, '.json'));
    if (problems.length) invalid.push({ file, problems });
    else agents.push(m);
  }
  agents.sort((a, b) => a.id.localeCompare(b.id));
  return { agents, invalid };
}

/** The valid manifests, sorted by id. Invalid files are skipped; `scanAgents` reports them. @param {string} [dir] */
export const listAgents = (dir) => scanAgents(dir).agents;

/** One valid manifest, or null. @param {string} id @param {string} [dir] */
export const agentById = (id, dir) => listAgents(dir).find((a) => a.id === id) ?? null;

/**
 * Whether an agent may ever push code or open a pull request (with the captain's approval on a launch card): its manifest's
 * `canShip`, else true only for ticket agents. Scheduled and on-demand agents never ship unless their manifest says so.
 * @param {Pick<AgentManifest, 'kind' | 'canShip'>} m
 */
export const canShipOf = (m) => (typeof m.canShip === 'boolean' ? m.canShip : m.kind === 'ticket');

/** The profile a registry role runs under when its manifest names none. */
const ROLE_PROFILES = { lead: 'lead', engineer: 'code', agent: 'agent', job: 'agent' };

/**
 * The policy profile a crew member runs under: its role manifest's `policy`, else its registry role's (lead → lead,
 * engineer → code, agent and job → agent, which are today's rules). An unknown role gets the most restricted, reader.
 * @param {{ role: string, agent?: string | null }} member @param {string} [dir] the agents folder (tests)
 * @returns {string}
 */
export function profileOf(member, dir) {
  const m = member.agent ? agentById(member.agent, dir) : null;
  if (m?.policy) return m.policy;
  return /** @type {Record<string, string>} */ (ROLE_PROFILES)[member.role] ?? 'reader';
}

/** Whether a crew member is a contractor: an engineer whose role manifest says so. @param {{ role: string, agent?: string | null }} member @param {string} [dir] */
export const isContractor = (member, dir) => member.role === 'engineer' && !!member.agent && agentById(member.agent, dir)?.memberKind === 'contractor';

/**
 * Whether a crew member may ship: engineers and the Mate may (with an approval); an agent or job only when its manifest
 * allows it. An agent the catalog doesn't know never ships.
 * @param {{ role: string, agent?: string | null }} member @param {string} [dir] the agents folder (tests)
 */
export function memberCanShip(member, dir) {
  if (member.role === 'engineer' || member.role === 'lead') return true;
  const m = member.agent ? agentById(member.agent, dir) : null;
  return !!m && canShipOf(m);
}
