// @ts-check
// The crew's rules: rules/rules.json, plus the active team pack's additions. A pack can add rules but never remove one.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { appendRotating, readJsonStrict } from './fsx.mjs';
import { HOME, paths } from './paths.mjs';

/**
 * @typedef {{ re: RegExp, why: string }} BashRule
 * @typedef {{
 *   ship: {
 *     defaultMode: 'free' | 'card', choices: string[], allows: Record<string, string[]>, grantTtlMs: number,
 *     questionHeader: RegExp, actions: { action: string, re: RegExp }[]
 *   },
 *   policy: {
 *     denyBash: BashRule[], githubWrite: GithubRule, protectedBranches: string[], secretPath: RegExp, crewFiles: RegExp,
 *     crewFileNames: RegExp, claudeSettings: RegExp, gitInternals: RegExp, localTools: Set<string>, untrustedTools: RegExp, sendTools: RegExp,
 *     readVerbs: Set<string>, writeVerbs: Set<string>, readTools: Set<string>, readOnlyServers: RegExp[],
 *     appTools: RegExp, leadAppTools: RegExp, boardOnlyTools: RegExp, grantCode: RegExp, deployTools: RegExp, trustKinds: [string, RegExp][], draftKinds: [string, DraftRule[]][],
 *     browserTools: RegExp, browserScriptWrites: RegExp[],
 *     boardTimes: { fields: Set<string>, roundFields: Set<string>, aheadMs: number, roundMs: number, slackMs: number }, shellTempPaths: RegExp
 *   },
 *   risk: { patterns: { high: RiskRule[], medium: RiskRule[] }, size: { medium: number, high: number }, ttlMs: Record<string, number> },
 *   posts: { ttlMs: number },
 *   denials: { consecutive: number, total: number, softRetries: number, allowWhilePaused: Set<string> },
 *   memory: { candidateRetireMs: number, activeStaleMs: number },
 *   sessions: { defaultMode: string, compactWindow: number | 'auto', allowTools: string[] },
 *   pack: Record<string, any>
 * }} Rules
 * @typedef {BashRule & { deleted: boolean }} RiskRule
 * @typedef {{ tool: RegExp, input: [string, RegExp][] }} DraftRule a tool name, and the input fields it must have (each a string matching its pattern)
 * @typedef {{ command: RegExp, reads: RegExp, api: RegExp, apiWrite: RegExp, why: string }} GithubRule
 */

/** @param {any} r */
const rule = (r) => ({ re: new RegExp(r.pattern, r.flags ?? ''), why: String(r.why) });
/** @param {any} r @returns {RiskRule} */
const riskRule = (r) => ({ ...rule(r), deleted: r.deleted === true });
/** @param {any} r @returns {DraftRule} */
const draftRule = (r) => ({ tool: new RegExp(String(r.tool), 'i'), input: Object.entries(r.input ?? {}).map(([f, re]) => [f, new RegExp(String(re))]) });
const DAY_MS = 24 * 60 * 60_000;

/**
 * A section rules.json must have, so a missing one fails loudly instead of quietly turning a safety rule off.
 * @param {any} base @param {string} name
 */
function section(base, name) {
  if (!base[name] || typeof base[name] !== 'object') throw new Error(`${paths.rules()} has no "${name}" section`);
  return base[name];
}

/**
 * How a gh command is judged: every gh command writes to GitHub unless it matches `reads`; a gh api call reads unless
 * `apiWrite` matches. Pull request writes a ship choice covers go by ship.actions instead.
 * @param {any} g
 * @returns {GithubRule}
 */
function githubRule(g) {
  if (!g || typeof g !== 'object') throw new Error(`${paths.rules()} has no "policy.githubWrite" section`);
  const flags = g.flags ?? '';
  return { command: new RegExp(g.command, flags), reads: new RegExp(g.reads, flags), api: new RegExp(g.api, flags), apiWrite: new RegExp(g.apiWrite, flags), why: String(g.why) };
}

