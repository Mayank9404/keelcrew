// @ts-check
// The push check: a second layer under the policy hook. `keelctl register engineer|agent` points the worktree's own git
// config (`git config --worktree core.hooksPath`) at a hooks folder Keelcrew manages in HOME/githooks/<h16>. Its pre-push
// asks core whether the captain approved this push (a live ship approval for the worktree's ticket that allows pushing, and
// every pushed commit equal to the approved one); every hook there also runs the repo's own hook of the same name, so the
// repo's hooks keep working. `keelctl unregister` puts the worktree's config back. Git runs pre-push however the push was
// started (a shell, a script, an IDE), so a push the policy never saw still meets the approval.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { memberCanShip } from './agents.mjs';
import { readConfig, readRegistry } from './crew.mjs';
import { appendRotating, readJsonLoose, writeJsonAtomic } from './fsx.mjs';
import { SHA, branchOf, headOf, readGrant } from './grants.mjs';
import { HOME, PLUGIN_ROOT, inside, paths } from './paths.mjs';
import { loadRules } from './rules.mjs';

/** Client-side hooks git may run in a worktree; each is forwarded to the repo's own. */
const FORWARDED = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg',
  'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate',
  'push-to-checkout',
];
/** Hooks git runs very often: forwarded only when the repo has one, so a worktree without them stays as fast as before. */
const HOT = ['reference-transaction', 'post-index-change'];
const ZERO = /^0+$/;

/** @param {unknown} s */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** git in `dir`, with the caller's GIT_DIR and config overrides removed. Throws on failure. @param {string} dir @param {string[]} args */
function git(dir, args) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(k)) delete env[k];
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** git's output, or null when it fails (an unset key, not a repo). @param {string} dir @param {string[]} args */
function gitOr(dir, args) {
  try {
    return git(dir, args);
  } catch {
    return null;
  }
}

/** @param {string} p */
function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The hooks folder Keelcrew manages for a worktree. @param {string} dir */
export const guardDir = (dir) => paths.githooks(dir);

/** Whether a hooks path is a folder Keelcrew manages (this worktree's or another's, beside `self`), by real path. @param {string} self @param {string} p */
const isCrewHooks = (self, p) => isAbsolute(p) && (inside(dirname(self), p) || inside(real(dirname(self)), real(p)));

/**
 * The worktree's own earlier hooksPath: what its managed hooks also run, and what unregister puts back. A folder Keelcrew
 * manages never is (`git worktree add` run inside a crew worktree copies that worktree's hooksPath into the new one, and
 * chaining it would judge this worktree's pushes by the other's approval). It is followed to that folder's own earlier
 * hooksPath, so a real original is kept.
 * @param {string} self @param {unknown} p @returns {string | null}
 */
function ownHooksPath(self, p) {
  for (let i = 0; i < 8 && typeof p === 'string' && p; i++) {
    if (!isCrewHooks(self, p)) return p;
    p = readJsonLoose(join(p, 'keelcrew.json'), null)?.prev;
  }
  return null;
}

/** Whether a worktree's push check runs another Keelcrew hooks folder as its own earlier hooks (reinstalling fixes it). @param {string} dir */
export function chainsCrewHooks(dir) {
  const self = guardDir(dir);
  const prev = readJsonLoose(join(self, 'keelcrew.json'), null)?.prev;
  return typeof prev === 'string' && !!prev && isCrewHooks(self, prev);
}

/** The script git's pre-push runs (through node). */
export const checkScript = () => join(PLUGIN_ROOT, 'hooks', 'git-pre-push.mjs');

/**
 * The shell script every managed hook is. It runs Keelcrew's push check first (pre-push only; no node or no check script
 * refuses the push), then the repo's own hook of the same name: the worktree's earlier override if it had one, else the
 * hooksPath the repo, user or system sets, else the repo's hooks folder.
 * @param {{ dir: string, self: string, prev: string | null }} a
 */
