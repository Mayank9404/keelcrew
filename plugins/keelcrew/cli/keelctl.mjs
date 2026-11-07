#!/usr/bin/env node
// @ts-check
// crew: setup, membership, memory and checks for the Keelcrew crew on this Mac. `keelctl help` lists the commands.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { DIFFICULTIES, agentById, scanAgents } from '../core/agents.mjs';
import { listAlerts, markAlertSeen, writeAlert } from '../core/alerts.mjs';
import { costs as costsOf } from '../core/costs.mjs';
import { readConfig, readRegistry, updateConfig, updateRegistry } from '../core/crew.mjs';
import { readDenials, unpause as unpauseSessions } from '../core/denials.mjs';
import { JOB_MAX_AGE_MS, SERVED_MAX_AGE_MS, runDoctor } from '../core/doctor.mjs';
import { CorruptFileError, writeJsonAtomic } from '../core/fsx.mjs';
import { readGrant } from '../core/grants.mjs';
import { LEDGER_EVENTS, applyEvent, commitLedger, listRecords, readRecord } from '../core/ledger.mjs';
import { feed, measureEdits, recordSpend } from '../core/ledgerfeed.mjs';
import { mainAuthor, modelFor, orgRules, readOrg, readOrgFile, roleIdOf, staff } from '../core/org.mjs';
import { linkBug, scanReverts } from '../core/ledgerlink.mjs';
import { mateOnly, parseArgs } from '../core/cliargs.mjs';
import { weeklyReport } from '../core/report.mjs';
import { checkSpend, continueSpend, readSpend } from '../core/spend.mjs';
import { readProactive } from '../core/proactive.mjs';
import { HELPER_SERVER, MIN_NODE_MAJOR, bundleHelper, claudeAppRunning, helperNode, installHelperEntry, linkAll, quitClaudeApp, waitForHelperExtension } from '../core/install.mjs';
import { guardFolder, rekeySession, unregisterDir } from '../core/membership.mjs';
import {
  LESSON_TYPES,
  addLesson,
  approvePlaybook,
  compilePlaybook,
  editLesson,
  forgetLesson,
  listLessons,
  pinLesson,
  playbookDiff,
  playbookFor,
  playbookPath,
  promoteLesson,
  scopeLesson,
} from '../core/memory.mjs';
import { HOME, expand, inside, paths } from '../core/paths.mjs';
import { assessRisk } from '../core/risk.mjs';
import { loadPack, loadRules } from '../core/rules.mjs';

const USAGE = `keelctl <command>
  setup --board <url> --owner <name> [--lead-dir <folder>] [--pack <name|none>] [--cloud-id <id>] [--prompt-mode deny|ask]
  helper bundle [--open]            (the board's helper as a Claude app extension; --open shows its Install dialog and waits for the click)
  helper install [--restart]        (in Terminal, when extensions are blocked: adds the helper to the app's config; --restart quits and reopens it)
  register <lead|engineer|agent|job> [KEY] [dir] [--agent <id>] [--repo <name>]
  unregister [dir]
  rekey <oldSessionId> [--session <newSessionId>]   (after /clear, from the same folder: the panel keeps this session in the crew)
  status
  doctor [check] [--fix [--safe]] [--json]   (one check by id, e.g. leadsettings; --safe: only the housekeeping fixes the Mate's panel makes itself)
  risk [dir] [--base <branch>] [--json]
  costs [--key KEY] [--json]
  unpause <sessionId|KEY>
  alerts [--json] | alerts seen <id|all> | alerts add --kind <kind> --summary <text> [--key KEY]
  memory add --type <type> --key <key> --text <text> [--repo r] [--agent id] [--area a] [--task KEY]
             [--source s --ref r --quote q] [--confidence 0..1]
  memory list [--repo r] [--agent id] [--area a] [--all] [--json]
  memory edit <key> --text <text>
  memory scope <key> [--task KEY] [--repo r] [--agent id] [--area a]   (a task's lessons reach only that task's session and the Mate)
  memory forget <key> | pin <key> | promote <key> | compile | show [--role r] [--repo r] [--agent id] [--task KEY]
  memory diff [--json] | approve
  ledger show <KEY> [--json] | list [--json] | report [--weeks n] [--switch-on YYYY-MM-DD] [--json]
  ledger link-bug <BUG-KEY> --repo <name> --file <path> --line <n> [--severity s]   (the Mate: git blame finds the ticket)
  org show [--json]
  org staff <KEY> --difficulty d [--mechanical]
  org model <role|lead|subagents> [--difficulty d] [--json]   the model and effort a role runs on, and where they come from
  spend [show] [--json] | check [--json] | continue <KEY>   (check: the panel; continue: Mate only, from the captain's answer)
  org proactive [--json]               whether the Mate may start a suggestion by itself now, and paused sources
  org owner <path> --dir <repo checkout> --base <branch>   the file's main author on the base branch, and whether it's you
  ledger event <type> <KEY> [json] | feed <facts.json> | spend | reverts | commit
                                    (code only: hooks, the panel and the helper)
  agents [id] [--json]
  pack [--json] | pack init <team> [--title <text>] [--lead-dir <folder>] [--jira-site <url> [--jql <query>]]
                                    (setup: the captain's own team pack, from the repos in the Mate folder)
  grant ship <KEY> --choice <choice> [--head <sha>] [--answered-at <ms>] [--json]
  grant post <KEY> --tool <tool> [--match <text>] [--answered-at <ms>] [--json]
                                    (the panels only: a /keel-panel click, or the captain's answer from the board on a phone)`;

const ROLES = ['lead', 'engineer', 'agent', 'job'];
/** The Jira query a new pack starts with: the captain's open tickets. */
const DEFAULT_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
const AGENT_ID = /^[a-z][a-z0-9-]*$/;

/** A mistake the user can fix: printed plainly, exit 1. */
class UserError extends Error {}

/** @param {string} msg @returns {never} */
const fail = (msg) => {
  throw new UserError(msg);
};


const [cmd, ...rest] = process.argv.slice(2);
const { flags, pos } = parseArgs(rest);
/** A text flag's value, or undefined. @param {string} name */
const opt = (name) => (typeof flags[name] === 'string' ? /** @type {string} */ (flags[name]) : undefined);

