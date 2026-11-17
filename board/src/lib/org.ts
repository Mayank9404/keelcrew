/**
 * The company (Settings → Crew, `settings/main.org`): switches and approved models, and the board's own changes to it
 * (a merged PR's row). Pure: no DOM, no runtime.
 */
import type { CrewConfig, CrewState, Difficulty, Effort, MergeRecord, ModelChoice, OrgSettings, RoleModel } from '../types';
import { EFFORTS } from './agents';
import { isObj } from './versions';

export const DIFFICULTIES: Difficulty[] = ['simple', 'moderate', 'complex', 'critical'];
export const SUBAGENTS = 'subagents';
export const SUPPORT_SOURCE = /^(jira:[A-Z][A-Z0-9_]*|teams:\S.*)$/;
export const MAX_GOALS = 3;

export const ID = /^[a-z][a-z0-9-]*$/;

/**
 * `settings/main.org` safe to render and validate: goals without a title and approved models that aren't objects
 * dropped, a damaged part read as unset.
 */
export function orgSettingsOf(v: unknown): OrgSettings {
  if (!isObj(v)) return {};
  const o: OrgSettings = { ...v };
  if (Array.isArray(v.goals)) {
    o.goals = v.goals
      .filter((g): g is Record<string, unknown> => isObj(g) && typeof g.id === 'string' && !!g.id && typeof g.title === 'string' && !!g.title.trim())
      .map((g) => ({ id: g.id as string, title: g.title as string, metric: typeof g.metric === 'string' ? g.metric : '', target: typeof g.target === 'string' ? g.target : '', weight: typeof g.weight === 'number' && Number.isFinite(g.weight) ? g.weight : 1 }));
  } else delete o.goals;
  if (isObj(v.models)) {
    const approved = isObj(v.models.approved) ? v.models.approved : {};
    o.models = { ...v.models, approved: Object.fromEntries(Object.entries(approved).filter(([, m]) => isObj(m) && (!('byDifficulty' in m) || isObj(m.byDifficulty)))) as Record<string, RoleModel> };
  } else delete o.models;
  return o;
}

/** Lowercase words joined by dashes. */
const kebab = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** `base`, or `base-2`, `base-3`… when taken; a base that isn't an id starts with `id`. */
export function uniqueId(base: string, taken: string[]): string {
  const b = ID.test(kebab(base)) ? kebab(base) : `id-${kebab(base)}`.replace(/-+$/, '');
  if (!taken.includes(b)) return b;
  let n = 2;
  while (taken.includes(`${b}-${n}`)) n++;
  return `${b}-${n}`;
}

/** A department's switch: the captain's, else on for one that can't be switched, else its default. */
export function departmentOn(org: OrgSettings | undefined, d: { id: string; switchable: boolean; defaultEnabled: boolean }): boolean {
  if (!d.switchable) return true;
  const own = org?.departments?.[d.id]?.enabled;
  return typeof own === 'boolean' ? own : d.defaultEnabled;
}

/** The CEO seat: the Chief of Staff holds cards for tomorrow (and clears `held`) only while it's on. */
export const ceoOn = (crew: Pick<CrewState, 'config' | 'org'>): boolean => departmentOn(crew.config.org, crew.org?.departments.find((d) => d.id === 'ceo') ?? { id: 'ceo', switchable: true, defaultEnabled: false });

/** A role's own switch: `org.roles`, else `agents` (Settings → Crew writes both), else the manifest's default (as core org.mjs). */
export function roleOn(c: { org?: OrgSettings; agents?: CrewConfig['agents'] }, id: string, defaultEnabled: boolean): boolean {
  const own = c.org?.roles?.[id]?.enabled ?? c.agents?.[id]?.enabled;
  return typeof own === 'boolean' ? own : defaultEnabled;
}

function choiceOf(v: unknown): ModelChoice | null {
  return isObj(v) && typeof v.model === 'string' && v.model && EFFORTS.includes(v.effort as Effort) ? { model: v.model, effort: v.effort as Effort } : null;
}

/** A manifest's `proposedModel` or an approved model: `{model, effort}` or `{byDifficulty}`; null otherwise. */
export function roleModelOf(v: unknown): RoleModel | null {
  if (isObj(v) && isObj(v.byDifficulty)) {
    const by: Partial<Record<Difficulty, ModelChoice>> = {};
    for (const d of DIFFICULTIES) {
      const c = choiceOf(v.byDifficulty[d]);
      if (c) by[d] = c;
    }
    return Object.keys(by).length ? { byDifficulty: by } : null;
  }
  return choiceOf(v);
}

/** Why the Org settings can't be saved yet, by field. */
export function validateOrg(c: CrewConfig): Record<string, string> {
  const e: Record<string, string> = {};
  const o = c.org ?? {};
  const pct = (v: unknown) => v == null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100);
  for (const [id, v] of Object.entries(o.budgets?.departments ?? {})) if (!pct(v)) e[`org.budgets.departments.${id}`] = 'A percent from 0 to 100, or empty.';
  const goals = o.goals ?? [];
  if (goals.length > MAX_GOALS) e['org.goals'] = `At most ${MAX_GOALS} goals.`;
  for (const g of goals) if (!g.title.trim() || !(Number.isFinite(g.weight) && g.weight > 0)) e[`org.goals.${g.id}`] = 'A title, and a weight above 0.';
  const sourceOn = c.org?.departments?.support?.enabled === true;
  const source = String(c.agents?.support?.source ?? '').trim();
  if (sourceOn && !SUPPORT_SOURCE.test(source)) e['agents.support.source'] = 'Say where issues come from: jira:<PROJECT KEY> or teams:<channel>.';
  return e;
}

/** A task row as the board keeps it: its body plus the version this page saw. */
type TaskRow = Record<string, unknown> & { _v: string };

/**
 * The row changes a merged crew PR asks for (the Mate's panel records merges; the board applies them while open):
 * a row still at `pr`, whose PR is the one that merged, moves to the merge's target. Never one already moved, so it
 * never applies twice; never Jira.
 */
export function mergePatches(merges: MergeRecord[], rows: Map<string, TaskRow>, now: number): { key: string; version: string; patch: Record<string, unknown> }[] {
  const out: { key: string; version: string; patch: Record<string, unknown> }[] = [];
  for (const m of merges) {
    const r = rows.get(m.key);
    if (!r || r.status !== 'pr' || out.some((x) => x.key === m.key)) continue;
    if (m.mergedAt !== null && r.mergedAt === m.mergedAt) continue;
    if (m.url && typeof r.prUrl === 'string' && r.prUrl && r.prUrl !== m.url) continue;
    const at = m.mergedAt ?? now;
    out.push({ key: m.key, version: r._v, patch: { status: m.target, mergedAt: at, updatedAt: now, ...(m.target === 'done' ? { closedAt: at } : {}) } });
  }
  return out;
}
