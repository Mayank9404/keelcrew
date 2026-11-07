// @ts-check
// Leaving the crew, for `keelctl unregister` and doctor: a folder's registry entry and its sessions go, its ship approval is
// cleared, and its push check is removed. Also finds the entries nobody uses any more: folders that are gone, and agent
// and job sessions idle for a week. And staying in it across /clear (`keelctl rekey`), which gives a session a new id.
import { copyFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readRegistry, updateRegistry } from './crew.mjs';
import { isPaused } from './denials.mjs';
import { readJsonLoose, withLock } from './fsx.mjs';
import { clearGrant } from './grants.mjs';
import { installPushGuard, removePushGuard } from './githooks.mjs';
import { HOME, paths } from './paths.mjs';

export const IDLE_MAX_MS = 7 * 24 * 60 * 60_000;
/** How long the panel's note that a session ended with /clear (HOME/cleared/<old id>) lets `keelctl rekey` move its entry. */
export const CLEARED_MAX_MS = 15 * 60_000;
/** The note the panel writes when a session ends with /clear (`{ at }`), named as the panel names it (hooks/register.tsx
 * clearedNote). A crew file: no session writes one by hand. @param {string} sessionId */
export const clearedNote = (sessionId) => join(HOME, 'cleared', `${String(sessionId).replace(/[^\w.-]/g, '_')}.json`);

/**
 * Removes a folder from the crew: its entry, every session registered there, its approval and its push check.
 * @param {string} dir
 * @returns {{ found: boolean, guardRemoved: boolean }}
 */