/** @param {number} ms */
function stamp(ms) {
  const d = new Date(ms);
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The repo a worktree belongs to: its first folder under the Mate folder, else the repo git reports. @param {string} dir @param {string | null} leadDir */
function repoOf(dir, leadDir) {
  if (leadDir && dir !== leadDir && inside(leadDir, dir)) return relative(leadDir, dir).split('/')[0];
  try {
    const common = execFileSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    return basename(dirname(common.trim()));
  } catch {
    return basename(dir);
  }
}

/** origin's default branch, else main or master (on origin, then local), else the branch checked out, else main. @param {string} path */
function baseBranchOf(path) {
  const git = (/** @type {string[]} */ ...args) => {
    try {
      return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  const has = (/** @type {string} */ ref) => git('rev-parse', '--verify', '--quiet', ref) !== '';
  return (
    git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, '') ||
    ['main', 'master'].find((b) => has(`refs/remotes/origin/${b}`) || has(`refs/heads/${b}`)) ||
    git('branch', '--show-current') ||
    'main'
  );
}

/** The git repos in the Mate folder (each folder in it with a .git folder; a .git file is a worktree of another repo),
 * with their base branches. @param {string} dir */
function reposIn(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && statSync(join(dir, e.name, '.git'), { throwIfNoEntry: false })?.isDirectory())
    .map((e) => ({ name: e.name, path: join(dir, e.name), baseBranch: baseBranchOf(join(dir, e.name)) }));
}

/* ---------- setup and membership ---------- */

function setup() {
  if (process.platform !== 'darwin') fail('Keelcrew runs on macOS only for now: it works through the Claude desktop app for Mac.');
  const config = readConfig();
  const board = opt('board') ?? config.board;
  const owner = opt('owner') ?? config.owner;
  if (!board || !owner) fail('Usage: keelctl setup --board <url> --owner <name> [--lead-dir <folder>] [--pack <name|none>] [--cloud-id <id>] [--prompt-mode deny|ask]');
  const promptMode = opt('prompt-mode') ?? config.promptMode ?? 'deny';
  if (promptMode !== 'deny' && promptMode !== 'ask') fail('--prompt-mode is deny (crew sessions are refused with a next step instead of waiting on a prompt) or ask.');
  // Engineers start in the Mate's folder and make their worktrees in the repos inside it.
  const leadDir = expand(opt('lead-dir') ?? config.leadDir ?? (existsSync(join(process.cwd(), '.git')) ? dirname(process.cwd()) : process.cwd()));
  if (!existsSync(leadDir)) fail(`${leadDir} doesn't exist.`);
  // "none" is stored as null, so doctor can tell a choice from a pack that was never set.
  const pack = opt('pack') === 'none' ? null : (opt('pack') ?? config.pack);
  if (pack) {
    try {
      loadRules(pack);
    } catch (e) {
      fail(`Team pack "${pack}" can't be used: ${/** @type {Error} */ (e).message}`);
    }
  }
  // The repos the crew works in, with their base branches; entries already in config.json (the board's edits) win.
  const found = reposIn(leadDir);
  const repos = { ...Object.fromEntries(found.map((r) => [r.name, { path: r.path, baseBranch: r.baseBranch, enabled: true }])), ...(config.repos ?? {}) };
  updateConfig({ board, owner, leadDir, pack, promptMode, repos, ...(opt('cloud-id') ? { jiraCloudId: opt('cloud-id') } : {}) });
  if (!existsSync(join(HOME, 'lead.md'))) writeFileSync(join(HOME, 'lead.md'), '');
  const [link, helperLink] = linkAll();
  const repoLine = Object.keys(repos).length ? Object.entries(repos).map(([n, r]) => `${n} (base ${r.baseBranch})`).join(', ') : `none: put the git repos the crew works in inside ${leadDir}`;
  console.log(`Keelcrew is set up for ${owner}.\n  Board: ${board}\n  Mate folder: ${leadDir}\n  Repos: ${repoLine}\n  Team pack: ${pack ?? 'none'}\n  Prompts in crew sessions: ${promptMode === 'ask' ? 'ask' : 'deny with a next step'}\n  Command: ${link}\n  Helper: ${helperLink} (keelctl helper bundle --open adds it to the Claude app)`);
}

function helper() {
  if (pos[0] === 'bundle') {
    const bundle = bundleHelper();
    if (flags.open === undefined) {
      console.log(`Wrote ${bundle}. Open it in the Claude app and click Install to add the board's helper.`);
      return;
    }
    execFileSync('open', ['-a', 'Claude', bundle], { stdio: 'ignore' });
    // Waits for the Install click, inside a session's two-minute command limit.
    if (waitForHelperExtension(100_000)) console.log('The Keelcrew helper is installed in the Claude app.');
    else fail(`The Keelcrew helper isn't installed yet: click Install in the Claude app's dialog (${bundle}), then run this again.`);
    return;
  }
  if (pos[0] !== 'install') fail('Usage: keelctl helper bundle [--open] | keelctl helper install [--restart]');
  // The app runs the helper with this node, or the newest node 22+ beside it when this one is older.
  const node = helperNode();
  if (!node) {
    fail(`This is node ${process.versions.node} (${process.execPath}), and no node ${MIN_NODE_MAJOR} or newer was found in nvm, Homebrew or /usr/local; the helper needs one. Install it, or run this with one:\n  <path to node ${MIN_NODE_MAJOR}> ${process.argv[1]} helper install --restart`);
  }
  // The app rewrites its config when it quits, which would drop an entry written while it runs.
  const restart = flags.restart !== undefined;
  if (!process.env.KEELCREW_DESKTOP_CONFIG && claudeAppRunning()) {
    if (!restart) fail(`The Claude app is running, and it rewrites its config when it quits, which would drop the helper. Run this in Terminal to quit it, add the helper and open it again:\n  node ${process.argv[1]} helper install --restart`);
    if (process.env.CLAUDE_CODE_SESSION_ID) fail('--restart quits the Claude app, which would end this session with it: run it in Terminal.');
    if (!quitClaudeApp()) fail('The Claude app didn\'t quit, so nothing was changed. Quit it (⌘Q) and run this again.');
  }
  linkAll();
  const { file, backup, entry } = installHelperEntry(node);
  console.log(`Added ${HELPER_SERVER} to the Claude app (${file}${backup ? `; the old file is in ${backup}` : ''}).\n  It runs: ${entry.command} ${entry.args[0]}\nIn the Claude app, go back to your setup session and say "go on" (or run /keel-setup in a Code session in your Mate folder).`);
  if (restart && !process.env.KEELCREW_DESKTOP_CONFIG) execFileSync('open', ['-a', 'Claude'], { stdio: 'ignore' });
}

function register() {
  const [role, rawKey, rawDir] = pos;
  if (!ROLES.includes(role)) fail('Usage: keelctl register <lead|engineer|agent|job> [KEY] [dir] [--agent <id>]');
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid) fail('Run this from the Claude Code session that is joining the crew.');
  const where = expand(rawDir ?? process.cwd());
  if (!existsSync(where)) fail(`${where} doesn't exist.`);
  const config = readConfig();
  const leadDir = config.leadDir ? expand(config.leadDir) : null;
  // An engineer may join as a role (`--agent contractor`); agents and jobs always name one.
  const agent = role === 'agent' || role === 'job' || role === 'engineer' ? opt('agent') : undefined;
  if (role === 'agent' && !agent) fail('Usage: keelctl register agent [KEY] [dir] --agent <id>');
  if (agent && !AGENT_ID.test(agent)) fail(`"${agent}" isn't an agent id (lowercase letters, digits and dashes).`);
  // An engineer takes only a contractor's role: any other would carry that agent's own allowances (a browser, say).
  if (role === 'engineer' && agent && agentById(agent)?.memberKind !== 'contractor') fail(`An engineer joins as itself or as a contractor, not as ${agent}.`);
  // A registered folder catches every session in it, so it must never be the Mate folder or one above it.
  if (role === 'engineer' && (!existsSync(join(where, '.git')) || (leadDir && inside(where, leadDir)))) {
    fail(`${where} isn't one repo's worktree. Register from inside your worktree.`);
  }
  if (role === 'agent' && leadDir && inside(where, leadDir)) fail(`Agents work in a folder of their own, not ${where}. Register from that folder.`);
  const key = rawKey && rawKey !== '-' ? rawKey.toUpperCase() : null;
  const now = Date.now();
  const hostId = process.env.CLAUDE_CODE_HOST_SESSION_ID || null;
  const extra = agent ? { agent } : {};
  updateRegistry((reg) => {
    const mine = reg.sessions[sid];
    if (mine) fail(`This session is already in the crew as ${mine.role}${mine.key ? ` for ${mine.key}` : ''}.`);
    // One engineer per ticket: a session that worked one ticket never takes another, and a ticket has one worktree.
    if (role === 'engineer') {
      reg.served = Object.fromEntries(Object.entries(reg.served ?? {}).filter(([, v]) => now - v.at < SERVED_MAX_AGE_MS));
      const before = reg.served[sid];
      if (before && before.key !== key) fail(`This session already worked ${before.key}. One engineer per ticket: ${key ?? 'other work'} gets a fresh engineer session from the Mate.`);
      // Compared by real path, so the same worktree through a link (or /var vs /private/var) is the same one.
      const real = realpathSync(where);
      const twin = key ? Object.entries(reg.dirs).find(([d, m]) => m.role === 'engineer' && m.key === key && existsSync(d) && realpathSync(d) !== real) : undefined;
      if (twin) fail(`${key} already has an engineer worktree at ${twin[0]}. One per ticket: work there, or the Mate unregisters it first.`);
      const held = Object.entries(reg.dirs).find(([d, m]) => m.role === 'engineer' && m.key !== key && existsSync(d) && realpathSync(d) === real);
      if (held) fail(`${where} is the worktree of ${held[1].key ?? 'another engineer'}. One per ticket: ${key ?? 'other work'} gets its own worktree, or the Mate unregisters this one first.`);
      if (key) reg.served[sid] = { key, at: now };
      // Re-staffing the same ticket: the engineers that worked this worktree before leave the crew, keeping their ticket.
      for (const [s, m] of Object.entries(reg.sessions)) {
        if (s === sid || m.role !== 'engineer' || !m.dir || !existsSync(m.dir) || realpathSync(m.dir) !== real) continue;
        if (m.key) reg.served[s] = { key: m.key, at: now };
        delete reg.sessions[s];
      }
    }
    for (const [s, m] of Object.entries(reg.sessions)) {
      // One Mate at a time, and watch runs are forgotten after a day.
      if ((role === 'lead' && m.role === 'lead') || (m.role === 'job' && now - m.at > JOB_MAX_AGE_MS)) delete reg.sessions[s];
    }
    if (role === 'lead') for (const [d, m] of Object.entries(reg.dirs)) if (m.role === 'lead') delete reg.dirs[d];
    if (role !== 'job') reg.dirs[where] = { role, key, ...extra, at: now };
    // hostId is the app's own id for the session (local_…), so crew members can message it without asking.
    reg.sessions[sid] = { role: /** @type {any} */ (role), key, dir: where, hostId, ...extra, at: now };
  });
  const as = agent ? ` (${agent})` : '';
  console.log(`This session joined the crew as ${role}${as}${key ? ` for ${key}` : ''} (${where}). Crew rules now apply to it.`);
  if (agent && !agentById(agent)) console.log(`Note: no agent "${agent}" in the catalog yet.`);
  // A second layer for pushes: git's pre-push in this worktree checks the same approval, however the push is started.
  if (role === 'engineer' || role === 'agent') {
    const guard = guardFolder(where);
    console.log(guard.installed ? guard.detail : `Note: ${guard.detail}`);
  }
  printPlaybook(role, where, agent, leadDir, key);
}

