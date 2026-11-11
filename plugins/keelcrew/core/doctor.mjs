// @ts-check
// `keelctl doctor`: checks the crew's files on this Mac and, with fix, repairs what is safe to repair. Damaged files are
// reported, never deleted. Shared by the crew command and the helper's doctor tool.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { BUSY_STALE_MS, CONFIG_SCHEMA, REGISTRY_SCHEMA, readConfig, readRegistry, registryProblem, updateRegistry } from './crew.mjs';
import { LOCK_HELD_MAX_MS, lockAbandoned, lockOwner, readJsonLoose, readJsonStrict, withLock, writeJsonAtomic } from './fsx.mjs';
import { chainsCrewHooks, isWorktreeTop, pushGuardStatus } from './githooks.mjs';
import { HELPER_SERVER, helperExtensionManifest } from './install.mjs';
import { applyLeadSettings, leadSettingsStatus } from './leadsettings.mjs';
import { guardFolder, pruneMembers, staleMembers, unregisterDir } from './membership.mjs';
import { initMemory, memoryStatus, retireStaleCandidates, staleLessons } from './memory.mjs';
import { HOME, PLUGIN_ROOT, expand as expandHome, hash16, inside, paths } from './paths.mjs';
import { loadPack, loadRules } from './rules.mjs';

export const JOB_MAX_AGE_MS = 24 * 60 * 60_000;
/** How long the registry remembers which ticket an engineer session worked (sessions are never resumed after this). */
export const SERVED_MAX_AGE_MS = 90 * 24 * 60 * 60_000;
export const LOCK_STALE_MS = 60_000;
export { LOCK_HELD_MAX_MS };
export const LOG_MAX_BYTES = 4 * 1024 * 1024;
export const WORK_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** Handled alerts and a gone session's denial count (unless it is paused) are kept this long. */
export const KEEP_HANDLED_MS = 14 * DAY_MS;
/** Activity and state files of folders no longer in the crew, and attic items, are kept this long. */
export const KEEP_GONE_MS = 30 * DAY_MS;
/** The fixes `keelctl doctor --fix --safe` makes (the Mate's panel, every 2 hours): housekeeping with nothing to decide. */
export const SAFE_FIXES = new Set(['locks', 'jobs', 'busy', 'logs', 'lessons', 'work', 'members', 'alerts', 'denials', 'orphans', 'attic']);

/**
 * @typedef {{ id: string, label: string, status: 'ok' | 'warn' | 'fail', detail: string, fixed?: boolean }} Check
 */

/** @param {string} id @param {string} label */
const checker = (id, label) => ({
  /** @param {string} detail @returns {Check} */ ok: (detail) => ({ id, label, status: 'ok', detail }),
  /** @param {string} detail @returns {Check} */ warn: (detail) => ({ id, label, status: 'warn', detail }),
  /** @param {string} detail @returns {Check} */ fail: (detail) => ({ id, label, status: 'fail', detail }),
  /** @param {string} detail @returns {Check} */ fixed: (detail) => ({ id, label, status: 'ok', detail, fixed: true }),
});

/** @param {number} n @param {string} one @param {string} [many] */
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A schema-versioned crew file: parses, and is version 2.
 * @param {{ id: string, label: string, path: string, schema: number, missing: Check['status'], missingDetail: string, shape?: (data: any) => string | null }} f
 * @returns {Check}
 */
function checkVersioned(f) {
  const c = checker(f.id, f.label);
  const name = basename(f.path);
  let data;
  try {
    data = readJsonStrict(f.path, undefined);
  } catch (e) {
    return c.fail(`${name} is damaged (${/** @type {any} */ (e).cause?.message ?? e}). Repair it by hand or move it aside; doctor never deletes it.`);
  }
  if (data === undefined) return { ...c.ok(f.missingDetail), status: f.missing };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return c.fail(`${name} isn't a JSON object. Repair it by hand or move it aside.`);
  const wrong = f.shape?.(data);
  if (wrong) return c.fail(`${name} ${wrong}. Repair it by hand or move it aside; until then every crew session asks before anything could ship.`);
  if (data.schemaVersion === f.schema) return c.ok(`${name} is version ${f.schema}.`);
  if (typeof data.schemaVersion === 'number' && data.schemaVersion > f.schema) return c.fail(`${name} is version ${data.schemaVersion}, newer than this Keelcrew. Update the plugin.`);
  return c.fail(`${name} has an unknown version (${JSON.stringify(data.schemaVersion ?? null)}).`);
}