/** @param {string} s */
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A team pack by name: one shipped with the plugin (packs/<name>), or the user's own (~/.keelcrew/packs/<name>).
 * @param {string | null | undefined} name
 * @returns {Record<string, any>}
 */
export function loadPack(name) {
  if (!name) return {};
  for (const dir of [paths.userPacks(), paths.packs()]) {
    const pack = readJsonStrict(join(dir, name, 'pack.json'), null);
    if (pack) return pack;
  }
  throw new Error(`Team pack "${name}" not found in ${paths.userPacks()} or ${paths.packs()}`);
}

/** @type {Map<string, Rules>} */
const cache = new Map();
let warnedNoPack = false;

/**
 * Notes once per process, in logs/rules.log, that the crew runs with only the generic rules. A pack set to none on
 * purpose (`keelctl setup --pack none` stores null) isn't worth a warning, and neither is a Mac not set up yet (every
 * hook call is its own process, so it would repeat on each call while /keel-setup runs).
 */
function warnNoPack() {
  if (warnedNoPack || !existsSync(paths.config())) return;
  warnedNoPack = true;
  try {
    appendRotating(join(paths.logs(), 'rules.log'), `${new Date().toISOString()} WARN no team pack is set, so only the generic rules apply (the team's own denials are off). Run keelctl setup --pack <name>, or keelctl doctor.`);
  } catch {
    /* logging is best effort */
  }
}

/**
 * The rules with the pack's additions merged in. Throws if rules.json or the pack can't be read: callers fail closed.
 * With no pack (undefined) the generic rules still load, and a warning is logged unless `quiet` (callers that only need a
 * generic value, such as a TTL, pass it).
 * @param {string | null | undefined} packName
 * @param {{ quiet?: boolean }} [options]
 * @returns {Rules}
 */
