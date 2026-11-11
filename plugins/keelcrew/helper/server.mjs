#!/usr/bin/env node
// @ts-check
// keelcrew-local: the Keelcrew board's hands on this Mac. A small MCP server (stdio, no dependencies) the Claude app runs.
// It reads the crew state the hooks record, transcripts, diffs and logs; opens worktrees and sessions in the captain's apps;
// and records the approvals given on the board. It never runs agents or calls Claude.
// Read-only tools carry `readOnlyHint`, so the app may let the board run them without asking; the rest ask every time.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isObject, readJsonLoose } from '../core/fsx.mjs';
import { HOME, paths } from '../core/paths.mjs';
import { loadRules } from '../core/rules.mjs';
import { readDenials } from '../core/denials.mjs';
import { agentOf } from '../core/costs.mjs';
import { agentsList, approvePost, configGet, configSet, doctor, logToOpen, logTail, logs, memoryList, promptSave, prompts } from './admin.mjs';
import { approve, branchUrl, changedFiles, diff, risk } from './git.mjs';
import { log, messageOf } from './io.mjs';
import { openFile, openIn, openLogs, openSession } from './mac.mjs';
import { orgGet } from './org.mjs';
import { members, repoFor } from './members.mjs';
import { costs, sessionEvents, transcript, usageOf } from './transcripts.mjs';

const VERSION = '1.0.0';
/** The board's data schema this helper is built for; the board checks it through `ping`. */
const SCHEMA = 2;

/* ---------- tool schemas ---------- */

/**
 * @typedef {{ type?: string | string[], description?: string, enum?: unknown[], items?: object }} Prop
 * @typedef {{ type: 'object', properties: Record<string, Prop>, required: string[], additionalProperties: false }} Schema
 * @typedef {{ d: string, s: Schema, f: (args: any) => unknown, ro?: boolean }} Tool
 */

