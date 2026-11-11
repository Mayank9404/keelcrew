// @ts-check
// The board's settings and upkeep views: crew logs, the instruction files you can edit, Mac-side settings, health checks,
// the crew's memory and its agents, and the captain's one-shot approvals of drafted posts. Memory, agents and the shared health checks come from core modules loaded on first use,
// so a plugin that doesn't have them yet answers with a clear message instead of failing to start.
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfig, updateConfig } from '../core/crew.mjs';
import { applyLeadSettings, isCompactWindow, wantedLeadSettings } from '../core/leadsettings.mjs';
import { HOME, PLUGIN_ROOT, paths } from '../core/paths.mjs';
import { writePostGrant } from '../core/posts.mjs';
import { log, messageOf, tail } from './io.mjs';
import { packOf } from './members.mjs';

/** @typedef {import('./mac.mjs').Check} Check */

const LOG_WINDOW_BYTES = 4 * 1024 * 1024;
const LOG_LABELS = /** @type {Record<string, string>} */ ({ 'policy.log': 'Crew rules', 'activity.log': 'Crew activity', 'helper.log': 'Crew helper' });
/** Settings the board may change in config.json. The rest (board link, pack, Mate folder) belong to `keelctl setup`. */
const SETTABLE = ['ide', 'repos', 'owner', 'claudePath', 'promptMode', 'shipMode'];
/** The core skills, shown first and in this order; any other crew skill follows by name. */
const CORE_SKILLS = ['keel-lead', 'keel-engineer', 'keel-ship', 'keel-scan', 'keel-brief'];
const ABOUT = /** @type {Record<string, string>} */ ({
  'keel-lead.md': 'The Mate: triage, starting engineers, answering them, when to ask you.',
  'keel-engineer.md': 'Engineers: how they plan, build, verify and ask.',
  'keel-ship.md': 'The launch card: how work leaves your Mac.',
  'keel-scan.md': 'How the Mate handles Jira scan wakes.',
  'keel-brief.md': 'Morning brief, standup draft and weekly retro.',
  'lead.md': "The Mate's workspace notes: repos, how to run and lint.",
});

/* ---------- logs ---------- */

/** The crew's log files with sizes and times. */
export function logs() {
  const dir = paths.logs();
  if (!existsSync(dir)) return { logs: [] };
  return {
    logs: readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((file) => {
        const st = statSync(join(dir, file));
        return { file, label: LOG_LABELS[file] ?? file, sessionId: null, size: st.size, mtime: st.mtimeMs };
      }),
  };
}

/** A log's path, refusing anything but a plain `*.log` name in the logs folder. @param {unknown} file */
function logPath(file) {
  if (!/^[\w.-]+\.log$/.test(String(file))) throw new Error('Unknown log file.');
  const p = join(paths.logs(), String(file));
  if (!existsSync(p)) throw new Error(`${file} doesn't exist yet.`);
  return p;
}

/** The last lines of a crew log. @param {{ file: string, lines?: number }} a */
export function logTail({ file, lines = 500 }) {
  const path = logPath(file);
  const all = tail(path, LOG_WINDOW_BYTES);
  const st = statSync(path);
  return { file, lines: all.slice(-Math.max(1, Math.floor(Number(lines) || 500))), total: all.length, size: st.size, mtime: st.mtimeMs, path };
}

/** The path `open_logs` shows: one log, or the folder when `file` is empty. @param {string | null | undefined} file */
export const logToOpen = (file) => (file ? logPath(file) : null);

/* ---------- instruction files ---------- */

/** The files the board can edit: every crew skill in this plugin (skills/<name>/SKILL.md) and the Mate's workspace notes. */
function promptFiles() {
  const dir = join(PLUGIN_ROOT, 'skills');
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => existsSync(join(dir, n, 'SKILL.md'))) : [];
  const ordered = [...CORE_SKILLS.filter((n) => names.includes(n)), ...names.filter((n) => !CORE_SKILLS.includes(n)).sort()];
  return [...ordered.map((n) => ({ file: `${n}.md`, path: join(dir, n, 'SKILL.md') })), { file: 'lead.md', path: join(HOME, 'lead.md') }];
}