function hookScript({ dir, self, prev }) {
  return `#!/bin/sh
# Keelcrew manages this hook for ${dir.replace(/\n/g, ' ')}.
# \`keelctl register\` wrote it and \`keelctl unregister\` removes it. It runs the repo's own hook of the same name, and before a
# push, Keelcrew's check that the captain approved what is being pushed.
KEELCREW_HOME=${shq(HOME)}; export KEELCREW_HOME
crew_dir=${shq(dir)}
crew_self=${shq(self)}
crew_prev=${shq(prev ?? '')}
crew_node=${shq(process.execPath)}
crew_check=${shq(checkScript())}
name=\${0##*/}
if [ "$name" = pre-push ]; then
  input=$(cat; printf x)
  input=\${input%x}
  [ -x "$crew_node" ] || crew_node=$(command -v node 2>/dev/null)
  if [ -z "$crew_node" ] || [ ! -f "$crew_check" ]; then
    echo "Keelcrew: the push check for $crew_dir can't run (node or $crew_check is missing), so this push is refused. Ask the Mate to run keelctl doctor --fix." >&2
    exit 1
  fi
  printf '%s' "$input" | "$crew_node" "$crew_check" "$crew_dir" "$@" || exit 1
fi
orig=$crew_prev
if [ -z "$orig" ]; then
  orig=$(git config --show-scope --type=path --get-all core.hooksPath 2>/dev/null | awk -F '\\t' '$1 != "worktree" && $1 != "command" { v = $2 } END { print v }')
fi
if [ -z "$orig" ]; then
  orig="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)/hooks"
fi
here=$(cd "$crew_self" 2>/dev/null && pwd -P)
there=$(cd "$orig" 2>/dev/null && pwd -P)
if [ -n "$there" ] && [ "$there" != "$here" ] && [ -f "$orig/$name" ] && [ -x "$orig/$name" ]; then
  if [ "$name" = pre-push ]; then
    printf '%s' "$input" | "$orig/$name" "$@"
    exit $?
  fi
  exec "$orig/$name" "$@"
fi
exit 0
`;
}

/**
 * Where the repo's own hooks live for this worktree, ignoring the worktree's own override: the last core.hooksPath set
 * at system, global or repo level, else the repo's hooks folder.
 * @param {string} dir
 */
function repoHooksDir(dir) {
  const scoped = gitOr(dir, ['config', '--show-scope', '--type=path', '--get-all', 'core.hooksPath']);
  let found = null;
  for (const line of (scoped ?? '').split('\n')) {
    const [scope, ...rest] = line.split('\t');
    if (scope && scope !== 'worktree' && scope !== 'command' && rest.length) found = rest.join('\t');
  }
  if (found) return found.startsWith('/') ? found : join(dir, found);
  const common = gitOr(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return common ? join(common, 'hooks') : null;
}

/**
 * Whether the push check is installed for a worktree: its own config points core.hooksPath at the managed folder, and the
 * folder has a pre-push.
 * @param {string} dir
 * @returns {{ installed: boolean, hooksPath: string | null, expected: string }}
 */
export function pushGuardStatus(dir) {
  const expected = guardDir(dir);
  const hooksPath = existsSync(dir) ? gitOr(dir, ['config', '--worktree', '--get', 'core.hooksPath']) : null;
  return { installed: hooksPath === expected && existsSync(join(expected, 'pre-push')), hooksPath, expected };
}

/** Whether a folder is the top of a git worktree (so it can have a push check). @param {string} dir */
export function isWorktreeTop(dir) {
  const top = existsSync(dir) ? gitOr(dir, ['rev-parse', '--show-toplevel']) : null;
  return !!top && real(top) === real(dir);
}

/**
 * Installs the push check for a registered worktree. Folders that aren't the top of a git worktree get none (nothing to
 * push from there). Idempotent: registering again rewrites the scripts.
 * @param {string} dir
 * @returns {{ installed: boolean, detail: string }}
 */
export function installPushGuard(dir) {
  const top = gitOr(dir, ['rev-parse', '--show-toplevel']);
  if (!top) return { installed: false, detail: `${dir} isn't a git worktree, so it has no push check (it has nothing to push).` };
  if (real(top) !== real(dir)) return { installed: false, detail: `${dir} is inside the worktree ${top}, not its top, so it has no push check of its own.` };
  const self = guardDir(dir);
  git(dir, ['config', '--local', 'extensions.worktreeConfig', 'true']);
  const current = gitOr(dir, ['config', '--worktree', '--get', 'core.hooksPath']);
  const meta = readJsonLoose(join(self, 'keelcrew.json'), {});
  // A worktree that already had its own hooksPath keeps running those hooks, and gets it back on unregister.
  const prev = ownHooksPath(self, current && current !== self ? current : meta.prev);
  mkdirSync(self, { recursive: true });
  const repoHooks = repoHooksDir(dir);
  const names = [...FORWARDED, ...HOT.filter((h) => (prev && existsSync(join(prev, h))) || (repoHooks && existsSync(join(repoHooks, h))))];
  const script = hookScript({ dir, self, prev });
  for (const name of names) {
    writeFileSync(join(self, name), script);
    chmodSync(join(self, name), 0o755);
  }
  writeJsonAtomic(join(self, 'keelcrew.json'), { dir, prev, at: Date.now() });
  git(dir, ['config', '--worktree', 'core.hooksPath', self]);
  const effective = gitOr(dir, ['config', '--get', 'core.hooksPath']);
  if (effective !== self) return { installed: false, detail: `git in ${dir} still uses ${effective ?? 'its own hooks'}; the push check isn't active.` };
  return { installed: true, detail: `Pushes from ${dir} now need the captain's approval on a launch card (git pre-push check).` };
}

/**
 * Removes the push check: the worktree's override goes back to what it was (or is unset), and the managed folder goes.
 * The repo keeps extensions.worktreeConfig, since other worktrees may rely on it.
 * @param {string} dir
 * @returns {{ removed: boolean }}
 */
export function removePushGuard(dir) {
  const self = guardDir(dir);
  const meta = readJsonLoose(join(self, 'keelcrew.json'), {});
  let removed = false;
  if (existsSync(dir) && gitOr(dir, ['config', '--worktree', '--get', 'core.hooksPath']) === self) {
    const prev = ownHooksPath(self, meta.prev);
    if (prev) gitOr(dir, ['config', '--worktree', 'core.hooksPath', prev]);
    else gitOr(dir, ['config', '--worktree', '--unset', 'core.hooksPath']);
    removed = true;
  }
  if (existsSync(self)) {
    rmSync(self, { recursive: true, force: true });
    removed = true;
  }
  return { removed };
}

/**
 * The refs a push sends, from pre-push's standard input: `<local ref> <local sha> <remote ref> <remote sha>` per line.
 * @param {string} text
 * @returns {{ localRef: string, localSha: string, remoteRef: string, remoteSha: string }[]}
 */
export function parsePushLines(text) {
  return String(text)
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 4)
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({ localRef, localSha, remoteRef, remoteSha }));
}