const checkConfig = () =>
  checkVersioned({ id: 'config', label: 'Settings', path: paths.config(), schema: CONFIG_SCHEMA, missing: 'warn', missingDetail: 'Not set up yet. Run /keel-setup.' });

const checkRegistry = () =>
  checkVersioned({ id: 'registry', label: 'Crew list', path: paths.registry(), schema: REGISTRY_SCHEMA, missing: 'ok', missingDetail: 'No crew members yet.', shape: registryProblem });

/**
 * The pack config.json names, read loosely: a damaged config is reported by its own
 * check. Null when the captain chose none.
 * @returns {string | null | undefined}
 */
function packName() {
  try {
    return readConfig().pack;
  } catch {
    return readJsonLoose(paths.config(), {}).pack;
  }
}

/** @returns {Check} */
function checkRules() {
  const c = checker('rules', 'Rules');
  try {
    const r = loadRules(undefined, { quiet: true });
    return c.ok(`rules.json loads (${count(r.policy.denyBash.length, 'never-allowed rule')}).`);
  } catch (e) {
    return c.fail(/** @type {Error} */ (e).message);
  }
}

/** @returns {Check} */
function checkPack() {
  const c = checker('pack', 'Team pack');
  const name = packName();
  if (name === null) return c.ok('None, as chosen with keelctl setup --pack none: only the generic rules apply.');
  if (!name) return c.fail("No team pack is set, so the team's own rules (its denials, protected branches, read-only servers) are off. Run keelctl setup --pack <name>, or --pack none if that is what you want.");
  try {
    const pack = loadPack(name);
    loadRules(name);
    const elsewhere = Object.keys(pack.repos ?? {}).filter((r) => !readConfig().repos?.[r]);
    if (elsewhere.length) return c.warn(`${name} loads, but its repos ${elsewhere.join(', ')} aren't in your Mate folder, so the crew can't work in them. Make your own pack with keelctl pack init <team>, then keelctl setup --pack <team>.`);
    return c.ok(`${name}${pack.title ? ` (${pack.title})` : ''} loads.`);
  } catch (e) {
    return c.fail(`${/** @type {Error} */ (e).message}. Fix the pack or run keelctl setup --pack <name>.`);
  }
}

/** @param {boolean} fix @param {number} now @returns {Check} */
function checkJobs(fix, now) {
  const c = checker('jobs', 'Watch sessions');
  let reg;
  try {
    reg = readRegistry();
  } catch {
    return c.warn("Skipped: crew.json can't be read.");
  }
  /** @param {{ role: string, at?: number }} m */
  const old = (m) => m.role === 'job' && now - (m.at ?? 0) > JOB_MAX_AGE_MS;
  const n = Object.values(reg.sessions).filter(old).length;
  if (!n) return c.ok('None older than a day.');
  if (!fix) return c.warn(`${count(n, 'job session')} older than a day. Run keelctl doctor --fix to prune them.`);
  updateRegistry((r) => {
    for (const [s, m] of Object.entries(r.sessions)) if (old(m)) delete r.sessions[s];
  });
  return c.fixed(`Pruned ${count(n, 'job session')} older than a day.`);
}