/** A skill's one-line description from its front matter. @param {string} text */
const descriptionOf = (text) => /^description:\s*(.+)$/m.exec(text)?.[1]?.trim().replace(/^["']|["']$/g, '').slice(0, 300) ?? '';

/** The instruction files that exist, with their text. */
export function prompts() {
  return {
    prompts: promptFiles()
      .filter((p) => existsSync(p.path))
      .map((p) => {
        const text = readFileSync(p.path, 'utf8');
        return { file: p.file, about: ABOUT[p.file] ?? descriptionOf(text), text };
      }),
  };
}

/** Saves an edited instruction file in place (the plugin's own skills folder, or the Mate's notes). @param {{ file: string, text: string }} a */
export function promptSave({ file, text }) {
  const p = promptFiles().find((x) => x.file === file);
  if (!p) throw new Error('Unknown instruction file.');
  if (typeof text !== 'string' || !text.trim()) throw new Error('The text is empty.');
  const tmp = `${p.path}.${process.pid}.tmp`;
  writeFileSync(tmp, text.endsWith('\n') ? text : `${text}\n`);
  renameSync(tmp, p.path);
  log('info', `prompt_save ${file}`);
  return prompts();
}

/* ---------- settings ---------- */

/** Changes the board-editable Mac-side settings; other keys in the patch are ignored. @param {{ patch: Record<string, unknown> }} a */
export async function configSet({ patch }) {
  const picked = Object.fromEntries(Object.entries(patch ?? {}).filter(([k]) => SETTABLE.includes(k)));
  if ('shipMode' in picked && picked.shipMode !== 'free' && picked.shipMode !== 'card') throw new Error('The ship mode is "free" or "card".');
  if (patch && 'compactWindow' in patch) {
    if (!isCompactWindow(patch.compactWindow)) throw new Error('The compact window is "auto" or 100000 to 1000000 tokens.');
    picked.compactWindow = patch.compactWindow;
  }
  // Apply first, so a settings file Keelcrew can't write leaves config.json unchanged too.
  if ('compactWindow' in picked) applyLeadSettings({ ...readConfig(), ...picked });
  const config = updateConfig(picked);
  log('info', `config_set ${Object.keys(picked).join(', ') || '(nothing allowed)'}`);
  return { config: withCompactWindow(config) };
}

/** The Mac-side settings, with the compact window crew sessions use (the captain's choice, else the rules' default). */
export const configGet = () => ({ config: withCompactWindow(readConfig()) });

/** @param {Record<string, any>} config */
function withCompactWindow(config) {
  try {
    return { ...config, compactWindow: wantedLeadSettings(config).compactWindow };
  } catch {
    return config;
  }
}

/* ---------- one-shot posts ---------- */

/**
 * The captain's "Approve and post" on a draft card: exactly one matching outside write (the tool, with this text in its
 * input) goes through without a prompt, within the rules' post TTL.
 * @param {{ key: string, tool: string, match?: string }} a
 */
export function approvePost({ key, tool, match }) {
  const post = writePostGrant({ key: String(key).trim().toUpperCase(), tool, match: match ?? null, via: 'board' });
  log('info', `approve_post ${post.key} ${post.tool}${post.match ? ` "${post.match.slice(0, 80)}"` : ''}`);
  return { ok: true, post };
}

/* ---------- core modules loaded on first use ---------- */

/**
 * A core module this plugin may not have yet. Throws a message the board can show as is.
 * @param {string} file e.g. "memory.mjs"
 * @returns {Promise<any>}
 */
async function importCore(file) {
  const path = join(PLUGIN_ROOT, 'core', file);
  if (!existsSync(path)) throw new Error(`This Keelcrew plugin doesn't have core/${file} yet. Update the plugin, then restart the Claude app.`);
  return import(pathToFileURL(path).href);
}

/** @param {Record<string, unknown>} o */
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

/**
 * The crew's lessons and the standing orders a session would get: all of them for the Mate, or one agent's (and repo's) share.
 * @param {{ repo?: string, agent?: string }} a
 */
export async function memoryList({ repo, agent }) {
  const memory = await importCore('memory.mjs');
  const scope = defined({ repo, agent });
  const role = !agent ? 'lead' : agent === 'engineer' ? 'engineer' : 'agent';
  const lessons = await memory.listLessons(Object.keys(scope).length ? { scope } : {});
  const playbook = await memory.playbookFor({ role, ...scope });
  return { lessons, playbook };
}

/** The crew's agents (their manifests) with what the team pack adds to each one's brief. */
export async function agentsList() {
  const { listAgents } = await importCore('agents.mjs');
  const team = packOf().agents ?? {};
  /** @type {Record<string, any>[]} */
  const manifests = await listAgents();
  const agents = manifests.map((a) => ({ ...a, teamSkills: team[a.id]?.skills ?? [], teamNotes: team[a.id]?.notes ?? null }));
  return { agents, pack: readConfig().pack ?? null };
}

/** @param {string} detail @returns {Check} */
const coreDoctorFailed = (detail) => ({ id: 'core-doctor', label: 'Crew health checks', status: 'fail', detail });

/** core `runDoctor` without fixing anything, or one failing check saying why it couldn't run. @returns {Promise<Check[]>} */
async function coreChecks() {
  let doctorModule;
  try {
    doctorModule = await importCore('doctor.mjs');
  } catch (e) {
    return [coreDoctorFailed(messageOf(e))];
  }
  try {
    return (await doctorModule.runDoctor({ fix: false })).checks ?? [];
  } catch (e) {
    log('error', `doctor: ${e instanceof Error ? e.stack : e}`);
    return [coreDoctorFailed(`The health checks failed: ${messageOf(e)}`)];
  }
}

/** The check only the helper makes: the board link. @returns {Check[]} */
function helperChecks() {
  try {
    const board = readConfig().board;
    return [{ id: 'board', label: 'Keelcrew board', status: board ? 'ok' : 'fail', detail: board ?? 'Run /keel-setup with the board link.' }];
  } catch (e) {
    return [{ id: 'config', label: 'Crew settings', status: 'fail', detail: messageOf(e) }];
  }
}

/** The shared health checks plus the helper's own; a check core already makes isn't repeated. Never fixes anything. */
export async function doctor() {
  const [core, own] = await Promise.all([coreChecks(), helperChecks()]);
  const seen = new Set(core.map((c) => c.id));
  return { checks: [...core, ...own.filter((c) => !seen.has(c.id))] };
}