/** @param {Record<string, Prop>} [props] @param {string[]} [required] @returns {Schema} */
const obj = (props = {}, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
/** @param {string} description @returns {Prop} */
const str = (description) => ({ type: 'string', description });
/** @param {string} [description] @returns {Prop} */
const num = (description) => (description ? { type: 'number', description } : { type: 'number' });
/** Who a call is about: a ticket key or "lead", and optionally which agent's session for that ticket. */
const who = {
  key: str('Ticket key, or "lead"'),
  agent: str('Agent id when several crew sessions share the ticket (for example "qa"); the engineer by default'),
};

/** approve's `choice`: one of the rules' ship choices (left open if rules.json can't be read; approve then fails clearly). @returns {Prop} */
function shipChoice() {
  try {
    return { type: 'string', enum: loadRules(undefined).ship.choices };
  } catch {
    return { type: 'string' };
  }
}

/* ---------- tools ---------- */

/** The plan's 5-hour and weekly use the panel mod in the Mate session wrote to usage.json, or null before it has. */
function localUsage() {
  const u = readJsonLoose(paths.usage(), null);
  return isObject(u) && typeof u.updatedAt === 'number' ? { fiveHour: u.fiveHour ?? null, sevenDay: u.sevenDay ?? null, updatedAt: u.updatedAt } : null;
}

/** The compactions crew sessions' panels ran for board requests (compacted/<request id>.json), for the board to close them. */
function localCompacted() {
  /** @type {string[]} */
  let names = [];
  try {
    names = readdirSync(paths.compacted()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return names.flatMap((f) => {
    const c = readJsonLoose(join(paths.compacted(), f), null);
    if (!isObject(c) || typeof c.at !== 'number') return [];
    return [{ id: f.slice(0, -5), key: typeof c.key === 'string' ? c.key : null, at: c.at, ...(c.error ? { error: String(c.error) } : {}) }];
  });
}

/** A file the panel mod in the Mate session writes (scan.json, health.json), or null before it has or when it's damaged. @param {string} path */
const localReport = (path) => {
  const r = readJsonLoose(path, null);
  return isObject(r) && typeof r.at === 'number' ? r : null;
};

/** When the panel in the Mate session last read the board (it rewrites summary.json each minute), or null: the board warns
 * when this goes stale, since a Mate session that isn't running watches nothing. */
function localPanel() {
  const s = localReport(paths.summary());
  return s ? { at: s.at } : null;
}

/** Every crew session on this Mac with what it's doing, whether it's paused, its context in use and its estimated cost; the plan's usage; and what the panels left for the board. */
function crewState() {
  return {
    now: Date.now(),
    usage: localUsage(),
    compacted: localCompacted(),
    scan: localReport(paths.scan()),
    health: localReport(paths.health()),
    merges: localReport(paths.merges()),
    spend: localReport(paths.spend()),
    panel: localPanel(),
    members: members().map((m) => ({
      dir: m.dir,
      role: m.role,
      key: m.key ?? null,
      agent: agentOf(m),
      sessionId: m.sessionId ?? null,
      lastTool: m.lastTool ?? null,
      lastText: m.lastText ?? null,
      activity: m.activity ?? 'idle',
      busy: !!m.busy,
      lastAt: m.lastAt ?? null,
      aliveAt: m.aliveAt,
      repo: repoFor(m.dir)?.name ?? null,
      paused: m.sessionId && m.role !== 'lead' ? readDenials(m.sessionId)?.paused === true : false,
      ...usageOf(m.transcript, m.at),
    })),
  };
}

/** @type {Record<string, Tool>} */
const TOOLS = {
  ping: { ro: true, d: 'Check that the Keelcrew helper is reachable, and which version and board schema it serves.', s: obj(), f: () => ({ ok: true, version: VERSION, schema: SCHEMA, home: HOME }) },
  crew_state: {
    ro: true,
    d: 'Every crew session on this Mac: role, ticket, agent, folder, session id, whether it is paused, last tool, activity, when it was last seen open, context in use, tokens and estimated cost. Also `usage`: the plan 5-hour and weekly use as the Mate session last read it ({fiveHour, sevenDay, updatedAt}), or null; `compacted`: the compactions sessions ran for board requests ([{id, key, at, error?}]); `scan` and `health`: the last Jira scan ({at, ok, error?, new, changed, updated}) and health check ({at, issues, ok}) the panel in the Mate session ran, or null; `merges`: crew PRs the panel saw merge ({at, merges: [{key, url, prNumber, mergedAt, mergeSha, target}]}); `spend`: weekly allowances used and the spend alarm\'s lines and flags; `panel`: when the panel in the Mate session last read the board ({at}); each null until written.',
    s: obj(),
    f: crewState,
  },
  session_events: {
    ro: true,
    d: "A crew session's recent activity (tool calls, results, turns), newest last.",
    s: obj({ ...who, before: num('Only events before this time (epoch ms)'), limit: num('At most this many (1000 max)') }, ['key']),
    f: sessionEvents,
  },
  transcript: {
    ro: true,
    d: "A crew session's conversation as readable steps: the last `limit` steps, or `limit` steps from `offset`.",
    s: obj({ ...who, offset: { type: ['number', 'null'] }, limit: num('At most this many steps (1000 max)') }, ['key']),
    f: transcript,
  },
  diff: {
    ro: true,
    d: "A ticket's changes against its base branch (committed and not), its git status, and the GitHub compare link once pushed.",
    s: obj({ key: str('Ticket key') }, ['key']),
    f: diff,
  },
  risk: {
    ro: true,
    d: "A ticket's risk tier for its launch card (low, medium or high) from its committed diff against the base branch, with the reasons, files and lines changed.",
    s: obj({ key: str('Ticket key') }, ['key']),
    f: risk,
  },
  costs: {
    ro: true,
    d: 'Estimated spend per crew member since it joined (key, agent, role, costUsd, tokens, since), summed per ticket (with each role) and per role.',
    s: obj(),
    f: costs,
  },
  branch_url: { ro: true, d: "GitHub's compare page for a ticket's branch against its base, once the branch is pushed (null before).", s: obj({ key: str('Ticket key') }, ['key']), f: branchUrl },
  changed_files: { ro: true, d: 'Files each engineer has changed, for spotting two tickets touching the same file.', s: obj(), f: changedFiles },
  open_in: { d: "Open a crew member's worktree in the editor, Finder or the terminal.", s: obj({ ...who, app: { type: 'string', enum: ['editor', 'finder', 'terminal'] } }, ['key', 'app']), f: openIn },
  open_session: { d: "Open a crew member's real session in the Claude app, Warp or Terminal.", s: obj({ ...who, app: { type: 'string', enum: ['desktop', 'warp', 'terminal'] } }, ['key']), f: openSession },
  open_file: { d: 'Open a file the crew linked in its default app (documents only: csv, xlsx, pdf, md, txt, json, images…), or show it in Finder. Only files in the home folder or a temp folder.', s: obj({ path: { type: 'string' }, reveal: { type: 'boolean' } }, ['path']), f: openFile },
  logs: { ro: true, d: 'The crew log files.', s: obj(), f: logs },
  log_tail: { ro: true, d: 'The last lines of a crew log.', s: obj({ file: str('Log file name'), lines: num() }, ['file']), f: logTail },
  open_logs: { d: 'Show the logs folder in Finder, or open one log in Console.', s: obj({ file: { type: ['string', 'null'] } }), f: ({ file }) => openLogs(logToOpen(file)) },
  doctor: { ro: true, d: "Check the crew's health on this Mac (the shared crew checks and the board link). Fixes nothing.", s: obj(), f: doctor },
  prompts: { ro: true, d: 'The crew instruction files (skills and the Mate workspace notes).', s: obj(), f: prompts },
  prompt_save: { d: 'Save an edited crew instruction file. Board only.', s: obj({ file: str('File name from prompts'), text: str('Full new text') }, ['file', 'text']), f: promptSave },
  config_get: { ro: true, d: 'The Mac-side crew settings: apps, repos, and when Mate-folder sessions auto-compact.', s: obj(), f: configGet },
  config_set: { d: 'Change Mac-side crew settings (ide, editor, terminal, repos, owner, claudePath, promptMode, shipMode: free or card, compactWindow: when Mate-folder sessions auto-compact). Board only.', s: obj({ patch: { type: 'object' } }, ['patch']), f: configSet },
  approve: {
    d: "Record the captain's ship decision for a ticket, pinned to the commit on the card (`head`, which must be the worktree's HEAD or one before it) or else the worktree's current commit; \"Not yet\" clears it. Board only: crew rules block agents from calling it.",
    s: obj({ key: str('Ticket key'), choice: shipChoice(), head: str("The launch card's commit (receipts.head), a full sha") }, ['key', 'choice']),
    f: approve,
  },
  approve_post: {
    d: 'Approve one drafted outside write: the next call of `tool` (an exact tool name, or /regex/) whose input contains `match` goes through once without a prompt. Board only: crew rules block agents from calling it.',
    s: obj({ key: str('Ticket or task key of the draft card'), tool: str('Exact tool name, or /regex/'), match: str('Text the call must contain, for example the message or page title') }, ['key', 'tool']),
    f: approvePost,
  },
  memory_list: {
    ro: true,
    d: "The crew's lessons and the standing orders they compile to: all of them for the Mate, or the share one agent (and repo) gets.",
    s: obj({ repo: str('Only lessons for this repo'), agent: str('Only lessons for this agent') }),
    f: memoryList,
  },
  agents_list: { ro: true, d: "The crew's agents (their manifests), with the skills and notes the team pack adds to each.", s: obj(), f: agentsList },
  org: { ro: true, d: 'The company: departments ({id, name, summary, head, order, colour, budgetShare, defaultEnabled, switchable}) and the org as code resolves it ({ceo, departments with enabled, roles with enabled, seats, approved models, budgets, goals}).', s: obj(), f: orgGet },
};

/* ---------- argument checks ---------- */

/** @param {unknown} v */
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/**
 * What's wrong with a call's arguments, or null. Checks what the schema promises the tools (an object, required keys,
 * types, enums); extra keys are ignored so an older or newer board keeps working.
 * @param {Schema} schema @param {unknown} args
 */
function argumentProblem(schema, args) {
  if (typeOf(args) !== 'object') return 'The arguments must be an object.';
  const a = /** @type {Record<string, unknown>} */ (args);
  for (const k of schema.required) if (a[k] === undefined || a[k] === null || a[k] === '') return `Missing "${k}".`;
  for (const [k, p] of Object.entries(schema.properties)) {
    const v = a[k];
    if (v === undefined) continue;
    const types = [p.type ?? []].flat();
    if (types.length && !types.includes(typeOf(v))) return `"${k}" must be ${types.join(' or ')}.`;
    if (p.enum && !p.enum.includes(v)) return `"${k}" must be one of: ${p.enum.join(', ')}.`;
  }
  return null;
}

/* ---------- MCP over stdio ---------- */

/** A JSON-RPC error with its code. */
class RpcError extends Error {
  /** @param {number} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** @param {string} text */
const toolFailure = (text) => ({ content: [{ type: 'text', text }], isError: true });

/**
 * Runs one tool. A tool that throws answers with its message as an error result; an unknown tool is a JSON-RPC error.
 * @param {any} params
 */
async function callTool(params) {
  const name = params?.name;
  if (typeof name !== 'string' || !Object.hasOwn(TOOLS, name)) throw new RpcError(-32602, `Unknown tool: ${name}`);
  const tool = TOOLS[name];
  const args = params.arguments ?? {};
  const problem = argumentProblem(tool.s, args);
  if (problem) return toolFailure(`${name}: ${problem}`);
  try {
    const out = await tool.f(args);
    const structured = out && typeof out === 'object' && !Array.isArray(out) ? out : { result: out ?? null };
    return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
  } catch (e) {
    log('error', `${name} failed: ${e instanceof Error ? e.stack : e}`);
    return toolFailure(messageOf(e) || `${name} failed.`);
  }
}

const toolList = () => Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.d, inputSchema: t.s, annotations: { readOnlyHint: !!t.ro } }));

/**
 * The result for one request, or undefined for a notification (nothing to answer).
 * @param {any} req
 */
async function resultFor(req) {
  const { method, params } = req;
  if (typeof method !== 'string') throw new RpcError(-32600, 'Invalid request: no method.');
  if (method === 'initialize') return { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'keelcrew-local', version: VERSION } };
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: toolList() };
  if (method === 'tools/call') return callTool(params);
  throw new RpcError(-32601, `Method not found: ${method}`);
}