/** @param {string} sha */
const short = (sha) => sha.slice(0, 7);

/**
 * Whether the captain approved this push from a registered worktree. Refuses when the crew files can't be read, the folder
 * isn't in the crew list, its agent never ships, there is no live approval allowing a push, a pushed commit isn't the
 * approved one, a ref is deleted, or a protected branch is named.
 * @param {{ dir: string, input: string, now?: number }} a
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkPush({ dir, input, now = Date.now() }) {
  const card = 'Post a launch card (the keel-ship skill) and wait for the captain to approve it; then push the approved commit.';
  let reg;
  let rules;
  try {
    reg = readRegistry();
    rules = loadRules(readConfig().pack);
  } catch (e) {
    return { ok: false, reason: `Keelcrew can't read its crew files (${/** @type {Error} */ (e).message.split('\n')[0]}), so no push goes out. Run keelctl doctor.` };
  }
  const entry = reg.dirs[dir];
  if (!entry) {
    return { ok: false, reason: `${dir} has Keelcrew's push check but isn't in the crew list. If it is no longer crew work, the Mate removes the check with \`keelctl unregister ${dir}\`.` };
  }
  const label = entry.agent ?? entry.role;
  if (!memberCanShip({ role: entry.role, agent: entry.agent })) {
    return { ok: false, reason: `The ${label} agent never pushes code. Hand the change to the Mate instead.` };
  }
  const updates = parsePushLines(input);
  if (!updates.length) return { ok: true, reason: 'Nothing to push.' };
  const protectedRefs = new Set(rules.policy.protectedBranches.map((b) => `refs/heads/${b}`));
  // An engineer pushes its checked-out commit to its own branch freely; anything else needs the card.
  if (entry.role === 'engineer') {
    const branch = branchOf(dir);
    const head = headOf(dir);
    const own = (/** @type {{ localSha: string, remoteRef: string }} */ u) => u.localSha === head && u.remoteRef === `refs/heads/${branch}` && !protectedRefs.has(u.remoteRef);
    if (branch && head && updates.every(own)) return { ok: true, reason: `Engineers push their own branch (${branch}) freely.` };
  }
  const key = entry.key ?? null;
  const g = readGrant(dir, key, now);
  if (!g) return { ok: false, reason: `The captain hasn't approved shipping ${key ?? 'this worktree'}. ${card}` };
  if (!rules.ship.allows[g.choice]?.includes('push')) return { ok: false, reason: `The captain chose "${g.choice}" on the launch card, which doesn't allow a push. ${card}` };
  for (const u of updates) {
    if (ZERO.test(u.localSha)) return { ok: false, reason: `This push deletes ${u.remoteRef}; deleting remote branches is for people.` };
    if (protectedRefs.has(u.remoteRef)) return { ok: false, reason: `${u.remoteRef} is a protected branch; crew work never goes there.` };
    if (!SHA.test(u.localSha)) return { ok: false, reason: `Can't read what this push sends (${u.localRef}). ${card}` };
    if (g.head && u.localSha !== g.head) {
      return { ok: false, reason: `This push sends ${short(u.localSha)} (${u.localRef}), but the captain approved ${short(g.head)}. ${card}` };
    }
  }
  return { ok: true, reason: `The captain approved this on the launch card (${g.choice}).` };
}

/** Notes a push check in logs/policy.log. Best effort. @param {string} dir @param {{ ok: boolean, reason: string }} r */
export function logPushCheck(dir, r) {
  try {
    appendRotating(join(paths.logs(), 'policy.log'), `${new Date().toISOString()} ${dir} PRE-PUSH ${r.ok ? 'ALLOW' : 'REFUSE'} | ${r.reason}`);
  } catch {
    /* logging is best effort */
  }
}
