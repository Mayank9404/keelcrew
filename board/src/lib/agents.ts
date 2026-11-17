/**
 * Agent manifests (plugins/keelcrew/agents/<id>.json, imported at build time by agentCatalog.ts) and the captain's
 * settings for each one (`settings/main.agents[id]`). Pure: no DOM, no runtime.
 */
import type { AgentSettings, Effort, OrgSettings, RoleModel } from '../types';
import { DEPARTMENTS } from './departmentCatalog';
import { modelFor } from './models';
import { ID, departmentOn, roleModelOf, roleOn } from './org';
import { isObj } from './versions';

export type AgentKind = 'ticket' | 'scheduled' | 'on-demand';
export type SettingType = 'number' | 'boolean' | 'string';

export interface AgentSetting {
  key: string;
  type: SettingType;
  default: unknown;
  label: string;
}

export interface AgentSchedule {
  cron: string;
  label: string;
}

export interface AgentManifest {
  id: string;
  name: string;
  summary: string;
  kind: AgentKind;
  runAs: 'session' | 'subagent' | 'schedule';
  skill: string;
  trigger: string | null;
  defaultEnabled: boolean;
  schedules: AgentSchedule[];
  model: string | null;
  effort: Effort | null;
  settings: AgentSetting[];
  /** The department it belongs to, what kind of member it is, and the model it proposes (used only once approved). */
  department: string | null;
  memberKind: string;
  proposedModel: RoleModel | null;
}

/** An agent as it runs now: the manifest with the captain's overrides applied (its model from Settings → Crew, read-only here). */
export interface AgentConfig {
  enabled: boolean;
  model: string;
  effort: Effort;
  /** A cron that replaces the manifest's first schedule; '' keeps the manifest's. */
  schedule: string;
  values: Record<string, unknown>;
}

export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const KINDS: AgentKind[] = ['ticket', 'on-demand', 'scheduled'];
const RUN_AS = ['session', 'subagent', 'schedule'] as const;

const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** "Kind" in words for the agent card. */
function schedulesOf(v: unknown): AgentSchedule[] {
  const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return list.filter((s): s is Record<string, unknown> => isObj(s) && text(s.cron)).map((s) => ({ cron: String(s.cron), label: text(s.label) ? String(s.label) : String(s.cron) }));
}

function settingsOf(v: unknown): AgentSetting[] {
  if (!isObj(v)) return [];
  const out: AgentSetting[] = [];
  for (const [key, s] of Object.entries(v)) {
    if (!isObj(s) || !text(s.type)) continue;
    const type: SettingType = s.type === 'number' || s.type === 'boolean' ? s.type : 'string';
    const fallback = type === 'number' ? 0 : type === 'boolean' ? false : '';
    out.push({ key, type, default: s.default ?? fallback, label: text(s.label) ? String(s.label) : key });
  }
  return out;
}

/**
 * A manifest as the board uses it, or null when it isn't one (missing id, name, summary or skill, or an unknown kind).
 * `fileId` is the file's name; a manifest whose id doesn't match it is rejected, as core agents.mjs does.
 */
export function normalizeManifest(raw: unknown, fileId?: string): AgentManifest | null {
  if (!isObj(raw)) return null;
  const id = raw.id;
  if (typeof id !== 'string' || !ID.test(id) || (fileId && fileId !== id)) return null;
  if (!text(raw.name) || !text(raw.summary) || !text(raw.skill)) return null;
  if (!KINDS.includes(raw.kind as AgentKind)) return null;
  const runAs = RUN_AS.includes(raw.runAs as (typeof RUN_AS)[number]) ? (raw.runAs as AgentManifest['runAs']) : 'session';
  return {
    id,
    name: raw.name,
    summary: raw.summary,
    kind: raw.kind as AgentKind,
    runAs,
    skill: raw.skill,
    trigger: text(raw.trigger) ? raw.trigger : null,
    defaultEnabled: typeof raw.defaultEnabled === 'boolean' ? raw.defaultEnabled : true,
    schedules: schedulesOf(raw.schedule),
    model: text(raw.model) ? raw.model : null,
    effort: EFFORTS.includes(raw.effort as Effort) ? (raw.effort as Effort) : null,
    settings: settingsOf(raw.settings),
    department: text(raw.department) ? raw.department : null,
    memberKind: text(raw.memberKind) ? raw.memberKind : 'agent',
    proposedModel: roleModelOf(raw.proposedModel),
  };
}

/** Manifests from an `import.meta.glob` result (path → JSON), valid ones only, ticket agents first, then by name. */
export function manifestsFrom(modules: Record<string, unknown>): AgentManifest[] {
  const out: AgentManifest[] = [];
  for (const [path, mod] of Object.entries(modules)) {
    const fileId = /([^/\\]+)\.json$/.exec(path)?.[1];
    const json = isObj(mod) && 'default' in mod && isObj(mod.default) ? mod.default : mod;
    const m = normalizeManifest(json, fileId);
    if (m && !out.some((x) => x.id === m.id)) out.push(m);
  }
  return out.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || (a.id === 'engineer' ? -1 : b.id === 'engineer' ? 1 : 0) || a.name.localeCompare(b.name));
}

/** The settings that decide whether an agent is on. */
type OnSettings = { org?: OrgSettings; agents?: Record<string, AgentSettings> };

/** Whether the agent's department is on: always without one, never in one this build doesn't know (as core readOrg). */
export function agentDepartmentOn(org: OrgSettings | undefined, m: AgentManifest): boolean {
  if (!m.department) return true;
  const d = DEPARTMENTS.find((x) => x.id === m.department);
  return !!d && departmentOn(org, d);
}

/** Whether an agent is on, as core readOrg: off while its department is off, else its role switch, else the manifest's default. */
export function agentOn(c: OnSettings, m: AgentManifest): boolean {
  return agentDepartmentOn(c.org, m) && roleOn(c, m.id, m.defaultEnabled);
}

/**
 * The agent's effective settings: what the captain saved, else the manifest. Its model and effort are what Settings →
 * Crew resolves (lib/models.ts); a `model` or `effort` saved here is never read.
 */
export function agentConfig(m: AgentManifest, saved: AgentSettings | undefined, org?: OrgSettings): AgentConfig {
  const s = saved ?? {};
  const values: Record<string, unknown> = {};
  for (const st of m.settings) values[st.key] = s[st.key] !== undefined && s[st.key] !== null ? s[st.key] : st.default;
  const { model, effort } = modelFor(org, m.id, m);
  return {
    enabled: agentOn({ org, agents: { [m.id]: s } }, m),
    model,
    effort,
    schedule: text(s.schedule) ? s.schedule : '',
    values,
  };
}

/** The agents that are on, in catalog order. */
export function enabledAgents(manifests: AgentManifest[], c: OnSettings | undefined): AgentManifest[] {
  return manifests.filter((m) => agentOn(c ?? {}, m));
}

/** A setting's value as the form holds it, typed by the manifest; invalid numbers fall back to the default. */
export function coerceSetting(st: AgentSetting, raw: unknown): unknown {
  if (st.type === 'boolean') return raw === true || raw === 'true';
  if (st.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : st.default;
  }
  return raw == null ? '' : String(raw);
}

/** A display name for an agent id (an inbox card's `from`, a session's agent). */
export function agentName(manifests: AgentManifest[], id: string | null | undefined): string {
  if (!id) return 'Agent';
  return manifests.find((m) => m.id === id)?.name ?? id.charAt(0).toUpperCase() + id.slice(1);
}