/** @param {boolean} fix @param {number} now @returns {Check} */
function checkBusy(fix, now) {
  const c = checker('busy', 'Busy flags');
  const dir = join(HOME, 'state');
  const stale = listFiles(dir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.alive.json'))
    .map((f) => ({ path: join(dir, f), state: readJsonLoose(join(dir, f), null) }))
    .filter((s) => s.state?.busy === true && now - (Number(s.state.lastAt) || 0) > BUSY_STALE_MS);
  if (!stale.length) return c.ok('No session stuck busy.');
  if (!fix) return c.warn(`${count(stale.length, 'session')} marked busy with no step for ${BUSY_STALE_MS / 60_000} minutes. Run keelctl doctor --fix to clear them.`);
  for (const s of stale) {
    // Under the activity hook's lock (locks/state-<h16>), re-read: a step that arrived meanwhile keeps the session busy.
    withLock(join(HOME, 'locks', `state-${basename(s.path, '.json')}`), () => {
      const cur = readJsonLoose(s.path, null);
      if (cur?.busy === true && now - (Number(cur.lastAt) || 0) > BUSY_STALE_MS) writeJsonAtomic(s.path, { ...cur, busy: false, activity: 'idle' });
    });
  }
  return c.fixed(`Cleared ${count(stale.length, 'stale busy flag')}.`);
}

/** @param {boolean} fix @param {number} now @returns {Check} */
function checkLocks(fix, now) {
  const c = checker('locks', 'Locks');
  const dir = join(HOME, 'locks');
  // Left behind: the holder's process is gone (or an ownerless lock is old), or a live pid has held it for ten minutes.
  const stale = listFiles(dir)
    .map((f) => join(dir, f))
    .filter((p) => lockAbandoned(p, LOCK_STALE_MS, now) || now - (lockOwner(p)?.at ?? mtime(p)) > LOCK_HELD_MAX_MS);
  if (!stale.length) return c.ok('No stale locks.');
  if (!fix) return c.warn(`${count(stale.length, 'lock')} left by a process that is gone (${stale.map((p) => basename(p)).join(', ')}). Run keelctl doctor --fix to remove them.`);
  for (const p of stale) rmSync(p, { recursive: true, force: true });
  return c.fixed(`Removed ${count(stale.length, 'stale lock')}.`);
}

/** @param {boolean} fix @returns {Check} */
function checkLogs(fix) {
  const c = checker('logs', 'Logs');
  const big = [
    ...listFiles(paths.logs()).filter((f) => f.endsWith('.log')).map((f) => join(paths.logs(), f)),
    ...listFiles(join(HOME, 'events')).filter((f) => f.endsWith('.jsonl')).map((f) => join(HOME, 'events', f)),
  ].filter((p) => size(p) > LOG_MAX_BYTES);
  if (!big.length) return c.ok('Every log is under 4 MB.');
  if (!fix) return c.warn(`${count(big.length, 'log')} over 4 MB. Run keelctl doctor --fix to rotate them.`);
  for (const p of big) renameSync(p, `${p}.1`);
  return c.fixed(`Rotated ${count(big.length, 'log')}.`);
}

/** @param {boolean} fix @returns {Check} */
function checkMemory(fix) {
  const c = checker('memory', 'Memory');
  const s = memoryStatus();
  const damaged = s.damaged ? ` ${count(s.damaged, 'damaged line')} in lessons.jsonl ${s.damaged === 1 ? 'is' : 'are'} skipped.` : '';
  const candidates = s.candidates ? ` (${count(s.candidates, 'candidate')})` : '';
  if (s.repo) return (s.damaged ? c.warn : c.ok)(`${count(s.lessons, 'lesson')} in force${candidates}.${damaged}`);
  if (!fix) return c.warn('No memory repo yet. Run keelctl doctor --fix to create it.');
  initMemory();
  return c.fixed(`Created the memory repo in ${paths.memory()}.`);
}

/** @param {string[]} keys */
const someKeys = (keys) => `${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ` and ${keys.length - 5} more` : ''}`;

/** Candidates nobody saw for a month retire with fix; active lessons nobody saw for a quarter are flagged for review. @param {boolean} fix @param {number} now @returns {Check} */
function checkLessons(fix, now) {
  const c = checker('lessons', 'Lessons');
  if (!memoryStatus().repo) return c.ok('No memory yet.');
  const { candidateRetireMs, activeStaleMs } = loadRules(undefined, { quiet: true }).memory;
  const { candidates, active } = staleLessons({ now });
  const flagged = active.length
    ? `${count(active.length, 'active lesson')} unseen for ${Math.round(activeStaleMs / DAY_MS)} days (${someKeys(active.map((l) => l.key))}). Check ${active.length === 1 ? 'it still holds' : 'they still hold'} with keelctl memory list; forget what doesn't.`
    : '';
  const unseen = `unseen for ${Math.round(candidateRetireMs / DAY_MS)} days`;
  if (!candidates.length) return flagged ? c.warn(flagged) : c.ok('No lesson has gone unseen too long.');
  if (!fix) return c.warn(`${count(candidates.length, 'candidate lesson')} ${unseen}. Run keelctl doctor --fix to retire them.${flagged ? ` ${flagged}` : ''}`);
  const retired = retireStaleCandidates({ now });
  const done = `Retired ${count(retired.length, 'candidate lesson')} ${unseen}.`;
  return flagged ? { ...c.warn(`${done} ${flagged}`), fixed: true } : c.fixed(done);
}

const WALK_MAX_ENTRIES = 50_000;

/**
 * Whether anything in a folder, at any depth, changed after `since`. Stops at the first such entry; a folder too big to
 * walk counts as recent, so it is never moved on a guess.
 * @param {string} dir @param {number} since
 */
function changedSince(dir, since) {
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const d = /** @type {string} */ (stack.pop());
    const st = lstatSync(d, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.mtimeMs > since) return true;
    if (!st.isDirectory()) continue;
    for (const f of listFiles(d)) {
      if (++seen > WALK_MAX_ENTRIES) return true;
      stack.push(join(d, f));
    }
  }
  return false;
}