/** What the crew has learned, for the session that just joined. @param {string} role @param {string} dir @param {string | undefined} agent @param {string | null} leadDir @param {string | null} [key] */
function printPlaybook(role, dir, agent, leadDir, key) {
  if (role === 'job' && !agent) return;
  let md = '';
  try {
    md = role === 'lead' ? playbookFor({ role }) : playbookFor({ role, repo: opt('repo') ?? (role === 'job' ? undefined : repoOf(dir, leadDir)), agent, task: key ?? undefined });
  } catch {
    return;
  }
  if (md) console.log(`\n${md.trimEnd()}`);
}

function unregister() {
  const where = expand(pos[0] ?? process.cwd());
  const { found, guardRemoved } = unregisterDir(where);
  console.log(found ? `Unregistered ${where}.` : `${where} wasn't in the crew.`);
  if (guardRemoved) console.log("Removed its push check; the worktree's git hooks are back to the repo's own.");
}

/** After /clear: this session's old crew entry moves to its new id (rekeySession says what is checked). */
function rekey() {
  const from = pos[0];
  const to = opt('session') ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!from || !to) fail('Usage: keelctl rekey <oldSessionId> [--session <newSessionId>]   (from the session /clear started, in the same folder)');
  let m;
  try {
    m = rekeySession(from, to, { cwd: process.cwd(), caller: process.env.CLAUDE_CODE_SESSION_ID, hostId: process.env.CLAUDE_CODE_HOST_SESSION_ID || null });
  } catch (e) {
    if (e instanceof CorruptFileError) throw e;
    fail(/** @type {Error} */ (e).message);
  }
  console.log(`Session ${to} goes on in the crew as ${m.role}${m.agent ? ` (${m.agent})` : ''}${m.key ? ` for ${m.key}` : ''}, in place of ${from}.`);
}

