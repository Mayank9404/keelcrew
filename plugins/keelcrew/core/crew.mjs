// @ts-check
// The crew on this Mac: config.json (who owns it, the board, the team pack) and crew.json (which sessions and folders are
// crew members). Writes go through a lock so two sessions registering at once can't lose one another.
import { realpathSync } from 'node:fs';
import { CorruptFileError, isObject, readJsonLoose, readJsonStrict, withLock, writeJsonAtomic } from './fsx.mjs';
import { inside, paths } from './paths.mjs';

export const CONFIG_SCHEMA = 2;
export const REGISTRY_SCHEMA = 2;
/** A session marked busy with no step for this long is stuck, not working. */
export const BUSY_STALE_MS = 30 * 60_000;
const ROLES = new Set(['lead', 'engineer', 'agent', 'job']);

/**
 * @typedef {{ role: 'lead' | 'engineer' | 'job' | 'agent', key: string | null, dir: string, hostId?: string | null, agent?: string, at: number }} Member
 * @typedef {{ role: string, key: string | null, agent?: string, at: number }} DirEntry
 * @typedef {{ schemaVersion: number, dirs: Record<string, DirEntry>, sessions: Record<string, Member>, served?: Record<string, { key: string, at: number }> }} Registry
 *   `served`: the ticket each engineer session joined for, kept after it leaves: one engineer per ticket, for life.
 */

/**
 * config.json as stored. Undefined when there is no file.
 * @returns {Record<string, any> | undefined}
 */
function configOnDisk() {
  const c = readJsonStrict(paths.config(), undefined);
  if (c === undefined) return undefined;
  if (!isObject(c)) throw new CorruptFileError(paths.config(), null, "isn't a JSON object");
  return c;
}

/** The captain's settings. Throws CorruptFileError if the file is damaged or isn't an object. @returns {Record<string, any>} */
export const readConfig = () => configOnDisk() ?? {};

/** Merges `patch` into config.json under the registry lock. @param {Record<string, any>} patch */
export function updateConfig(patch) {
  return withLock(paths.registryLock(), () => {
    const next = { ...readConfig(), ...patch, schemaVersion: CONFIG_SCHEMA };
    writeJsonAtomic(paths.config(), next);
    return next;
  });
}

/**
 * What is wrong with crew.json's shape, or null: it must be an object whose `dirs` and `sessions` (when present) map to
 * entries with a known role, and every session names its folder.
 * @param {unknown} r
 * @returns {string | null}
 */
export function registryProblem(r) {
  if (!isObject(r)) return "isn't a JSON object";
  for (const k of /** @type {const} */ (['dirs', 'sessions'])) {
    if (r[k] === undefined) continue;
    if (!isObject(r[k])) return `has a "${k}" that isn't an object`;
    for (const [id, m] of Object.entries(r[k])) {
      if (!isObject(m) || !ROLES.has(m.role)) return `has a ${k === 'dirs' ? 'folder' : 'session'} entry (${id.slice(0, 80)}) without a known role`;
      if (k === 'sessions' && typeof m.dir !== 'string') return `has a session (${id.slice(0, 80)}) without its folder`;
      if (m.key !== undefined && m.key !== null && typeof m.key !== 'string') return `has an entry (${id.slice(0, 80)}) whose key isn't text`;
    }
  }
  return null;
}

/** The crew list. Throws CorruptFileError if the file is damaged or has the wrong shape, so policy fails closed. @returns {Registry} */
export function readRegistry() {
  const r = readJsonStrict(paths.registry(), {});
  const problem = registryProblem(r);
  if (problem) throw new CorruptFileError(paths.registry(), null, problem);
  return { schemaVersion: REGISTRY_SCHEMA, dirs: {}, sessions: {}, ...r };
}

/**
 * Every registered folder with what the hooks last recorded about it (state/<h16>.json) and the sessions registered there.
 * @param {Registry} [reg]
 * @returns {(DirEntry & Record<string, any> & { dir: string, sessions: string[] })[]}
 */
export function crewDirs(reg = readRegistry()) {
  return Object.entries(reg.dirs).map(([dir, m]) => ({
    ...readJsonLoose(paths.state(dir), {}),
    ...m,
    dir,
    sessions: Object.entries(reg.sessions).filter(([, s]) => s.dir === dir).map(([sid]) => sid),
  }));
}

/**
 * Changes the crew list atomically: `fn` gets the current list and returns the next one.
 * @template T
 * @param {(reg: Registry) => T} fn
 * @returns {T}
 */
export function updateRegistry(fn) {
  return withLock(paths.registryLock(), () => {
    const reg = readRegistry();
    const out = fn(reg);
    writeJsonAtomic(paths.registry(), { ...reg, schemaVersion: REGISTRY_SCHEMA });
    return out;
  });
}

/**
 * The crew member a session is, or null: its own registration first (so it counts in any folder), else the deepest
 * registered engineer or agent worktree containing `cwd`. The Mate is known only by its session, because its folder holds
 * every repo and would otherwise catch the captain's own sessions.
 * @param {string | undefined} cwd
 * @param {string | undefined} sessionId
 * @param {Registry} [reg]
 * @returns {(Member & { dir: string }) | null}
 */
export function memberFor(cwd, sessionId, reg = readRegistry()) {
  if (sessionId && reg.sessions[sessionId]) return reg.sessions[sessionId];
  if (!cwd) return null;
  const realCwd = real(cwd);
  /** @type {any} */
  let best = null;
  for (const [dir, m] of Object.entries(reg.dirs)) {
    if (m.role !== 'engineer' && m.role !== 'agent') continue;
    // A folder reached through a symlink (macOS /var is /private/var) is the same folder.
    if ((inside(dir, cwd) || inside(real(dir), realCwd)) && (!best || dir.length > best.dir.length)) best = { ...m, dir };
  }
  return best;
}

/** A path with its symlinks resolved, or the path itself when it doesn't exist. @param {string} p */
function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Whether a ticket already has a pull request, from the summary the Mate's panel writes every minute (`prUrl`); a
 * draft PR is free only before the first one. No entry reads as no PR; no summary file yet (the panel hasn't recorded
 * anything), or one that can't be read or isn't the expected shape, reads as a PR, since this gates a decision.
 * @param {string | null} key
 */
export function hasPr(key) {
  let s;
  try {
    s = readJsonStrict(paths.summary(), undefined);
  } catch {
    return true;
  }
  if (!key) return false;
  if (s === undefined) return true;
  if (!isObject(s) || !isObject(s.tickets)) return true;
  const t = s.tickets[key];
  return t === undefined ? false : !isObject(t) || !!t.prUrl;
}

/** The ticket's pull request URL from the Mate's summary, or '' when it has none or the summary can't tell. @param {string | null} key */
export function prUrlOf(key) {
  const url = ticketOf(key)?.prUrl;
  return typeof url === 'string' ? url : '';
}

/** A ticket from the summary the Mate's panel writes, or null. @param {string | null} key @returns {Record<string, any> | null} */
function ticketOf(key) {
  const s = readJsonLoose(paths.summary(), null);
  return key && isObject(s?.tickets) && isObject(s.tickets[key]) ? s.tickets[key] : null;
}

/** The Mate's session, if one is registered. @param {Registry} [reg] */
export const leadOf = (reg = readRegistry()) => Object.entries(reg.sessions).find(([, m]) => m.role === 'lead') ?? null;
