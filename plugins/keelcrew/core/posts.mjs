// @ts-check
// One-shot post approvals: the captain approves a drafted outside write on the board (a Teams message, a Confluence page, a
// PR comment), and exactly one matching connector or GitHub call goes through without a prompt. The one place that writes
// and uses them up; the panel mod writes the same file shape.
import { randomBytes } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonLoose, withLock, writeJsonAtomic } from './fsx.mjs';
import { paths } from './paths.mjs';
import { loadRules } from './rules.mjs';

/**
 * @typedef {{ id: string, key: string | null, tool: string, match: string | null, uses: number, at: number, expires: number, via: string }} PostGrant
 */

const MAX_MATCH = 2000;
const MAX_TTL_MINUTES = 24 * 60;

/** A `/regex/flags` tool pattern as a RegExp, or null for an exact tool name. Throws on a bad pattern. @param {string} tool */
function toolPattern(tool) {
  const m = /^\/(.+)\/([a-z]*)$/.exec(tool);
  if (!m) return null;
  try {
    return new RegExp(m[1], m[2]);
  } catch (e) {
    throw new Error(`The tool pattern ${tool} isn't a valid regular expression.`);
  }
}

/** Whether a grant's tool (exact name or /regex/) names this tool. @param {string} pattern @param {string} tool */
function toolMatches(pattern, tool) {
  try {
    const re = toolPattern(pattern);
    return re ? re.test(tool) : pattern === tool;
  } catch {
    return false;
  }
}

/** @param {unknown} s */
const squash = (s) => String(s).replace(/\s+/g, ' ').trim();

/** Every text value in a tool's input, joined, with whitespace collapsed. @param {unknown} input */
function inputText(input) {
  /** @type {string[]} */
  const out = [];
  /** @param {unknown} v @param {number} depth */
  const walk = (v, depth) => {
    if (depth > 8) return;
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'number' || typeof v === 'boolean') out.push(String(v));
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(input, 0);
  return squash(out.join('\n'));
}

/**
 * Records the captain's approval of one outside write: `tool` is the exact tool name (or `/regex/`), `match` text its input
 * must contain. Throws with a plain message on a bad request.
 * @param {{ key: string | null, tool: string, match?: string | null, via: string, ttlMinutes?: number, now?: number }} a
 * @returns {PostGrant}
 */
export function writePostGrant({ key, tool, match = null, via, ttlMinutes, now = Date.now() }) {
  const name = String(tool ?? '').trim();
  if (!name) throw new Error('Say which tool the post uses.');
  toolPattern(name);
  const text = match === null || match === undefined ? null : squash(match);
  if (text !== null && (!text || text.length > MAX_MATCH)) throw new Error(`The text to match must be 1 to ${MAX_MATCH} characters.`);
  const ttlMs = ttlMinutes === undefined ? loadRules(undefined, { quiet: true }).posts.ttlMs : Number(ttlMinutes) * 60_000;
  if (!(ttlMs > 0 && ttlMs <= MAX_TTL_MINUTES * 60_000)) throw new Error(`A post approval lasts 1 to ${MAX_TTL_MINUTES} minutes.`);
  /** @type {PostGrant} */
  const g = { id: `${now}-${randomBytes(4).toString('hex')}`, key: key ? String(key) : null, tool: name, match: text, uses: 1, at: now, expires: now + ttlMs, via: String(via) };
  withLock(paths.postsLock(), () => writeJsonAtomic(join(paths.posts(), `${g.id}.json`), g));
  return g;
}

/** @param {string} dir */
function jsonFiles(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

/**
 * Uses up the post approval this call matches, if there is one: same tool, the approved text in its input, and (when both
 * name one) the same ticket. Expired approvals are cleared on the way.
 * @param {string} tool
 * @param {unknown} input
 * @param {{ key?: string | null, now?: number, lockTimeoutMs?: number }} [options]
 * @returns {PostGrant | null} the approval used, or null
 */
export function consumePostGrant(tool, input, { key = null, now = Date.now(), lockTimeoutMs = 5000 } = {}) {
  return withLock(paths.postsLock(), () => {
    const text = inputText(input);
    /** @type {PostGrant | null} */
    let hit = null;
    let hitPath = '';
    for (const f of jsonFiles(paths.posts())) {
      const path = join(paths.posts(), f);
      const g = readJsonLoose(path, null);
      if (!g || typeof g !== 'object') continue;
      if (typeof g.expires !== 'number' || g.expires <= now || !(Number(g.uses) > 0)) {
        rmSync(path, { force: true });
        continue;
      }
      if (typeof g.tool !== 'string' || !toolMatches(g.tool, tool)) continue;
      if (g.match && !text.includes(squash(g.match))) continue;
      if (key && g.key && String(g.key).toUpperCase() !== String(key).toUpperCase()) continue;
      if (!hit || g.expires < hit.expires) {
        hit = g;
        hitPath = path;
      }
    }
    if (!hit) return null;
    const left = Number(hit.uses) - 1;
    if (left > 0) writeJsonAtomic(hitPath, { ...hit, uses: left });
    else rmSync(hitPath, { force: true });
    return hit;
  }, { timeoutMs: lockTimeoutMs });
}