/**
 * Agents' scratch folders (HOME/work/<agent>-<key>) whose task the crew list no longer has, untouched for a week.
 * @param {boolean} fix @param {number} now @returns {Check}
 */
function checkWork(fix, now) {
  const c = checker('work', 'Work folders');
  const root = paths.work();
  // Without the crew list nobody can tell which folders are in use, so none is touched.
  if (!existsSync(paths.registry())) return c.ok('Skipped: no crew list yet, so no folder is known to be finished.');
  let reg;
  try {
    reg = readRegistry();
  } catch {
    return c.warn("Skipped: crew.json can't be read.");
  }
  const members = [...Object.entries(reg.dirs).map(([dir, m]) => ({ ...m, dir })), ...Object.values(reg.sessions)];
  const names = new Set(members.filter((m) => m.key).map((m) => `${m.agent ?? m.role}-${m.key}`.toLowerCase()));
  const finished = listFiles(root).filter((name) => {
    const dir = join(root, name);
    if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return false;
    if (names.has(name.toLowerCase()) || members.some((m) => m.dir && (inside(dir, m.dir) || inside(m.dir, dir)))) return false;
    return !changedSince(dir, now - WORK_MAX_AGE_MS);
  });
  if (!finished.length) return c.ok('No leftover work folders.');
  if (!fix) return c.warn(`${count(finished.length, 'work folder')} of finished tasks, untouched for a week (${someKeys(finished)}). Run keelctl doctor --fix to move them to the attic.`);
  const attic = join(paths.attic(), 'work');
  mkdirSync(attic, { recursive: true });
  for (const name of finished) {
    const dir = join(root, name);
    if (inside(root, dir) && dir !== root) moveFile(dir, join(attic, `${name}-${now}`));
  }
  return c.fixed(`Moved ${count(finished.length, 'work folder')} of finished tasks to ${attic}: ${someKeys(finished)}.`);
}

/**
 * Crew entries nobody uses: folders that are gone, agent folders idle for a week, and sessions left behind. --fix
 * unregisters them (approval and push check included), --safe only the gone folders' entries.
 * @param {boolean} fix @param {number} now @param {boolean} [safe] @returns {Check}
 */
function checkMembers(fix, now, safe = false) {
  const c = checker('members', 'Crew entries');
  if (!existsSync(paths.registry())) return c.ok('No crew list yet.');
  try {
    readRegistry();
  } catch {
    return c.warn("Skipped: crew.json can't be read.");
  }
  const stale = staleMembers({ now });
  const n = stale.dirs.length + stale.sessions.length;
  if (!n) return c.ok('Every crew folder exists and is in use.');
  const what = `${count(stale.dirs.length, 'folder')} gone or idle for a week${stale.dirs.length ? ` (${someKeys(stale.dirs.map((d) => basename(d)))})` : ''} and ${count(stale.sessions.length, 'session')} left behind`;
  if (!fix) return c.warn(`${what}. Run keelctl doctor --fix to unregister them.`);
  if (safe) {
    const gone = stale.dirs.filter((d) => !existsSync(d));
    if (!gone.length) return c.warn(`${what}. Run keelctl doctor --fix to unregister them.`);
    for (const d of gone) unregisterDir(d);
    const left = n - gone.length;
    const done = `Unregistered ${count(gone.length, 'folder')} that ${gone.length === 1 ? 'is' : 'are'} gone (${someKeys(gone.map((d) => basename(d)))}).`;
    return left ? { ...c.warn(`${done} ${count(left, 'other entry', 'other entries')} idle or left behind: run keelctl doctor --fix.`), fixed: true } : c.fixed(done);
  }
  pruneMembers({ now });
  return c.fixed(`Unregistered ${what}.`);
}