/** @param {unknown} msg */
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
/** @param {unknown} id @param {number} code @param {string} message */
const sendError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

/** Answers one line from the app. Nothing a request does can stop the server. @param {string} line */
async function onLine(line) {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    log('warn', `unreadable request: ${line.slice(0, 300)}`);
    return sendError(null, -32700, 'Parse error: the request is not JSON.');
  }
  if (typeOf(req) !== 'object') return sendError(null, -32600, 'Invalid request: expected one JSON-RPC object.');
  const { id } = req;
  if (id === undefined || id === null) return;
  try {
    send({ jsonrpc: '2.0', id, result: await resultFor(req) });
  } catch (e) {
    const code = e instanceof RpcError ? e.code : -32603;
    if (code === -32603) log('error', `${req.method} failed: ${e instanceof Error ? e.stack : e}`);
    sendError(id, code, messageOf(e));
  }
}

/** Reads requests until the app closes stdin, then exits once the requests still running have answered. */
function serve() {
  let running = 0;
  let closed = false;
  const exitIfDone = () => closed && running === 0 && process.exit(0);
  process.stdout.on('error', () => process.exit(0));
  process.on('uncaughtException', (e) => log('error', `uncaught: ${e.stack ?? e}`));
  process.on('unhandledRejection', (e) => log('error', `unhandled: ${e instanceof Error ? e.stack : e}`));
  createInterface({ input: process.stdin }).on('line', (line) => {
    running++;
    onLine(line).finally(() => {
      running--;
      exitIfDone();
    });
  });
  process.stdin.on('end', () => {
    closed = true;
    exitIfDone();
  });
}

serve();
