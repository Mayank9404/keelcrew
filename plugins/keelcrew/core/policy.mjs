// @ts-check
// The crew's rules (rules/rules.json plus the team pack) applied to one tool call, for hooks/policy.mjs. A decision is
// deny (never allowed), ask (a native approval prompt), allow (approved on the launch card or as a one-shot post), or none
// (the session's normal flow). Crew sessions run unattended, so with config.promptMode "deny" (the default) every ask for
// a crew member becomes a deny that says what to do instead: post a launch card, post a draft card, or message the Mate.
// When a crew file can't be read, nobody can tell who is crew or what is approved, so anything that could matter asks.
// Denials are counted per crew session; too many pause it until the Mate runs `keelctl unpause`.
import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { agentById, isContractor, memberCanShip, profileOf } from './agents.mjs';
import { hasPr, leadOf, memberFor, prUrlOf, readConfig, readRegistry } from './crew.mjs';
import { isPaused, noteAllowed, noteDenial, readDenials } from './denials.mjs';
import { BOOLEAN_FLAGS, LEAD_ONLY_SUBS, MEMBER_READS, mateOnly, parseArgs } from './cliargs.mjs';
import { CorruptFileError, LockTimeoutError, appendRotating, isObject, readJsonStrict } from './fsx.mjs';
import { LOCK_BUDGET_MS, RISK_BUDGET_MS, branchOf, headOf, readGrant } from './grants.mjs';
import { HOME, PLUGIN_ROOT, expand as expandHome, inside, paths } from './paths.mjs';
import { consumePostGrant } from './posts.mjs';
import { assessRisk, baseBranchOf, tierOf } from './risk.mjs';
import { draftsAllow, gitGlobalOptions, loadRules, normalizeCommand, pushesProtected, splitCommand } from './rules.mjs';
import { globMatches, lex, shellTargets } from './shellpaths.mjs';