/* ---------- looking ---------- */

function status() {
  /** @type {Record<string, any>} */
  let c = {};
  try {
    c = readConfig();
  } catch {
    console.log("Settings: config.json is damaged. Run keelctl doctor.");
  }
  let packLine = 'none';
  if (c.pack) {
    try {
      packLine = `${c.pack} (${loadPack(c.pack).title ?? 'no title'})`;
    } catch {
      packLine = `${c.pack} (can't be read; run keelctl doctor)`;
    }
  }
  const { agents, invalid } = scanAgents();
  let shipMode = c.shipMode;
  try {
    shipMode ??= loadRules(c.pack, { quiet: true }).ship.defaultMode;
  } catch {
    shipMode ??= 'free';
  }
  const shipping = shipMode === 'card' ? 'each push and PR waits for the launch card' : 'free (engineers push and open or update their own PR)';
  console.log(`Captain: ${c.owner ?? '(not set up)'}\nBoard: ${c.board ?? '(not set up)'}\nTeam pack: ${packLine}\nPrompts in crew sessions: ${c.promptMode === 'ask' ? 'ask' : 'deny with a next step'}\nShipping: ${shipping}`);
  console.log(`Agents: ${agents.length ? agents.map((a) => a.id).join(', ') : 'none yet'}${invalid.length ? ` (${invalid.length} invalid; see keelctl agents)` : ''}`);
  let reg;
  try {
    reg = readRegistry();
  } catch {
    console.log('\nCrew: crew.json is damaged. Run keelctl doctor.');
    return;
  }
  const dirs = Object.entries(reg.dirs);
  console.log(`\nCrew (${dirs.length}):`);
  for (const [dir, m] of dirs) {
    const g = readGrant(dir, m.key);
    const grant = g ? ` · ship approved: ${g.choice}${g.risk ? ` (${g.risk} risk)` : ''}` : '';
    console.log(`  ${m.role.padEnd(8)} ${(m.agent ?? '').padEnd(10)} ${(m.key ?? '').padEnd(14)} ${dir}${grant}`);
  }
  const sessions = Object.entries(reg.sessions);
  if (sessions.length) console.log(`\nSessions (${sessions.length}):`);
  for (const [s, m] of sessions) {
    const d = readDenials(s);
    const paused = d?.paused ? ` · paused${d.pausedAt ? ` ${Math.round((Date.now() - d.pausedAt) / 60_000)} min` : ''}` : '';
    console.log(`  ${m.role.padEnd(8)} ${(m.agent ?? '').padEnd(10)} ${(m.key ?? '').padEnd(14)} ${s}${m.hostId ? ` (${m.hostId})` : ''}${paused}`);
  }
  const open = listAlerts().length;
  if (open) console.log(`\n${open} alert${open === 1 ? '' : 's'} to look at: keelctl alerts`);
  if (!dirs.length && !sessions.length) console.log('  (nobody yet)');
}

function doctor() {
  let checks;
  try {
    ({ checks } = runDoctor({ fix: flags.fix === true, safe: flags.safe === true, only: pos[0] }));
  } catch (e) {
    fail(/** @type {Error} */ (e).message);
  }
  if (checks.some((c) => c.status === 'fail')) process.exitCode = 1;
  if (flags.json) {
    console.log(JSON.stringify({ checks }, null, 2));
    return;
  }
  for (const c of checks) console.log(`${(c.fixed ? 'fixed' : c.status).padEnd(5)}  ${c.label.padEnd(13)} ${c.detail}`);
  const open = checks.filter((c) => c.status !== 'ok');
  console.log(open.length ? `\n${open.length} to look at.` : '\nAll good.');
}

function agents() {
  const { agents: all, invalid } = scanAgents();
  const list = pos[0] ? all.filter((a) => a.id === pos[0]) : all;
  const bad = pos[0] ? invalid.filter((i) => i.file.replace(/\.json$/, '') === pos[0]) : invalid;
  if (pos[0] && !list.length && !bad.length) fail(`No agent "${pos[0]}".`);
  if (flags.json) {
    console.log(JSON.stringify({ agents: list, invalid: bad }, null, 2));
    return;
  }
  if (!list.length && !bad.length) console.log('No agents yet.');
  for (const a of list) {
    const crons = [a.schedule ?? []].flat().map((s) => s.cron).join(' | ');
    console.log(`${a.id.padEnd(10)} ${a.kind.padEnd(10)} ${a.runAs.padEnd(9)} ${a.defaultEnabled ? 'on ' : 'off'}${crons ? `  [${crons}]` : ''}  ${a.summary}`);
  }
  for (const i of bad) console.log(`Skipped ${i.file}: ${i.problems.join('; ')}.`);
}

/** Writes the captain's own team pack to ~/.keelcrew/packs/<team>: the Mate folder's repos and their base branches
 * (protected, so the crew always works on a branch), the Mac's time zone, and Jira when they use it. */
