// @ts-check
// The Claude Code settings Keelcrew keeps in the Mate folder's `.claude/settings.local.json`, which every session that
// starts there reads: the Mate, engineers, agents and jobs. Keelcrew owns `permissions.defaultMode` (crew sessions never
// stall on a prompt), `autoCompactWindow` (when they compact), its entries in `permissions.allow` (SAFE_ALLOW only), and
// `env.CLAUDE_CODE_SUBAGENT_MODEL` once the captain approved a subagent model in Settings → Crew (the env var sets only
// the model: an effort reaches a subagent through the Agent tool's `effort`); everything else in the file is the captain's and is left alone. The defaults are rules.json `sessions`; the captain's compact window from board Settings
// is config.json `compactWindow`.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readConfig } from './crew.mjs';
import { isObject, readJsonLoose, readJsonStrict, writeJsonAtomic } from './fsx.mjs';
import { readOrgFile } from './org.mjs';
import { expand, paths } from './paths.mjs';
import { loadRules } from './rules.mjs';

/** Permission modes Keelcrew may give crew sessions: never one that skips permission checks. */
const MODES = new Set(['default', 'acceptEdits', 'auto']);
/** The only tools Keelcrew may put on the Mate folder's allow list; it also removes them when the rules stop listing them. */
const SAFE_ALLOW = new Set(['mcp__ccd_session__start_session']);
const SUBAGENT_ENV = 'CLAUDE_CODE_SUBAGENT_MODEL';
/** A model alias or id: nothing a shell or Claude Code would read as more than a name. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9.\-[\]]{0,63}$/;

/** The subagent model Keelcrew last wrote, so it takes out only its own when the captain revokes it. */
const writtenSubagentModel = () => readJsonLoose(paths.leadSettingsState(), {})?.subagentModel ?? null;

/** The subagent model the captain approved, or null (then only one Keelcrew wrote is taken out). */
function approvedSubagentModel() {
  const model = readOrgFile().models?.approved?.subagents?.model;
  return typeof model === 'string' && MODEL_NAME.test(model) ? model : null;
}

/** "auto" (the model's own window), or a whole number of tokens from 100k to 1M. @param {unknown} v @returns {v is number | 'auto'} */
export const isCompactWindow = (v) => v === 'auto' || (Number.isInteger(v) && Number(v) >= 100_000 && Number(v) <= 1_000_000);

/** The settings file sessions started in the Mate folder read, or null before a Mate folder is set. */
export function leadSettingsFile(config = readConfig()) {
  return config.leadDir ? join(expand(config.leadDir), '.claude', 'settings.local.json') : null;
}

/** The two values Keelcrew keeps there. Throws on rules it can't use, so nothing is written from them. */
export function wantedLeadSettings(config = readConfig()) {
  // `sessions` comes only from the base rules (a pack can't change it), so a missing or broken pack doesn't block it.
  const { sessions } = loadRules(undefined, { quiet: true });
  if (!MODES.has(sessions.defaultMode)) throw new Error(`rules.json sessions.defaultMode must be one of ${[...MODES].join(', ')}`);
  const compactWindow = isCompactWindow(config.compactWindow) ? config.compactWindow : sessions.compactWindow;
  if (!isCompactWindow(compactWindow)) throw new Error('rules.json sessions.compactWindow must be "auto" or 100000 to 1000000');
  const unsafe = sessions.allowTools.filter((t) => !SAFE_ALLOW.has(t));
  if (unsafe.length) throw new Error(`rules.json sessions.allowTools may only list ${[...SAFE_ALLOW].join(', ')} (not ${unsafe.join(', ')})`);
  return { defaultMode: sessions.defaultMode, compactWindow, allowTools: sessions.allowTools, subagentModel: approvedSubagentModel() };
}