/**
 * @typedef {import('./rules.mjs').Rules} Rules
 * @typedef {import('./crew.mjs').Member} Member
 * @typedef {import('./crew.mjs').Registry} Registry
 * @typedef {'deny' | 'ask' | 'allow'} Decision
 * @typedef {'ship' | 'post' | 'other'} AskKind what an ask is about, which decides the next step a deny names
 * @typedef {{ decision: Decision | null, reason: string, kind?: AskKind, hint?: string, count?: boolean }} Verdict
 * @typedef {{ decision: Decision | null, reason: string }} Answer
 * @typedef {{ tool: string, ti: Record<string, any>, tiOk: boolean, toolOk: boolean, cwd: string, sessionId: string | undefined }} Call
 */

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read']);
const SEND_MESSAGE = 'mcp__ccd_session_mgmt__send_message';
const START_SESSION = 'mcp__ccd_session__start_session';
// An engineer's brief id, keel-<key> (keel-brin-123, keel-t-4-5); an agent's adds its id (keel-qa-t-4).
const ENGINEER_BRIEF = /^keel-[a-z][a-z0-9]*-\d+(-\d+)?$/;
/** Servers whose tools act on this Mac itself (its apps, sessions and settings) rather than on an outside service. */
const MAC_SERVERS = /^mcp__(ccd_[a-z_]+|keelcrew[-_]local|terminal|scheduled-tasks)__/;
const CREW_FILES_BY_HAND = "only the Read tool, or a plain cat, head, tail, jq, grep, wc, ls or stat with nothing redirected, may open the crew's approval, membership, settings and memory files; they change only through the launch card and the keelctl command";
// Shell programs that only read what they're given: a plain run of them reads the crew's files like the Read tool.
const CREW_READERS = new Set(['cat', 'head', 'tail', 'jq', 'grep', 'wc', 'ls', 'stat']);
const ONLY_LEAD_STARTS = 'Crew policy: only the Mate starts sessions. Put the follow-up in your report or message the Mate (send_message), and carry on.';
// The claude CLI run from another crew session's shell starts a session, in whatever folder, that the crew's checks may not
// cover: as a program in any chained part, after a wrapper (env, xargs, nohup, sh -c, find -exec…), by path, through
// $(which claude) or npx. Only its read-only forms pass: version, help, plugin list|validate, config|mcp get|list, auth status.
const CLAUDE_PROGRAM = String.raw`(^\s*|[;&|({\x60\n]\s*|\b(then|do|else|elif|if|while|until)\s+|!\s+|\)\s*|\s-(exec|execdir|ok|okdir)\s+|<<<\s*["']?)(\w+=[^\s;&|]*\s+)*((((sudo|xargs|env|command(?!\s+-[vV]\b)|builtin|eval|nohup|time|timeout|gtimeout|watch|nice|stdbuf|caffeinate|exec|setsid|script|unbuffer|parallel)(\s+(-\S+(\s+(?![-\d])(?![A-Za-z_]\w*=)(?!((\S*\/)?(ba|z|k|da|fi)?sh|sudo|xargs|env|command|builtin|eval|nohup|time|timeout|gtimeout|watch|nice|stdbuf|caffeinate|exec|setsid|script|unbuffer|parallel)(?=[\s;&|]|$))[^\s;&|]+)?|[A-Za-z_]\w*=[^\s;&|]*|\d[^\s;&|]*))*\s+["']?|(\S*\/)?(ba|z|k|da|fi)?sh(\s+-\w+)*\s+-\w*c\w*\s+["']?(\w+=[^\s;&|]*\s+)*))*)((\S*\/|\\|["'])?claude["']?|(\$\(|\x60)\s*(which|command\s+-[vV]|type\s+-[pP]|whence(\s+-\w+)*)\s+["']?claude["']?\s*(\)|\x60)|(npx|bunx|pnpx|(npm|pnpm)\s+exec|(pnpm|yarn)\s+dlx)(\s+-\S+)*\s+["']?(@anthropic-ai\/claude-code|claude)(@[^\s;&|'"]*)?["']?)(?=$|[\s;&|)\x60])`;
const CLAUDE_READS = String.raw`(?!((\s+(--version|-v|--help|-h))+|\s+plugins?\s+(list|validate)\b((?!\s(-p|--print)\b)[^;&|\n])*|\s+(config|mcp)\s+(get|list)\b((?!\s(-p|--print)\b)[^;&|\n])*|\s+auth\s+status\b((?!\s(-p|--print)\b)[^;&|\n])*)(\s+\d*>>?&?\S*)*\s*($|[;&|)\n\x60'"]))`;
const CLAUDE_START = new RegExp(CLAUDE_PROGRAM + CLAUDE_READS, 'i');
// A program read from a variable or a substitution ($C -p hi) in a command that names claude.
const VAR_PROGRAM = /(^\s*|[;&|({\x60\n]\s*|\b(then|do|else|elif|if|while|until)\s+)(\w+=[^\s;&|]*\s+)*["']?\$/;
const NAMES_CLAUDE = /(^|[^\w.\/-])claude([^\w.\/-]|$)/i;
// gh, git or curl named in a command whose program comes from a variable (g=gh; $g pr merge 1): the rules can't read it.
const NAMES_SHIPPERS = /(^|[^\w.-])(gh|git|curl)([^\w.\/-]|$)/;
// A program word that is only a variable or a substitution ($g, "${G}", $(which gh)); `$ROOT/scripts/x` names its program.
const VAR_ONLY_PROGRAM = /(^\s*|[;&|({\x60\n]\s*|\b(then|do|else|elif|if|while|until)\s+)(\w+=[^\s;&|]*\s+)*(["']?(\$\w+|\$\{[^}]*\}|\$\((?:[^()]|\([^()]*\))*\))["']?)+(?=[\s;&|)]|$)/;
const VAR_SHIPPER = "Crew policy: run gh, git and curl by name, not from a variable, so the crew's rules can read the command.";
// git remote add|set-url|rename, git's global options taken out (normalizeCommand), -v allowed before the subcommand.
const GIT_REMOTE_WRITE = /\bgit\s+remote\s+((-v|--verbose)\s+)*(add|set-url|rename)\b/;
const CLAUDE_STARTS ="Crew policy: only the Mate starts sessions, and a claude run from this shell would start one outside the crew's checks. Put the follow-up in your report or message the Mate (send_message), and carry on.";
// The crew command's own subcommands. Only the Mate changes membership, settings and memory, or repairs with doctor --fix;
// a member keeps its role. `keelctl … register` is read with quotes and backslashes taken out; its role with the CLI's parser.
const REGISTER = /\bkeelctl(\.mjs)?\b[^;&|\n]*\bregister\b/;
// `keelctl … rekey`, read the same way: a session /clear started takes over its own folder's old entry, nobody else's.
const REKEY = /\bkeelctl(\.mjs)?\b[^;&|\n]*\brekey\b/;
const LEAD_ONLY = /\bkeelctl(\.mjs)?\s+(unregister|setup|unpause|alerts\s+seen|memory\s+(forget|pin|promote|edit|scope|approve)|doctor\b[^;&|\n]*--fix)\b/;
// `keelctl … ledger`, read the same way: crew sessions read the ticket records (show, list); only the crew's own code records.
const LEDGER_CLI = /\bkeelctl(\.mjs)?\b[^;&|\n]*\bledger\b/;
// `keelctl … org|spend`, read the same way: other members read the org and spend; changes are the Mate's.
const ORG_CLI = /\bkeelctl(\.mjs)?\b[^;&|\n]*\b(org|spend)\b/;
// `keelctl … grant`, read the same way: the captain's answers from the board, carried out by the Mate's panel and nobody else.
const GRANT_CLI = /\bkeelctl(\.mjs)?\b[^;&|\n]*\bgrant\b/;
// The word `grant` and later one of the CLI's grant kinds, in text a shell runs: a grant whatever the program is called.
const GRANT_WORDS = /(^|\s)grant\s(.*\s)?(ship|post)(\s|$)/;
const GRANT_KIND = /^(ship|post)$/;
/** The Mate-only commands as one pattern, for a part (quotes taken out) that can't be read plainly: flags may sit in between. */
const LEAD_ONLY_LOOSE = new RegExp(
  `\\bkeelctl(\\.mjs)?\\b[^;&|\\n]*\\b(${Object.entries(LEAD_ONLY_SUBS)
    .filter(([c, subs]) => subs.length || c === 'doctor')
    .map(([c, subs]) => (subs.includes('*') ? c : c === 'doctor' ? `${c}\\b[^;&|\\n]*--fix` : `${c}\\b[^;&|\\n]*\\b(${subs.join('|')})`))
    .join('|')})\\b`,
);
/** A word holding a variable or substitution (`$C`, `"$C"`, `keel$C`, `$(which keelctl)`) followed by a crew command: read as keelctl. */
const VAR_CREW = new RegExp(`(^|[\\s({!])\\S*(\\$\\{?\\w+\\}?|\\$\\([^)]*\\)|\`[^\`]*\`)\\S*\\s+((${Object.keys(LEAD_ONLY_SUBS).join('|')})(\\s[\\s\\S]*)?)$`);
/** A path through a folder named .env (`.env/<file>`): every file in one counts as a secret. */
const ENV_DIR = /(^|\/)\.env(\.[\w-]+)?\//;
/** A git command that changes a repo (fetching only updates remote refs, so a reader may fetch), but not its list, show and check forms. */
const GIT_CHANGES = /\bgit\b(\s+-[cC]\s+\S+)*\s+(?!(stash|worktree|notes)\s+(list|show)(?![\w-])|tag(\s+(-l|--list|-n\d*)(?![\w-])|\s*$)|apply\s+--(check|stat|numstat|summary)(?![\w-])(?![^;&|\n]*\s--ap))(commit|push|checkout|switch|reset|merge|rebase|cherry-pick|revert|stash|tag|am|apply|pull|clean|restore|rm|mv|add|worktree|notes|update-ref|branch\s+-[dDmMcC])(?![\w-])/;
/**
 * git's own commands (`git --list-cmds=main`, and lfs), less those that push or fetch over a transport of their own, send
 * mail, print credentials, serve a repo or run a command in other repos. An alias can stand for any command, a push
 * included, so a name not here is refused.
 */
const GIT_COMMANDS = new Set(
  'add am annotate apply archive backfill bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick clean clone column commit commit-graph commit-tree config count-objects describe diagnose diff diff-files diff-index diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch fmt-merge-msg for-each-ref format-patch fsck fsck-objects gc get-tar-commit-id grep hash-object help hook index-pack init init-db interpret-trailers lfs log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-one-file merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-redundant pack-refs patch-id prune prune-packed pull push range-diff read-tree rebase reflog refs remote repack replace replay request-pull rerere reset restore rev-list rev-parse revert rm shortlog show show-branch show-index show-ref sparse-checkout stage stash status stripspace submodule subtree switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info var verify-commit verify-pack verify-tag version whatchanged worktree write-tree'.split(' '),
);
/** What a read-only role may run of git: reads, and commands whose write forms GIT_CHANGES or READER_WRITES refuse. */
const READER_GIT = new Set(
  'annotate apply blame branch cat-file check-attr check-ignore check-mailmap check-ref-format cherry config count-objects describe diff diff-files diff-index diff-tree fetch for-each-ref grep help log ls-files ls-remote ls-tree merge-base merge-tree name-rev notes range-diff reflog remote rev-list rev-parse shortlog show show-branch show-ref stash status tag var version whatchanged worktree'.split(' '),
);
/** Write forms a read-only role may not run: git fetch into a local branch, git branch, remote, reflog and config changes (`git config <key>` alone reads), gh commands that write files, curl and wget requests that send data, and crew lessons or alerts. */
const READER_WRITES = [
  /\bgit\s+fetch\b[^;&|\n]*(\s\+?([^\s:'"-][^\s:'"]*)?:(?!\/\/)|\s--(upload-pack|refmap|set-upstream)\b)/,
  /\bgit\s+branch\b[^;&|\n]*\s(-[a-zA-Z]*[dDmMcCfu]\b|--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description|track|no-track|create-reflog)\b)/,
  /\bgit\s+branch(?![^;&|\n]*\s(-l|--list)(\s|$))(\s+(--(contains|no-contains|merged|no-merged|points-at|sort|format)(=\S+|\s+\S+)|-(?!-(contains|no-contains|merged|no-merged|points-at|sort|format)(=|\s|$))\S+))*\s+[^\s;&|-]/,
  /\bgit\s+(remote(\s+-\S+)*\s+(add|remove|rm|rename|set-url|set-head|set-branches|prune|update)|reflog\s+(expire|delete))\b/,
  /\bgit\s+config\b(?![^;&|\n]*\s(--get(-all|-regexp|-urlmatch|-color|-colorbool)?|--list|-l|get|list)(\s|=|$))(?!\s+[\w.-]+\s*$)/,
  /\bgh\s+((-R|--repo)(=|\s+)\S+\s+)*(pr\s+checkout|repo\s+clone|run\s+download|release\s+download|attestation\s+download)\b/,
  /\bcurl\b[^;&|\n]*\s(-X\s*['"]?(?!(GET|HEAD)\b)\w|--request[=\s]+['"]?(?!(GET|HEAD)\b)\w|-[a-zA-Z]*[dFT](\s|$|['"=@])|--(data|data-\w+|form|form-string|upload-file|json)\b)/i,
  /\bwget\b[^;&|\n]*\s--(post-data|post-file|method|body-data|body-file)\b/,
  /(^|[\s/])keelctl(\.mjs)?\b[^;&|\n]*\s(memory|alerts)\s+([^;&|\n]*\s)?add\b/,
];
/** git as the program: starting the part (after assignments), after $( or a backtick, or after a wrapper (env, xargs, bash -c …) and its options. */
const GIT_PROGRAM = /(?:^[\s({!]*(?:[A-Za-z_]\w*=\S*\s+)*|\$\(\s*|`\s*|(?:^|\s)(?:do|then|else|time|xargs|env|sudo|nohup|command(?!\s+-[vV]\b)|exec|nice|caffeinate|stdbuf|watch|timeout\s+\S+|-\w*c)(?:\s+(?:-\S+|[A-Za-z_]\w*=\S*))*\s+)(?:\/[\w./-]*\/)?git\s+([^\s-][^\s;&|()<>`]*)/g;
/**
 * The git commands a part runs (normalizeCommand takes git's own options out, so `git -c alias.p=push p` reads `git p`).
 * Quoted text with a space in it is left out, unless the command runs text it's given. @param {string} part @param {boolean} fed
 */
const gitCommandsIn = (part, fed) =>
  [...(fed ? part : part.replace(/"[^"]*\s[^"]*"|'[^']*\s[^']*'/g, ' ')).replace(/["'\\]/g, '').matchAll(GIT_PROGRAM)].map((m) => m[1]);
/** Programs that run their arguments as a command: a crew command quoted after one of them still runs. */
const RUNS_ARGS = /(^|\/)(bash|sh|zsh|dash|ksh|csh|tcsh|fish|env|xargs|eval|exec|command|builtin|sudo|nohup|timeout|time|watch|nice|caffeinate|stdbuf|python3?|perl|ruby|osascript|script)$/;
/**
 * Whether a chained part may run git: it runs a command it's given, holds a command substitution, or names git anywhere
 * (after a wrapper such as arch or xcrun, a `{`, `!` or a keyword such as then), unless it is grep, echo, printf or rg
 * (without --pre, which runs a command) naming git only in quoted text, and nothing in the whole command runs text it's
 * given (`fed`). A grep for "git add" doesn't. @param {string} part @param {boolean} [fed] what runsText says of the command
 */
function runsGit(part, fed = false) {
  const s = part.replace(/^[\s(]*([A-Za-z_]\w*=\S*\s+)*/, '');
  const first = s.replace(/["'\\]/g, '').split(/\s+/)[0] ?? '';
  if (RUNS_ARGS.test(first) || /\$\(|`/.test(part)) return true;
  if (!/\bgit\b/.test(s.replace(/["'\\]/g, ''))) return false;
  const reader = TEXT_ONLY.test(first) || (/(^|\/)rg$/.test(first) && !/\s--pre(=|\s)/.test(s));
  return fed || !reader || /\bgit\b/.test(s.replace(/"[^"]*"|'[^']*'/g, ' ').replace(/\\/g, ''));
}
/**
 * A plain command's words after `keelctl` (with node and the script path taken off); 'other' for a plain command of
 * another program that doesn't run its arguments (a commit message or a grep that names crew); null when the command
 * can't be read plainly or wraps another command. A stderr redirect to /dev/null, or a keyword in front (a loop's do),
 * changes nothing about what runs; a quoted "$NAME" is one word, `$NAME`, whose value isn't known (never the subcommand).
 * @param {string} cmd @returns {string[] | 'other' | null}
 */
function crewArgs(cmd) {
  const s = String(cmd).replace(/(^|\s)[12&]?>>?\s*\/dev\/null(?=\s|$)/g, ' ').replace(/^\s*((do|then|else|\{|!)\s+)+/, '').replace(/"\$\{?[A-Za-z_]\w*\}?"/g, "'$$NAME'");
  const w0 = plainWords(s, /./);
  if (!w0) return null;
  const node = /(^|\/)node$/.test(w0[0]);
  const w = node ? w0.slice(1) : w0;
  if (w.length && /(^|\/)keelctl(\.mjs)?$/.test(w[0])) return w[1]?.startsWith('$') ? null : w.slice(1);
  return node || RUNS_ARGS.test(w0[0]) ? null : 'other';
}

/** The crew command named as a word of its own (`keelctl`, `…/keelctl`, `keelctl.mjs`), not keel-lead or .keelcrew. */
const NAMES_CREW = /(^|[\s/=({])keelctl(\.mjs)?(?=$|[\s;&|)}])/;
/** Programs that take quoted arguments only as text (a search pattern, a line printed), never as a command to run. */
const TEXT_ONLY = /(^|\/)(grep|egrep|fgrep|echo|printf)$/;
/** git subcommands whose quoted arguments are only text (a message, a log search). */
const GIT_TEXT = new Set(['commit', 'log', 'tag']);
/** `xargs … crew`: crew runs with arguments read from its input, which can't be checked. */
const XARGS_CREW = /(^|[\s/])xargs\b[^;&|\n]*(^|[\s/])keelctl(\.mjs)?(\s|$)/;

/** Whether any part of a command runs text it's given (sh, bash, xargs, source …): then no quoted text counts as only text. @param {string} cmd */
const runsText = (cmd) =>
  splitCommand(cmd).some((p) => {
    const first = p.replace(/["'\\]/g, '').replace(/^[\s(]*([A-Za-z_]\w*=\S*\s+)*/, '').split(/\s+/)[0] ?? '';
    return RUNS_ARGS.test(first) || /^(source|\.)$/.test(first);
  });

/**
 * Whether every part of a shell command that names a crew file is a plain CREW_READERS run: nothing redirected but its
 * input or stderr to /dev/null, no variable but $HOME, no substitution, heredoc or line join, and nothing in the command
 * runs text. Writes are writesCrewFiles'.
 * @param {unknown} cmd @param {Rules} rules
 */
function plainReads(cmd, rules) {
  if (typeof cmd !== 'string') return false;
  const s = cmd.replace(/\$(HOME\b|\{HOME\})/g, '~').replace(/(^|\s)(\d?>>?\s*\/dev\/null|\d?>&[12])(?=\s|$|[;&|)])/g, '$1');
  if (/[`>\r$]|<<|\\\n/.test(s) || runsText(s)) return false;
  const names = (/** @type {import('./shellpaths.mjs').Word[]} */ seg) => rules.policy.crewFiles.test(seg.map((w) => w.text).join(' ').split(HOME).join('~/.keelcrew'));
  return lex(s).every((seg) => !names(seg) || (CREW_READERS.has(seg[0].text) && seg.every((w) => !w.redirect && !w.heredoc && !w.subs?.length)));
}

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Programs that never run the text they're given: only in a command made wholly of these does commandText take text out. */
const VIEW_SAFE = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'cat', 'head', 'tail', 'wc', 'ls', 'pwd', 'cd', 'true', 'false', 'jq', 'uniq', 'cut', 'tr', 'mkdir', 'touch', 'tee', 'diff', 'nl', 'column', 'sleep', 'date', 'basename', 'dirname', 'realpath', 'git', 'gh', 'keelctl']);
/** git and gh subcommands that run nothing they're given (no alias, hook into the command line or exec option). */
const VIEW_GIT = new Set(['add', 'commit', 'status', 'diff', 'log', 'show', 'shortlog', 'grep', 'tag', 'notes', 'stash', 'push', 'fetch', 'branch', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'checkout', 'switch', 'restore', 'reset', 'merge-base', 'describe', 'reflog', 'rev-list', 'cat-file', 'for-each-ref', 'show-ref', 'remote', 'worktree', 'mv', 'rm']);
const VIEW_GH = new Set(['pr', 'issue', 'api', 'run', 'repo', 'release', 'search', 'workflow', 'label', 'status', 'browse', 'auth']);
const VIEW_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}']);
/** Options whose value is prose, per program (git per subcommand); every argument of PROSE_ALL is. */
const PROSE_FLAGS = /** @type {Record<string, RegExp>} */ ({
  keelctl: /^--(text|quote|summary)$/,
  'gh pr': /^(--body|-b|--title|-t)$/,
  'gh issue': /^(--body|-b|--title|-t)$/,
  'git commit': /^(-m|--message)$/,
  'git tag': /^(-m|--message)$/,
  'git notes': /^(-m|--message)$/,
  'git stash': /^(-m|--message)$/,
  'git log': /^(--grep|--author|-S|-G)$/,
  'git shortlog': /^(--grep|--author)$/,
});
/** An unquoted brace expansion, `{a,b}` or `{1..3}`: one word the shell turns into several. */
const BRACES = /\{[^{}\s]*(,|\.\.)[^{}\s]*\}/;
const PROSE_ALL = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'git grep']);
/** The crew command as a command word: `keelctl`, or its link in the crew folder. */
const CREW_WORD = new RegExp(`^(keelctl|(~|\\$HOME|\\$\\{HOME\\}|${escapeRe(homedir())})/\\.keelcrew/bin/keelctl|${escapeRe(join(HOME, 'bin', 'keelctl'))})$`);

/**
 * The command as the shell will run it, with the text it only carries taken out: heredoc bodies, and the prose arguments
 * (a message, a title, a search pattern, a line printed) of programs that never run them, each as `''`. Only for a
 * command made wholly of VIEW_SAFE programs, where a substitution's output lands only in prose; anything that could turn
 * text into a command (a program that runs text, a variable or substitution as the command, arithmetic, process
 * substitution, a prefix assignment) or that the shell might read differently (an unclosed quote or heredoc, an odd tag
 * or character, a joined line, ANSI-C quoting) keeps the whole command.
 * @param {string} cmd
 */
function commandText(cmd) {
  if (typeof cmd !== 'string' || /[^\S \t\n]|\\\n/.test(cmd)) return cmd;
  const s = cmd;
  /** @type {[number, number, string][]} */
  const cuts = [];
  const fail = () => {
    throw new Error('not plain');
  };
  /**
   * @typedef {{ start: number, raw: string, redirect: boolean, subs: Seg[][], dq: boolean, dqEnd: number, plain: boolean }} ViewWord
   * @typedef {{ words: ViewWord[], heredocs: { from: number, to: number, data: boolean }[] }} Seg
   */
  /** The segments from i to the end, or to the `)` that closes a substitution. @param {number} i @param {boolean} inSub @returns {{ segs: Seg[], end: number }} */
  const parse = (i, inSub) => {
    /** @type {Seg[]} */
    const segs = [];
    /** @type {Seg} */
    let seg = { words: [], heredocs: [] };
    /** @type {ViewWord | null} */
    let w = null;
    let redirect = false;
    let depth = 0;
    /** @type {{ tag: string, strip: boolean, data: boolean, seg: Seg }[]} */
    const pending = [];
    const word = () => (w ??= { start: i, raw: '', redirect, subs: [], dq: false, dqEnd: -1, plain: true });
    const endWord = () => {
      if (w) {
        w.raw = s.slice(w.start, i);
        w.dq = w.dqEnd === i;
        seg.words.push(w);
        redirect = false;
      }
      w = null;
    };
    const endSeg = () => {
      endWord();
      segs.push(seg);
      seg = { words: [], heredocs: [] };
    };
    const sub = (/** @type {number} */ at) => {
      if (pending.length) fail();
      const inner = parse(at, true);
      word().subs.push(inner.segs);
      return inner.end;
    };
    while (i < s.length) {
      const c = s[i];
      if (c === ' ' || c === '\t') {
        endWord();
        i++;
      } else if (c === '\n') {
        endSeg();
        i++;
        for (const h of pending.splice(0)) {
          const from = i;
          for (;;) {
            if (i >= s.length) fail();
            const eol = s.indexOf('\n', i);
            const line = s.slice(i, eol < 0 ? s.length : eol);
            const at = i;
            i = eol < 0 ? s.length : eol + 1;
            if ((h.strip ? line.replace(/^\t+/, '') : line) !== h.tag) continue;
            // In a substitution, an unmatched `)` in the body can end it early in an old bash (3.2).
            if (inSub && [...s.slice(from, at).replace(/[^()]/g, '')].reduce((d, p) => (d < 0 ? d : d + (p === '(' ? 1 : -1)), 0) !== 0) fail();
            h.seg.heredocs.push({ from, to: at, data: h.data || !/[$`\\]/.test(s.slice(from, at)) });
            break;
          }
        }
      } else if (c === '#' && !w) {
        const eol = s.indexOf('\n', i);
        i = eol < 0 ? s.length : eol;
      } else if (c === "'") {
        const end = s.indexOf("'", i + 1);
        if (end < 0) fail();
        word().plain = false;
        i = end + 1;
      } else if (c === '"') {
        const first = !w;
        word().plain = false;
        let j = i + 1;
        while (s[j] !== '"') {
          if (j >= s.length) fail();
          if (s[j] === '\\') j += 2;
          else if (s[j] === '`' || (s[j] === '$' && /^\$(\(\(|\[)/.test(s.slice(j)))) fail();
          else if (s[j] === '$' && s[j + 1] === '(') j = sub(j + 2);
          else if (s[j] === '$' && s[j + 1] === '{' && !/^\$\{[A-Za-z_]\w*\}/.test(s.slice(j))) fail();
          else j++;
        }
        i = j + 1;
        if (first) word().dqEnd = i;
      } else if (c === '`' || (c === '$' && /^\$(\(\(|\[|['"])/.test(s.slice(i)))) {
        // Backticks, arithmetic and ANSI-C or locale quoting aren't read here.
        fail();
      } else if (c === '$') {
        word().plain = false;
        if (s[i + 1] === '(') i = sub(i + 2);
        else if (s[i + 1] === '{' && !/^\$\{[A-Za-z_]\w*\}/.test(s.slice(i))) fail();
        else i++;
      } else if (c === '\\') {
        word().plain = false;
        i += 2;
      } else if (c === '<' && s[i + 1] === '<' && s[i + 2] === '<') {
        endWord();
        redirect = true;
        i += 3;
      } else if (c === '<' && s[i + 1] === '<') {
        endWord();
        let j = i + 2;
        const strip = s[j] === '-';
        if (strip) j++;
        while (s[j] === ' ' || s[j] === '\t') j++;
        // The tag as the shell reads it: up to a blank or an operator, and nothing but plain characters in it.
        const m = /^(?:'([\w.-]+)'|"([\w.-]+)"|\\([\w.-]+)|([\w.-]+))(?=$|[ \t\n;&|()<>])/.exec(s.slice(j));
        if (!m) fail();
        const tag = /** @type {RegExpExecArray} */ (m);
        pending.push({ tag: tag[1] ?? tag[2] ?? tag[3] ?? tag[4], strip, data: tag[4] === undefined, seg });
        i = j + tag[0].length;
      } else if (c === '<' || c === '>' || (c === '&' && s[i + 1] === '>')) {
        if (w && /^\d+$/.test(s.slice(w.start, i))) w = null;
        endWord();
        let j = i + /** @type {RegExpExecArray} */ (/^(&>>?|>>?[|!]?|<>|<)/.exec(s.slice(i)))[0].length;
        // A duplicated or closed descriptor (2>&1, >&-) names no file; >&file and every other redirection does.
        if (c !== '&' && s[j] === '&' && /[\d-]/.test(s[j + 1] ?? '')) {
          for (j++; /[\d-]/.test(s[j] ?? ''); ) j++;
        } else {
          if (c !== '&' && s[j] === '&') j++;
          // Process substitution, <(…) or >(…), runs a command.
          if (s[j] === '(') fail();
          redirect = true;
        }
        i = j;
      } else if (c === ';' || c === '|' || c === '&') {
        endSeg();
        i++;
      } else if (c === '(') {
        // Not mid-word (a function, a glob qualifier, an array) nor arithmetic.
        if (w || seg.words.length || s[i + 1] === '(') fail();
        endSeg();
        depth++;
        i++;
      } else if (c === ')') {
        endSeg();
        i++;
        if (depth) depth--;
        else if (inSub && !pending.length) return { segs, end: i };
        else fail();
      } else {
        if (c > '~' || c < ' ') fail();
        word();
        i++;
      }
    }
    if (inSub || depth || pending.length) fail();
    endSeg();
    return { segs, end: i };
  };
  /** Cuts the prose of each segment (when `prose`), and fails on anything that could run text. @param {Seg[]} segs @param {boolean} prose */
  const take = (segs, prose) => {
    for (const seg of segs) {
      // A substitution's output anywhere but in prose becomes part of a command line (or a file it writes).
      if (seg.words.some((x) => x.redirect && x.subs.length)) fail();
      const words = seg.words.filter((x) => !x.redirect);
      let k = 0;
      while (k < words.length && VIEW_KEYWORDS.has(words[k].raw)) k++;
      const rest = words.slice(k);
      if (!rest.length || (rest[0].raw === 'for' && /^[A-Za-z_]\w*$/.test(rest[1]?.raw ?? '') && (!rest[2] || rest[2].raw === 'in'))) {
        if (rest.some((x) => x.subs.length)) fail();
        continue;
      }
      if (rest.every((x) => /^[A-Za-z_]\w*=/.test(x.raw) && !x.subs.length)) continue;
      const base = CREW_WORD.test(rest[0].raw) ? 'keelctl' : rest[0].plain ? rest[0].raw : '';
      if (!VIEW_SAFE.has(base)) fail();
      const args = rest.slice(1);
      // A brace expansion makes several crew arguments of one word (elsewhere it stops the prose walk below).
      if (base === 'keelctl' && args.some((x) => BRACES.test(x.raw.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '')))) fail();
      const texts = args.map((x) => x.raw);
      let key = base;
      if ((base === 'printf' && texts.some((t) => /^-v/.test(t))) || (base === 'rg' && texts.some((t) => /^--pre(=|$)/.test(t)))) fail();
      if (base === 'gh' || base === 'git') {
        let j = 0;
        for (; base === 'git' && j < texts.length && texts[j].startsWith('-'); j++) {
          if (/^(-c|--config-env|--exec-path)/.test(texts[j])) fail();
          if (/^(-C|--git-dir|--work-tree|--namespace)$/.test(texts[j])) j++;
        }
        if (!(base === 'git' ? VIEW_GIT : VIEW_GH).has(texts[j] ?? '')) fail();
        if (base === 'git' && texts.some((t) => /^--(upload-pack|receive-pack|exec|open-files-in-pager)|^-O/.test(t))) fail();
        key = `${base} ${texts[j]}`;
        args.splice(0, j + 1);
      }
      const flags = PROSE_FLAGS[key];
      /** A word as the program gets it, or null when the shell could make it something else (several words, a flag). @param {ViewWord} x */
      const value = (x) => (x.plain ? (/[*?[{~]/.test(x.raw) ? null : x.raw) : /^'[^']*'$/.test(x.raw) || (x.dq && !/[$`\\]/.test(x.raw)) ? x.raw.slice(1, -1) : null);
      // The prose values, read as the program reads its options (crew's exactly as parseArgs: a word taken as a value is
      // never a flag); a word the shell could turn into several words or a flag ends the reading.
      /** @type {Set<ViewWord>} */
      const prosy = new Set(PROSE_ALL.has(key) ? args : []);
      for (let j = 0; flags && j < args.length; j++) {
        const t = value(args[j]);
        if (t === null) break;
        const eq = /^(--?[\w-]+)=/.exec(t);
        if (eq || (base === 'keelctl' ? !t.startsWith('--') || t === '--' || BOOLEAN_FLAGS.has(t.slice(2)) : !t.startsWith('-'))) {
          if (eq && flags.test(eq[1])) prosy.add(args[j]);
          continue;
        }
        const next = args[j + 1];
        if (next && flags.test(t) && (next.dq || value(next) !== null)) prosy.add(next);
        if (base === 'keelctl' || flags.test(t)) j++;
      }
      args.forEach((x) => {
        const eq = /^--?[\w-]+=/.exec(x.raw);
        if (!prosy.has(x) || !prose) {
          if (x.subs.length) fail();
        } else if (!x.subs.length) cuts.push([x.start + (eq && !PROSE_ALL.has(key) ? eq[0].length : 0), x.start + x.raw.length, "''"]);
        else if (x.dq) for (const inner of x.subs) take(inner, true);
        else fail();
      });
      if (prose) for (const h of seg.heredocs) if (h.data) cuts.push([h.from, h.to, '']);
    }
  };
  try {
    take(parse(0, false).segs, true);
  } catch {
    return cmd;
  }
  let out = s;
  for (const [from, to, by] of cuts.sort((a, b) => b[0] - a[0])) out = out.slice(0, from) + by + out.slice(to);
  return out;
}

/**
 * How a chained part calls the crew command: its words after `keelctl` for a plain crew call; null when it can't be read
 * plainly or names crew in any other way (after a wrapper such as arch or find -exec, inside code such as awk or a git
 * alias, unquoted as an argument, or anywhere in a command that runs text it's given), so the loose patterns judge it;
 * 'other' only when it doesn't name crew, or names it only in quoted text that a commit, a log search, grep or echo takes
 * as text. @param {string} part @param {boolean} fed what runsText says of the whole command
 * @returns {string[] | 'other' | null}
 */
function crewCall(part, fed) {
  const a = crewArgs(part);
  if (a !== 'other' || !NAMES_CREW.test(part.replace(/["'\\]/g, ''))) return a;
  if (fed || NAMES_CREW.test(part.replace(/"[^"]*"|'[^']*'/g, ' ').replace(/\\/g, ''))) return null;
  const w = plainWords(String(part).replace(/(^|\s)2>>?\s*\/dev\/null(?=\s|$)/g, ' '), /./) ?? [];
  const rg = /(^|\/)rg$/.test(w[0] ?? '') && !w.some((x) => /^--pre(=|$)/.test(x));
  return TEXT_ONLY.test(w[0] ?? '') || rg || (/(^|\/)git$/.test(w[0] ?? '') && GIT_TEXT.has(w[1])) ? 'other' : null;
}

/**
 * A crew command another member may not run, judged per chained part: the Mate-only commands and subcommands, read with
 * the CLI's own argument parser, so flags or quotes in front of a subcommand don't hide it. A part that can't be read
 * plainly, or names crew without being a plain crew call, is refused when it names one of them, or any org or spend
 * command, or runs crew from xargs. A part that only quotes crew as text (a commit message, a grep) isn't judged.
 * Null for everything else (and the Mate).
 * @param {string} cmd @param {string} role
 * @returns {Verdict | null}
 */
function leadOnlyCliVerdict(cmd, role) {
  if (role === 'lead') return null;
  const why = "Crew policy: only the Mate changes crew membership, settings, alerts, memory and spend lines. Read them with keelctl org show|staff|model|proactive or keelctl spend.";
  const fed = runsText(cmd);
  for (let part of splitCommand(cmd)) {
    const v = VAR_CREW.exec(part.replace(/["'\\]/g, ''));
    if (v) part = `keelctl ${v[3]}`;
    const a = crewCall(part, fed);
    if (a === 'other') continue;
    if (LEAD_ONLY.test(part)) return deny("Crew policy: only the Mate changes crew membership, settings, alerts, memory and spend lines, or repairs with doctor --fix.");
    if (a === null) {
      const flat = part.replace(/["'\\]/g, '');
      // A read such as keelctl org owner $F stays a read whatever its arguments.
      const read = /(^|[\s/])keelctl(\.mjs)?\s+(org|spend)(\s+([a-z]+))?(?=\s|$)/.exec(flat);
      if (read?.[5] && MEMBER_READS[read[3]]?.includes(read[5]) && !LEAD_ONLY_LOOSE.test(flat) && !XARGS_CREW.test(flat)) continue;
      if (LEAD_ONLY_LOOSE.test(flat) || ORG_CLI.test(flat) || XARGS_CREW.test(flat)) return deny(why, false);
      continue;
    }
    const [command, ...rest] = a;
    if (mateOnly(command, rest)) return deny(why, false);
  }
  return null;
}

/**
 * A `keelctl register` from a crew member, judged per chained part: a session already in the crew doesn't join again, and a
 * session working in a crew folder joins only as that folder's role, read with the CLI's own parser so flags or quotes in
 * front of the role don't hide it. A register that can't be read plainly is refused. Null when no part registers.
 * @param {Env} env @param {string} cmd @returns {Verdict | null}
 */
function registerVerdict(env, cmd) {
  const { call, reg, me } = env;
  const fed = runsText(cmd);
  for (const part of splitCommand(cmd)) {
    const flat = part.replace(/["'\\]/g, '');
    if (!REGISTER.test(flat) && !XARGS_CREW.test(flat)) continue;
    const a = crewCall(part, fed);
    if (a === 'other' || (a && a[0] !== 'register')) continue;
    if (call.sessionId && reg.sessions[call.sessionId]) {
      if (!REGISTER.test(flat)) continue;
      const mine = reg.sessions[call.sessionId];
      // Registering again as itself does nothing (the CLI says so), so it needn't stop the rest of the command.
      const again = a ? parseArgs(a.slice(1)).pos : null;
      if (again && again[0] === mine.role && (again[1] === undefined || again[1] === mine.key)) continue;
      return deny(`Crew policy: this session is already in the crew as ${mine.role ?? 'a member'}${mine.key ? ` for ${mine.key}` : ''}; there is nothing to register.`, false);
    }
    if (!a) return deny(`Crew policy: run keelctl register ${me.role} as a plain command (no variables, substitutions or wrappers), so the role it joins as can be checked.`, false);
    const role = parseArgs(a.slice(1)).pos[0];
    // A session working in a crew folder joins as that folder's role; it can't make itself the Mate or anything else.
    if (role !== undefined && role !== me.role) return deny(`Crew policy: a session in ${me.dir} joins the crew as its ${me.role}, never as ${role}.`);
  }
  return null;
}

/**
 * A `keelctl rekey` from a crew member, judged per chained part: a session registered in the crew keeps its id, and one a
 * /clear left out (a member only by its folder) takes over only an entry whose folder is its own, for its own id. A rekey
 * that can't be read plainly is refused. Null when no part re-keys.
 * @param {Env} env @param {string} cmd @returns {Verdict | null}
 */
function rekeyVerdict(env, cmd) {
  const { call, reg, me } = env;
  const fed = runsText(cmd);
  for (const part of splitCommand(cmd)) {
    if (!REKEY.test(part.replace(/["'\\]/g, ''))) continue;
    const a = crewCall(part, fed);
    if (a === 'other' || (a && a[0] !== 'rekey')) continue;
    if (call.sessionId && reg.sessions[call.sessionId]) return deny('Crew policy: this session is in the crew under its own id; keelctl rekey is only for a session /clear started.', false);
    if (!a) return deny('Crew policy: run keelctl rekey as a plain command (no variables, substitutions or wrappers), so the entry it takes over can be checked.', false);
    const { flags, pos } = parseArgs(a.slice(1));
    const old = pos[0] ? reg.sessions[pos[0]] : undefined;
    if (!old?.dir || realOf(old.dir) !== realOf(me.dir) || (flags.session !== undefined && flags.session !== call.sessionId)) {
      return deny(`Crew policy: a session in ${me.dir} takes over only its own folder's crew entry, for its own session id.`);
    }
  }
  return null;
}

// A lesson the captain said directly starts active, so only the Mate may record one; others record what they saw.
const OWNER_LESSON = /\bkeelctl(\.mjs)?\s+memory\s+add\b.*--source(=|\s+)["']?owner\b/;
/** Whether a part of a command adds a lesson with --source owner, read with the CLI's own parser (loosely when it can't be read plainly). @param {string} cmd */
const ownerLesson = (cmd) => {
  const fed = runsText(cmd);
  return splitCommand(cmd).some((part) => {
    const a = crewCall(part, fed);
    if (a === 'other') return false;
    if (!a) return OWNER_LESSON.test(part.replace(/["'\\]/g, ''));
    const { flags, pos } = parseArgs(a.slice(1));
    return a[0] === 'memory' && pos[0] === 'add' && /^owner\b/.test(String(flags.source ?? '').replace(/["']/g, ''));
  });
};
// Without readable rules, this coarse net stands in for ship.actions and githubWrite: anything that might reach GitHub.
const MIGHT_SHIP = /\bgit\b[^;&|\n]*\bpush\b|\bgh\s+[\w-]/;
// Tools that only read or search on this Mac, when no rules can be read at all.
const MINIMAL_LOCAL = new Set(['Read', 'Grep', 'Glob', 'LS']);
// Commands a push may be chained with: they only show output, so they can't change what goes out.
const OUTPUT_ONLY = /^(tail|head|grep|egrep|fgrep|cat|wc|sort|uniq|echo|printf|true|sleep\s+\d+)(\s|$)/;
const PUSH_FLAGS = new Set(['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose', '--porcelain', '--progress', '--no-progress', '--atomic', '-n', '--dry-run', '--verify', '--no-recurse-submodules']);
const PUSH_OPTION_FLAGS = new Set(['-o', '--push-option']);
// A command that writes files, for the guard on the crew's own folder.
const WRITES = />|\b(tee|cp|mv|ln|rm|rmdir|unlink|touch|chmod|chown|truncate|dd|rsync|install|python\d*(\.\d+)?|node)\b|\bsed\b[^;&|\n]*\s-\w*i|\bperl\b[^;&|\n]*\s-\w*i/;
/** Hooks run under a 10 s timeout, so nothing they wait on may take long. */
const GIT_BUDGET_MS = 1500;
/** Risk tiers whose changes go out as a draft PR without the launch card. */
const DRAFT_FREE_TIERS = new Set(['low', 'medium']);
/** A contractor's mechanical change goes out as a draft PR without the card only at low risk. */
const CONTRACTOR_DRAFT_FREE_TIERS = new Set(['low']);

/* ---------- verdicts ---------- */

/** @returns {Verdict} */
const none = () => ({ decision: null, reason: '' });
/** @param {string} reason @returns {Verdict} */
const allow = (reason) => ({ decision: 'allow', reason });
/** @param {string} reason @param {boolean} [count] @returns {Verdict} */
const deny = (reason, count = true) => ({ decision: 'deny', reason, count });
/**
 * A call that needs a person: a prompt in ask mode, a denial naming the next step in deny mode.
 * @param {AskKind} kind @param {string} why @param {string} [hint] what the captain reads in the prompt
 * @returns {Verdict}
 */
const gate = (kind, why, hint = 'Approve only if you meant to.') => ({ decision: 'ask', reason: why, kind, hint });

/* ---------- the call and the crew's files ---------- */

/** The call as the hook got it, with its shape checked. @param {unknown} raw @returns {Call} */
function callOf(raw) {
  const input = isObject(raw) ? raw : {};
  const toolOk = typeof input.tool_name === 'string' && input.tool_name.length > 0;
  const ti = input.tool_input;
  // SendMessage to a session id is the same act as send_message, so it gets the same checks.
  const toSession = input.tool_name === 'SendMessage' && isObject(ti) && /^local_/.test(String(ti.to ?? ''));
  return {
    tool: toolOk ? (toSession ? SEND_MESSAGE : input.tool_name) : '',
    toolOk,
    ti: isObject(ti) ? ti : {},
    tiOk: ti === undefined || ti === null || isObject(ti),
    cwd: typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd(),
    sessionId: typeof input.session_id === 'string' && input.session_id ? input.session_id : undefined,
  };
}

/** A short, plain name for why a crew file couldn't be read. @param {unknown} e */
function problemOf(e) {
  if (e instanceof CorruptFileError) return `${basename(e.path)} is damaged`;
  return String(/** @type {Error} */ (e)?.message ?? e).split('\n')[0];
}

/** Everything a decision reads. A file that can't be read is recorded as a problem instead of being treated as empty. */
function loadState() {
  /** @type {string[]} */
  const problems = [];
  /** @type {Record<string, any>} */
  let config = {};
  /** @type {Registry | null} */
  let reg = null;
  /** @type {Rules | null} */
  let rules = null;
  try {
    config = readConfig();
  } catch (e) {
    problems.push(problemOf(e));
  }
  try {
    reg = readRegistry();
  } catch (e) {
    problems.push(problemOf(e));
  }
  try {
    rules = loadRules(config.pack);
  } catch (e) {
    problems.push(problemOf(e));
  }
  return { config, reg, rules, problems };
}

/** The plugin's own rules without the pack, to classify tools with when the configured rules can't load. */
function baseRules() {
  try {
    return loadRules(undefined, { quiet: true });
  } catch {
    return null;
  }
}

/** What a call does, in one line, for the log and the denial count. @param {Call} call */
const whatOf = (call) =>
  typeof call.ti.command === 'string' ? call.ti.command.split('\n')[0].slice(0, 160) : `${call.tool || '(no tool)'} ${JSON.stringify(call.ti).slice(0, 140)}`;

/** Whether `p` is inside `root`, as written or once symlinks are resolved. @param {string} root @param {string} p */
function insideReal(root, p) {
  // Real paths on both sides: a symlink inside a worktree that points elsewhere leads outside it.
  return inside(realOf(root), realOf(p));
}

/** A path with symlinks resolved, also for a file not created yet: its deepest existing folder, then the rest. @param {string} p */
function realOf(p) {
  let base = p;
  const rest = [];
  for (;;) {
    try {
      return join(realpathSync(base), ...rest.reverse());
    } catch {
      const up = resolve(base, '..');
      if (up === base) return p;
      rest.push(basename(base));
      base = up;
    }
  }
}

/* ---------- classifying tools ---------- */

/**
 * Whether a connector tool only reads: each clause of its name (split at "and", "or", "then") is judged by its first read
 * or write verb, and any clause that writes makes it a write, so get_or_create_x writes while get_release_notes reads.
 * @param {string} name @param {Rules} rules
 */
function readsOnly(name, rules) {
  const action = name.slice(name.lastIndexOf('__') + 2);
  if (rules.policy.readTools.has(action)) return true;
  const words = action.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  /** @type {string[][]} */
  const clauses = [[]];
  for (const w of words) {
    if (w === 'and' || w === 'or' || w === 'then') clauses.push([]);
    else clauses[clauses.length - 1].push(w);
  }
  const verbs = clauses.map((c) => c.find((w) => rules.policy.readVerbs.has(w) || rules.policy.writeVerbs.has(w))).filter(Boolean);
  return verbs.length > 0 && verbs.every((v) => rules.policy.readVerbs.has(/** @type {string} */ (v)));
}

/** MCP tools that run without asking: the app's own tools, read-only servers and reads. @param {string} tool @param {Member | null} m @param {Rules} rules */
function quietMcp(tool, m, rules) {
  const p = rules.policy;
  if (p.appTools.test(tool) || (m?.role === 'lead' && p.leadAppTools.test(tool))) return true;
  return p.readOnlyServers.some((re) => re.test(tool)) || readsOnly(tool, rules);
}

/**
 * Why a crew member's browser call needs a person, or null when it can run: a URL that isn't a web page (or can't be
 * read), or a page script that might send data, change the page or leave it. A batch is checked step by step.
 * @param {Rules} rules @param {string} action the tool name after its server @param {Record<string, any>} inp
 * @returns {string | null}
 */
function browserCheck(rules, action, inp) {
  if (/batch$/.test(action)) {
    if (!Array.isArray(inp?.actions)) return "this batch can't be checked.";
    for (const step of inp.actions) {
      const why = browserCheck(rules, String(step?.name ?? '').replace(/^.*__/, ''), isObject(step?.input) ? step.input : {});
      if (why) return why;
    }
    return null;
  }
  if (inp?.paths !== undefined || inp?.files !== undefined) return 'this hands files from this Mac to a web page.';
  if (action === 'preview_start' && inp?.name !== undefined) return 'this runs a command from .claude/launch.json.';
  if (inp?.url !== undefined && typeof inp.url !== 'string') return "this URL can't be checked.";
  if (typeof inp?.url === 'string' && !(action === 'navigate' && /^(back|forward)$/.test(inp.url))) {
    // An explicit http(s) URL, or a bare host[/…] that is localhost or an IPv4 address (with a port or not) or a dotted
    // name (without one), so `file:/x`, `javascript:0/…`, `scheme:x@host` and `com.app:0/x` are never read as a host;
    // whitespace and backslashes never pass.
    const bare = /^(?:(localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?|((?:[a-z0-9-]+\.)+[a-z]{2,}))(?=[/?#]|$)/i.exec(inp.url);
    let web = false;
    if (!/[\s\\\x00-\x1f\x7f]/.test(inp.url) && (/^https?:\/\//i.test(inp.url) || bare)) {
      try {
        const u = new URL(bare ? `https://${inp.url}` : inp.url);
        web = (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && (!bare || u.hostname === (bare[1] ?? bare[2]).toLowerCase());
      } catch {
        /* not a URL anyone can check */
      }
    }
    // file: would read what the policy keeps from every other tool, and javascript: is a page script unchecked.
    if (!web) return `${inp.url.slice(0, 120)} isn't a web page (http or https).`;
  }
  if (/^javascript/.test(action)) {
    const code = [inp?.text, inp?.code, inp?.script, inp?.function].find((v) => typeof v === 'string');
    if (code === undefined) return "this page script can't be checked.";
    if (rules.policy.browserScriptWrites.some((re) => re.test(code))) return 'this page script may send data, change the page or leave it.';
  }
  return null;
}

/** A heredoc: its opening line, its body and its closing tag. */
// The tag is one whole quoted word (`<<'EOF'`, not `<<'EOF'x`, whose tag the shell reads as EOFx), so the body blanked
// is never shorter than the shell's.
const HEREDOC = /(<<-?\s*(['"])(\w+)\2(?=[\s;&|<>)]|$)[^\n]*\n)([\s\S]*?)(\n[ \t]*\3[ \t]*(?=\n|$))/g;

/** Programs whose heredocs are only data: none of them runs text as commands, here or from a file written before. */
const DATA_PROGRAMS = new Set(['cat', 'tee', 'cd', 'mkdir', 'ls', 'echo', 'printf', 'true', 'wc', 'head', 'tail', 'grep', 'jq', 'date', 'pwd']);
const DATA_GIT = new Set(['add', 'commit', 'tag', 'status', 'diff', 'log', 'show', 'push']);
const DATA_GH = /^(pr|issue)\s(create|new|edit|comment)$/;

/** Whether every program a command (its heredoc bodies blanked) runs treats a heredoc as data, with no `$(…)` anywhere. @param {string} cmd */
function heredocsAreData(cmd) {
  return lex(cmd).every((seg) => {
    if (seg.some((x) => x.subs?.length)) return false;
    const w = seg.filter((x) => !x.redirect && !x.input && !x.heredoc).map((x) => x.text);
    const at = w.findIndex((x) => !/^[A-Za-z_]\w*=/.test(x));
    if (at < 0) return true;
    const name = basename(w[at]);
    if (name === 'git') return DATA_GIT.has(w[at + 1]);
    if (name === 'gh') return DATA_GH.test(`${w[at + 1]} ${w[at + 2]}`);
    return DATA_PROGRAMS.has(name);
  });
}

/**
 * A shell denial that only a heredoc's text caused (the command with its heredoc bodies blanked isn't denied). When
 * every program in the command treats heredocs as data (heredocsAreData: a PR body, a commit message, notes written with
 * cat), the blanked command's verdict stands. Otherwise the denial says so and isn't counted toward a pause: the text is
 * usually data that belongs in the tool call or a file written with the Write tool. Every other verdict is returned as it is.
 * @param {Env} env @param {string} cmd @param {Verdict} v @returns {Verdict}
 */
function textOnlyDenial(env, cmd, v) {
  // Only quoted-tag heredocs (no expansion) that no shell runs: text a shell runs is a command, not data.
  if (v.decision !== 'deny' || !/<</.test(cmd) || /<<-?\s*\w/.test(cmd) || /(^|[\s|;&(])(\S*\/)?(ba|z|k|da|fi)?sh(\s|$)/.test(cmd)) return v;
  const blank = cmd.replace(HEREDOC, (_m, head, _q, _tag, _body, tail) => `${head}${tail}`);
  // A dry run: the check never uses up the captain's one-time approval of a post.
  if (blank === cmd || shellVerdict({ ...env, dryRun: true }, blank).decision === 'deny') return v;
  if (heredocsAreData(blank)) return shellVerdict(env, blank);
  return deny(`${v.reason} This comes only from text inside a heredoc: if that text is data (a card, JSON, notes), put it in the tool call or a file written with the Write tool instead of the command line.`, false);
}

/** Whether this call messages another crew session. @param {Call} call @param {Registry} reg */
function toCrew(call, reg) {
  const hosts = new Set(Object.values(reg.sessions).map((m) => m.hostId).filter(Boolean));
  return call.tool === SEND_MESSAGE && hosts.has(String(call.ti.session_id ?? call.ti.to ?? ''));
}

/** Whether a tool runs a shell command (Bash, and any other tool whose input carries one, such as Monitor). @param {Call} call */
const runsCommand = (call) => call.tool === 'Bash' || (!call.tool.startsWith('mcp__') && typeof call.ti.command === 'string');

/**
 * The chained parts of a command, each with the ship actions it performs and whether it writes to GitHub otherwise.
 * @param {string} cmd @param {Rules} rules
 */
function partsOf(cmd, rules) {
  const g = rules.policy.githubWrite;
  return splitCommand(cmd).map((raw) => {
    const norm = normalizeCommand(raw);
    const actions = [...new Set(rules.ship.actions.filter((a) => a.re.test(norm)).map((a) => a.action))];
    const github = !actions.length && g.command.test(norm) && (g.api.test(norm) ? g.apiWrite.test(norm) : !g.reads.test(norm));
    return { raw, norm, actions, github };
  });
}

/**
 * Whether a shell command writes into the crew's own files however it names the folder: `.keelcrew`, $KEELCREW_HOME or
 * the folder's real path, for the folder itself (as with `cd ~/.keelcrew && …`) or a crew file in it, together with a
 * command or redirection that writes. Agents' work folders, logs and the crew command itself don't count. The paths the
 * command writes are read the shell's way too (core/shellpaths.mjs: quotes taken out, `~` and `$HOME` expanded), so
 * `~/.keel""crew/grants` counts, and so does a glob that could match the crew folder, whatever follows it.
 * @param {string} cmd @param {Rules} rules @param {string} cwd
 */
function writesCrewFiles(cmd, rules, cwd) {
  const text = commandText(String(cmd)).replace(/\d*>>?\s*\/dev\/null|\d*>&\d+/g, ' ');
  const mention = new RegExp(`(?:\\.keelcrew|\\$\\{?KEELCREW_HOME\\}?|${escapeRe(HOME)})["']?(\\/[^\\s'";&|)]*)?`, 'g');
  for (const m of text.matchAll(mention)) {
    const sub = (m[1] ?? '').replace(/^\/+/, '');
    if ((!sub || rules.policy.crewFileNames.test(sub)) && WRITES.test(text)) return true;
  }
  return shellTargets(cmd, cwd).targets.some((t) => t.write && isCrewFileTarget(t, rules));
}

/** The crew folder as a shell command may name it, in lower case: KEELCREW_HOME as written and by real path, and ~/.keelcrew. */
const crewHomes = () => [...new Set([HOME, realOf(HOME), join(homedir(), '.keelcrew')].map((h) => h.toLowerCase()))];

/**
 * Whether a path a command writes is the crew folder itself or a crew file in it (rules policy.crewFileNames), as named or
 * where links lead; any `.keelcrew` folder counts, as in the text check. A glob counts when a wildcard in it could match
 * the crew folder (`~/.keel*`), whatever follows, or, under the folder named plainly, could match a crew file in it.
 * @param {import('./shellpaths.mjs').Target} t @param {Rules} rules
 */
function isCrewFileTarget(t, rules) {
  const homes = crewHomes();
  if (t.glob) {
    const segs = t.path.split('/');
    const wild = (/** @type {string} */ s) => /[*?[{]/.test(s);
    return segs.some((_, i) => {
      const head = segs.slice(0, i + 1).join('/');
      if (i === 0 || !globMatches(head, homes)) return false;
      const rest = segs.slice(i + 1);
      return wild(head) || !rest.length || wild(rest[0]) || rules.policy.crewFileNames.test(rest.join('/').toLowerCase());
    });
  }
  return [t.path, realOf(t.path)].some((raw) => {
    const p = raw.toLowerCase();
    const home = homes.find((h) => p === h || p.startsWith(`${h}/`));
    const named = /(?:^|\/)\.keelcrew(?:\/(.*))?$/.exec(p);
    const sub = home !== undefined ? p.slice(home.length + 1) : named ? (named[1] ?? '') : null;
    return sub !== null && (!sub || rules.policy.crewFileNames.test(sub));
  });
}

/** A file path as the tool will use it: `~` is the home folder, and a relative path starts in the session's folder. @param {string} cwd @param {string} p */
const absPath = (cwd, p) => resolve(cwd, p.replace(/^~(?=$|\/)/, homedir()));

/** @param {string} s */
const words = (s) => [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

/** @param {string} sha */
const short = (sha) => sha.slice(0, 7);

/* ---------- decisions for a healthy crew ---------- */

/**
 * @typedef {{ call: Call, config: Record<string, any>, reg: Registry, rules: Rules, me: Member, owner: string, leadHost: string | null, worksInDir: boolean, profile: string, dryRun?: boolean }} Env
 */

/**
 * Why a push can't be matched to the approval, or null: it must run inside the worktree, on its own (only output
 * commands and other ship steps beside it), without naming another folder, to a named remote, sending HEAD or the
 * checked-out branch.
 * @param {Env} env @param {ReturnType<typeof partsOf>} parts
 * @returns {string | null}
 */
function pushProblem(env, parts) {
  const { call, me } = env;
  if (!insideReal(me.dir, call.cwd)) return `this push would run in ${call.cwd}, outside ${me.dir}.`;
  const extra = parts.find((p) => !p.actions.length && !OUTPUT_ONLY.test(p.raw));
  if (extra) return `this push is chained with \`${extra.raw.slice(0, 80)}\`, which can change what goes out. Run the push on its own.`;
  const pushes = parts.filter((p) => p.actions.includes('push'));
  if (pushes.length !== 1) return 'this runs more than one push. Run one push on its own.';
  const p = pushes[0];
  if (/(^|\s)(-C|--git-dir|--work-tree)\b/.test(gitGlobalOptions(p.raw))) return 'this push names another folder or repo. Run it from the worktree without -C.';
  // git -c remote.origin.pushurl=…, url.….insteadOf, push.pushOption: config on the command line can send the push
  // elsewhere or ask the server for more.
  if (/(^|\s)(-c|--config-env)(\s|=|$)/.test(gitGlobalOptions(p.raw))) return 'this push sets git config on the command line (-c or --config-env), which can change where it goes or what it asks the server. Run a plain git push.';
  const w = words(p.norm);
  const at = w.findIndex((t, j) => /(^|\/)git$/.test(t) && w[j + 1] === 'push');
  if (at < 0) return "this push can't be read.";
  /** @type {string[]} */
  const args = [];
  for (let j = at + 2; j < w.length; j++) {
    const t = w[j];
    if (/^(\d*(>>?|<)|&>>?)$/.test(t)) {
      j++;
      continue;
    }
    if (/^(\d*(>>?|<)|&>>?)\S/.test(t)) continue;
    if (t.startsWith('-')) {
      const flag = t.split('=')[0];
      if (PUSH_FLAGS.has(t)) continue;
      // A push option asks the server for more than the push (GitLab merge_request.merge_when_pipeline_succeeds can
      // merge), so neither free mode nor a card approval covers it.
      if (PUSH_OPTION_FLAGS.has(flag) || /^-o./.test(t)) return `this push sends a push option (${t.slice(0, 80)}), which can ask the server to merge or more. Push without -o/--push-option.`;
      return `this push uses ${t}, which the policy can't match to an approval.`;
    }
    args.push(t);
  }
  const [remote, ...refspecs] = args;
  if (remote !== undefined && !/^[\w.-]+$/.test(remote)) return `this push goes to ${remote.slice(0, 80)}, not a named remote.`;
  const branch = refspecs.length ? branchOf(me.dir, GIT_BUDGET_MS) : null;
  for (const r of refspecs) {
    const src = r.split(':')[0];
    if (src === 'HEAD' || (branch && (src === branch || src === `refs/heads/${branch}`))) continue;
    return `this push sends ${src || r}, not HEAD or the checked-out branch${branch ? ` (${branch})` : ''}.`;
  }
  // Last, as it runs git: push options set in git config ride along on a plain push, just as -o does.
  const opts = configPushOptions(call.cwd);
  if (opts === null) return "git's push options (push.pushOption) can't be read here, so this push can't be checked.";
  if (opts) return `git config sets a push option (push.pushOption ${opts.split('\n')[0].slice(0, 80)}), which rides along on every push and can ask the server to merge or more. Crew sessions can't change it: tell the Mate, who asks ${env.owner} to remove it.`;
  return null;
}

/**
 * The push options git config sets for a folder (push.pushOption, from any config file), '' when none, or null when git
 * can't tell in time.
 * @param {string} dir
 * @returns {string | null}
 */
function configPushOptions(dir) {
  // With the caller's GIT_DIR and friends removed, as grants.mjs reads HEAD, so the environment can't point git elsewhere.
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  const r = spawnSync('git', ['-C', dir, 'config', '--get-all', 'push.pushOption'], { encoding: 'utf8', timeout: GIT_BUDGET_MS, env, stdio: ['ignore', 'pipe', 'ignore'] });
  // Exit 1: the key isn't set. An empty value clears the list set before it.
  if (r.status === 1 && !String(r.stdout ?? '').trim()) return '';
  if (r.status !== 0) return null;
  const lines = String(r.stdout ?? '').replace(/\n$/, '').split('\n');
  return lines.slice(lines.lastIndexOf('') + 1).join('\n').trim();
}

/**
 * The git config parts of a normalized command, each as git reads its words: quotes around text without spaces and
 * backslash escapes taken out, so `remote.origin."url"`, `'push.pushOption'` and `push.push\Option` read as the key
 * git sets. Quoted text with spaces (a message) stays as it is, and only parts that run `git config` change, so text in
 * another command's arguments never trips a rule. Only parts that differ are returned; each pass is linear.
 * @param {string} norm
 * @returns {string[]}
 */
function gitConfigWords(norm) {
  const out = [];
  for (const p of splitCommand(norm)) {
    // $'…' decodes \xHH, \uHHHH and octal escapes as bash and zsh do; the leftover backslashes go after the quotes.
    const q = p
      .replace(/\$'([^\s']*)'/g, (_, t) => t.replace(/\\(?:x([0-9a-f]{1,2})|u([0-9a-f]{1,4})|([0-7]{1,3}))/gi, (_m, x, u, o) => String.fromCharCode(parseInt(x ?? u ?? o, x || u ? 16 : 8))))
      .replace(/\$?(['"])([^\s'"]*)\1/g, '$2')
      .replace(/\\(\S)/g, '$1');
    if (q !== p && /\bgit['"]?\s+['"]?config['"]?(?=\s|$)/i.test(q)) out.push(q);
  }
  return out;
}

/** A shell command from a crew member. @param {Env} env @param {string} cmd @returns {Verdict} */
function shellVerdict(env, cmd) {
  const { call, rules, me, owner } = env;
  // The rules that read the command's text read it without the text it only carries (a message, a heredoc).
  const view = commandText(cmd);
  const norm = normalizeCommand(view);
  const { opaque, unreadable, expanded } = shellTargets(cmd, call.cwd);
  // Not counted: a brace expansion in a program word is read roughly, and one past 256 words isn't expanded.
  if (opaque) return deny("Crew policy: this command's program can't be read plainly, so it can't be checked.", false);
  if (unreadable) return deny("Crew policy: this command can't be read plainly, so it can't be checked.", false);
  // Brace expansions in arguments are judged as the shell expands them too.
  // git config keys are judged unquoted too, as git reads them.
  const keys = gitConfigWords(norm);
  for (const r of rules.policy.denyBash) if (r.re.test(view) || r.re.test(norm) || expanded.some((e) => r.re.test(e)) || keys.some((k) => r.re.test(k))) return deny(`Crew policy: ${r.why}.`);
  if (writesCrewFiles(cmd, rules, call.cwd)) return deny('Crew policy: approvals, crew membership, settings and memory are changed only by the launch card and the keelctl command, never by hand.');
  const fedNorm = runsText(norm);
  for (const part of splitCommand(norm)) {
    const odd = runsGit(part, fedNorm) ? gitCommandsIn(part, fedNorm).find((c) => !GIT_COMMANDS.has(c)) : undefined;
    if (odd) return deny(`Crew policy: \`git ${odd.slice(0, 40)}\` isn't one of git's own commands, and an alias can hide a push. Spell out the git command.`, false);
  }
  // What other programs write there: git's own commands change .git themselves.
  // A git part counts only for its redirects; a glob counts when a segment could be .git; a stale .lock file may go.
  const byHand = splitCommand(cmd).map((p) => (/^[\s(]*([A-Za-z_]\w*=\S*\s+)*(\S*\/)?git(\s|$)/.test(p) ? `: ${(p.match(/\d*>>?\s*[^\s;&|]+/g) ?? []).join(' ')}` : p)).join(' ; ');
  const inGit = (/** @type {string} */ p) => rules.policy.gitInternals.test(p) && !/\.lock$/.test(p);
  if (shellTargets(byHand, call.cwd).targets.some((t) => t.write && ([t.path, realOf(t.path)].some(inGit) || (t.glob && !/\.lock$/.test(t.path) && t.path.split('/').some((seg) => globMatches(seg, ['.git'])))))) {
    return deny("Crew policy: git's own files (.git) change only through git commands.");
  }
  const grants = grantCliVerdict(cmd, call.cwd, rules);
  if (grants) return grants;
  const registers = registerVerdict(env, view) ?? rekeyVerdict(env, view);
  if (registers) return registers;
  // Both readings: quotes folded inside a word (`sp""end`), and as written (git's -c alias options kept).
  const leadOnly = leadOnlyCliVerdict(view, me.role) ?? leadOnlyCliVerdict(norm, me.role);
  if (leadOnly) return leadOnly;
  // Not counted: a command line is read roughly, so a wrong guess never pauses the session.
  if (me.role !== 'lead' && ([view, norm, ...expanded].some((e) => CLAUDE_START.test(e)) || (NAMES_CLAUDE.test(norm) && splitCommand(norm).some((p) => VAR_PROGRAM.test(p))))) return deny(CLAUDE_STARTS, false);
  // Single-quoted text never expands a variable (an awk program's `($1==…`), so it's blanked before the check.
  if (NAMES_SHIPPERS.test(norm) && splitCommand(norm.replace(/'[^']*'/g, "''")).some((p) => VAR_ONLY_PROGRAM.test(p))) return deny(VAR_SHIPPER, false);
  // A read-only role changes nothing from the shell either: no file outside its scratch folder, no interpreter code or
  // script (which can't be checked), and no git command that changes a repo.
  if (env.profile === 'reader') {
    const { targets, code, runs } = shellTargets(cmd, call.cwd);
    const writes = targets.filter((t) => t.write && !/^\/dev\/(null|stdout|stderr)$/.test(t.path) && !isClaudeMemory(t.path) && !isOwnScratch(t.path, env));
    const fed = runsText(norm);
    const jq = code.length || runs.length ? " interpreter code can't be checked, so filter JSON with jq or read it as is;" : '';
    const gitWrites = (/** @type {string} */ p) => runsGit(p, fed) && (GIT_CHANGES.test(p) || gitCommandsIn(p, fed).some((c) => !READER_GIT.has(c)));
    if (writes.length || code.length || runs.length || splitCommand(norm).some((p) => gitWrites(p) || READER_WRITES.some((r) => r.test(p.replace(/["'\\]/g, ''))))) return deny(`Crew policy: the ${me.agent ?? me.role} role only reads;${jq} write notes to your scratch folder, and put changes in a proposal card for ${owner}.`, false);
  }
  // A push goes to any named remote, so a new or repointed remote would send it elsewhere (after the read-only check, so a
  // reader hears why it only reads).
  if ([view, norm, ...expanded].some((e) => GIT_REMOTE_WRITE.test(e))) return deny('Crew policy: adding or repointing a git remote is never allowed; push to origin.');
  // Engineers and agents write files only in their own folder from the shell too (temp folders and scratch aside).
  if (env.worksInDir) {
    const away = shellTargets(cmd, call.cwd).targets.find((t) => t.sure && !t.unknown && !isTemp(t.path, rules) && !insideReal(me.dir, t.path) && !isClaudeMemory(t.path) && !isOwnScratch(t.path, env));
    // Not counted: a command line is read roughly, so a wrong guess never pauses the session.
    if (away) return deny(`Crew policy: ${me.role === 'agent' ? 'agents edit only inside their folder' : 'engineers edit only inside their worktree'} (${me.dir}), from the shell too; ${away.path} is outside it. Don't work around it: tell the Mate what you need.`, false);
  }
  const ledgerCli = ledgerCliVerdict(view, me.role);
  if (ledgerCli) return ledgerCli;
  if (me.role !== 'lead' && ownerLesson(view)) {
    return deny("Crew policy: only the Mate records what the captain said directly. Add the lesson with the source you saw (chat, card, pr-review, edit or commit); the Mate promotes it once the captain approves.");
  }
  if ([view, ...expanded].some((e) => pushesProtected(e, rules.policy.protectedBranches))) return deny('Crew policy: pushing to a protected branch is never allowed.');
  const parts = partsOf(view, rules);
  const actions = [...new Set(parts.flatMap((p) => p.actions))];
  const writes = parts.filter((p) => p.github || p.actions.length);
  // A post the captain approved on the board covers one GitHub write or PR comment, never a push, a new PR or a second write.
  if (writes.length === 1 && actions.every((a) => a === 'pr-update') && usePost(env, 'Bash')) {
    return allow(`${owner} approved this post on the board (one use).`);
  }
  const reply = ownPrReply(env, parts);
  if (reply) return allow(reply);
  // Before the ship check, so an approved push can't carry a GitHub write along with it.
  if (parts.some((p) => p.github)) return gate('post', `Crew policy: ${rules.policy.githubWrite.why}.`);
  if (!actions.length) return none();
  const shipping = actions.filter((a) => a !== 'pr-update');
  if (shipping.length && !memberCanShip(me)) {
    return deny(`Crew policy: the ${me.agent ?? me.role} agent never pushes code or opens pull requests. Hand the change to the Mate: send_message to ${env.leadHost ?? "the Mate's session"} with what should ship, and end your turn.`);
  }
  // An agent's PR edit has no launch card to wait for: it goes out as a post the captain approves on its draft card.
  if (!memberCanShip(me)) return gate('post', `Crew policy: a PR edit from the ${me.agent ?? me.role} agent needs ${owner}'s approval of its draft card first.`);
  const free = freeShip(env, parts, actions);
  if (free) return free;
  const g = readGrant(me.dir, me.key);
  if (!g) return gate('ship', `${owner} hasn't approved shipping ${me.key ?? 'this'} on the launch card.`);
  if (!actions.every((a) => rules.ship.allows[g.choice]?.includes(a))) return gate('ship', `${owner} chose "${g.choice}" on the launch card, which doesn't cover this.`);
  if (actions.includes('push')) {
    const why = pushProblem(env, parts);
    if (why) return gate('ship', `Crew policy: ${why}`);
  }
  // The card approves the ship step, not what rides along with it: the shape checks free mode makes (plain git push and
  // gh pr steps only, this ticket's own repo and PR, a body file from the worktree that isn't a secret).
  // A quoted heredoc's body is the PR's text, not commands: it is checked without it.
  const command = String(call.ti.command ?? '').replace(QUOTED_HEREDOC_BODY, '$1');
  const shape = shipsFreely({ ...env, call: { ...call, ti: { ...call.ti, command } } }, partsOf(command, rules), true);
  if (shape?.decision === 'deny') return shape;
  if (shape?.decision !== 'allow') return gate('ship', "Crew policy: an approved ship step goes out on its own: plain git push and gh pr commands on this ticket's own PR, nothing chained to them, a body file only from this worktree.");
  if (g.head) {
    const head = headOf(me.dir, GIT_BUDGET_MS);
    if (!head) return gate('ship', `Crew policy: can't read this worktree's commit to check it against the one ${owner} approved (${short(g.head)}).`);
    if (head !== g.head) {
      return gate('ship', `Crew policy: the code changed after ${owner} approved commit ${short(g.head)} (now ${short(head)}).`, 'Show a new launch card, or approve only if you meant to.');
    }
  }
  return allow(`${owner} approved this on the launch card (${g.choice}).`);
}

/**
 * One command, plus output filters, with nothing that could carry a second action: no command substitution, variables,
 * redirection to a file, chaining or variable prefix. The free paths below wave through only such commands, so an
 * explicit allow can't cover anything the captain didn't mean. Quoted text with these characters fails too (it then needs
 * the card).
 * @param {unknown} cmd
 * @param {RegExp} [program] what the first word must be (bare gh or git by default: `./gh` could be any script)
 * @returns {string[] | null} the command's words, or null when it isn't plain
 */
function plainWords(cmd, program = /^(gh|git)$/) {
  const s = String(cmd ?? '').replace(/(^|\s)2>&1(?=\s|$)/g, ' ').trim();
  // Text in single quotes, or double quotes without $, a backtick or a backslash, is only text whatever it says.
  const bare = s.replace(/'[^']*'|"[^"$`\\]*"/g, (q) => '_'.repeat(q.length));
  if (!s || /[;&<>`$\n\r\\]/.test(bare) || BRACES.test(bare) || /^[A-Za-z_]\w*=/.test(s)) return null;
  const pipes = [...bare.matchAll(/\|/g)].map((m) => m.index ?? 0);
  const [first, ...filters] = [-1, ...pipes].map((at, k) => s.slice(at + 1, pipes[k] ?? s.length));
  if (!filters.every((f) => /^\s*(tail|head|grep|wc)(\s+[-\w.:'"]+)*\s*$/.test(f))) return null;
  const w = words(first.trim());
  return w.length && program.test(w[0]) ? w : null;
}

/** A flag and its value from `--flag=value`, `--flag value` or `-f value`; advances past the value. @param {string[]} w @param {number} i */
function flagAt(w, i) {
  const t = w[i];
  const eq = t.startsWith('--') ? t.indexOf('=') : -1;
  return eq > 0 ? { flag: t.slice(0, eq), value: t.slice(eq + 1), next: i + 1, inline: true } : { flag: t, value: w[i + 1], next: i + 2, inline: false };
}

/**
 * Whether the words are a draft PR and nothing more: `gh pr create` with `--draft` (or `-d`), and only `--title`,
 * `--body`, `--fill`, a `--body-file` the caller accepts (one in the worktree) and a `--base` equal to the repo's base
 * branch. No other repo, head, file or host.
 * @param {string[]} w @param {string | null} base @param {(path: string) => boolean} bodyFileOk
 */
function isPlainDraftPr(w, base, bodyFileOk) {
  if (!/(^|\/)gh$/.test(w[0]) || w[1] !== 'pr' || !['create', 'new'].includes(w[2])) return false;
  let draft = false;
  for (let i = 3; i < w.length; ) {
    const f = flagAt(w, i);
    if (f.flag === '--draft' || f.flag === '-d' || f.flag === '--fill' || f.flag === '--fill-first') {
      if (f.inline) return false;
      if (f.flag === '--draft' || f.flag === '-d') draft = true;
      i += 1;
    } else if (['--title', '-t', '--body', '-b'].includes(f.flag) && f.value !== undefined) i = f.next;
    else if (['--body-file', '-F'].includes(f.flag) && f.value !== undefined && bodyFileOk(f.value)) i = f.next;
    else if (['--base', '-B'].includes(f.flag) && f.value !== undefined && base && f.value === base) i = f.next;
    else return false;
  }
  return draft;
}

/**
 * Whether the words are a reply on the engineer's own PR and nothing more: `gh pr comment [<its number or URL>]` with
 * only `--body`, or `gh api` POSTing only a `body` field to that PR's comments or to a reply in one of its review threads.
 * @param {string[]} w @param {RegExpExecArray | null} pr the ticket's PR URL, split into owner, repo and number
 */
function isOwnPrReply(w, pr) {
  if (!/(^|\/)gh$/.test(w[0])) return false;
  if (w[1] === 'pr' && w[2] === 'comment') {
    let body = false;
    let target = null;
    for (let i = 3; i < w.length; ) {
      const f = flagAt(w, i);
      if (['--body', '-b'].includes(f.flag) && f.value !== undefined) {
        body = true;
        i = f.next;
      } else if (!f.flag.startsWith('-') && target === null) {
        target = f.flag;
        i += 1;
      } else return false;
    }
    return body && (target === null || (!!pr && (target === pr[3] || target === pr[0])));
  }
  if (w[1] !== 'api' || !pr || !w[2]) return false;
  const path = w[2].replace(/^\//, '');
  const own = [`repos/${pr[1]}/${pr[2]}/issues/${pr[3]}/comments`];
  const thread = new RegExp(`^repos/${pr[1].replace(/\./g, '\\.')}/${pr[2].replace(/\./g, '\\.')}/pulls/${pr[3]}/comments/\\d+/replies$`);
  if (!own.includes(path) && !thread.test(path)) return false;
  let bodies = 0;
  for (let i = 3; i < w.length; ) {
    const f = flagAt(w, i);
    if (['-X', '--method'].includes(f.flag) && String(f.value).toUpperCase() === 'POST') i = f.next;
    else if (['-f', '--raw-field'].includes(f.flag) && typeof f.value === 'string' && f.value.startsWith('body=')) {
      bodies++;
      i = f.next;
    } else return false;
  }
  return bodies === 1;
}

/** Per gh pr subcommand, the flags a free ship step may use: those that take a value, and those that don't. */
const PR_FLAGS = /** @type {Record<string, { value: string[], bool: string[] }>} */ ({
  create: {
    value: ['-t', '--title', '-b', '--body', '-F', '--body-file', '-B', '--base', '-l', '--label', '-a', '--assignee', '-r', '--reviewer', '-m', '--milestone', '-p', '--project', '-T', '--template'],
    bool: ['-d', '--draft', '-f', '--fill', '--fill-first', '--fill-verbose', '--no-maintainer-edit', '--dry-run'],
  },
  edit: {
    value: ['-t', '--title', '-b', '--body', '-F', '--body-file', '-B', '--base', '-m', '--milestone', '--add-label', '--remove-label', '--add-reviewer', '--remove-reviewer', '--add-assignee', '--remove-assignee', '--add-project', '--remove-project'],
    bool: [],
  },
  comment: { value: ['-b', '--body', '-F', '--body-file'], bool: [] },
  ready: { value: [], bool: ['--undo'] },
  review: { value: ['-b', '--body', '-F', '--body-file'], bool: ['-a', '--approve', '-c', '--comment', '-r', '--request-changes'] },
  close: { value: ['-c', '--comment'], bool: [] },
  reopen: { value: ['-c', '--comment'], bool: [] },
});
/** gh pr flags whose value is a file gh reads and posts. */
const PR_FILE_FLAGS = new Set(['-F', '--body-file', '-T', '--template']);

/** A quoted heredoc (`<<'EOF'`) and its body; group 1 is the line that opens it. */
const QUOTED_HEREDOC_BODY = /(<<-?[ \t]*(['"])(\w+)\2[^\n]*)\n(?:[\s\S]*?\n)?[ \t]*\3[ \t]*(?=\n|$)/g;

/** `tail` or `head` with at most a line count: it reads only what is piped in, so it can sit beside a ship step. */
const COUNT_FILTER = /^\s*(tail|head)(\s+(-\d+|-n\s*\d+))?\s*$/;

/**
 * Free ship mode: an engineer's pushes from its worktree (the worktree's pre-push check holds them to its own branch and
 * commit), PRs on its repo and changes to its own PR go out without the launch card, at any risk. Each step is plain words:
 * no `$(…)`, backticks, variables or escapes anywhere in the command (refused, with the way to run it), bare git or gh
 * first, and for gh pr only the flags PR_FLAGS lists, a body or template file in the worktree, its scratch or a temp
 * folder that is no secret, and no PR but the ticket's own. Allowed only when every part of the command is such a step;
 * chained with anything else, Claude Code's own checks decide (the crew's hard rules have already passed). Null when a
 * step doesn't fit, which waits for the card.
 * @param {Env} env @param {ReturnType<typeof partsOf>} parts @param {boolean} [countFilters] whether a `tail -3` beside a step
 * counts as part of it (on the launch card's path; free mode leaves such a command to Claude Code)
 * @returns {Verdict | null}
 */
function shipsFreely(env, parts, countFilters = false) {
  const { me, call, rules } = env;
  const cmd = String(call.ti.command ?? '');
  // A heredoc body is only text when its tag is quoted; unquoted (or a here-string), the shell expands it. A backslash
  // or $'…' makes a word the shell reads differently from its text (aut\opr), and a brace expansion one word several
  // (-c {x,-d}), so the rules can't read it.
  if (lex(cmd).some((seg) => seg.some((x) => !x.heredoc && (x.subs?.length || x.vars || x.braces))) || /[<>]\(|<<<|<<-?\s*[^\s'"]|\\|\$'/.test(cmd)) {
    return deny("Crew policy: a push or PR step goes out on its own only as plain words: no $(…), backticks, variables, braces like {a,b}, backslashes, $'…' or unquoted heredoc tags in the command. Write the values out, quote the tag (<<'EOF'), or put long text in a file and pass it with --body-file.", false);
  }
  const pr = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/.exec(prUrlOf(me.key ?? null));
  const ownPr = (/** @type {string} */ t) => !!pr && (t === pr[0] || t.replace(/^#/, '') === pr[3]);
  const fileOk = (/** @type {string} */ p) => {
    const abs = absPath(call.cwd, p);
    const where = insideReal(me.dir, abs) || isOwnScratch(abs, env) || isTemp(abs, rules);
    return where && [abs, realOf(abs)].every((x) => !rules.policy.secretPath.test(x) && !ENV_DIR.test(x));
  };
  let alone = true;
  for (const p of parts) {
    const w = words(p.norm).filter((t, i, all) => !/^(\d*(>>?|<)|&>>?)/.test(t) && !/^(\d*(>>?|<)|&>>?)$/.test(all[i - 1] ?? '') && !/^<<-?/.test(t) && !/^<<-?$/.test(all[i - 1] ?? ''));
    if (!p.actions.length) {
      if (!countFilters || !COUNT_FILTER.test(p.raw)) alone = false;
      continue;
    }
    // A variable in front (GH_REPO, GIT_DIR), a wrapper or a path (./gh could be any script) could run something else.
    if (w[0] !== 'git' && w[0] !== 'gh') return null;
    if (p.actions.includes('push')) {
      if (/(^|\s)(-C|--git-dir|--work-tree)\b/.test(gitGlobalOptions(p.raw)) || pushProblem(env, [p])) return null;
      continue;
    }
    if (w[1] !== 'pr') return null;
    const sub = w[2] === 'new' ? 'create' : w[2];
    const spec = PR_FLAGS[sub];
    if (!spec || !Object.hasOwn(PR_FLAGS, sub)) return null;
    /** @type {string[]} */
    const picks = [];
    for (let i = 3; i < w.length; i++) {
      const t = w[i];
      if (!t.startsWith('-') || t === '-') {
        picks.push(t);
        continue;
      }
      const long = t.startsWith('--');
      const eq = t.indexOf('=');
      const flag = long ? (eq > 0 ? t.slice(0, eq) : t) : t.slice(0, 2);
      let value = long ? (eq > 0 ? t.slice(eq + 1) : undefined) : t.length > 2 ? t.slice(2).replace(/^=/, '') : undefined;
      if (spec.bool.includes(flag)) {
        if (value !== undefined) return null;
        continue;
      }
      if (!spec.value.includes(flag)) return null;
      if (value === undefined) value = w[++i];
      // `-` (or /dev/stdin) reads stdin: its one source is a quoted heredoc or a file that passes as a body file would.
      const stdinOk = () => {
        const ins = [...p.raw.matchAll(/(<<<|<<-?|(?<![<>&\d])0?<(?![<>&]))[ \t]*(['"]?)([^\s<>&|;'"]*)\2/g)];
        if (ins.length > 1) return false;
        const [, op, quote, target] = ins[0] ?? [];
        return !op || (op === '<<<' ? false : op.startsWith('<<') ? !!quote : fileOk(target));
      };
      // Any other descriptor (/dev/fd/3 with a `3<`) is a redirect it can't follow.
      const fileBad = (/** @type {string} */ v) => (/^(-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/.test(v) ? !stdinOk() : /^\/(dev\/fd|proc)\//.test(v) || !fileOk(v));
      if (value === undefined || (PR_FILE_FLAGS.has(flag) && fileBad(value))) return null;
    }
    // A PR picked by an argument: only this ticket's, by number, URL or the checked-out branch. A new PR takes none.
    if (sub === 'create' ? picks.length : picks.length > 1 || (picks.length === 1 && !ownPr(picks[0]) && picks[0] !== branchOf(me.dir, GIT_BUDGET_MS))) return null;
  }
  return alone ? allow('Crew policy: engineers push their branch and open or update their own PR freely.') : none();
}

/**
 * Why an engineer's ship step needs no launch card, or null when it does. In free ship mode (config shipMode, else the
 * rules' default) that is shipsFreely. With the card: only a plain command (plainWords) from inside its worktree
 * qualifies: pushing its own branch, whatever its PR or risk; and, while the diff is low or medium risk, a draft PR
 * (isPlainDraftPr). A non-draft PR, `gh pr ready` or `edit` and every high-risk PR still wait for the card. The
 * worktree's pre-push check holds pushes to its own branch.
 * @param {Env} env @param {ReturnType<typeof partsOf>} parts @param {string[]} actions
 * @returns {Verdict | null}
 */
function freeShip(env, parts, actions) {
  const { me, call, config } = env;
  if (me.role !== 'engineer' || !insideReal(me.dir, call.cwd)) return null;
  if ((config.shipMode ?? env.rules.ship.defaultMode) === 'free') return shipsFreely(env, parts);
  const w = plainWords(call.ti.command);
  if (!w || parts.filter((p) => p.actions.length || p.github).length !== 1) return null;
  const key = me.key ?? null;
  if (actions.length === 1 && actions[0] === 'push') return pushProblem(env, parts) ? null : allow('Crew policy: engineers push their own branch freely.');
  if (!(actions.length === 1 && actions[0] === 'pr-draft' && !hasPr(key))) return null;
  const deadline = Date.now() + RISK_BUDGET_MS;
  // A body file goes out as the PR's text, so only one in this worktree (by real path) that isn't a secret, as written or
  // where a link leads, nor anything in a .env folder.
  const bodyFileOk = (/** @type {string} */ p) => {
    const abs = absPath(call.cwd, p);
    return p !== '-' && insideReal(me.dir, abs) && [abs, realOf(abs)].every((x) => !env.rules.policy.secretPath.test(x) && !ENV_DIR.test(x));
  };
  if (!isPlainDraftPr(w, baseBranchOf(me.dir, config.pack, deadline), bodyFileOk)) return null;
  const tier = tierOf(assessRisk(me.dir, null, { packName: config.pack, budgetMs: Math.max(500, deadline - Date.now()) }));
  const freeTiers = isContractor(me) ? CONTRACTOR_DRAFT_FREE_TIERS : DRAFT_FREE_TIERS;
  return tier && freeTiers.has(tier) ? allow(`Crew policy: a ${tier}-risk change goes out as a draft PR without the launch card.`) : null;
}

/**
 * Why a GitHub comment is an engineer's plain reply on its own PR (isOwnPrReply), or null.
 * @param {Env} env @param {ReturnType<typeof partsOf>} parts
 * @returns {string | null}
 */
function ownPrReply(env, parts) {
  const { me, call } = env;
  if (me.role !== 'engineer' || !insideReal(me.dir, call.cwd)) return null;
  const w = plainWords(call.ti.command);
  if (!w || parts.filter((p) => p.actions.length || p.github).length !== 1) return null;
  const pr = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/.exec(prUrlOf(me.key ?? null));
  return isOwnPrReply(w, pr) ? 'Crew policy: engineers reply on their own PR freely.' : null;
}

/** Uses up the captain's one-shot approval for this exact post, if there is one. @param {Env} env @param {string} name */
function usePost(env, name) {
  if (env.dryRun) return null;
  try {
    return consumePostGrant(name, env.call.ti, { key: env.me.key ?? null, lockTimeoutMs: LOCK_BUDGET_MS });
  } catch {
    return null;
  }
}

/** A file tool from a crew member. @param {Env} env @returns {Verdict} */
function fileVerdict(env) {
  const { call, rules, me } = env;
  const p = call.ti.file_path ?? call.ti.notebook_path;
  if (typeof p !== 'string' || !p) return gate('other', "Crew policy: this call doesn't name its file plainly, so it can't be checked.");
  const abs = absPath(call.cwd, p);
  // Also where a link leads, so a link to .env is the secret it points to.
  if (rules.policy.secretPath.test(p) || rules.policy.secretPath.test(realOf(abs))) return deny('Crew policy: secret files are off limits.');
  if (call.tool === 'Read') return none();
  if (rules.policy.gitInternals.test(abs)) return deny("Crew policy: git's own files (.git) change only through git commands.");
  if (env.profile === 'reader' && !isClaudeMemory(abs) && !isOwnScratch(abs, env)) {
    return deny(`Crew policy: the ${me.agent ?? me.role} role only reads; it writes nothing but its own scratch notes.`);
  }
  // Temp folders as from the shell.
  if (env.worksInDir && !insideReal(me.dir, abs) && !isClaudeMemory(abs) && !isOwnScratch(abs, env) && !isTemp(abs, rules)) {
    return deny(`Crew policy: ${me.role === 'agent' ? 'agents edit only inside their folder' : 'engineers edit only inside their worktree'} (${me.dir}).`);
  }
  return none();
}

/** Tools that only read, search or carry text: a crew file they name, in a path or a prompt, is one they don't change. */
const TEXT_TOOLS = new Set(['Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'TodoRead', 'Agent', 'Task', 'Skill', 'SendMessage', 'ToolSearch', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'ReportFindings', 'SubagentHandback', 'StructuredOutput', 'PushNotification', 'ExitPlanMode', 'EnterPlanMode', 'NotebookRead', 'LSP']);

/**
 * The part of a call that could change a crew file: a file tool's path, a command as it runs (commandText), the files an
 * Artifact publishes or a board read saves, nothing for a message to another session or a tool that only reads or
 * carries text, and the whole input for anything else. Text that only mentions a crew file (notes, a brief, a message)
 * changes nothing. @param {Call} call
 */
function crewTarget(call) {
  const ti = call.ti ?? {};
  if (FILE_TOOLS.has(call.tool)) return String(ti.file_path ?? ti.notebook_path ?? '');
  if (runsCommand(call) && typeof ti.command === 'string') return commandText(ti.command);
  if (call.tool === SEND_MESSAGE || TEXT_TOOLS.has(call.tool)) return '';
  if (call.tool === 'ArtifactData') return JSON.stringify([ti.out_dir, ti.file_path, ...(Array.isArray(ti.writes) ? ti.writes.map((/** @type {any} */ w) => w?.file_path) : [])]);
  if (call.tool === 'Artifact') return JSON.stringify([ti.file_path, ti.file_paths, ti.out_dir, ti.root, ti.files]);
  return JSON.stringify(ti);
}

/**
 * What a call may write: a file tool's path (Read writes nothing), or what a shell command names (core/shellpaths.mjs),
 * each resolved where it really lands. @param {Call} call @returns {{ targets: import('./shellpaths.mjs').Target[], code: string[] }}
 */
function callTargets(call) {
  if (call.tool === 'Read') return { targets: [], code: [] };
  if (FILE_TOOLS.has(call.tool)) {
    const p = call.ti.file_path ?? call.ti.notebook_path;
    return { targets: typeof p === 'string' ? [{ path: absPath(call.cwd, p), write: true, glob: false, copier: false }] : [], code: [] };
  }
  // The Artifact tools save files under `out_dir` (Artifact also at `out_dir/<path>`): a folder they write into.
  if ((call.tool === 'Artifact' || call.tool === 'ArtifactData') && typeof call.ti.out_dir === 'string') {
    const dir = absPath(call.cwd, call.ti.out_dir);
    const saved = typeof call.ti.path === 'string' ? [{ path: resolve(dir, call.ti.path), write: true, glob: false, copier: false }] : [];
    return { targets: [{ path: dir, write: true, glob: false, copier: true }, ...saved], code: [] };
  }
  if (!runsCommand(call) || typeof call.ti.command !== 'string') return { targets: [], code: [] };
  return shellTargets(call.ti.command, call.cwd);
}

/** The settings files a glob could reach, under the literal folder before its first wildcard. @param {string} glob */
function settingsCandidates(glob) {
  const segs = glob.split('/');
  const first = segs.findIndex((s) => /[*?[{]/.test(s));
  const prefix = segs.slice(0, first).join('/');
  const depth = segs.length - first;
  const under = depth <= 1 ? '' : `${'x/'.repeat(Math.max(0, depth - 2))}.claude/`;
  // Both the deeper shape and the folder itself, since `**` may match no folder at all.
  return ['settings.json', 'settings.local.json'].flatMap((f) => [`${prefix}/${under}${f}`, `${prefix}/${f}`]);
}

/**
 * Whether a path is the same file (by inode) as a settings file that decides every crew session's permissions: the
 * Mate folder's and the user's own. Catches a hard link made earlier. @param {string} p
 */
function sameFileAsProtected(p) {
  let st;
  try {
    st = statSync(p);
  } catch {
    return false;
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude');
  /** @type {string[]} */
  const files = [join(configDir, 'settings.json'), join(configDir, 'settings.local.json')];
  try {
    const lead = readConfig().leadDir;
    if (lead) files.push(join(expandHome(lead), '.claude', 'settings.json'), join(expandHome(lead), '.claude', 'settings.local.json'));
  } catch {
    /* no config: the user's own files still count */
  }
  return files.some((f) => {
    try {
      const o = statSync(f);
      return o.ino === st.ino && o.dev === st.dev;
    } catch {
      return false;
    }
  });
}

/** Whether a call may change a Claude Code settings file (also through a symlink, or under CLAUDE_CONFIG_DIR). @param {Call} call @param {Rules} rules */
function touchesClaudeSettings(call, rules) {
  const { targets, code } = callTargets(call);
  const configDir = process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR).toLowerCase() : null;
  const isSettings = (/** @type {string} */ p) => rules.policy.claudeSettings.test(p) || (!!configDir && [`${configDir}/settings.json`, `${configDir}/settings.local.json`].includes(p.toLowerCase()));
  const isClaudeDir = (/** @type {string} */ p) => /(^|\/)\.claude\/?$/i.test(p) || (!!configDir && p.toLowerCase() === configDir);
  const hit = (/** @type {import('./shellpaths.mjs').Target} */ t) => {
    if (t.unknown && /^settings(\.local)?\.json$/i.test(basename(t.path)) && (t.unknownParent || basename(dirname(t.path)).toLowerCase() === '.claude')) return true;
    if (!t.glob && sameFileAsProtected(t.path)) return true;
    if (t.glob) return globMatches(t.path, settingsCandidates(t.path).filter(isSettings));
    return [t.path, realOf(t.path)].some((p) => isSettings(p) || ((t.copier || t.replaces) && isClaudeDir(p)));
  };
  return targets.some((t) => t.write && hit(t)) || code.some((c) => codeWrites(c, /\.claude['"]?\s*[\\/,+]\s*['"]?[\\/]?settings(\.local)?\.json/i));
}

/**
 * Whether interpreter code writes a file the pattern names: one statement that both names it (or a variable holding it)
 * and writes. Reading the file and writing another one is fine. @param {string} code @param {RegExp} names
 */
function codeWrites(code, names) {
  const statements = code.split(/[;\n]/);
  const vars = statements.flatMap((s) => (/^\s*([A-Za-z_]\w*)\s*=\s*['"`]/.test(s) && names.test(s) ? [/^\s*([A-Za-z_]\w*)/.exec(s)?.[1] ?? ''] : []));
  const mentions = (/** @type {string} */ s) => names.test(s) || vars.some((v) => v && new RegExp(`\\b${v}\\b`).test(s));
  return statements.some((s) => mentions(s) && WRITES_IN_CODE.test(s));
}

/** Interpreter code that writes files: open(…, 'w'), write_text, writeFileSync, dump, rename, copy, unlink. Not `>` or `=>`, which are code. */
const WRITES_IN_CODE = /open\s*\([^)]*['"][wa+x]|write_text|write_bytes|writeFile|appendFile|\.write\(|json\.dump|\brename|copyfile|shutil\.(copy|move)|unlink|os\.remove|truncate|file_put_contents|fwrite|fopen\([^)]*['"][wa]|File\.write/;

/**
 * The folders that hold the crew's own code and hook configuration: this plugin and its siblings (the panel mod), and
 * Claude Code's plugins folder. A crew session that changed them could switch the crew policy off.
 */
function crewCodeRoots() {
  const roots = [realOf(dirname(PLUGIN_ROOT))];
  const configDir = process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude');
  roots.push(join(configDir, 'plugins'), realOf(join(configDir, 'plugins')));
  return roots.map((r) => r.toLowerCase());
}

/** Whether a call may change the crew's own code or hook configuration (crewCodeRoots). @param {Call} call */
function touchesCrewCode(call) {
  const roots = crewCodeRoots();
  const under = (/** @type {string} */ p) => roots.some((r) => p.toLowerCase() === r || p.toLowerCase().startsWith(`${r}/`));
  return callTargets(call).targets.some((t) => t.write && [t.path, realOf(t.path)].some(under));
}

/** Whether a call may change a brief or the Mate's notes, which new sessions follow as instructions. @param {Call} call */
function touchesLeadNotes(call) {
  const { targets, code } = callTargets(call);
  const notes = join(HOME, 'lead.md').toLowerCase();
  const briefs = paths.briefs().toLowerCase();
  const hit = (/** @type {import('./shellpaths.mjs').Target} */ t) => {
    if (t.unknown && ((basename(t.path).toLowerCase() === 'lead.md' && (t.unknownParent || basename(dirname(t.path)).toLowerCase() === '.keelcrew')) || /\/briefs\//i.test(t.path))) return true;
    if (t.glob) return globMatches(t.path, [join(HOME, 'lead.md'), join(paths.briefs(), /[*?[{]/.test(basename(t.path)) ? 'keel-x.md' : basename(t.path))]);
    return [t.path, realOf(t.path)].some((raw) => {
      const p = raw.toLowerCase();
      return p === notes || p.startsWith(`${briefs}/`) || (t.copier && p === briefs);
    });
  };
  const named = new RegExp(`${[notes, `${briefs}/`].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}|\\.keelcrew\\/(lead\\.md|briefs\\/)`, 'i');
  return targets.some((t) => t.write && hit(t)) || code.some((c) => codeWrites(c, named));
}

/**
 * A path in this session's own scratch folder (`/private/tmp/claude-<uid>/<project>/<session id>/…`), which it may write:
 * its session's, or (a resumed session gets a new id) any `…/<session id>/scratchpad` of its own project, named after its
 * folder. Another project's scratch isn't its own. @param {string} abs @param {Env} env
 */
function isOwnScratch(abs, env) {
  const { sessionId, cwd } = env.call;
  // Real path, as for the worktree: a symlink in the scratch folder that points elsewhere leads outside it.
  const parts = realOf(abs).replace(/^\/private\//, '/').split('/');
  if (parts[1] !== 'tmp' || parts[2] !== `claude-${process.getuid?.()}` || parts.includes('..') || !parts[4]) return false;
  const project = [cwd, env.me.dir].map((d) => d.replace(/[^A-Za-z0-9]/g, '-'));
  return (!!sessionId && parts[4] === sessionId) || (parts[5] === 'scratchpad' && project.includes(parts[3]));
}

/** A project's folder in Claude Code's own temp folder (`/tmp/claude-<uid>/-Users-…`): only a session's own scratch in it is its to write. */
const CLAUDE_TMP = /^\/(private\/)?tmp\/claude-\d+\/-/;

/** A temp path a crew member may write (rules policy.shellTempPaths, by real path), outside the projects' folders in Claude Code's temp folder. @param {string} p @param {Rules} rules */
function isTemp(p, rules) {
  // By real path, so a link in /tmp that points elsewhere doesn't count as temp.
  const real = realOf(p);
  return rules.policy.shellTempPaths.test(real) && !CLAUDE_TMP.test(real);
}

/** A session's own Claude Code memory file (`<config dir>/projects/<project>/memory/…`), which any session may keep. @param {string} abs */
function isClaudeMemory(abs) {
  const configDir = process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude');
  const rel = relative(join(configDir, 'projects'), abs);
  return !rel.startsWith('..') && !isAbsolute(rel) && rel.split('/')[1] === 'memory';
}

/** A connector, app or browser tool from a crew member. @param {Env} env @returns {Verdict} */
function mcpVerdict(env) {
  const { call, reg, rules, me, owner } = env;
  const tool = call.tool;
  // Crew sessions message each other freely; scheduled runs and Mate-started sessions have nobody to approve it.
  if (toCrew(call, reg)) return allow('Crew policy: crew sessions message each other.');
  // A crew session's Claude Code id (keelctl status, crew_state) isn't the app id send_message takes.
  const host = tool === SEND_MESSAGE ? reg.sessions[String(call.ti.session_id ?? call.ti.to ?? '')]?.hostId : undefined;
  if (host) return deny(`Crew policy: that is a crew session's Claude Code id; send_message takes its app id. Send it to ${host}.`, false);
  // Every crew member drives a browser freely on any web page.
  if (rules.policy.browserTools.test(tool)) {
    const why = browserCheck(rules, tool.slice(tool.lastIndexOf('__') + 2), call.ti);
    return why ? gate('other', `Crew policy: ${why}`, `Approve only if ${owner} asked for it.`) : none();
  }
  // An engineer must open in its worktree, and a proposal can't carry a folder: it opens in the Mate folder instead.
  if (tool === START_SESSION && me.role === 'lead' && call.ti.initiation === 'own_initiative' && ENGINEER_BRIEF.test(String(call.ti.name ?? ''))) {
    return deny('Crew policy: an engineer never starts as a proposal, which opens it in the Mate folder, not its worktree. Post the start card and end the turn with the Start <KEY> buttons (keel-lead skill, step 2).', false);
  }
  if (quietMcp(tool, me, rules)) return none();
  // The app asks every session to propose follow-ups with start_session; a proposal starts nothing.
  if (tool === START_SESSION) {
    if (call.ti.initiation === 'own_initiative' && !call.ti.proposal_id) return none();
    return deny(ONLY_LEAD_STARTS, false);
  }
  if (!call.tiOk) return gate('other', "Crew policy: this call's input isn't in the expected form, so it can't be checked.");
  // Outside connectors are free for every role but reader and drafts; Claude Code's auto mode and permissions judge them.
  // A CI build trigger (a deploy) still needs a person.
  if (env.profile !== 'reader' && env.profile !== 'drafts' && !rules.policy.untrustedTools.test(tool) && !rules.policy.deployTools.test(tool)) return none();
  // A read-only role posts nothing anywhere, even with a one-shot approval.
  // Not counted: a tool's name is read roughly, so a wrong guess never pauses the session.
  if (env.profile === 'reader') return deny(`Crew policy: the ${me.agent ?? me.role} role only reads; ${tool.split('__').pop()} would change something. Put it in a proposal card for ${owner} instead.`, false);
  // A drafts role prepares writes for the captain's approval: it never sends. It
  // writes freely only to the connector kinds its manifest lists in `drafts` (the designer's own Figma file).
  if (env.profile === 'drafts' && rules.policy.sendTools.test(tool)) return deny(`Crew policy: the ${me.agent ?? me.role} role prepares drafts; sending (${tool.split('__').pop()}) is ${owner}'s.`, false);
  if (env.profile === 'drafts' && !rules.policy.untrustedTools.test(tool) && !rules.policy.deployTools.test(tool) && draftsAllow(tool, (me.agent && agentById(me.agent)?.drafts) || [], rules, call.ti)) return none();
  if (usePost(env, tool)) return allow(`${owner} approved this post on the board (one use).`);
  const what = MAC_SERVERS.test(tool) ? `acts on this Mac (${owner}'s apps, sessions or settings)` : 'changes something outside this Mac';
  return gate('post', `Crew policy: ${tool.split('__').pop()} ${what}.`, `Approve only if ${owner} asked for it.`);
}

/**
 * A denial for a shell command that writes with `keelctl ledger`, or null for any other. A plain `keelctl ledger show <KEY>`,
 * `keelctl ledger list` or `keelctl ledger report` (with `--json`) runs; the Mate may also link a bug ticket (`link-bug`, where
 * code finds the ticket from git blame); any other recording or committing is the crew's own code's (hooks and the
 * panel). Judged per chained part, so a read piped into jq or a grep that names keelctl ledger isn't taken for a write.
 * @param {string} cmd @param {string} role
 * @returns {Verdict | null}
 */
function ledgerCliVerdict(cmd, role) {
  const fed = runsText(cmd);
  for (const part of splitCommand(normalizeCommand(cmd))) {
    const flat = part.replace(/["'\\]/g, '');
    if (!LEDGER_CLI.test(flat) && !XARGS_CREW.test(flat) && !(NAMES_CREW.test(flat) && /(^|\s)ledger(\s|$)/.test(flat) && /[$`]/.test(flat))) continue;
    const a = crewCall(part, fed);
    if (a === 'other' || (Array.isArray(a) && a[0] !== 'ledger')) continue;
    const { pos } = a ? parseArgs(a.slice(1)) : { pos: [] };
    const reads = !!a && ((pos.length === 1 && (pos[0] === 'list' || pos[0] === 'report')) || (pos.length === 2 && pos[0] === 'show' && /^[A-Za-z0-9._-]+$/.test(pos[1])));
    const linksBug = !!a && role === 'lead' && pos[0] === 'link-bug' && pos.length === 2;
    if (!reads && !linksBug) return deny('Crew policy: ticket records are written only by the crew\'s own code (its hooks and the panel). Read one with keelctl ledger show <KEY>.', false);
  }
  return null;
}

/**
 * A denial for a shell command that runs `keelctl grant`, from any crew session, the Mate's included: it carries out the
 * captain's answers from the board and only the Mate's panel runs it. Judged per chained part like the other crew
 * commands (a part that names crew without being a plain crew call counts when it says grant or computes its command),
 * and on the whole command when some part runs text it's given or crew runs from xargs. Whatever the program is called
 * (a variable, a link, a glob), a part whose words say `grant` and later `ship` or `post` counts too; quoted text stays
 * one word, so a commit message, a grep or an echo quoting "grant ship" doesn't. So does interpreter code (`node -e`,
 * `python -c`, a heredoc) that reaches the approval code (rules policy.grantCode). Null for any other command.
 * @param {string} cmd @param {string} cwd @param {Rules | null} rules @returns {Verdict | null}
 */
function grantCliVerdict(cmd, cwd, rules) {
  const why = "Crew policy: keelctl grant carries out the captain's own answers from the board; only the Mate's panel runs it. Ask the captain to answer the card.";
  const fed = runsText(cmd);
  const whole = cmd.replace(/["'\\]/g, '');
  if ((fed || XARGS_CREW.test(whole)) && /(^|\s)grant(\s|$)/.test(whole) && (NAMES_CREW.test(whole) || GRANT_WORDS.test(whole))) return deny(why, false);
  for (const seg of lex(cmd)) {
    const w = seg.filter((x) => !x.redirect && !x.input && !x.heredoc);
    const at = w.findIndex((x) => x.text === 'grant' || !!x.subs?.includes('grant'));
    if (at >= 0 && w.slice(at + 1).some((x) => GRANT_KIND.test(x.text))) return deny(why, false);
  }
  if (rules && shellTargets(cmd, cwd).code.some((c) => rules.policy.grantCode.test(c))) {
    return deny("Crew policy: interpreter code may not reach the crew's approval code (the helper's approve and approve_post, or the grant files); only the captain's answer on the board approves. Ask the captain to answer the card.", false);
  }
  for (const part of splitCommand(normalizeCommand(cmd))) {
    const flat = part.replace(/["'\\]/g, '');
    if (!GRANT_CLI.test(flat) && !/(^|[\s/])keelctl(\.mjs)?\s+[$`]/.test(flat) && !XARGS_CREW.test(flat)) continue;
    const a = crewCall(part, fed);
    if (a === 'other' || (Array.isArray(a) && a[0] !== 'grant')) continue;
    return deny(why, false);
  }
  return null;
}

/** A card's hand-off to the Mac, as a top-level key: `grantPending`, or a dotted path into it. */
const GRANT_PENDING_KEY = /^grantPending(\.|$)/;

/** Whether a board write names the inbox collection. @param {unknown} c */
const isInbox = (c) => String(c ?? '').replace(/^\/+|\/+$/g, '') === 'inbox';

/** A board write's entries: the call itself, or each of a batch's writes (`op` as the action). @param {Record<string, any>} ti @returns {Record<string, any>[]} */
const writesOf = (ti) => (ti.action === 'batch' ? (Array.isArray(ti.writes) ? ti.writes.filter(isObject).map((w) => ({ ...w, action: w.op })) : []) : [ti]);

/**
 * Why a board write would hand an inbox card's answer to the Mac in the captain's place, or null. Only the board writes a
 * card's `grantPending`: the captain's snapshot of what the card showed (`{choice, at, key, head?, post?}`), which the Mate's
 * panel carries out with `keelctl grant`. Refused: a set or update (alone or in a batch) whose top-level data sets
 * `grantPending` (or a path into it) to anything but false or null, a deletion included, or a str_replace on it or whose
 * new text mentions it. The answer itself (the panel's click writes one), nested answers (a batch card's `items`) and the
 * Mate's own fields (`handledAt`, `grantResult`, `grantError`, `grantPending: false`) are fine here; cardWriteProblem
 * checks when the last may be written. @param {Call} call @returns {string | null}
 */
function handsToMac(call) {
  const ti = call.ti;
  for (const w of writesOf(ti)) {
    if ((w.action !== 'set' && w.action !== 'update') || !isInbox(w.collection) || !isObject(w.data)) continue;
    const d = w.data;
    const hit = Object.keys(d).find((k) => GRANT_PENDING_KEY.test(k) && (k !== 'grantPending' || (d[k] !== false && d[k] !== null)));
    if (hit) return `it sets ${hit}`;
  }
  if (ti.action === 'str_replace' && isInbox(ti.collection)) {
    if (/grantPending/.test(String(ti.field ?? ''))) return `it edits ${ti.field}`;
    if (/grantPending/.test(String(ti.new_str ?? ''))) return 'its new text mentions grantPending';
  }
  return null;
}

/** Whether the Mate's panel has carried out a phone answer to card `id`: phone-grants.json (keyed "<card id> <answeredAt>") records one. @param {unknown} id */
function carriedOut(id) {
  if (typeof id !== 'string' || !id) return false;
  try {
    const done = readJsonStrict(paths.phoneGrants(), {});
    return isObject(done) && Object.keys(done).some((k) => k.startsWith(`${id} `));
  } catch {
    return false;
  }
}

/**
 * Why a crew session's write to an inbox card is refused, or null; each write of a batch counts. A card takes its data
 * inline: data in a `file_path` would be read here and again by the tool, and could change in between. Only the Mate
 * deletes cards (its daily hygiene deletes handled ones), since a card may hold the captain's answer waiting for this Mac.
 * And `grantPending: false` or null, which takes that answer away, goes only on a card whose answer the Mate's panel has
 * carried out (carriedOut), so a "Not yet" can't be dropped and leave an earlier approval standing. A set without
 * `grantPending` is left alone: the hook can't tell whether the card exists.
 * @param {Call} call @param {string | null} role @param {string} owner @returns {string | null}
 */
function cardWriteProblem(call, role, owner) {
  for (const w of writesOf(call.ti).filter((e) => isInbox(e.collection))) {
    const writes = w.action === 'set' || w.action === 'update';
    if (writes && w.file_path !== undefined) return 'inbox cards take their data inline, never from file_path (the file could change after this check). Write the data in the call';
    if (w.action === 'delete' && role !== 'lead') return `only the Mate deletes inbox cards; a card may hold ${owner}'s answer waiting for this Mac. Tell the Mate what should go`;
    if (writes && isObject(w.data) && (w.data.grantPending === false || w.data.grantPending === null) && !carriedOut(w.doc_id)) {
      return `${String(w.doc_id ?? 'this card')}'s grantPending is ${owner}'s answer, which this Mac hasn't carried out yet; it is cleared only after the panel's "Phone answer" wake. To change an answer, ask ${owner} on the board`;
    }
  }
  return null;
}

/** The denial for a board write that would hand a card's answer to the Mac. @param {string} why @param {string} owner @returns {Verdict} */
const handOffDenied = (why, owner) =>
  deny(`Crew policy: only ${owner}'s answer on the board hands a card to the Mac (${why}). Clear it with grantPending: false and grantResult or grantError; to change an answer, ask ${owner} on the board.`, false);

/**
 * A made-up time in a board write (`data`, or each batch entry's), at any depth: one ahead of now, or, in a field that
 * holds "now" (roundFields), a round number far from it (a fresh clock reading is rarely a whole 100 s). 0 means unset.
 * Returns the field and its value, or null.
 * @param {Record<string, any>} ti @param {Rules['policy']['boardTimes']} t @param {number} now
 * @returns {{ field: string, value: number } | null}
 */
function madeUpTime(ti, t, now) {
  /** @param {unknown} o @param {number} depth @returns {{ field: string, value: number } | null} */
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 6) return null;
    for (const [k, v] of Object.entries(o)) {
      if (t.fields.has(k) && typeof v === 'number' && v !== 0 && (v > now + t.aheadMs || (t.roundFields.has(k) && v % t.roundMs === 0 && Math.abs(now - v) > t.slackMs))) return { field: k, value: v };
      const inner = walk(v, depth + 1);
      if (inner) return inner;
    }
    return null;
  };
  return walk([ti.data, ...(Array.isArray(ti.writes) ? ti.writes.map((/** @type {any} */ w) => w?.data) : [])], 0);
}

/** Every call from a crew member when the crew's files and rules all read cleanly. @param {Env} env @returns {Verdict} */
function memberVerdict(env) {
  const { call, rules, me, owner, leadHost } = env;
  // A paused session may only look around and tell the Mate what happened. A message relayed from anyone, even one that
  // says the captain agreed, changes nothing here: only the Mate's `keelctl unpause` does.
  if (call.sessionId && me.role !== 'lead' && isPaused(call.sessionId)) {
    const toLead = call.tool === SEND_MESSAGE && !!leadHost && String(call.ti.session_id ?? call.ti.to ?? '') === leadHost;
    if (!rules.denials.allowWhilePaused.has(call.tool) && !toLead) {
      return deny(
        readDenials(call.sessionId)?.cause === 'spend'
          ? `Crew policy: this session is paused because its ticket's spend reached the hard line. Only ${[...rules.denials.allowWhilePaused].join(', ')} and messaging the Mate work now. Send the Mate a handoff (what's done, what's left) with send_message to ${leadHost ?? "the Mate's session"} and end your turn; ${owner} decides whether it continues.`
          : `Crew policy: this session is paused after too many denied calls. Only ${[...rules.denials.allowWhilePaused].join(', ')} and messaging the Mate work now. Tell the Mate what you were trying to do (send_message to ${leadHost ?? "the Mate's session"}) and end your turn; the Mate runs \`keelctl unpause ${me.key ?? call.sessionId}\` once it's sorted.`,
        false,
      );
    }
  }
  if (!call.toolOk) return gate('other', "Crew policy: this call doesn't say which tool it is, so it can't be checked.");
  // Approvals, membership, settings and memory change only through the launch card and the crew command.
  if (call.tool !== 'Read' && !(call.tool === 'Bash' && plainReads(call.ti.command, rules)) && rules.policy.crewFiles.test(crewTarget(call).split(HOME).join('~/.keelcrew'))) {
    return deny(`Crew policy: ${CREW_FILES_BY_HAND}.`);
  }
  // Claude Code settings decide every session's permissions: they are the captain's (keelctl doctor --fix keeps Keelcrew's two keys).
  if (touchesClaudeSettings(call, rules)) {
    return deny(`Crew policy: Claude Code settings files are ${owner}'s to change; read one with the Read tool. If it needs a change, tell the Mate what and why.`, false);
  }
  if (touchesCrewCode(call)) {
    return deny(`Crew policy: the crew's own plugin and Claude Code's plugins are ${owner}'s to change. Tell the Mate what should change and why.`, false);
  }
  if (me.role !== 'lead' && touchesLeadNotes(call)) {
    return deny("Crew policy: briefs and the Mate's notes are the Mate's to write; read them with the Read tool. Tell the Mate what should change.", false);
  }
  // Nobody watches a crew session, so a question asked there waits unseen and stalls it: engineers, agents and jobs ask
  // the Mate, the Mate asks on the board. A ship question stays, since grant.mjs records its answer.
  if (call.tool === 'AskUserQuestion') {
    const qs = Array.isArray(call.ti.questions) ? call.ti.questions : [];
    if (env.worksInDir && qs.length && qs.every((q) => rules.ship.questionHeader.test(String(q?.header ?? '')))) return none();
    return deny(
      me.role === 'lead'
        ? `Crew policy: ${owner} answers on the Keelcrew board, not in this session. Post the question as an inbox card (kind "question", with options) and say so in the Mate chat; the answer wakes you.`
        : `Crew policy: nobody watches this session. Ask the Mate instead: send_message to ${leadHost ?? "the Mate's session"} with the question, the options and your recommendation${env.worksInDir ? ', set your row\'s activity to "waiting",' : ','} and end your turn. The Mate answers, or asks ${owner} on the board.`,
    );
  }
  // The app nudges every session to propose follow-ups with start_session: refuse a malformed one without counting it.
  if (call.tool === START_SESSION && !call.tiOk && me.role !== 'lead') return deny(ONLY_LEAD_STARTS, false);
  if (!call.tiOk && !rules.policy.localTools.has(call.tool)) return gate('other', "Crew policy: this call's input isn't in the expected form, so it can't be checked.");
  if (runsCommand(call)) {
    const cmd = call.ti.command;
    if (typeof cmd !== 'string') return gate('other', "Crew policy: this command isn't plain text, so it can't be checked.");
    return textOnlyDenial(env, cmd, shellVerdict(env, cmd));
  }
  if (FILE_TOOLS.has(call.tool)) return fileVerdict(env);
  if (call.tool.startsWith('mcp__')) return mcpVerdict(env);
  if (call.tool === 'ArtifactData') {
    const card = cardWriteProblem(call, me.role, owner);
    if (card) return deny(`Crew policy: ${card}.`, false);
    const handOff = handsToMac(call);
    if (handOff) return handOffDenied(handOff, owner);
    const now = Date.now();
    const bad = madeUpTime(call.ti, rules.policy.boardTimes, now);
    if (bad) return deny(`Crew policy: ${bad.field} ${bad.value} is ${bad.value > now ? 'ahead of now' : 'a guess'}; times on the board are read from the clock. Now is ${now} (epoch ms): write it again with that.`, false);
  }
  if (rules.policy.localTools.has(call.tool)) return none();
  return gate('other', `Crew policy: ${call.tool} isn't a tool the crew rules know, so it can't be checked.`);
}

/* ---------- decisions when a crew file can't be read ---------- */

/**
 * A crew file is damaged or the rules are missing. A session that crew.json says isn't crew stays untouched. For a known
 * member, the rules that can be read still deny what they deny, and every other command, write or connector call asks.
 * When crew.json itself can't be read, nobody can tell who is crew (the captain's own sessions included), so only calls
 * that could ship, write to GitHub or outside this Mac, or break a rule ask.
 * @param {Call} call @param {ReturnType<typeof loadState>} s @param {Rules | null} rules
 * @returns {{ verdict: Verdict, member: Member | null }}
 */
function unhealthyVerdict(call, s, rules) {
  const member = s.reg ? memberFor(call.cwd, call.sessionId, s.reg) : null;
  if (s.reg && !member) return { verdict: none(), member };
  const known = !!member;
  const reason = `Crew policy: ${s.problems.join('; ')}, so this asks first. Run \`keelctl doctor\` to see what's wrong and fix it.`;
  const ask = () => ({ verdict: /** @type {Verdict} */ ({ decision: 'ask', reason }), member });
  /** A rule broken: denied for a known member, asked for anyone else. @param {string} why */
  const broken = (why) => (known ? { verdict: deny(`Crew policy: ${why}.`, false), member } : ask());
  if (!call.toolOk || !call.tiOk) return ask();
  if (rules?.policy.crewFiles.test(JSON.stringify(call.ti).split(HOME).join('~/.keelcrew')) && call.tool !== 'Read') {
    return broken(CREW_FILES_BY_HAND);
  }
  if (rules && touchesClaudeSettings(call, rules)) return broken("Claude Code settings files are the captain's to change");
  if ((!member || member.role !== 'lead') && touchesLeadNotes(call)) return broken("briefs and the Mate's notes are the Mate's to write");
  if (touchesCrewCode(call)) return broken("the crew's own plugin and Claude Code's plugins are the captain's to change");
  const card = call.tool === 'ArtifactData' ? cardWriteProblem(call, member?.role ?? null, 'the captain') : null;
  if (card) return broken(card);
  const handOff = call.tool === 'ArtifactData' ? handsToMac(call) : null;
  if (handOff) return broken(`only the captain's answer on the board hands a card to the Mac (${handOff})`);
  if (runsCommand(call)) {
    const cmd = call.ti.command;
    if (typeof cmd !== 'string') return ask();
    if (grantCliVerdict(cmd, call.cwd, rules)) return broken("keelctl grant is run only by the Mate's panel");
    if (rules) {
      const norm = normalizeCommand(cmd);
      const keys = gitConfigWords(norm);
      for (const r of rules.policy.denyBash) if (r.re.test(cmd) || r.re.test(norm) || keys.some((k) => r.re.test(k))) return broken(r.why);
      if (writesCrewFiles(cmd, rules, call.cwd)) return broken('the crew files are changed only by the launch card and the keelctl command');
      const parts = partsOf(cmd, rules);
      if (parts.some((p) => p.github || p.actions.length)) return ask();
    }
    if (MIGHT_SHIP.test(normalizeCommand(cmd)) || known) return ask();
    return { verdict: none(), member };
  }
  if (call.tool.startsWith('mcp__')) {
    if (s.reg && toCrew(call, s.reg)) return { verdict: allow('Crew policy: crew sessions message each other.'), member };
    if (!rules || !quietMcp(call.tool, member, rules)) return ask();
    return { verdict: none(), member };
  }
  if (FILE_TOOLS.has(call.tool)) {
    const p = call.ti.file_path ?? call.ti.notebook_path;
    if (typeof p !== 'string' || !p) return ask();
    if (!rules) return call.tool === 'Read' || !known ? { verdict: none(), member } : ask();
    if (rules.policy.secretPath.test(p)) return broken('secret files are off limits');
    if (call.tool !== 'Read' && member && (member.role === 'engineer' || member.role === 'agent')) {
      const abs = absPath(call.cwd, p);
      if (rules.policy.gitInternals.test(abs)) return broken("git's own files (.git) change only through git commands");
      if (!insideReal(member.dir, abs)) return broken(`crew members edit only inside their own folder (${member.dir})`);
    }
    return { verdict: none(), member };
  }
  if (known && !(rules?.policy.localTools ?? MINIMAL_LOCAL).has(call.tool) && call.tool !== 'AskUserQuestion') return ask();
  return { verdict: none(), member };
}

/* ---------- putting it together ---------- */

/**
 * The next step a denial names in place of a prompt. @param {AskKind} kind @param {Member} me @param {string} owner
 * @param {string | null} leadHost
 */
function nextStep(kind, me, owner, leadHost) {
  if (kind === 'ship') return `Post a launch card (the keel-ship skill); ${owner}'s approval on it lets this through.`;
  if (kind === 'post') return `Post a draft card on the board; once ${owner} approves it, the post goes through once.`;
  if (me.role === 'lead') return `Ask ${owner} with a decision card on the board.`;
  return `Message the Mate (send_message to ${leadHost ?? "the Mate's session"}) with what you need and why, and end your turn.`;
}

/**
 * Logs and counts a decision, and turns a prompt into a denial in deny mode. Counting is best effort: it never changes
 * the decision.
 * @param {Call} call @param {Verdict} v
 * @param {{ member: Member | null, rules: Rules | null, convert: boolean, counting: boolean, owner: string, leadHost: string | null }} o
 * @returns {Answer}
 */
function finish(call, v, o) {
  let { decision, reason } = v;
  let soft = false;
  if (decision === 'ask' && v.kind) {
    if (o.convert && o.member) {
      decision = 'deny';
      reason = `${reason} ${nextStep(v.kind, o.member, o.owner, o.leadHost)}`;
      soft = true;
    } else if (v.hint) reason = `${reason} ${v.hint}`;
  }
  try {
    const who = o.member?.key ?? o.member?.agent ?? o.member?.role ?? 'unknown';
    // A session outside the crew is logged only when the policy acted on its call, not on every pass.
    if (o.member || decision) appendRotating(join(paths.logs(), 'policy.log'), `${new Date().toISOString()} ${who} ${(decision ?? 'pass').toUpperCase()}${soft ? ' (for a prompt)' : ''} ${whatOf(call)} | ${reason}`);
  } catch {
    /* logging is best effort */
  }
  const m = o.member;
  if (o.counting && m && call.sessionId && o.rules && v.count !== false) {
    try {
      if (decision === 'deny') {
        const label = [m.key, m.agent ?? (m.role === 'engineer' ? 'engineer' : m.role)].filter(Boolean).join(' ');
        noteDenial(call.sessionId, { key: m.key ?? null, role: m.role, label, what: whatOf(call), why: reason.replace(/^Crew policy: /, ''), rules: o.rules, soft });
      } else if (decision !== 'ask') noteAllowed(call.sessionId);
    } catch (e) {
      if (!(e instanceof LockTimeoutError)) {
        /* a busy or unwritable denials folder must not block the call */
      }
    }
  }
  return { decision, reason };
}

/**
 * The crew policy's answer for one PreToolUse call: `{decision, reason}`, where a null decision means the session's normal
 * permission flow. Throws only on a bug; the hook answers ask (or deny) for crew members then.
 * @param {unknown} raw the hook's input
 * @returns {Answer}
 */
export function policyDecision(raw) {
  const call = callOf(raw);
  const state = loadState();
  const known = state.rules ?? baseRules();
  const healthy = !state.problems.length && !!state.reg && !!state.rules;
  const owner = (typeof state.config.owner === 'string' && state.config.owner) || 'the captain';
  const member = healthy ? memberFor(call.cwd, call.sessionId, /** @type {Registry} */ (state.reg)) : null;
  const leadHost = state.reg ? (leadOf(state.reg)?.[1]?.hostId ?? null) : null;
  const opts = { member, rules: state.rules, convert: false, counting: !!(healthy && member && call.sessionId), owner, leadHost };

  // The helper's approve, save and settings tools are for the board page only. No session may call them, crew or not.
  if (known?.policy.boardOnlyTools.test(call.tool)) return finish(call, deny('Crew policy: only the captain can do this, from the Keelcrew board.'), opts);

  if (!healthy) {
    const u = unhealthyVerdict(call, state, known);
    return finish(call, u.verdict, { ...opts, member: u.member, counting: false });
  }
  if (!member) return finish(call, none(), opts);
  const env = {
    call,
    config: state.config,
    reg: /** @type {Registry} */ (state.reg),
    rules: /** @type {Rules} */ (state.rules),
    me: member,
    owner,
    leadHost,
    worksInDir: member.role === 'engineer' || member.role === 'agent',
    profile: profileOf(member),
  };
  return finish(call, memberVerdict(env), { ...opts, convert: state.config.promptMode !== 'ask' });
}