export function loadRules(packName, { quiet = false } = {}) {
  if (packName === undefined && !quiet) warnNoPack();
  const key = packName ?? '';
  const hit = cache.get(key);
  if (hit) return hit;
  const base = readJsonStrict(paths.rules(), null);
  if (!base) throw new Error(`${paths.rules()} is missing`);
  const pack = loadPack(packName);
  const p = base.policy;
  const pp = pack.policy ?? {};
  const risk = section(base, 'risk');
  const packRisk = pack.risk?.patterns ?? {};
  const denials = section(base, 'denials');
  const memory = section(base, 'memory');
  const sessions = section(base, 'sessions');
  const protectedBranches = [...new Set([...(p.protectedBranches ?? []), ...(pp.protectedBranches ?? [])])];
  const branches = protectedBranches.map(escape).join('|');
  /** @type {Rules} */
  const rules = {
    ship: {
      defaultMode: base.ship.defaultMode === 'card' ? 'card' : 'free',
      choices: base.ship.choices,
      allows: base.ship.allows,
      grantTtlMs: base.ship.grantTtlMinutes * 60_000,
      questionHeader: new RegExp(base.ship.questionHeader, 'i'),
      actions: (base.ship.actions ?? []).map((a) => ({ action: String(a.action), re: new RegExp(a.pattern, a.flags ?? '') })),
    },
    policy: {
      denyBash: [
        ...(p.denyBash ?? []).map(rule),
        ...(pp.denyBash ?? []).map(rule),
        // The branch must be the whole argument, so `git checkout main-fix` or `git checkout main.py` stay allowed.
        { re: new RegExp(`\\bgit\\s+(checkout|switch)\\s+(-\\S+\\s+)*(${branches})(?!\\s+--\\s+[^\\s;&|)])(?=$|[\\s;&|)])`), why: 'switching to a base branch is never allowed' },
      ],
      githubWrite: githubRule(p.githubWrite),
      protectedBranches,
      secretPath: new RegExp(p.secretPath),
      crewFiles: new RegExp(p.crewFiles),
      crewFileNames: new RegExp(p.crewFileNames ?? '(?!)'),
      // macOS paths ignore case, so .Claude/Settings.json is the same file.
      claudeSettings: new RegExp(p.claudeSettings ?? '(?!)', 'i'),
      gitInternals: new RegExp(p.gitInternals ?? '(?!)'),
      localTools: new Set(p.localTools ?? []),
      untrustedTools: new RegExp(p.untrustedTools ?? '(?!)'),
      // Tools that send something on the captain's behalf (a message, a mail, a reply, a publish): a drafts role never may.
      sendTools: new RegExp(p.sendTools ?? '(?!)', 'i'),
      readVerbs: new Set(p.readVerbs),
      writeVerbs: new Set(p.writeVerbs),
      readTools: new Set([...(p.readTools ?? []), ...(pp.readTools ?? [])]),
      readOnlyServers: [...(p.readOnlyServers ?? []), ...(pp.readOnlyServers ?? [])].map((s) => new RegExp(s)),
      appTools: new RegExp(p.appTools),
      leadAppTools: new RegExp(p.leadAppTools),
      boardOnlyTools: new RegExp(p.boardOnlyTools),
      // Interpreter code (node -e, python -c, a heredoc) that reaches the approval code: no crew session runs it.
      grantCode: new RegExp(p.grantCode ?? '(?!)'),
      deployTools: new RegExp(p.deployTools ?? '(?!)'),
      trustKinds: Object.entries(p.trustKinds ?? {}).map(([k, v]) => [k, new RegExp(String(v), 'i')]),
      // Connector kinds beyond the trust kinds that a drafts role's manifest may list in `drafts` (the designer's Figma): each
      // a tool pattern (ignoring case), or a list of {tool, input} rules where input names fields the call must carry.
      draftKinds: Object.entries(p.draftKinds ?? {}).map(([k, v]) => [k, (Array.isArray(v) ? v : [{ tool: v }]).map(draftRule)]),
      // Without these, browser tools fall back to the read/write verb check for everyone.
      browserTools: new RegExp(p.browserTools ?? '(?!)'),
      browserScriptWrites: (p.browserScriptWrites ?? []).map((/** @type {string} */ re) => new RegExp(re)),
      // Times written to the board are read from the clock: none ahead of now, and no "now" a round guess far from it.
      boardTimes: { fields: new Set(p.boardTimes?.fields ?? []), roundFields: new Set(p.boardTimes?.roundFields ?? p.boardTimes?.fields ?? []), aheadMs: Number(p.boardTimes?.aheadMs ?? 30000), roundMs: Number(p.boardTimes?.roundMs ?? 100000), slackMs: Number(p.boardTimes?.slackMs ?? 60000) },
      // Where a crew member's shell may write outside its own folder: the system's temp folders and the standard streams.
      shellTempPaths: new RegExp(p.shellTempPaths ?? '(?!)'),
    },
    risk: {
      patterns: {
        high: [...(risk.patterns?.high ?? []), ...(packRisk.high ?? [])].map(riskRule),
        medium: [...(risk.patterns?.medium ?? []), ...(packRisk.medium ?? [])].map(riskRule),
      },
      size: { medium: Number(risk.size.medium), high: Number(risk.size.high) },
      ttlMs: Object.fromEntries(Object.entries(risk.ttlMinutes).map(([tier, m]) => [tier, Number(m) * 60_000])),
    },
    posts: { ttlMs: Number(section(base, 'posts').ttlMinutes) * 60_000 },
    denials: {
      consecutive: Number(denials.pauseAfterConsecutive),
      total: Number(denials.pauseAfterTotal),
      softRetries: Number(denials.softRetries ?? 3),
      allowWhilePaused: new Set(denials.allowWhilePaused ?? []),
    },
    memory: {
      candidateRetireMs: Number(memory.candidateRetireDays) * DAY_MS,
      activeStaleMs: Number(memory.activeStaleDays) * DAY_MS,
    },
    sessions: {
      defaultMode: String(sessions.defaultMode),
      compactWindow: sessions.compactWindow === 'auto' ? 'auto' : Number(sessions.compactWindow),
      allowTools: Array.isArray(sessions.allowTools) ? sessions.allowTools.map(String) : [],
    },
    pack,
  };
  cache.set(key, rules);
  return rules;
}