/** Where the Mate folder's settings differ from what Keelcrew keeps there: one line per key, none when they match. */
export function leadSettingsStatus(config = readConfig()) {
  const file = leadSettingsFile(config);
  const wanted = wantedLeadSettings(config);
  /** @type {string[]} */
  const drift = [];
  if (!file) return { file, wanted, drift, missing: false };
  // A Mate folder that is gone stays gone (setup picks a new one); there is nothing to compare until then.
  if (!existsSync(dirname(dirname(file)))) return { file, wanted, drift, missing: true };
  const current = readSettings(file);
  const mode = current.permissions?.defaultMode;
  if (mode !== wanted.defaultMode) drift.push(`permission mode is ${mode ?? 'unset'}, not ${wanted.defaultMode}`);
  const window = typeof current.autoCompactWindow === 'number' ? current.autoCompactWindow : 'auto';
  if (window !== wanted.compactWindow) drift.push(`compact window is ${window}, not ${wanted.compactWindow}`);
  // `/autocompact` saves a per-model window, which wins over the top-level one within this file.
  const perModel = Object.keys(current.modelSettings ?? {}).filter((model) => current.modelSettings[model]?.autoCompactWindow !== undefined);
  if (perModel.length) drift.push(`a per-model compact window is set for ${perModel.join(', ')}`);
  const allow = Array.isArray(current.permissions?.allow) ? current.permissions.allow : [];
  const missingAllow = wanted.allowTools.filter((t) => !allow.includes(t));
  if (missingAllow.length) drift.push(`the allow list lacks ${missingAllow.join(', ')}`);
  const staleAllow = allow.filter((t) => SAFE_ALLOW.has(t) && !wanted.allowTools.includes(t));
  if (staleAllow.length) drift.push(`the allow list still has ${staleAllow.join(', ')}, which Keelcrew no longer adds`);
  const subagents = current.env?.[SUBAGENT_ENV];
  if (wanted.subagentModel && subagents !== wanted.subagentModel) drift.push(`subagents run on ${subagents ?? 'the session model'}, not the approved ${wanted.subagentModel}`);
  if (!wanted.subagentModel && subagents && subagents === writtenSubagentModel()) drift.push(`subagents still run on ${subagents}, which the captain no longer approves`);
  return { file, wanted, drift, missing: false };
}

/** The settings file as an object; throws (so nothing is written) when it, or a part Keelcrew touches, isn't one. @param {string} file */
function readSettings(file) {
  const current = readJsonStrict(file, {});
  if (!isObject(current)) throw new Error(`${file} isn't a JSON object, so Keelcrew leaves it alone`);
  for (const key of ['permissions', 'modelSettings', 'env']) {
    if (current[key] !== undefined && !isObject(current[key])) throw new Error(`${file}: "${key}" isn't an object, so Keelcrew leaves the file alone`);
  }
  return current;
}

/** Writes Keelcrew's keys into the Mate folder's settings. A file that isn't valid JSON is left alone (it throws). */
export function applyLeadSettings(config = readConfig()) {
  const { file, wanted, drift, missing } = leadSettingsStatus(config);
  if (!file || missing || !drift.length) return { file, changed: [], missing };
  const current = readSettings(file);
  const allow = Array.isArray(current.permissions?.allow) ? current.permissions.allow : [];
  const kept = allow.filter((t) => !SAFE_ALLOW.has(t) || wanted.allowTools.includes(t));
  const next = { ...current, permissions: { ...(current.permissions ?? {}), defaultMode: wanted.defaultMode, allow: [...kept, ...wanted.allowTools.filter((t) => !kept.includes(t))] } };
  if (wanted.subagentModel) next.env = { ...(current.env ?? {}), [SUBAGENT_ENV]: wanted.subagentModel };
  else if (current.env?.[SUBAGENT_ENV] && current.env[SUBAGENT_ENV] === writtenSubagentModel()) {
    // The captain revoked the model Keelcrew wrote; one the captain set by hand is never touched.
    const { [SUBAGENT_ENV]: _, ...env } = current.env;
    next.env = env;
  }
  if (wanted.compactWindow === 'auto') delete next.autoCompactWindow;
  else next.autoCompactWindow = wanted.compactWindow;
  if (next.modelSettings) {
    next.modelSettings = Object.fromEntries(
      Object.entries(next.modelSettings).map(([model, s]) => {
        if (!isObject(s)) return [model, s];
        const { autoCompactWindow: _, ...rest } = /** @type {Record<string, unknown>} */ (s);
        return [model, rest];
      }),
    );
  }
  writeJsonAtomic(file, next);
  writeJsonAtomic(paths.leadSettingsState(), { subagentModel: wanted.subagentModel });
  return { file, changed: drift };
}
