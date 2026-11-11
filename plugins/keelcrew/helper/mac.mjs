// @ts-check
// Things that happen in the captain's Mac apps: opening a worktree, a session or a file the crew linked in the editor, the
// terminal, Finder or the Claude app.
import { chmodSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, readRegistry } from '../core/crew.mjs';
import { HOME, paths } from '../core/paths.mjs';
import { run, shq } from './io.mjs';
import { findMember, packOf } from './members.mjs';

/**
 * @typedef {{ id: string, label: string, status: 'ok' | 'warn' | 'fail', detail: string }} Check
 */

const EDITOR_APPS = /** @type {Record<string, string>} */ ({ vscode: 'Visual Studio Code', cursor: 'Cursor', pycharm: 'PyCharm', sublime: 'Sublime Text', zed: 'Zed' });

/**
 * The apps things open in: the captain's choice (config.ide), else the team pack's, else VS Code and Terminal.
 * @returns {{ editor: string, terminal: string }}
 */
export function ide() {
  const c = readConfig();
  const p = packOf().ide ?? {};
  return { editor: c.ide?.editor ?? p.editor ?? 'vscode', terminal: c.ide?.terminal ?? p.terminal ?? 'terminal' };
}

/* ---------- opening things ---------- */

/** Runs macOS `open`, turning a failure into a readable error. @param {string[]} args @param {string} [failure] */
async function open(args, failure = 'Could not open it.') {
  const r = await run('open', args);
  if (r.code !== 0) throw new Error(r.stderr.trim() || failure);
}

/** Documents a board link may open in their default app. Anything else (apps, scripts, folders) is only shown in Finder, so a link never runs a program. */
const OPENABLE = new Set(['csv', 'tsv', 'txt', 'md', 'json', 'log', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'xlsx', 'docx', 'pptx', 'sql', 'yaml', 'yml', 'diff', 'patch']);

/**
 * Opens a file the crew linked (a file:// URL, or an absolute or ~ path) in its default app, or shows it in Finder. Only
 * files in the captain's home folder or a temp folder, after following links.
 * @param {{ path: string, reveal?: boolean }} a
 */
export async function openFile({ path, reveal = false }) {
  const raw = String(path ?? '').trim();
  let given = raw.replace(/^~(?=\/|$)/, homedir());
  if (/^file:\/\//i.test(raw)) {
    try {
      given = fileURLToPath(raw);
    } catch {
      throw new Error(`${raw} isn't a file link.`);
    }
  }
  if (!isAbsolute(given)) throw new Error('Give the full path to the file.');
  let real;
  try {
    real = realpathSync(given);
  } catch {
    throw new Error(`There's no ${given} on this Mac.`);
  }
  const roots = [homedir(), '/tmp', '/var/folders'].map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  });
  if (!roots.some((r) => real === r || real.startsWith(r + sep))) throw new Error('Only files in your home folder or a temp folder open from the board.');
  const opened = !reveal && statSync(real).isFile() && OPENABLE.has(extname(real).slice(1).toLowerCase());
  await open(opened ? [real] : ['-R', real], `Could not open ${real}.`);
  return { ok: true, shown: opened ? 'opened' : 'revealed' };
}

/**
 * Opens a crew member's worktree in the editor, Finder or the terminal.
 * @param {{ key: string, agent?: string, app: 'editor' | 'finder' | 'terminal' }} a
 */
export async function openIn({ key, agent, app }) {
  const { dir } = findMember(key, agent);
  const { editor, terminal } = ide();
  if (app === 'finder') await open([dir]);
  else if (app === 'terminal') await open(terminal === 'warp' ? [`warp://action/new_tab?path=${encodeURIComponent(dir)}`] : ['-a', 'Terminal', dir]);
  else await open(['-a', EDITOR_APPS[editor] ?? editor, dir]);
  return { ok: true };
}

/**
 * Opens a crew member's real session in the Claude app, Warp or Terminal; it keeps running in the crew either way. Without
 * `app` it follows the captain's own terminal choice, else the Claude app (a team pack's terminal isn't a reason to leave it).
 * @param {{ key: string, agent?: string, app?: 'desktop' | 'warp' | 'terminal' }} a
 */
export async function openSession({ key, agent, app }) {
  const m = findMember(key, agent);
  const c = readConfig();
  const where = app ?? c.ide?.terminal ?? 'desktop';
  // Only this member's own sessions count (jobs register in the Mate folder too), newest first. The app's own id for
  // the session (local_…), recorded at registration, opens it as it is in the sidebar.
  const sessions = readRegistry().sessions;
  const newest = [...(m.sessions ?? [])].sort((a, b) => (sessions[b]?.at ?? 0) - (sessions[a]?.at ?? 0));
  const own = [m.sessionId, ...newest].filter((sid) => !!sid && sessions[sid]?.role === m.role);
  const sessionId = own[0] ?? m.sessionId;
  // Only the chosen session's own app id: an older session's would open the wrong window.
  const host = sessionId ? sessions[sessionId]?.hostId : null;
  const hostId = typeof host === 'string' && /^local_[\w-]+$/.test(host) ? host : null;
  if (where === 'desktop' && hostId) {
    await open([`claude://claude.ai/epitaxy/${hostId}`], 'Could not open the Claude app.');
    return { command: `claude --desktop --resume ${sessionId ?? ''}`.trim() };
  }
  if (!sessionId) throw new Error(`${key}'s session hasn't run a step since joining the crew, so its id isn't known yet.`);
  if (where === 'desktop') {
    await open([`claude://resume?session=${sessionId}`], 'Could not open the Claude app.');
    return { command: `claude --desktop --resume ${sessionId}` };
  }
  const command = `${shq(c.claudePath ?? 'claude')} --resume ${sessionId}`;
  const file = join(HOME, 'tmp', `session-${String(key).toLowerCase().replace(/[^\w.-]/g, '_')}.command`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/zsh -l\n# Keelcrew: ${key}\ncd ${shq(m.dir)} || exit 1\n${command}\n`, { mode: 0o755 });
  chmodSync(file, 0o755);
  await open(['-a', where === 'warp' ? 'Warp' : 'Terminal', file], 'Could not open the terminal.');
  return { command: `cd ${shq(m.dir)} && ${command}` };
}

/** Shows the logs folder in Finder, or opens one log in Console. @param {string | null} path */
export async function openLogs(path) {
  await open(path ? ['-a', 'Console', path] : [paths.logs()]);
  return { ok: true };
}
