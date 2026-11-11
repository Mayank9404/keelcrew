// @ts-check
// A worktree's git view for the board: its base branch, its changes against it and their risk tier, the GitHub compare
// link, the files each engineer touched, and the board's ship approvals, which pin the commit the captain approved.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readConfig } from '../core/crew.mjs';
import { writeGrant } from '../core/grants.mjs';
import { classifyRisk, parseChanges, riskGitArgs } from '../core/risk.mjs';
import { loadRules } from '../core/rules.mjs';
import { log, run } from './io.mjs';
import { findMember, members } from './members.mjs';

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_EVERY_MS = 5 * 60_000;
const QUICK_TIMEOUT_MS = 5_000;

const RISK_MODULE = new URL('../core/risk.mjs', import.meta.url).href;
/** Runs core's baseBranchOf in a child node: it calls git synchronously, which would stall the helper's other requests. */
const BASE_SCRIPT = `import(process.argv[1]).then((m) => process.stdout.write(JSON.stringify(m.baseBranchOf(process.argv[2], null, Date.now() + ${QUICK_TIMEOUT_MS}))))`;
/** Lookups in flight by folder, so a board refresh asking for one folder several times runs it once. @type {Map<string, Promise<string | null>>} */
const baseLookups = new Map();

/**
 * The branch a worktree's work goes into, as the crew policy finds it (core's baseBranchOf, without blocking), or null.
 * @param {string} dir
 * @returns {Promise<string | null>}
 */
function policyBaseOf(dir) {
  let p = baseLookups.get(dir);
  if (!p) {
    p = run(process.execPath, ['-e', BASE_SCRIPT, RISK_MODULE, dir], { timeoutMs: QUICK_TIMEOUT_MS + 3_000 })
      .then((r) => {
        try {
          const b = r.code === 0 ? JSON.parse(r.stdout) : null;
          return typeof b === 'string' && b ? b : null;
        } catch {
          return null;
        }
      })
      .finally(() => baseLookups.delete(dir));
    baseLookups.set(dir, p);
  }
  return p;
}

/**
 * The branch a worktree's work goes into, as the crew policy finds it (core's baseBranchOf), else 'main'.
 * @param {string} dir
 */
async function baseOf(dir) {
  return (await policyBaseOf(dir)) ?? 'main';
}

/** Recent fetches by repo and base branch, so the board's polling doesn't fetch on every look. @type {Map<string, { at: number, done: Promise<unknown> }>} */
const fetches = new Map();

/**
 * Fetches `base` from origin unless the same repo fetched it in the last five minutes (worktrees of one repo share it).
 * A failed fetch counts too: an offline Mac shouldn't wait out the timeout on every look.
 * @param {string} dir @param {string} base @param {number} [now]
 * @returns {Promise<boolean>} whether it fetched
 */
async function fetchBase(dir, base, now = Date.now()) {
  const common = await run('git', ['rev-parse', '--git-common-dir'], { cwd: dir, timeoutMs: QUICK_TIMEOUT_MS });
  const key = `${common.code === 0 ? resolve(dir, common.stdout.trim()) : dir}\0${base}`;
  const recent = fetches.get(key);
  if (recent && now - recent.at < FETCH_EVERY_MS) {
    await recent.done;
    return false;
  }
  const done = run('git', ['fetch', 'origin', base], { cwd: dir, timeoutMs: FETCH_TIMEOUT_MS });
  fetches.set(key, { at: now, done });
  await done;
  return true;
}

/** What git says when macOS hasn't given the helper's node Files and Folders access (Desktop, Documents, Downloads). */
const MAC_BLOCKED = /Operation not permitted/;

/**
 * The worktree's current commit, or null if git can't say within five seconds; `blocked` when macOS kept it out.
 * @param {string} dir
 */
async function headOf(dir) {
  const r = await run('git', ['rev-parse', 'HEAD'], { cwd: dir, timeoutMs: QUICK_TIMEOUT_MS });
  const sha = r.stdout.trim();
  return { sha: r.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null, blocked: MAC_BLOCKED.test(r.stderr) };
}

/** @param {string} dir */
const branchOf = async (dir) => (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })).stdout.trim();

/**
 * GitHub's compare page for `branch` against `base`, once the branch is on origin; null before, or for a non-GitHub origin.
 * @param {string} dir @param {string} base @param {string} branch
 */
