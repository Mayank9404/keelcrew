// @ts-check
// Where Keelcrew keeps things: the plugin's own files, and the crew's state on this Mac (~/.keelcrew, or KEELCREW_HOME).
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = process.env.KEELCREW_HOME ?? join(homedir(), '.keelcrew');

/** The first 16 hex digits of a folder's SHA-1: how state, events and approval files are named per folder. @param {string} dir */
export const hash16 = (dir) => createHash('sha1').update(dir).digest('hex').slice(0, 16);

/** `~/x` → an absolute path. @param {string} p */
export const expand = (p) => resolve(p.replace(/^~(?=$|\/)/, homedir()));

/** Whether `p` is `root` or inside it. @param {string} root @param {string} p */
export const inside = (root, p) => {
  const rel = relative(root, resolve(root, p));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export const paths = {
  config: () => join(HOME, 'config.json'),
  registry: () => join(HOME, 'crew.json'),
  registryLock: () => join(HOME, 'locks', 'crew'),
  /** @param {string} dir */ grant: (dir) => join(HOME, 'grants', `${hash16(dir)}.json`),
  grantLock: () => join(HOME, 'locks', 'grants'),
  /** @param {string} dir */ state: (dir) => join(HOME, 'state', `${hash16(dir)}.json`),
  /** @param {string} dir */ alive: (dir) => join(HOME, 'state', `${hash16(dir)}.alive.json`),
  /** @param {string} dir */ events: (dir) => join(HOME, 'events', `${hash16(dir)}.jsonl`),
  memory: () => join(HOME, 'memory'),
  memoryLock: () => join(HOME, 'locks', 'memory'),
  posts: () => join(HOME, 'posts'),
  postsLock: () => join(HOME, 'locks', 'posts'),
  /** @param {string} sessionId */ denials: (sessionId) => join(HOME, 'denials', `${String(sessionId).replace(/[^\w.-]/g, '_')}.json`),
  denialsLock: () => join(HOME, 'locks', 'denials'),
  alerts: () => join(HOME, 'alerts'),
  alertsSeen: () => join(HOME, 'alerts', 'seen'),
  work: () => join(HOME, 'work'),
  /** Briefs the Mate writes for sessions the captain starts from the board. */ briefs: () => join(HOME, 'briefs'),
  attic: () => join(HOME, 'attic'),
  /** The git hooks Keelcrew manages for one worktree (its push check). @param {string} dir */ githooks: (dir) => join(HOME, 'githooks', hash16(dir)),
  logs: () => join(HOME, 'logs'),
  cache: () => join(HOME, 'cache'),
  summary: () => join(HOME, 'summary.json'),
  /** The plan's 5-hour and weekly use, as the panel mod in the Mate session last read it. */ usage: () => join(HOME, 'usage.json'),
  /** `<request id>.json` per /compact a crew session's panel ran for a board request. */ compacted: () => join(HOME, 'compacted'),
  /** The last Jira scan the panel mod in the Mate session ran. */ scan: () => join(HOME, 'scan.json'),
  /** The last routine health check the panel mod in the Mate session ran. */ health: () => join(HOME, 'health.json'),
  userPacks: () => join(HOME, 'packs'),
  rules: () => join(PLUGIN_ROOT, 'rules', 'rules.json'),
  packs: () => join(PLUGIN_ROOT, 'packs'),
  agents: () => join(PLUGIN_ROOT, 'agents'),
  /** Department manifests: the org's departments, each with a head role and a switch. */ departments: () => join(PLUGIN_ROOT, 'departments'),
  /** The captain's company: department and role switches, seats, approved models, budgets, goals. */ org: () => join(HOME, 'org.json'),
  /** One record per ticket or work item, kept in its own git repo and written only by `keelctl ledger`. */ ledger: () => join(HOME, 'ledger'),
  /** Weekly allowances used, spend alarm lines and flags, computed by code from the ledger. */ spend: () => join(HOME, 'spend.json'),
  /** Crew PRs the panel saw merge, for the board to set their rows. */ merges: () => join(HOME, 'merges.json'),
  /** The phone answers the Mate's panel carried out with `keelctl grant`, keyed "<card id> <answeredAt>". */ phoneGrants: () => join(HOME, 'phone-grants.json'),
  /** What Keelcrew last wrote into the Mate folder's settings that it may take out again (the subagent model). */ leadSettingsState: () => join(HOME, 'lead-settings.json'),
  /** The `keelctl` command: a link to this plugin's cli/keelctl.mjs. */ crewBin: () => join(HOME, 'bin', 'keelctl'),
  /** The helper the Claude app runs: a link to this plugin's helper/server.mjs, so the app's entry survives plugin updates. */ helperBin: () => join(HOME, 'bin', 'keelcrew-helper'),
  /** The Claude app's config, where its entry for the helper lives (KEELCREW_DESKTOP_CONFIG in tests). */
  desktopConfig: () => process.env.KEELCREW_DESKTOP_CONFIG ?? join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  /** Where the Claude app keeps the desktop extensions it installed, beside its config. */
  desktopExtensions: () => join(dirname(paths.desktopConfig()), 'Claude Extensions'),
  /** The helper as a desktop extension, which the Claude app installs from one dialog with no restart. */
  helperBundle: () => join(HOME, 'keelcrew-helper.mcpb'),
};