/**
 * Every engineer and agent worktree has its push check (git pre-push through Keelcrew's hooks folder). --fix installs a
 * missing one, for example after the plugin moved, and reinstalls one that runs another worktree's check.
 * @param {boolean} fix @returns {Check}
 */
function checkPushGuards(fix) {
  const c = checker('pushguard', 'Push checks');
  if (!existsSync(paths.registry())) return c.ok('No crew list yet.');
  let reg;
  try {
    reg = readRegistry();
  } catch {
    return c.warn("Skipped: crew.json can't be read.");
  }
  const dirs = Object.entries(reg.dirs).filter(([d, m]) => (m.role === 'engineer' || m.role === 'agent') && isWorktreeTop(d)).map(([d]) => d);
  const missing = dirs.filter((d) => !pushGuardStatus(d).installed || !existsSync(join(paths.githooks(d), 'pre-push')) || !hookPointsHere(d) || chainsCrewHooks(d));
  if (!missing.length) return c.ok(dirs.length ? `${count(dirs.length, 'worktree')} with the push check.` : 'No crew worktrees yet.');
  if (!fix) return c.warn(`${count(missing.length, 'worktree')} without a working push check (${someKeys(missing.map((d) => basename(d)))}). Run keelctl doctor --fix to install it.`);
  const failed = missing.filter((d) => !guardFolder(d).installed);
  return failed.length ? c.fail(`Couldn't install the push check in ${someKeys(failed)}.`) : c.fixed(`Installed the push check in ${count(missing.length, 'worktree')}.`);
}

/**
 * Claude Code settings that would switch the crew policy off: `disableAllHooks` stops the policy hook, and
 * `bypassPermissions` skips Claude Code's own checks. Read from the Mate folder's settings and the user's own; reported,
 * never changed (they are the captain's).
 */