function packInit() {
  const name = pos[1];
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) fail('Usage: keelctl pack init <team> [--title <text>] [--lead-dir <folder>] [--jira-site <url> [--jql <query>]]   (team: lowercase letters, digits and dashes)');
  const file = join(paths.userPacks(), name, 'pack.json');
  if (existsSync(file)) fail(`${file} already exists: edit it, or pick another name.`);
  // A pack of yours would take the place of a shipped one of the same name, rules and all.
  if (existsSync(join(paths.packs(), name))) fail(`"${name}" is the name of a pack that ships with Keelcrew: pick another name.`);
  const leadDir = expand(opt('lead-dir') ?? readConfig().leadDir ?? (existsSync(join(process.cwd(), '.git')) ? dirname(process.cwd()) : process.cwd()));
  if (!existsSync(leadDir)) fail(`${leadDir} doesn't exist.`);
  const repos = reposIn(leadDir);
  const site = opt('jira-site')?.replace(/\/+$/, '');
  if (opt('jql') && !site) fail('--jql needs --jira-site.');
  writeJsonAtomic(file, {
    name,
    title: opt('title') ?? name,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(site ? { jira: { site, jql: opt('jql') ?? DEFAULT_JQL } } : {}),
    repos: Object.fromEntries(repos.map((r) => [r.name, { baseBranch: r.baseBranch }])),
    policy: { protectedBranches: [...new Set(repos.map((r) => r.baseBranch))] },
  });
  console.log(`Wrote ${file}.\n  Repos: ${repos.length ? repos.map((r) => `${r.name} (base ${r.baseBranch})`).join(', ') : `none found in ${leadDir}`}\n  Jira: ${site ? `${site}, query: ${opt('jql') ?? DEFAULT_JQL}` : 'not used'}\nUse it with keelctl setup --pack ${name}.`);
}

function pack() {
  if (pos[0] === 'init') return packInit();
  const name = readConfig().pack;
  const rules = loadRules(name);
  const p = name ? loadPack(name) : {};
  if (flags.json) {
    const effective = {
      protectedBranches: rules.policy.protectedBranches,
      readOnlyServers: rules.policy.readOnlyServers.map((re) => re.source),
      denyBash: rules.policy.denyBash.map((r) => ({ pattern: r.re.source, why: r.why })),
    };
    console.log(JSON.stringify({ name: name ?? null, pack: p, effective }, null, 2));
    return;
  }
  console.log(name ? `Team pack: ${name}${p.title ? ` (${p.title})` : ''}` : 'Team pack: none (generic rules only)');
  const repos = Object.entries(p.repos ?? {});
  if (repos.length) console.log(`Repos: ${repos.map(([r, v]) => `${r}${v?.baseBranch ? ` (base ${v.baseBranch})` : ''}`).join(', ')}`);
  console.log(`Protected branches: ${rules.policy.protectedBranches.join(', ')}`);
  console.log(`Never allowed:\n${rules.policy.denyBash.map((r) => `  - ${r.why}`).join('\n')}`);
  if (rules.policy.readOnlyServers.length) console.log(`Read-only servers: ${rules.policy.readOnlyServers.map((re) => re.source).join(', ')}`);
}

/* ---------- risk, pauses and alerts ---------- */

function risk() {
  const dir = expand(pos[0] ?? process.cwd());
  if (!existsSync(dir)) fail(`${dir} doesn't exist.`);
  const r = assessRisk(dir, opt('base'), { packName: readConfig().pack });
  if (flags.json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`Risk: ${r.tier}`);
  for (const why of r.reasons) console.log(`  - ${why}`);
  console.log(`${r.files} file${r.files === 1 ? '' : 's'}, +${r.added} -${r.deleted}${r.base ? ` against ${r.base}` : ''}.`);
}

function costs() {
  const c = costsOf({ key: opt('key') ?? null });
  if (flags.json) {
    console.log(JSON.stringify(c, null, 2));
    return;
  }
  const usd = (/** @type {number} */ n) => `$${n.toFixed(2)}`;
  const tickets = Object.entries(c.tickets).sort((a, b) => b[1].costUsd - a[1].costUsd);
  if (!c.members.length) console.log(opt('key') ? `No crew folder for ${opt('key')}.` : 'No crew folders yet.');
  for (const [k, t] of tickets) console.log(`${k.padEnd(16)} ${usd(t.costUsd).padStart(9)}  ${Object.entries(t.byRole).map(([r, v]) => `${r} ${usd(v)}`).join(', ')}`);
  const roles = Object.entries(c.roles).sort((a, b) => b[1].costUsd - a[1].costUsd);
  if (roles.length) console.log(`\nBy role: ${roles.map(([r, s]) => `${r} ${usd(s.costUsd)}`).join(', ')}`);
  console.log(`Total: ${usd(c.totalUsd)} (estimated, API-equivalent, since each folder joined)`);
}

function unpause() {
  if (!pos[0]) fail('Usage: keelctl unpause <sessionId|KEY>');
  const cleared = unpauseSessions(pos[0], readRegistry());
  console.log(cleared.length ? `Unpaused ${cleared.join(', ')}. Its denial count starts over.` : `Nothing paused for ${pos[0]} that unpause lifts (a spend-alarm pause lifts only with keelctl spend continue, after the captain's answer).`);
}