async function compareUrl(dir, base, branch) {
  if (branch === 'HEAD') return null; // detached: no branch to compare
  if ((await run('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd: dir })).code !== 0) return null;
  const o = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec((await run('git', ['remote', 'get-url', 'origin'], { cwd: dir })).stdout.trim());
  return o ? `https://github.com/${o[1]}/${o[2]}/compare/${base}...${branch}` : null;
}

/** The ref to diff against: origin's copy of the base branch, else the local branch, else null. @param {string} dir @param {string} base */
async function baseRef(dir, base) {
  for (const ref of [`origin/${base}`, base]) if ((await run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: dir, timeoutMs: QUICK_TIMEOUT_MS })).code === 0) return ref;
  return null;
}

/**
 * A ticket's changes against its base branch (committed and not), its git status, and the compare link once pushed.
 * @param {{ key: string }} a
 */
export async function diff({ key }) {
  const { dir } = findMember(key);
  const base = await baseOf(dir);
  await fetchBase(dir, base);
  const branch = await branchOf(dir);
  const ref = await baseRef(dir, base);
  const committed = ref ? await run('git', ['diff', '--no-color', `${ref}...HEAD`], { cwd: dir }) : { stdout: '' };
  const uncommitted = await run('git', ['diff', '--no-color', 'HEAD'], { cwd: dir });
  const status = await run('git', ['status', '--short', '--branch'], { cwd: dir });
  return {
    base,
    branch,
    diff: committed.stdout + (uncommitted.stdout ? `\n${uncommitted.stdout}` : ''),
    status: status.stdout,
    branchUrl: await compareUrl(dir, base, branch),
  };
}

/**
 * A worktree's risk tier from its committed diff against the freshly fetched base: origin's copy, else a local branch.
 * When the diff can't be read the risk counts as high.
 * @param {string} dir
 * @returns {Promise<import('../core/risk.mjs').Risk>}
 */
async function riskOf(dir) {
  const rules = loadRules(readConfig().pack);
  // No 'main' fallback here: when the policy can't tell the base, it counts the risk as high, and so does the board.
  const base = await policyBaseOf(dir);
  if (base) await fetchBase(dir, base);
  const ref = base ? await baseRef(dir, base) : null;
  if (ref) {
    const args = riskGitArgs(ref);
    const [numstat, removed] = await Promise.all([run('git', args.numstat, { cwd: dir }), run('git', args.removed, { cwd: dir })]);
    if (numstat.code === 0 && removed.code === 0) return classifyRisk(parseChanges(numstat.stdout, removed.stdout), rules, ref);
  }
  return { tier: 'high', reasons: ["Couldn't compare with the base branch, so this counts as high risk."], files: 0, added: 0, deleted: 0, base };
}

/** A ticket's risk tier for the launch card: low, medium or high, with the reasons, files and lines changed. @param {{ key: string }} a */
export async function risk({ key }) {
  const m = findMember(key);
  return { key: m.key ?? key, ...(await riskOf(m.dir)) };
}

/** The compare link for a ticket's branch (null before it's pushed). @param {{ key: string }} a */
export async function branchUrl({ key }) {
  const { dir } = findMember(key);
  return { branchUrl: await compareUrl(dir, await baseOf(dir), await branchOf(dir)) };
}

/** Files each engineer has changed, committed or not, for spotting two tickets touching the same file. */
export async function changedFiles() {
  const engineers = members().filter((m) => m.role === 'engineer' && m.key && existsSync(m.dir));
  const lists = await Promise.all(
    engineers.map(async (m) => {
      const base = await baseOf(m.dir);
      const ref = await baseRef(m.dir, base);
      const a = ref ? await run('git', ['diff', '--name-only', `${ref}...HEAD`], { cwd: m.dir }) : { stdout: '' };
      const b = await run('git', ['diff', '--name-only', 'HEAD'], { cwd: m.dir });
      return [m.key, [...new Set(`${a.stdout}\n${b.stdout}`.split('\n').map((f) => f.trim()).filter(Boolean))]];
    }),
  );
  return { files: Object.fromEntries(lists) };
}

/**
 * Records the captain's ship choice from the board for the ticket's worktree, pinned to the card's commit (`head`, which
 * must be HEAD or an ancestor of it) or else its current commit, and lasting as long as its risk tier allows. "Not yet"
 * (any choice that allows nothing) clears the approval.
 * @param {{ key: string, choice: string, head?: string | null }} a
 */
export async function approve({ key, choice, head: cardHead }) {
  const m = findMember(key);
  if (m.role !== 'engineer' && m.role !== 'agent') throw new Error('Approvals are for a ticket worktree, not the Mate.');
  const packName = readConfig().pack;
  const allowsSomething = !!loadRules(packName).ship.allows[choice];
  if (cardHead !== undefined && cardHead !== null && (typeof cardHead !== 'string' || !/^[0-9a-f]{40,64}$/.test(cardHead))) {
    throw new Error('head must be the full commit sha from the launch card (40 to 64 hex digits).');
  }
  const at = allowsSomething ? await headOf(m.dir) : null;
  if (at?.blocked) {
    throw new Error(`macOS didn't let the helper (${process.execPath}) into ${m.dir}, so nothing was approved. Allow it when macOS asks, or under System Settings → Privacy & Security → Files and Folders, where it's listed as Claude (the extension) or node (an entry in the app's config).`);
  }
  const current = at?.sha ?? null;
  if (allowsSomething && !current) throw new Error(`Couldn't read the current commit in ${m.dir}, so nothing was approved. Try again.`);
  // The approval pins the commit the captain reviewed on the card, which must be the worktree's HEAD or one before it.
  if (allowsSomething && cardHead && cardHead !== current) {
    const r = await run('git', ['merge-base', '--is-ancestor', cardHead, 'HEAD'], { cwd: m.dir, timeoutMs: QUICK_TIMEOUT_MS });
    if (r.code !== 0) throw new Error(`The card's commit ${cardHead.slice(0, 7)} isn't in ${m.key ?? 'this worktree'}'s history (HEAD is ${current?.slice(0, 7)}), so nothing was approved. Ask for a new launch card.`);
  }
  const head = allowsSomething ? (cardHead || current) : null;
  const assessed = allowsSomething ? await riskOf(m.dir) : null;
  const grant = writeGrant({ key: m.key, dir: m.dir, choice, via: 'board', head, packName, risk: assessed?.tier ?? null });
  log('info', `approve ${m.key ?? m.dir} "${choice}"${head ? ` at ${head.slice(0, 12)}` : ''}${assessed ? ` (${assessed.tier} risk)` : ''}`);
  return { ok: true, key: m.key, choice, head, expires: grant?.expires ?? null, risk: assessed, grant };
}
