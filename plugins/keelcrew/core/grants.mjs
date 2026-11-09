// @ts-check
// Ship approvals: the one place that reads and writes them. An approval is per worktree, names the ticket and the captain's
// choice, expires after the rules' cap (two weeks: approvals have no working clock), and (when known) pins the exact commit the captain approved.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { readJsonLoose, withLock, writeJsonAtomic } from './fsx.mjs';
import { paths } from './paths.mjs';
import { assessRisk, tierOf } from './risk.mjs';
import { loadRules } from './rules.mjs';

/** Hooks run under a 10 s timeout: the longest a hook waits on the grant lock, and on the git calls that size a diff's risk. */
export const LOCK_BUDGET_MS = 1500;
export const RISK_BUDGET_MS = 4000;

/** The longest any approval can last, whatever its file says: rules.json's longest risk-tier time (risk.ttlMinutes) or ship grant time. */
const maxTtlMs = () => {
  const r = loadRules(undefined, { quiet: true });
  return Math.max(r.ship.grantTtlMs, ...Object.values(r.risk.ttlMs));
};

/** A sha git prints for a commit. */
export const SHA = /^[0-9a-f]{40,64}$/;

/** git with the caller's GIT_DIR and friends removed, so a hook's environment can't point it at another repo. */
function gitEnv() {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  return env;
}

/**
 * @typedef {{ key: string | null, dir: string, choice: string, at: number, expires: number, via: string, head?: string | null, risk?: string }} Grant
 */

/**
 * The live approval for a worktree, or null when there is none, it expired, it names another ticket, or it doesn't look
 * like one the crew wrote (no choice, no start time, an expiry beyond the longest TTL, a head that isn't a sha).
 * A damaged approval file reads as no approval: that only ever makes the policy ask.
 * @param {string} dir @param {string | null} [key] @param {number} [now]
 * @returns {Grant | null}
 */
export function readGrant(dir, key, now = Date.now()) {
  const g = readJsonLoose(paths.grant(dir), null);
  if (!g || typeof g !== 'object' || typeof g.expires !== 'number' || g.expires <= now) return null;
  if (typeof g.choice !== 'string' || typeof g.at !== 'number' || g.at > now + 60_000 || g.expires - g.at > maxTtlMs()) return null;
  if (g.head !== undefined && g.head !== null && (typeof g.head !== 'string' || !SHA.test(g.head))) return null;
  if (key && g.key && g.key !== key) return null;
  return g;
}

/**
 * Records the captain's choice for a worktree. "Not yet" (or any choice that allows nothing) clears the approval.
 * The approval lasts the TTL for `risk` (a tier or an assessment); without one, the worktree is assessed here.
 * @param {{ key: string | null, dir: string, choice: string, via: string, head?: string | null, packName?: string | null, now?: number, risk?: unknown, lockTimeoutMs?: number, gitBudgetMs?: number }} a
 * @returns {Grant | null}
 */
export function writeGrant({ key, dir, choice, via, head = null, packName, now = Date.now(), risk, lockTimeoutMs = 5000, gitBudgetMs }) {
  const rules = loadRules(packName);
  if (!rules.ship.choices.includes(choice)) throw new Error(`"${choice}" is not a ship choice (${rules.ship.choices.join(', ')})`);
  if (risk !== undefined && risk !== null && !tierOf(risk)) throw new Error('risk must be low, medium or high');
  if (head !== null && head !== undefined && !SHA.test(String(head))) throw new Error('head must be a commit sha');
  const allows = !!rules.ship.allows[choice];
  const tier = allows ? (tierOf(risk) ?? assessRisk(dir, null, { packName, budgetMs: gitBudgetMs }).tier) : null;
  return withLock(paths.grantLock(), () => {
    if (!allows || !tier) {
      rmSync(paths.grant(dir), { force: true });
      return null;
    }
    /** @type {Grant} */
    const g = { key, dir, choice, at: now, expires: now + (rules.risk.ttlMs[tier] ?? Math.min(...Object.values(rules.risk.ttlMs))), via, head, risk: tier };
    writeJsonAtomic(paths.grant(dir), g);
    return g;
  }, { timeoutMs: lockTimeoutMs });
}

/**
 * The commit a worktree is on, or null when git can't tell (not a repo, git missing, or slower than `timeoutMs`).
 * @param {string} dir @param {number} [timeoutMs]
 * @returns {string | null}
 */
export function headOf(dir, timeoutMs = 2000) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: timeoutMs, env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    return SHA.test(out.trim()) ? out.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The branch a worktree has checked out, or null when HEAD is detached or git can't tell.
 * @param {string} dir @param {number} [timeoutMs]
 * @returns {string | null}
 */
export function branchOf(dir, timeoutMs = 2000) {
  try {
    const out = execFileSync('git', ['-C', dir, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8', timeout: timeoutMs, env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** @param {string} dir @param {{ lockTimeoutMs?: number }} [options] */
export const clearGrant = (dir, { lockTimeoutMs = 5000 } = {}) => withLock(paths.grantLock(), () => rmSync(paths.grant(dir), { force: true }), { timeoutMs: lockTimeoutMs });