function checkClaudeGuard() {
  const c = checker('claudeguard', 'Claude settings');
  const config = readConfig();
  // CLAUDE_CONFIG_DIR is where Claude Code keeps the user's own settings when it is set.
  const files = [join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json')];
  if (config.leadDir) for (const f of ['settings.json', 'settings.local.json']) files.push(join(expandHome(config.leadDir), '.claude', f));
  const problems = [];
  for (const f of files) {
    let s;
    try {
      s = readJsonStrict(f, {});
    } catch {
      problems.push(`${f} isn't valid JSON`);
      continue;
    }
    if (s?.disableAllHooks === true) problems.push(`${f} sets disableAllHooks, which switches the crew policy off`);
    if (s?.permissions?.defaultMode === 'bypassPermissions') problems.push(`${f} sets defaultMode bypassPermissions`);
  }
  return problems.length ? c.fail(`${problems.join('; ')}. Change it by hand.`) : c.ok('Nothing switches the crew policy off.');
}

/**
 * The live plugin's own code: only the captain updates it (git pull or merge), so a change nobody committed there means
 * something edited the crew's code or hooks in place. Checked only when this is the plugin Claude Code loads.
 */
function checkPluginCode() {
  const c = checker('plugincode', 'Crew code');
  let live;
  let here;
  try {
    live = realpathSync(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'skills', 'keelcrew'));
    here = realpathSync(PLUGIN_ROOT);
  } catch {
    return c.ok('No live plugin link to compare.');
  }
  if (live !== here) return c.ok('Not the plugin Claude Code loads.');
  let out;
  try {
    out = execFileSync('git', ['-C', join(here, '..'), 'status', '--porcelain', '--', '.'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd();
  } catch {
    return c.ok("Not a git checkout, so changes can't be checked.");
  }
  if (!out) return c.ok('No uncommitted changes to the live plugin.');
  const files = out.split('\n').filter(Boolean).map((l) => l.slice(3));
  return c.fail(`The live plugin has changes nobody committed (${someKeys(files)}). Only the captain updates it; check them with git diff before anything else.`);
}

/** The Mate folder's Claude Code settings Keelcrew keeps: crew sessions' permission mode and compact window. @param {boolean} fix */
function checkLeadSettings(fix) {
  const c = checker('leadsettings', 'Mate folder settings');
  const config = readConfig();
  if (!config.leadDir) return c.ok('No Mate folder yet.');
  const { file, wanted, drift, missing } = leadSettingsStatus(config);
  if (missing) return c.warn(`The Mate folder ${config.leadDir} doesn't exist. Run /keel-setup to choose one; its settings follow.`);
  const what = `${wanted.defaultMode} mode, compacting at ${wanted.compactWindow === 'auto' ? 'the model\'s own window' : `${Number(wanted.compactWindow) / 1000}k tokens`}${wanted.allowTools.length ? `, ${wanted.allowTools.map((t) => t.split('__').pop()).join(', ')} allowed` : ''}${wanted.subagentModel ? `, subagents on ${wanted.subagentModel}` : ''}`;
  if (!drift.length) return c.ok(`Crew sessions start in ${what}.`);
  if (!fix) return c.warn(`In ${file}: ${drift.join('; ')}. Run keelctl doctor --fix.`);
  applyLeadSettings(config);
  return c.fixed(`Crew sessions now start in ${what} (${file}).`);
}

/**
 * The helper, the board's hands on this Mac: installed as a Claude app extension, or an entry in the app's config that
 * runs a file that exists (the fallback where extensions are blocked).
 */
function checkHelper() {
  const c = checker('helper', 'Board helper');
  const howTo = 'Run ~/.keelcrew/bin/keelctl helper bundle --open and click Install in the Claude app.';
  // The app names an extension's server by its display name, and the board calls host:keelcrew-local.
  const ext = helperExtensionManifest();
  if (ext && ext.display_name !== HELPER_SERVER) return c.fail(`The Keelcrew helper extension installed in the Claude app is an older build the board can't reach. Uninstall Keelcrew helper (Claude app → Settings → Extensions), then run ~/.keelcrew/bin/keelctl helper bundle --open and click Install.`);
  let entry;
  try {
    entry = readJsonStrict(paths.desktopConfig(), {})?.mcpServers?.[HELPER_SERVER];
  } catch {
    if (ext) return c.ok('The Claude app runs the helper as an extension.');
    return c.warn(`The Claude app's config isn't valid JSON, so its ${HELPER_SERVER} entry can't be read.`);
  }
  if (ext) {
    if (!entry) return c.ok('The Claude app runs the helper as an extension.');
    return c.warn(`The Claude app runs the helper as an extension, and its config also has an older ${HELPER_SERVER} entry under the same name. Remove that entry from ${paths.desktopConfig()} with the app quit.`);
  }
  if (!entry) return c.warn(`The Claude app doesn't have the helper, so the board can't reach this Mac. ${howTo}`);
  // nvm and Homebrew keep each node version in its own folder, so an upgrade can take the entry's node away.
  if (typeof entry.command === 'string' && isAbsolute(entry.command) && !existsSync(entry.command)) return c.fail(`The app's ${HELPER_SERVER} entry runs ${entry.command}, which is missing (node was moved or upgraded). ${howTo} Where extensions are blocked, run ~/.keelcrew/bin/keelctl helper install --restart in Terminal instead.`);
  const script = Array.isArray(entry.args) && typeof entry.args[0] === 'string' ? entry.args[0] : undefined;
  if (!script || !existsSync(script)) return c.fail(`The app's ${HELPER_SERVER} entry runs ${script ?? 'no helper file'}, which is missing. ${howTo} Where extensions are blocked, run ~/.keelcrew/bin/keelctl helper install --restart in Terminal instead.`);
  return c.ok(`The Claude app runs the helper from ${script}.`);
}

/** Whether a worktree's managed pre-push still runs this plugin's check script (it moves when the plugin is updated). @param {string} dir */
function hookPointsHere(dir) {
  try {
    return readFileSync(join(paths.githooks(dir), 'pre-push'), 'utf8').includes(join(PLUGIN_ROOT, 'hooks', 'git-pre-push.mjs'));
  } catch {
    return false;
  }
}

/** Handled alerts (alerts/seen/) older than KEEP_HANDLED_MS. @param {boolean} fix @param {number} now @returns {Check} */
function checkAlerts(fix, now) {
  const c = checker('alerts', 'Handled alerts');
  const dir = paths.alertsSeen();
  const old = listFiles(dir).filter((f) => now - mtime(join(dir, f)) > KEEP_HANDLED_MS);
  if (!old.length) return c.ok('No handled alert older than 14 days.');
  if (!fix) return c.warn(`${count(old.length, 'handled alert')} older than 14 days. Run keelctl doctor --fix to delete them.`);
  for (const f of old) rmSync(join(dir, f), { recursive: true, force: true });
  return c.fixed(`Deleted ${count(old.length, 'handled alert')} older than 14 days.`);
}

/** Denial counts of sessions no longer in the crew, untouched for KEEP_HANDLED_MS. @param {boolean} fix @param {number} now @returns {Check} */
function checkDenials(fix, now) {
  const c = checker('denials', 'Denial counts');
  let reg;
  try {
    reg = readRegistry();
  } catch {
    return c.warn("Skipped: crew.json can't be read.");
  }
  const dir = join(HOME, 'denials');
  // A pause (a spend pause included) stays until someone lifts it, however old.
  const old = listFiles(dir).filter((f) => !reg.sessions[f.replace(/\.json$/, '')] && now - mtime(join(dir, f)) > KEEP_HANDLED_MS && readJsonLoose(join(dir, f), null)?.paused === false);
  if (!old.length) return c.ok('No old denial count of a gone session.');
  if (!fix) return c.warn(`${count(old.length, 'denial count')} of sessions no longer in the crew, older than 14 days. Run keelctl doctor --fix to delete them.`);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return c.fixed(`Deleted ${count(old.length, 'old denial count')}.`);
}

/**
 * Activity (events/) and state (state/) files of folders no longer in the crew, and cost scans (cache/usage-*.json, one per
 * transcript, rebuilt when read again), untouched for KEEP_GONE_MS. @param {boolean} fix @param {number} now @returns {Check}
 */
function checkOrphans(fix, now) {
  const c = checker('orphans', 'Old activity files');
  let reg;
  try {
    reg = readRegistry();
  } catch {
    return c.warn("Skipped: crew.json can't be read.");
  }
  const live = new Set([...Object.keys(reg.dirs), ...Object.values(reg.sessions).map((m) => m.dir)].filter(Boolean).map((d) => hash16(d)));
  const old = ['events', 'state'].flatMap((sub) =>
    listFiles(join(HOME, sub))
      .filter((f) => /^[0-9a-f]{16}\./.test(f) && !live.has(f.slice(0, 16)) && now - mtime(join(HOME, sub, f)) > KEEP_GONE_MS)
      .map((f) => join(HOME, sub, f)),
  );
  const scans = listFiles(paths.cache())
    .filter((f) => /^usage-[0-9a-f]{16}\.json$/.test(f) && now - mtime(join(paths.cache(), f)) > KEEP_GONE_MS)
    .map((f) => join(paths.cache(), f));
  if (!old.length && !scans.length) return c.ok('No activity file of a folder gone for 30 days, and no cost scan unread for 30 days.');
  const what = [old.length ? `${count(old.length, 'activity or state file')} of folders no longer in the crew` : '', scans.length ? count(scans.length, 'cost scan') : ''].filter(Boolean).join(' and ');
  if (!fix) return c.warn(`${what}, untouched for 30 days. Run keelctl doctor --fix to delete them.`);
  for (const p of [...old, ...scans]) rmSync(p, { force: true });
  return c.fixed(`Deleted ${what}, untouched for 30 days.`);
}

/** Attic items (work and board folders moved aside, damaged files) older than KEEP_GONE_MS. @param {boolean} fix @param {number} now @returns {Check} */
function checkAttic(fix, now) {
  const c = checker('attic', 'Attic');
  const root = paths.attic();
  // An item's age is the time in its name (<name>-<ms>, when it was moved here), else its mtime.
  const age = (/** @type {string} */ p) => now - (Number(/-(\d{13})$/.exec(basename(p))?.[1]) || mtime(p));
  const items = listFiles(root).flatMap((f) => {
    const p = join(root, f);
    return ['work', 'board'].includes(f) && lstatSync(p, { throwIfNoEntry: false })?.isDirectory() ? listFiles(p).map((g) => join(p, g)) : [p];
  });
  const old = items.filter((p) => age(p) > KEEP_GONE_MS);
  if (!old.length) return c.ok('Nothing in the attic older than 30 days.');
  if (!fix) return c.warn(`${count(old.length, 'attic item')} older than 30 days (${someKeys(old.map((p) => basename(p)))}). Run keelctl doctor --fix to delete them.`);
  for (const p of old) if (inside(root, p) && p !== root) rmSync(p, { recursive: true, force: true });
  return c.fixed(`Deleted ${count(old.length, 'attic item')} older than 30 days.`);
}

/** @param {string} dir */
function listFiles(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
/** @param {string} p */
const mtime = (p) => statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
/** @param {string} p */
const size = (p) => statSync(p, { throwIfNoEntry: false })?.size ?? 0;

/** @param {string} from @param {string} to */
function moveFile(from, to) {
  try {
    renameSync(from, to);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EXDEV') throw e;
    if (lstatSync(from).isDirectory()) cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    else copyFileSync(from, to);
    rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Runs every check (or just `only`, by id), repairing what is safe when `fix` is set; with `safe` too, only the
 * SAFE_FIXES, and crew entries only for folders that are gone. A check that throws is reported as failed; the rest still
 * run.
 * @param {{ fix?: boolean, safe?: boolean, now?: number, only?: string }} [options]
 * @returns {{ checks: Check[] }}
 */
export function runDoctor({ fix: fixAll = false, safe = false, now = Date.now(), only } = {}) {
  /** @param {string} id */
  const may = (id) => fixAll && (!safe || SAFE_FIXES.has(id));
  /** @type {[string, string, () => Check][]} */
  const steps = [
    // Locks first, so the fixes below never wait on a dead process's lock.
    ['locks', 'Locks', () => checkLocks(may('locks'), now)],
    ['config', 'Settings', checkConfig],
    ['registry', 'Crew list', checkRegistry],
    ['rules', 'Rules', checkRules],
    ['pack', 'Team pack', checkPack],
    ['jobs', 'Watch sessions', () => checkJobs(may('jobs'), now)],
    ['busy', 'Busy flags', () => checkBusy(may('busy'), now)],
    ['logs', 'Logs', () => checkLogs(may('logs'))],
    ['memory', 'Memory', () => checkMemory(may('memory'))],
    ['lessons', 'Lessons', () => checkLessons(may('lessons'), now)],
    ['work', 'Work folders', () => checkWork(may('work'), now)],
    ['members', 'Crew entries', () => checkMembers(may('members'), now, safe)],
    ['alerts', 'Handled alerts', () => checkAlerts(may('alerts'), now)],
    ['denials', 'Denial counts', () => checkDenials(may('denials'), now)],
    ['orphans', 'Old activity files', () => checkOrphans(may('orphans'), now)],
    ['attic', 'Attic', () => checkAttic(may('attic'), now)],
    ['pushguard', 'Push checks', () => checkPushGuards(may('pushguard'))],
    ['leadsettings', 'Mate folder settings', () => checkLeadSettings(may('leadsettings'))],
    ['claudeguard', 'Claude settings', checkClaudeGuard],
    ['plugincode', 'Crew code', checkPluginCode],
    ['helper', 'Board helper', checkHelper],
  ];
  if (only !== undefined && !steps.some(([id]) => id === only)) throw new Error(`No check "${only}". Checks: ${steps.map(([id]) => id).join(', ')}`);
  const checks = steps.filter(([id]) => only === undefined || id === only).map(([id, label, run]) => {
    try {
      return run();
    } catch (e) {
      return checker(id, label).fail(`Check failed: ${/** @type {Error} */ (e).message}`);
    }
  });
  return { checks };
}