export function unregisterDir(dir) {
  // The folder as registered, when it's given through a link (or /var for /private/var).
  const real = (/** @type {string} */ p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const target = real(dir);
  dir = Object.keys(readRegistry().dirs).find((d) => d === dir || real(d) === target) ?? dir;
  let found = false;
  updateRegistry((reg) => {
    if (reg.dirs[dir]) found = true;
    delete reg.dirs[dir];
    for (const [s, m] of Object.entries(reg.sessions)) {
      if (m.dir === dir) {
        // Its ticket stays on record, so the session can't come back for another (one engineer per ticket).
        if (m.role === 'engineer' && m.key) reg.served = { ...reg.served, [s]: { key: m.key, at: Date.now() } };
        delete reg.sessions[s];
        found = true;
      }
    }
  });
  clearGrant(dir);
  let guardRemoved = false;
  try {
    guardRemoved = removePushGuard(dir).removed;
  } catch {
    /* the folder's git can't be reached; its managed hooks folder is gone with removePushGuard's best effort */
  }
  return { found, guardRemoved };
}

/** A path with its symlinks resolved, or the path itself when it doesn't exist. @param {string} p */
const realOf = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * After /clear a session goes on under a new id: its session entry moves to that id with its role, ticket, agent and host
 * id (the new host id when one is given), its ticket record (`served`) with it, and its denial count, so a /clear never
 * lifts a pause. Refused when the new id is already in the crew, the old one isn't, the caller isn't the new id itself
 * (a session re-keys only to its own id), the old entry's folder isn't `cwd` (by real path), or the panel left no note
 * (clearedNote, under CLEARED_MAX_MS old) that the old id really ended with /clear. The note is used up when it moves.
 * @param {string} from @param {string} to
 * @param {{ cwd: string, caller?: string, hostId?: string | null, now?: number }} o
 * @returns {import('./crew.mjs').Member}
 */
export function rekeySession(from, to, { cwd, caller, hostId, now = Date.now() }) {
  const check = (/** @type {import('./crew.mjs').Registry} */ reg) => {
    if (from === to) throw new Error(`${to} is already this session's id.`);
    const there = reg.sessions[to];
    if (there) throw new Error(`Session ${to} is already in the crew as ${there.role}${there.key ? ` for ${there.key}` : ''}.`);
    if (!caller || caller !== to) throw new Error('A session takes over only its own crew entry: run this from the session /clear started.');
    const m = reg.sessions[from];
    if (!m) throw new Error(`No crew session ${from}.`);
    if (!m.dir || realOf(m.dir) !== realOf(cwd)) throw new Error(`Session ${from} worked in ${m.dir}, not ${cwd}. Run this from that folder.`);
    const at = Number(readJsonLoose(clearedNote(from), {})?.at);
    if (!Number.isFinite(at) || at > now + 60_000 || now - at > CLEARED_MAX_MS) {
      throw new Error(`Session ${from} didn't just end with /clear (the panel notes each /clear): only the session /clear started takes over its entry.`);
    }
    return m;
  };
  check(readRegistry());
  const m = updateRegistry((reg) => {
    const m = { ...check(reg), ...(hostId ? { hostId } : {}) };
    // Only once every check passed, and before the entry moves: a refusal leaves the pause where it was, and a denial
    // count that can't be moved leaves the entry too.
    moveDenials(from, to);
    reg.sessions[to] = m;
    delete reg.sessions[from];
    if (reg.served?.[from]) {
      reg.served[to] = reg.served[from];
      delete reg.served[from];
    }
    return m;
  });
  rmSync(clearedNote(from), { force: true });
  return m;
}

/** A session's denial count goes to its new id. A pause (or a file that can't be read, which counts as one) always goes
 * with it; otherwise a count the new id already has stands. @param {string} from @param {string} to */
function moveDenials(from, to) {
  const src = paths.denials(from);
  if (!existsSync(src)) return;
  withLock(
    paths.denialsLock(),
    () => {
      if (!existsSync(paths.denials(to)) || isPaused(from)) copyFileSync(src, paths.denials(to));
      rmSync(src, { force: true });
    },
    { timeoutMs: 1500, staleMs: 10_000 },
  );
}

/**
 * Installs the push check for a newly registered engineer or agent folder. Never throws: a folder without one is still
 * crew, and the policy still guards its pushes.
 * @param {string} dir
 * @returns {{ installed: boolean, detail: string }}
 */
export function guardFolder(dir) {
  try {
    return installPushGuard(dir);
  } catch (e) {
    return { installed: false, detail: `The push check couldn't be installed in ${dir} (${/** @type {Error} */ (e).message.split('\n')[0]}).` };
  }
}

/** When a folder or session was last active: the hooks' last step there, else when it joined. @param {string} dir @param {number} at */
const lastActive = (dir, at) => Math.max(Number(at) || 0, Number(readJsonLoose(paths.state(dir), {}).lastAt) || 0);

/**
 * Registry entries nobody uses any more: folders (other than the Mate's) that no longer exist, agent folders idle for a
 * week, and sessions whose folder is gone or that are agent or job sessions idle for a week.
 * @param {{ now?: number }} [options]
 * @returns {{ dirs: string[], sessions: string[] }}
 */
export function staleMembers({ now = Date.now() } = {}) {
  const reg = readRegistry();
  const dirs = Object.entries(reg.dirs)
    .filter(([dir, m]) => m.role !== 'lead' && (!existsSync(dir) || (m.role === 'agent' && now - lastActive(dir, m.at) > IDLE_MAX_MS)))
    .map(([dir]) => dir);
  const gone = new Set(dirs);
  const sessions = Object.entries(reg.sessions)
    .filter(([, m]) => {
      if (m.role === 'lead') return false;
      if (gone.has(m.dir) || !existsSync(m.dir)) return true;
      // A job runs in the Mate's folder, whose activity is the Mate's: a job counts from when it joined.
      if (m.role === 'job') return now - (Number(m.at) || 0) > IDLE_MAX_MS;
      return m.role === 'agent' && now - lastActive(m.dir, m.at) > IDLE_MAX_MS;
    })
    .map(([sid]) => sid);
  return { dirs, sessions };
}

/**
 * Removes what staleMembers finds: each folder through unregisterDir, then the sessions left.
 * @param {{ now?: number }} [options]
 * @returns {{ dirs: string[], sessions: string[] }}
 */
export function pruneMembers({ now = Date.now() } = {}) {
  const stale = staleMembers({ now });
  for (const dir of stale.dirs) unregisterDir(dir);
  updateRegistry((reg) => {
    for (const sid of stale.sessions) delete reg.sessions[sid];
  });
  return stale;
}