function alerts() {
  const [sub, target] = pos;
  if (sub === 'seen') {
    if (!target) fail('Usage: keelctl alerts seen <id|all>');
    const moved = markAlertSeen(target);
    if (!moved.length && target !== 'all') fail(`No alert "${target}".`);
    console.log(`Marked ${moved.length} alert${moved.length === 1 ? '' : 's'} seen.`);
    return;
  }
  if (sub === 'add') {
    const kind = opt('kind');
    const summary = opt('summary');
    if (!kind || !summary) fail('Usage: keelctl alerts add --kind <kind> --summary <text> [--key KEY]');
    const a = writeAlert({ kind, summary, key: opt('key')?.toUpperCase() ?? null, sessionId: process.env.CLAUDE_CODE_SESSION_ID || null });
    console.log(`Raised alert ${a.id}.`);
    return;
  }
  if (sub) fail('Usage: keelctl alerts [--json] | alerts seen <id|all> | alerts add --kind <kind> --summary <text> [--key KEY]');
  const list = listAlerts();
  if (flags.json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (!list.length) console.log('No alerts.');
  for (const a of list) console.log(`${stamp(a.at)}  ${a.kind.padEnd(12)} ${(a.key ?? '').padEnd(14)} ${a.summary}\n  id ${a.id}`);
}

/* ---------- memory ---------- */

function memory() {
  const [sub, ...args] = pos;
  switch (sub) {
    case 'add': {
      // Flags first; `memory add <type> <key> <text...>` also works.
      const type = opt('type') ?? args[0];
      const key = opt('key') ?? args[1];
      const text = opt('text') ?? args.slice(2).join(' ');
      if (!type || !key || !text) fail(`Usage: keelctl memory add --type <${LESSON_TYPES.join('|')}> --key <key> --text <text> [--repo r] [--agent id] [--area a] [--task KEY] [--source s --ref r --quote q] [--confidence 0..1]`);
      const source = opt('source');
      const l = addLesson({
        type,
        key,
        text,
        scope: { repo: opt('repo'), agent: opt('agent'), area: opt('area'), task: opt('task') },
        evidence: source ? [{ source, ref: opt('ref') ?? '', ...(opt('quote') ? { quote: opt('quote') } : {}) }] : [],
        ...(opt('confidence') !== undefined ? { confidence: Number(opt('confidence')) } : {}),
      });
      if (l.kept) {
        console.log(`"${l.key}" is ${l.status}, so its text stays; the new sighting was added as evidence. The Mate changes the text with keelctl memory edit.`);
        return;
      }
      const how = l.status === 'candidate' ? ' as a candidate (the Mate promotes it once the captain approves)' : ` (${l.status})`;
      console.log(`Saved "${l.key}"${l.supersedes ? ' as a new version' : ''}${how}.`);
      return;
    }
    case 'list': {
      const scope = opt('repo') || opt('agent') || opt('area') ? { repo: opt('repo'), agent: opt('agent'), area: opt('area') } : undefined;
      const lessons = listLessons({ scope, includeRetired: flags.all === true });
      if (flags.json) {
        console.log(JSON.stringify(lessons, null, 2));
        return;
      }
      if (!lessons.length) console.log('No lessons yet.');
      for (const l of lessons) {
        const where = [l.scope.task, l.scope.repo, l.scope.agent, l.scope.area].filter(Boolean).join('/') || 'everywhere';
        const flag = l.status === 'active' ? '' : ` ${l.status}`;
        console.log(`${stamp(l.at)}  ${l.key}  [${l.type}, ${where}, ${l.confidence}${flag}, seen ${l.seen}×]\n  ${l.text}`);
      }
      return;
    }
    case 'edit': {
      const text = opt('text') ?? args.slice(1).join(' ');
      if (!args[0] || !text) fail('Usage: keelctl memory edit <key> --text <text>');
      const l = editLesson(args[0], text);
      if (!l) fail(`No lesson "${args[0]}".`);
      console.log(`Updated "${l.key}".`);
      return;
    }
    case 'scope': {
      const changes = Object.fromEntries(['task', 'repo', 'agent', 'area'].filter((k) => opt(k) !== undefined).map((k) => [k, String(opt(k))]));
      if (!args[0] || !Object.keys(changes).length) fail('Usage: keelctl memory scope <key> [--task KEY] [--repo r] [--agent id] [--area a] (an empty value clears it)');
      let l = null;
      try {
        l = scopeLesson(args[0], changes);
      } catch (e) {
        fail(/** @type {Error} */ (e).message);
      }
      if (!l) fail(`No lesson "${args[0]}".`);
      console.log(`"${l.key}" now applies ${[l.scope.task && `to task ${l.scope.task}`, l.scope.repo && `in ${l.scope.repo}`, l.scope.agent && `for ${l.scope.agent}`, l.scope.area && `in area ${l.scope.area}`].filter(Boolean).join(', ') || 'everywhere'}.`);
      return;
    }
    case 'forget':
    case 'pin': {
      if (!args[0]) fail(`Usage: keelctl memory ${sub} <key>`);
      const l = sub === 'forget' ? forgetLesson(args[0]) : pinLesson(args[0]);
      if (!l) fail(`No lesson "${args[0]}".`);
      console.log(sub === 'forget' ? `Forgot "${l.key}".` : `Pinned "${l.key}".`);
      return;
    }
    case 'promote': {
      if (!args[0]) fail('Usage: keelctl memory promote <key>');
      const l = promoteLesson(args[0]);
      if (!l) fail(`No lesson "${args[0]}".`);
      console.log(`"${l.key}" is ${l.status}.`);
      return;
    }
    case 'diff': {
      const d = playbookDiff();
      console.log(flags.json ? JSON.stringify(d, null, 2) : d.markdown.trimEnd());
      return;
    }
    case 'approve': {
      const a = approvePlaybook();
      console.log(`Recorded the standing orders (${a.lessons} lesson${a.lessons === 1 ? '' : 's'}) as approved.`);
      return;
    }
    case 'compile': {
      const md = compilePlaybook();
      console.log(`Rebuilt the standing orders: ${playbookPath()} (${(Buffer.byteLength(md) / 1024).toFixed(1)} KB).`);
      return;
    }
    case 'show': {
      const role = opt('role') ?? (opt('agent') ? 'agent' : 'lead');
      const md = playbookFor({ role, repo: opt('repo'), agent: opt('agent'), task: opt('task') });
      console.log(md ? md.trimEnd() : 'No lessons yet.');
      return;
    }
    default:
      fail('Usage: keelctl memory add|list|edit|scope|forget|pin|promote|compile|show|diff|approve (keelctl help for details)');
  }
}

/* ---------- main ---------- */

/** @type {Record<string, () => void | Promise<void>>} */
/** The ticket records: read them, or (hooks, the panel and the helper only) record an event and commit. */
function ledger() {
  const [sub, a, b, c] = pos;
  if (sub === 'show') {
    if (!a) fail('Usage: keelctl ledger show <KEY> [--json]');
    const r = readRecord(a);
    if (!r) fail(`No ledger record for ${a}.`);
    console.log(flags.json ? JSON.stringify(r, null, 2) : `${r.key}: ${r.status ?? '-'} · ${r.difficulty ?? '-'} · ${r.role ?? '-'} · $${(r.spendUsd ?? 0).toFixed(2)} · ${Object.keys(r.cards).length} cards · ${r.crewShas.length} crew commits${r.outcome ? ` · ${r.outcome}` : ''}`);
    return;
  }
  if (sub === 'list') {
    const { records, damaged } = listRecords();
    if (flags.json) console.log(JSON.stringify({ records, damaged }, null, 2));
    else {
      for (const r of records) console.log(`${r.key.padEnd(16)} ${String(r.status ?? '-').padEnd(9)} ${String(r.difficulty ?? '-').padEnd(9)} $${(r.spendUsd ?? 0).toFixed(2).padStart(8)}  ${r.role ?? ''}`);
      if (damaged.length) console.log(`Damaged: ${damaged.join(', ')}`);
    }
    return;
  }
  if (sub === 'event') {
    if (!a || !b) fail(`Usage: keelctl ledger event <${LEDGER_EVENTS.join('|')}> <KEY> [json]`);
    let data = {};
    try {
      data = c ? JSON.parse(c) : {};
    } catch {
      fail('The event data must be JSON.');
    }
    console.log(applyEvent(a, b, data) ? 'recorded' : 'already recorded');
    return;
  }
  if (sub === 'feed') {
    if (!a) fail('Usage: keelctl ledger feed <facts.json>');
    const facts = JSON.parse(readFileSync(expand(a), 'utf8'));
    const r = feed(facts);
    // Ready work gets its captain edits measured now; a worktree already cleaned up is skipped.
    const edits = r.ready.filter((k) => {
      try {
        return !!measureEdits(k);
      } catch {
        return false;
      }
    });
    console.log(JSON.stringify({ changed: r.changed, ready: r.ready, measured: edits, damaged: r.damaged }));
    return;
  }
  if (sub === 'spend') {
    console.log(JSON.stringify(recordSpend()));
    return;
  }
  if (sub === 'commit') {
    console.log(commitLedger(opt('message') ?? 'ledger') ? 'committed' : 'nothing to commit');
    return;
  }
  if (sub === 'link-bug') {
    const [repo, file, line] = [opt('repo'), opt('file'), Number(opt('line'))];
    if (!a || !repo || !file) fail('Usage: keelctl ledger link-bug <BUG-KEY> --repo <name> --file <path> --line <n> [--severity s]');
    const r = linkBug({ bug: a, repo: String(repo), file: String(file), line, severity: opt('severity') ?? null });
    console.log(!r.key ? `Line ${line} of ${file} came from ${r.sha.slice(0, 10)}, not a crew ticket.` : r.ignored ? `${r.key} (${r.ignored}): not counted.` : `${a} linked to ${r.key}.`);
    return;
  }
  if (sub === 'reverts') {
    console.log(JSON.stringify({ reverted: scanReverts() }));
    return;
  }
  if (sub === 'report') {
    const on = opt('switch-on') ?? readOrgFile().switchedOnAt;
    const { records } = listRecords();
    const switchOnAt = on == null ? null : typeof on === 'number' ? on : typeof on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(on) ? new Date(`${on}T00:00:00`).getTime() : null;
    const r = weeklyReport({ records, weeks: Number(opt('weeks') ?? 8), switchOnAt });
    if (flags.json) return void console.log(JSON.stringify(r, null, 2));
    const fmt = (/** @type {any} */ x) => `${x.tickets} closed · median ${x.medianHours ?? '?'}h · $${x.spendUsd} (median $${x.medianSpendUsd ?? '?'}) · QA first pass ${x.qaFirstPass ?? '?'} · ${x.withBugs} with bugs · ${x.reverted} reverted · captain edits ${x.medianOwnerEdit ?? '?'} · ${x.questionsPerTicket ?? '?'} questions each`;
    for (const w of r.weeks) console.log(`${w.week}: ${fmt(w)}`);
    if (r.baseline) console.log(`before ${typeof on === 'string' ? on : new Date(r.baseline.switchOnAt).toLocaleDateString('en-CA')}: ${fmt(r.baseline.before)}\nafter: ${fmt(r.baseline.after)}`);
    return;
  }
  fail('Usage: keelctl ledger show <KEY> | list | report | link-bug <BUG-KEY> ... | event <type> <KEY> [json] | commit');
}

/** The company: what is on, staffing a ticket (which role, which model), and the model a role runs on. */
function org() {
  const [sub, a] = pos;
  if (sub === 'show' || !sub) {
    const o = readOrg();
    if (flags.json) return void console.log(JSON.stringify(o, null, 2));
    console.log(`CEO seat: ${o.ceo ? 'on' : 'off'} · seats: ${o.seats}`);
    for (const d of o.departments) console.log(`${d.enabled ? 'on ' : 'off'} ${d.name}: ${o.roles.filter((r) => r.department === d.id && r.enabled).map((r) => r.id).join(', ') || '-'}`);
    return;
  }
  if (sub === 'staff') {
    if (!a) fail('Usage: keelctl org staff <KEY> --difficulty <d> [--mechanical]');
    const difficulty = String(opt('difficulty') ?? 'moderate');
    const o = readOrg();
    const s = staff({ mechanical: flags.mechanical === true }, o);
    const model = modelFor(o, roleIdOf(s), difficulty);
    console.log(JSON.stringify({ key: a, ...s, model: model.model, alias: model.alias, effort: model.effort, approved: model.source === 'approved', source: model.source }));
    return;
  }
  if (sub === 'owner') {
    const [dir, base] = [opt('dir'), opt('base')];
    if (!a || !dir || !base) fail('Usage: keelctl org owner <path> --dir <repo checkout> --base <branch>');
    const gh = (/** @type {string[]} */ args) => execFileSync('gh', args, { cwd: expand(String(dir)), encoding: 'utf8', timeout: 30_000 }).trim();
    const commits = JSON.parse(gh(['api', `repos/{owner}/{repo}/commits?sha=${encodeURIComponent(String(base))}&path=${encodeURIComponent(a)}&per_page=50`, '--jq', '[.[] | {login: .author.login}]']));
    const owner = mainAuthor(commits);
    const me = gh(['api', 'user', '--jq', '.login']);
    console.log(JSON.stringify({ path: a, owner, me, mine: owner === null || owner === me }));
    return;
  }
  if (sub === 'model') {
    const difficulty = opt('difficulty') ?? null;
    if (!a || (a !== 'lead' && a !== 'subagents' && !agentById(a))) fail('Usage: keelctl org model <role|lead|subagents> [--difficulty d] [--json] (a role is an agent id from keelctl agents)');
    if (difficulty !== null && !DIFFICULTIES.includes(difficulty)) fail(`--difficulty is one of ${DIFFICULTIES.join(', ')}`);
    const m = modelFor(readOrg(), a, difficulty);
    if (flags.json) return void console.log(JSON.stringify({ role: a, difficulty, ...m }));
    console.log(`${m.model} · ${m.effort} (${m.source})`);
    return;
  }
  if (sub === 'proactive') {
    const p = readProactive();
    if (flags.json) return void console.log(JSON.stringify(p, null, 2));
    console.log(p.autoStart.may ? `the Mate may start a suggestion (${p.autoStart.startedToday} of ${p.autoStart.cap} today)` : `no auto-start now: ${p.autoStart.why}`);
    for (const [source, h] of Object.entries(p.sources)) if (h.pausedUntil) console.log(`suggest ${source}: paused until ${new Date(h.pausedUntil).toISOString().slice(0, 10)} (hit rate ${h.hitRate})`);
    for (const [role, h] of Object.entries(p.roles)) if (h.pausedUntil) console.log(`${role}: proposals paused until ${new Date(h.pausedUntil).toISOString().slice(0, 10)} (hit rate ${h.hitRate})`);
    return;
  }
  fail('Usage: keelctl org show | staff <KEY> ... | owner <path> ... | model <role> ... | proactive');
}

/** Weekly allowances and the per-ticket spend alarm (computed by code from the ledger). */
function spend() {
  const [sub, a] = pos;
  if (sub === 'continue') {
    if (!a) fail('Usage: keelctl spend continue <KEY>');
    const line = continueSpend(a);
    console.log(line === null ? `${a} has no spend record.` : `${a} continues; its hard line is now $${line} and its sessions are unpaused.`);
    return;
  }
  if (sub !== undefined && sub !== 'show' && sub !== 'check') fail('Usage: keelctl spend [show] [--json] | check [--json] | continue <KEY>');
  const s = sub === 'check' ? checkSpend() : readSpend();
  if (flags.json) return void console.log(JSON.stringify(s ?? null, null, 2));
  if (!s) return void console.log('No spend state yet: the panel computes it from the ledger.');
  for (const [id, d] of Object.entries(s.departments)) console.log(`${id}: ${d.usedPct ?? '?'}% of ${d.allowancePct ?? '?'}% of the weekly bar ($${d.spentUsd})`);
  const lines = Object.entries(s.lines);
  console.log(lines.length ? `alarm lines: ${lines.map(([d, l]) => `${d} $${l.soft}/$${l.hard}`).join(', ')}` : 'spend alarm: off until enough closed tickets');
  for (const [key, f] of Object.entries(s.flags)) console.log(`${key}: $${f.spendUsd} (${f.level} line)`);
}

/**
 * The captain's answer to a launch card or an "Approve and post" card, from a /keel-panel click or given where the helper can't
 * be reached (their phone): the panel carries it out here with the helper's own approve and approve_post, so it gets the
 * same checks and writes the same approval as a click on the board on this Mac. With `--answered-at`, an answer older than the rules'
 * org.phoneGrantMaxAgeHours does nothing. Crew sessions never run it: the policy refuses it in any form.
 */
async function grant() {
  const [kind, key, ...extra] = pos;
  const usage = 'Usage: keelctl grant ship <KEY> --choice <choice> [--head <sha>] [--answered-at <ms>] [--json] | grant post <KEY> --tool <tool> [--match <text>] [--answered-at <ms>] [--json]';
  if ((kind !== 'ship' && kind !== 'post') || !key || extra.length) fail(usage);
  const answeredAt = opt('answered-at');
  if (answeredAt !== undefined) {
    const at = Number(answeredAt);
    const hours = Number(orgRules().phoneGrantMaxAgeHours ?? 24);
    if (!Number.isFinite(at) || at <= 0) fail('--answered-at is when the captain answered, in epoch ms.');
    if (Date.now() - at > hours * 3_600_000) fail(`This answer is over ${hours} hours old, so nothing was done. Answer the card again.`);
  }
  /** @type {Record<string, unknown>} */
  let out;
  try {
    if (kind === 'ship') {
      const choice = opt('choice');
      if (!choice) fail(usage);
      const { approve } = await import('../helper/git.mjs');
      const r = await approve({ key, choice, head: opt('head') ?? null });
      out = { ok: true, key: r.key, choice: r.choice, head: r.head, expires: r.expires, risk: r.risk?.tier ?? null };
    } else {
      const tool = opt('tool');
      if (!tool) fail(usage);
      const { approvePost } = await import('../helper/admin.mjs');
      const { post } = approvePost({ key, tool, match: opt('match') });
      out = { ok: true, key: post.key, tool: post.tool, match: post.match, expires: post.expires, id: post.id };
    }
  } catch (e) {
    if (e instanceof UserError) throw e;
    fail(/** @type {Error} */ (e).message);
  }
  if (flags.json) return void console.log(JSON.stringify(out));
  if (kind === 'post') console.log(`${out.key}: one ${out.tool} post approved until ${stamp(Number(out.expires))}.`);
  else if (out.expires) console.log(`${out.key}: ${out.choice} approved for ${String(out.head).slice(0, 7)} (${out.risk} risk) until ${stamp(Number(out.expires))}.`);
  else console.log(`${out.key}: ${out.choice}; any approval is cleared.`);
}

const COMMANDS = { setup, helper, register, unregister, rekey, status, doctor, risk, costs, unpause, alerts, agents, pack, memory, ledger, org, spend, grant };

/**
 * A crew session other than the Mate can't run the Mate's commands, or record what the captain said, by any name for this
 * command (a link, node and the script): the policy reads only the command's name. An unreadable crew file leaves it to the policy.
 */
function mateOnlyRefused() {
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid || !cmd) return false;
  let member;
  try {
    member = readRegistry().sessions?.[sid];
  } catch {
    return false;
  }
  const owner = cmd === 'memory' && pos[0] === 'add' && /^owner\b/i.test(String(flags.source ?? ''));
  return !!member && member.role !== 'lead' && (mateOnly(cmd, rest) || owner);
}

try {
  const run = cmd ? COMMANDS[cmd] : undefined;
  if (run && mateOnlyRefused()) fail(`Only the Mate runs keelctl ${cmd}${pos[0] ? ` ${pos[0]}` : ''}. Message the Mate with what you need.`);
  if (run) await run();
  else {
    console.log(USAGE);
    if (cmd) process.exitCode = 1;
  }
} catch (e) {
  if (e instanceof UserError || e instanceof CorruptFileError) console.error(e.message);
  else console.error(`keelctl ${cmd}: ${/** @type {Error} */ (e).message}`);
  process.exitCode = 1;
}

