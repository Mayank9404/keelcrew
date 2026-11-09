// @ts-check
// Risk tiers for ship approvals: low, medium or high, from a worktree's committed diff against its base branch (the
// changed paths against the rules' and pack's risk patterns, plus the size).
import { execFileSync } from 'node:child_process';
import { basename, dirname } from 'node:path';
import { readConfig } from './crew.mjs';
import { expand, inside } from './paths.mjs';
import { loadRules } from './rules.mjs';

export const RISK_TIERS = /** @type {const} */ (['low', 'medium', 'high']);

/**
 * @typedef {'low' | 'medium' | 'high'} Tier
 * @typedef {{ path: string, added: number, deleted: number, removed: boolean }} Change one changed file
 * @typedef {{ tier: Tier, reasons: string[], files: number, added: number, deleted: number, base: string | null }} Risk
 */

/**
 * Runs git in `dir` and returns its output, or null on failure. With a `deadline` (epoch ms), each call gets only the time
 * left, and none at all once it has passed, so a hook that assesses risk stays inside its own timeout.
 * @param {string} dir @param {string[]} args @param {number} [deadline]
 * @returns {string | null}
 */
function git(dir, args, deadline) {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  const timeout = deadline ? Math.min(10_000, deadline - Date.now()) : 10_000;
  if (timeout < 50) return null;
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env, timeout, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** The git arguments a risk assessment runs, so the helper can run them without blocking. @param {string} ref */
export const riskGitArgs = (ref) => ({
  numstat: ['diff', '--no-color', '--numstat', '-z', '-M', `${ref}...HEAD`],
  removed: ['diff', '--no-color', '--name-only', '-z', '-M', '--diff-filter=D', `${ref}...HEAD`],
});

/**
 * The changed files from `git diff --numstat -z` and the deleted paths from `--name-only -z --diff-filter=D`.
 * @param {string} numstat @param {string} removed
 * @returns {Change[]}
 */
export function parseChanges(numstat, removed) {
  const gone = new Set(removed.split('\0').filter(Boolean));
  const parts = numstat.split('\0');
  /** @type {Change[]} */
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(parts[i]);
    if (!m) continue;
    let path = m[3];
    // A rename leaves the path empty and puts the old and new paths in the next two fields.
    if (!path) {
      path = parts[i + 2] ?? '';
      i += 2;
    }
    out.push({ path, added: m[1] === '-' ? 0 : Number(m[1]), deleted: m[2] === '-' ? 0 : Number(m[2]), removed: gone.has(path) });
  }
  return out;
}

/** @param {Tier} a @param {Tier} b @returns {Tier} */
const higher = (a, b) => (RISK_TIERS.indexOf(a) >= RISK_TIERS.indexOf(b) ? a : b);

/**
 * The tier for a set of changes under the rules: the highest of every matching pattern and the size.
 * @param {Change[]} changes
 * @param {import('./rules.mjs').Rules} rules
 * @param {string | null} [base]
 * @returns {Risk}
 */
export function classifyRisk(changes, rules, base = null) {
  /** @type {Tier} */
  let tier = 'low';
  /** @type {string[]} */
  const reasons = [];
  for (const level of /** @type {const} */ (['high', 'medium'])) {
    for (const r of rules.risk.patterns[level]) {
      const hits = changes.filter((c) => (!r.deleted || c.removed) && r.re.test(c.path)).map((c) => c.path);
      if (!hits.length) continue;
      tier = higher(tier, level);
      reasons.push(`${r.why}: ${hits[0]}${hits.length > 1 ? ` and ${hits.length - 1} more` : ''}`);
    }
  }
  const added = changes.reduce((n, c) => n + c.added, 0);
  const deleted = changes.reduce((n, c) => n + c.deleted, 0);
  const lines = added + deleted;
  const bySize = lines >= rules.risk.size.high ? 'high' : lines >= rules.risk.size.medium ? 'medium' : null;
  if (bySize) {
    tier = higher(tier, bySize);
    reasons.push(`${lines.toLocaleString('en-US')} lines changed (${bySize} from ${rules.risk.size[bySize].toLocaleString('en-US')})`);
  }
  return { tier, reasons, files: changes.length, added, deleted, base };
}

/** A base branch from the config or a pack, or null for one git would read as an option (`--upload-pack=…`). @param {unknown} b */
const refName = (b) => (/^[^-\s][^\s]*$/.test(String(b)) ? String(b) : null);

/**
 * The branch a worktree's work goes into: the repo's `baseBranch` in config.json, else the team pack's for that repo,
 * else origin's default branch. Null when none of them can tell.
 * @param {string} dir @param {string | null} [packName] @param {number} [deadline]
 * @returns {string | null}
 */
export function baseBranchOf(dir, packName, deadline) {
  let config = {};
  try {
    config = readConfig();
  } catch {
    /* a damaged config is reported elsewhere; fall back to git */
  }
  /** @type {Record<string, any>} */
  const repos = /** @type {any} */ (config).repos ?? {};
  for (const r of Object.values(repos)) {
    if (!r?.path || !r.baseBranch) continue;
    const path = expand(String(r.path));
    if (inside(path, dir) || inside(`${path}-worktrees`, dir)) return refName(r.baseBranch);
  }
  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], deadline)?.trim();
  if (common) {
    try {
      const fromPack = loadRules(packName ?? /** @type {any} */ (config).pack).pack.repos?.[basename(dirname(common))]?.baseBranch;
      if (fromPack) return refName(fromPack);
    } catch {
      /* no readable pack: fall back to origin's default */
    }
  }
  return git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], deadline)?.trim().replace(/^origin\//, '') || null;
}

/**
 * The ref to compare a worktree with for `base`: origin's copy when there is one, else a local branch or ref of that name.
 * @param {string} dir @param {string} base @param {number} [deadline]
 * @returns {string | null}
 */
export function baseRefOf(dir, base, deadline) {
  for (const ref of [`refs/remotes/origin/${base}`, base]) {
    if (git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], deadline)) return ref.replace(/^refs\/remotes\//, '');
  }
  return null;
}

/** @param {string | null} base @returns {Risk} */
const unknownRisk = (base) => ({ tier: 'high', reasons: ["Couldn't compare with the base branch, so this counts as high risk."], files: 0, added: 0, deleted: 0, base });

/**
 * A worktree's risk from its committed diff against `base` (found from the config, pack or origin when not given). When
 * the diff can't be read the risk counts as high.
 * @param {string} dir
 * @param {string | null} [base]
 * @param {{ packName?: string | null, budgetMs?: number }} [options] `budgetMs` caps the time all git calls take together
 * @returns {Risk}
 */
export function assessRisk(dir, base, { packName, budgetMs } = {}) {
  const rules = loadRules(packName);
  const deadline = budgetMs ? Date.now() + budgetMs : undefined;
  const branch = base || baseBranchOf(dir, packName, deadline);
  const ref = branch ? baseRefOf(dir, branch, deadline) : null;
  if (!ref) return unknownRisk(branch);
  const args = riskGitArgs(ref);
  const numstat = git(dir, args.numstat, deadline);
  const removed = git(dir, args.removed, deadline);
  if (numstat === null || removed === null) return unknownRisk(ref);
  return classifyRisk(parseChanges(numstat, removed), rules, ref);
}

/** A tier from a tier name or an assessment, or null when it names none. @param {unknown} risk @returns {Tier | null} */
export function tierOf(risk) {
  const t = typeof risk === 'string' ? risk : /** @type {any} */ (risk)?.tier;
  return RISK_TIERS.includes(t) ? t : null;
}
