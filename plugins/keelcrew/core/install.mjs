// @ts-check
// The `keelctl` and `keelcrew-helper` links in ~/.keelcrew/bin, which run the installed plugin's code, and the Claude app's
// entry for the helper. A plugin update moves the plugin to a new folder in Claude Code's plugin cache, so the
// session-start hook points the links at the copy that is running; the app's entry runs the link, so it follows too.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isObject, readJsonLoose, readJsonStrict, writeJsonAtomic } from './fsx.mjs';
import { HOME, PLUGIN_ROOT, inside, paths } from './paths.mjs';

/** The helper's name in the Claude app's config: the board calls it as `host:keelcrew-local`. */
export const HELPER_SERVER = 'keelcrew-local';
/** The oldest node the app may run the helper with (the install guide's requirement). */
export const MIN_NODE_MAJOR = 22;
/** Where Claude Code keeps installed plugins: the cache (one folder per version) and plugins synced from claude.ai. */
const PLUGIN_CACHE = /[\\/]plugins[\\/](cache|synced)[\\/]/;
/** The Claude desktop app's own process (Claude Code's bundled `claude` is lowercase). */
const CLAUDE_APP = /\/Claude\.app\/Contents\/MacOS\/Claude$/m;

/** Each link in ~/.keelcrew/bin and the plugin file it runs. @param {string} root */
const links = (root) => [
  { link: paths.crewBin(), target: join(root, 'cli', 'keelctl.mjs') },
  { link: paths.helperBin(), target: join(root, 'helper', 'server.mjs') },
];

/** @param {string} link @param {string} target */
function point(link, target) {
  chmodSync(target, 0o755);
  mkdirSync(dirname(link), { recursive: true });
  rmSync(link, { force: true });
  symlinkSync(target, link);
}

/** Points both links at this plugin (setup, `keelctl helper bundle` and `keelctl helper install`). @returns {string[]} the links */
export function linkAll(root = PLUGIN_ROOT) {
  return links(root).map(({ link, target }) => (point(link, target), link));
}

/** A plugin copy's version from its plugin.json, as numbers (missing parts are 0). @param {string} root */
const versionOf = (root) => String(readJsonLoose(join(root, '.claude-plugin', 'plugin.json'), {})?.version ?? '').split('.').map((n) => Number(n) || 0);

/** Whether the copy a link runs (a file two folders into it) is an older version than `root`. @param {string} target @param {string} root */
function olderCopy(target, root) {
  const [was, now] = [versionOf(dirname(dirname(target))), versionOf(root)];
  for (let i = 0; i < Math.max(was.length, now.length); i++) if ((now[i] ?? 0) !== (was[i] ?? 0)) return (now[i] ?? 0) > (was[i] ?? 0);
  return false;
}

/**
 * Points a link at this plugin when it is missing, broken, runs a file this copy no longer uses (a folder updated in
 * place keeps files a release dropped), or runs an older version from the plugin cache (after an update; a session
 * still on the old version never pulls it back). A link to a checkout outside the cache, and a file that isn't a link,
 * are the captain's and are left alone. Does nothing before setup.
 * @returns {string[]} the links it changed
 */
export function healLinks(root = PLUGIN_ROOT) {
  if (!existsSync(paths.config())) return [];
  const changed = [];
  for (const { link, target } of links(root)) {
    const stat = lstatSync(link, { throwIfNoEntry: false });
    if (stat && !stat.isSymbolicLink()) continue;
    const current = stat ? readlinkSync(link) : null;
    if (current === target) continue;
    if (current !== null && existsSync(link) && !inside(root, current) && !(PLUGIN_CACHE.test(current) && olderCopy(current, root))) continue;
    point(link, target);
    changed.push(link);
  }
  return changed;
}

/** Whether the Claude desktop app is running: it rewrites its config when it quits, so an edit made meanwhile is lost. */
export function claudeAppRunning() {
  try {
    return CLAUDE_APP.test(execFileSync('ps', ['-axo', 'comm'], { encoding: 'utf8', timeout: 5000 }));
  } catch {
    return false;
  }
}

/**
 * Writes the helper as a Claude desktop extension (paths.helperBundle()): the app installs it from one dialog, with no
 * restart, and runs it with its own node. Its entry runs the `keelcrew-helper` link, so a plugin update needs no new
 * bundle. Needs macOS's `zip`. @returns {string} the bundle's path
 */
