/**
 * Models (Settings → Crew, `settings/main.org.models.approved`): the one place a role's model and effort are set, and
 * the board's one resolver for them, in the same order as core org.mjs `modelFor`. Pure: no DOM, no runtime.
 */
import type { CrewConfig, Difficulty, Effort, ModelChoice, OrgSettings, RoleModel } from '../types';
import { EFFORTS } from './agents';
import { DIFFICULTIES, roleModelOf } from './org';

/**
 * What a role runs on when neither the captain nor its manifest says: the engineer ladder, effort by difficulty. Core
 * org.mjs keeps the same values; scripts/check-consistency.mjs checks they agree.
 */
export const ENGINEER_LADDER = { model: 'claude-sonnet-5-5', effort: { simple: 'high', moderate: 'xhigh', complex: 'xhigh', critical: 'xhigh' } };

/** A model id the Mate folder's settings accept (core leadsettings.mjs): a plain name, nothing a shell reads as more. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9.\-[\]]{0,63}$/;

/** Model families by tier: the Claude app starts no session above its starter's tier. */
const FAMILY_TIER: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };

/** A model's tier (its family's), or null for a model outside the known families. */
export function modelTier(model: string): number | null {
  const m = /^(?:claude-)?(opus|sonnet|haiku|fable)(?:-|$)/.exec(model);
  return m ? FAMILY_TIER[m[1]] : null;
}

/**
 * Whether the Claude app would hold a session down when the Mate starts it: a model of a higher tier, or a higher
 * effort, than the Mate's own.
 */
export function aboveMate(use: ModelChoice, mate: ModelChoice): boolean {
  const [a, b] = [modelTier(use.model), modelTier(mate.model)];
  const [e, f] = [EFFORTS.indexOf(use.effort), EFFORTS.indexOf(mate.effort)];
  return (a !== null && b !== null && a > b) || (e >= 0 && f >= 0 && e > f);
}

export type ModelSource = 'approved' | 'manifest' | 'default';
export interface ModelInUse extends ModelChoice {
  source: ModelSource;
}

/** The captain's choice for a role (per difficulty for the engineer), or null. */
function approvedChoice(org: OrgSettings | undefined, roleId: string, difficulty: Difficulty): ModelChoice | null {
  const m = roleModelOf(org?.models?.approved?.[roleId]);
  if (!m) return null;
  return 'byDifficulty' in m ? (m.byDifficulty[difficulty] ?? null) : m;
}

/**
 * The model and effort a role runs on, and where they come from: the captain's choice, else the role's manifest, else the
 * engineer ladder's default. `lead` and `subagents` have no manifest. No difficulty reads as moderate.
 */
export function modelFor(org: OrgSettings | undefined, roleId: string, manifest: { model: string | null; effort: Effort | null } | null, difficulty?: Difficulty | null): ModelInUse {
  const d: Difficulty = difficulty && DIFFICULTIES.includes(difficulty) ? difficulty : 'moderate';
  const approved = approvedChoice(org, roleId, d);
  if (approved) return { ...approved, source: 'approved' };
  const model = manifest?.model ?? null;
  const effort = manifest?.effort ?? null;
  return { model: model ?? ENGINEER_LADDER.model, effort: effort ?? (ENGINEER_LADDER.effort[d] as Effort), source: model || effort ? 'manifest' : 'default' };
}

/**
 * The approved models with one row set to `choice`, or cleared with null: the engineer's by difficulty when a
 * difficulty is given, any other role whole. A role left with nothing is dropped (saving writes it as cleared).
 */
export function withApproved(approved: Record<string, RoleModel | null> | undefined, roleId: string, choice: ModelChoice | null, difficulty?: Difficulty | null): Record<string, RoleModel | null> {
  const next = { ...(approved ?? {}) };
  if (!difficulty) {
    if (choice) next[roleId] = { ...choice };
    else delete next[roleId];
    return next;
  }
  const cur = roleModelOf(next[roleId]);
  const by: Partial<Record<Difficulty, ModelChoice>> = !cur ? {} : 'byDifficulty' in cur ? { ...cur.byDifficulty } : Object.fromEntries(DIFFICULTIES.map((d) => [d, { ...cur }]));
  if (choice) by[difficulty] = { ...choice };
  else delete by[difficulty];
  if (Object.keys(by).length) next[roleId] = { byDifficulty: by };
  else delete next[roleId];
  return next;
}

/** A row's model as stored, even half typed, so the field shows what the captain typed; null when the row isn't set. */
export function storedChoice(org: OrgSettings | undefined, roleId: string, difficulty?: Difficulty | null): { model: string; effort: Effort } | null {
  const raw = org?.models?.approved?.[roleId] as Record<string, unknown> | null | undefined;
  const pick = (difficulty && raw && typeof raw.byDifficulty === 'object' && raw.byDifficulty ? (raw.byDifficulty as Record<string, unknown>)[difficulty] : raw) as Record<string, unknown> | null | undefined;
  if (!pick || typeof pick !== 'object' || typeof pick.model !== 'string') return null;
  return { model: pick.model, effort: pick.effort as Effort };
}

/** Why the Models settings can't be saved yet, by row (`models.<role>` or `models.engineer.<difficulty>`). */
export function validateModels(c: CrewConfig): Record<string, string> {
  const e: Record<string, string> = {};
  const why = 'Name a model, like claude-opus-5-5, or choose Default.';
  for (const [id, v] of Object.entries(c.org?.models?.approved ?? {})) {
    if (!v || typeof v !== 'object') continue;
    if ('byDifficulty' in v) {
      for (const [d, x] of Object.entries(v.byDifficulty ?? {})) if (x && !MODEL_NAME.test(x.model ?? '')) e[`models.${id}.${d}`] = why;
    } else if (!MODEL_NAME.test(v.model ?? '')) e[`models.${id}`] = why;
  }
  return e;
}