/** A shell word: a quoted string or a run of characters without spaces or shell operators. */
const WORD = `(?:"[^"]*"|'[^']*'|[^\\s;&|()<>]+)`;
/** git's own options before its subcommand (git -C dir, -c key=value, --git-dir=..., --no-pager and the like). */
const GIT_GLOBAL = new RegExp(
  `\\bgit((?:\\s+(?:-[cC]\\s+${WORD}|--(?:git-dir|work-tree|namespace|super-prefix|config-env|attr-source)(?:=${WORD}|\\s+${WORD})|--exec-path(?:=${WORD})?|-[pPh]|--[a-z][a-z-]*))+)(?=\\s)`,
  'g',
);

/**
 * A command line as the rules read it: backslash-newline continuations joined, a quoted word unquoted (`git "push"`), quotes
 * inside a word folded (`kube''ctl`, `"secret"s`), and git's own options dropped, so `git -C dir push` reads as `git push` for every rule and pack pattern.
 * @param {string} cmd
 */
export const normalizeCommand = (cmd) =>
  String(cmd)
    .replace(/\\\r?\n/g, ' ')
    .replace(/(^|[\s;&|(`])(['"])([\w./-]+)\2(?=$|[\s;&|)`])/g, '$1$3')
    .replace(/(\w)(['"])([\w.-]*)\2/g, '$1$3')
    .replace(/(['"])([\w.-]*)\1(\w)/g, '$2$3')
    .replace(GIT_GLOBAL, 'git');

/** git's own options in a command (what normalizeCommand drops), joined. @param {string} cmd */
export const gitGlobalOptions = (cmd) => [...String(cmd).replace(/\\\r?\n/g, ' ').matchAll(GIT_GLOBAL)].map((m) => m[1]).join(' ');

/**
 * The chained parts of a command line: split at &&, ||, ;, |, a background & and newlines, but not at redirections such
 * as 2>&1 or &>file.
 * @param {string} cmd
 * @returns {string[]}
 */
export const splitCommand = (cmd) =>
  String(cmd)
    .replace(/\\\r?\n/g, ' ')
    .split(/&&|\|\||;|\n|\|&?|(?<![<>&])&(?![>&])/)
    .map((p) => p.trim())
    .filter(Boolean);

/** Whether a push names a protected branch, checked per chained command. @param {string} cmd @param {string[]} branches */
export function pushesProtected(cmd, branches) {
  const re = new RegExp(`\\bgit\\s+push\\b.*(\\s|:|refs\\/heads\\/)(${branches.map(escape).join('|')})(\\s|$)`);
  return splitCommand(normalizeCommand(cmd)).some((part) => re.test(part));
}

/** The kind of a connector tool, for a drafts role's `drafts` list: a rules trust kind, or 'external'. @param {string} tool @param {Rules} rules */
export const connectorKind = (tool, rules) => rules.policy.trustKinds.find(([, re]) => re.test(tool))?.[0] ?? 'external';

/**
 * Whether a drafts role may write with a connector tool: the tool's trust kind, or a draft kind one of whose rules the tool
 * and its input match, is one its manifest lists in `drafts`.
 * @param {string} tool @param {string[]} drafts @param {Rules} rules @param {Record<string, unknown>} [input] the call's input
 */
export const draftsAllow = (tool, drafts, rules, input = {}) =>
  drafts.includes(connectorKind(tool, rules)) ||
  rules.policy.draftKinds.some(([k, rs]) => drafts.includes(k) && rs.some((r) => r.tool.test(tool) && r.input.every(([f, re]) => typeof input?.[f] === 'string' && re.test(input[f]))));

export { HOME };