export function bundleHelper() {
  linkAll();
  const dir = mkdtempSync(join(tmpdir(), 'keelcrew-helper-'));
  try {
    mkdirSync(join(dir, 'server'));
    const manifest = {
      manifest_version: '0.3',
      name: HELPER_SERVER,
      // The app names the server by its display name, and the board calls it as host:keelcrew-local.
      display_name: HELPER_SERVER,
      version: String(readJsonLoose(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), {})?.version ?? '0.0.0'),
      description: "Lets your Keelcrew board reach this Mac: the crew's state, diffs, approvals and logs.",
      author: { name: 'Keelcrew contributors' },
      server: { type: 'node', entry_point: 'server/index.mjs', mcp_config: { command: 'node', args: ['${__dirname}/server/index.mjs'], env: { KEELCREW_HOME: HOME } } },
    };
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(dir, 'server', 'index.mjs'), `// Runs the Keelcrew helper through the link Keelcrew keeps pointed at the installed plugin.\nawait import(${JSON.stringify(pathToFileURL(paths.helperBin()).href)});\n`);
    const out = paths.helperBundle();
    rmSync(out, { force: true });
    execFileSync('zip', ['-qr', out, 'manifest.json', 'server'], { cwd: dir, timeout: 30_000 });
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Waits up to `timeoutMs` for the helper extension to be installed (the captain clicks Install). @returns {boolean} */
export function waitForHelperExtension(timeoutMs) {
  for (const end = Date.now() + timeoutMs; !helperExtensionInstalled(); ) {
    if (Date.now() > end) return false;
    execFileSync('sleep', ['1']);
  }
  return true;
}

/** Whether the Claude app has this build of the helper (an older one names its server otherwise, which the board can't reach). */
export function helperExtensionInstalled() {
  return helperExtensionManifest()?.display_name === HELPER_SERVER;
}

/** The installed helper extension's manifest, `{}` when it can't be read, or null when none is installed. */
export function helperExtensionManifest() {
  let folder;
  try {
    folder = readdirSync(paths.desktopExtensions()).find((n) => n.endsWith(`.${HELPER_SERVER}`));
  } catch {
    return null;
  }
  if (!folder) return null;
  const manifest = readJsonLoose(join(paths.desktopExtensions(), folder, 'manifest.json'), {});
  return isObject(manifest) ? manifest : {};
}

/**
 * Quits the Claude app and waits for it to exit (it may ask about running sessions first). Never from a session the app
 * hosts, which would end with it. @returns {boolean} whether it exited in time
 */
export function quitClaudeApp(timeoutMs = 120_000) {
  try {
    execFileSync('osascript', ['-e', 'quit app "Claude"'], { stdio: 'ignore', timeout: 30_000 });
  } catch {
    /* refused or timed out: the wait below says whether it quit */
  }
  for (const end = Date.now() + timeoutMs; claudeAppRunning(); ) {
    if (Date.now() > end) return false;
    execFileSync('sleep', ['1']);
  }
  return true;
}

/**
 * The node the app should run the helper with: this one when it is MIN_NODE_MAJOR or newer, else the newest such node
 * from nvm, Homebrew or /usr/local (a Mac's default node is often older than the one installed beside it), else null.
 * @returns {string | null}
 */
export function helperNode(home = homedir()) {
  const major = (v) => Number(String(v).split('.')[0]) || 0;
  if (major(process.versions.node) >= MIN_NODE_MAJOR) return process.execPath;
  const kids = (dir, re, sub) => {
    try {
      return readdirSync(dir).filter((n) => re.test(n)).map((n) => join(dir, n, sub));
    } catch {
      return [];
    }
  };
  const candidates = [
    ...kids(join(home, '.nvm', 'versions', 'node'), /^v\d/, 'bin/node'),
    ...['/opt/homebrew', '/usr/local'].flatMap((b) => [join(b, 'bin', 'node'), ...kids(join(b, 'opt'), /^node(@\d+)?$/, 'bin/node')]),
  ];
  let best = null;
  let bestMajor = MIN_NODE_MAJOR - 1;
  for (const node of candidates) {
    try {
      const m = major(execFileSync(node, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
      if (m > bestMajor) [best, bestMajor] = [node, m];
    } catch {
      /* not a working node */
    }
  }
  return best;
}

/**
 * Adds or updates the helper's entry in the Claude app's config, keeping everything else in the file (through a
 * symlink, with its mode). The first run keeps a copy of the file as it was before Keelcrew changed it. The entry runs
 * the `keelcrew-helper` link with this node, by absolute paths (the app reads no shell profile).
 * @returns {{ file: string, backup: string | null, entry: { command: string, args: string[] } }}
 * @throws {import('./fsx.mjs').CorruptFileError} when the config isn't valid JSON (nothing is written)
 */
export function installHelperEntry(node = process.execPath) {
  const file = paths.desktopConfig();
  const config = readJsonStrict(file, {});
  if (!isObject(config)) throw new Error(`${file} isn't a JSON object, so it was left alone. Repair it by hand.`);
  const entry = { command: node, args: [paths.helperBin()] };
  const exists = existsSync(file);
  const real = exists ? realpathSync(file) : file;
  const backup = `${file}.keelcrew-backup`;
  if (exists && !existsSync(backup)) copyFileSync(real, backup);
  const mode = exists ? statSync(real).mode & 0o777 : null;
  writeJsonAtomic(real, { ...config, mcpServers: { ...(isObject(config.mcpServers) ? config.mcpServers : {}), [HELPER_SERVER]: entry } });
  if (mode !== null) chmodSync(real, mode);
  return { file, backup: existsSync(backup) ? backup : null, entry };
}
