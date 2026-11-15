// @ts-check
// What crew sessions cost: context in use, tokens and estimated cost from a transcript (scanned once, then only its new
// lines), and spend summed per crew folder, ticket and role across every transcript a folder has had (each session
// registered there, the hooks' record of past ones, and their subagents). Shared by the helper's `costs` tool and
// `keelctl costs`, so the board, the Mate and the health agent see the same numbers.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { crewDirs, readRegistry } from './crew.mjs';
import { eachLine, readJsonLoose, writeJsonAtomic } from './fsx.mjs';
import { hash16, paths } from './paths.mjs';

const CONTEXT_MAX = 1_000_000;
/** USD per million tokens: input, output, 5-minute cache write, 1-hour cache write, cache read. Estimates of API-equivalent cost. */
const PRICES = /** @type {Record<string, number[]>} */ ({
  'fable-5-2': [8, 40, 10, 16, 0.2],
  'opus-5-5': [4, 20, 5, 8, 0.2],
  'opus-5': [5, 25, 6.25, 10, 0.5],
  'sonnet-5-5': [2, 10, 2.5, 4, 0.1],
  'sonnet-5': [2, 10, 2.5, 4, 0.2],
  'haiku-5-5': [0.1, 0.5, 0.125, 0.2, 0.01],
  haiku: [1, 5, 1.25, 2, 0.1],
});

/**
 * @typedef {{ v: number, offset: number, cost: number, tokens: number, turns: number, lastId: string | null, last: any, model: string | null, context: number | null }} UsageScan
 * @typedef {{ contextTokens: number | null, contextMax: number | null, costUsd: number, tokens: number, model: string | null, turns: number }} Usage
 * @typedef {{ costUsd: number, tokens: number }} Spend
 */

/** Bumped when the scan counts something new, so older cached scans start over. */
const SCAN_VERSION = 2;

/** @returns {UsageScan} */
const freshScan = () => ({ v: SCAN_VERSION, offset: 0, cost: 0, tokens: 0, turns: 0, lastId: null, last: null, model: null, context: null });

/** Every token one API response used: input, output, cache writes and cache reads. @param {any} u */
const tokensOf = (u) => (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);

/** @param {string | null} model */
const priceFor = (model) => PRICES[Object.keys(PRICES).find((k) => String(model ?? '').includes(k)) ?? 'opus-5-5'];

/** One API response's estimated cost in USD. @param {any} u the response's usage @param {string | null} model */
function costOf(u, model) {
  const [pin, pout, pw5, pw1, pr] = priceFor(model);
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5 = (u.cache_creation?.ephemeral_5m_input_tokens ?? 0) || Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1);
  return ((u.input_tokens ?? 0) * pin + (u.output_tokens ?? 0) * pout + w5 * pw5 + w1 * pw1 + (u.cache_read_input_tokens ?? 0) * pr) / 1e6;
}

/** @param {number} usd */
const cents = (usd) => Math.round(usd * 100) / 100;

/**
 * Folds one transcript line into the scan. A response's usage repeats on every streamed line, so it is only counted once
 * the next response starts. Cost counts from when the session joined the crew: an adopted session's history isn't crew work.
 * @param {UsageScan} c @param {string} line @param {number} since
 */
function scanUsage(c, line, since) {
  if (!line.includes('"usage"')) {
    if (line.includes('"type":"user"') && !line.includes('"tool_result"') && !line.includes('"isMeta":true')) c.turns++;
    return;
  }
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  const msg = m.message;
  if (m.type !== 'assistant' || !msg?.usage) return;
  if (msg.id !== c.lastId && c.last) {
    c.cost += costOf(c.last, c.model);
    c.tokens += tokensOf(c.last);
    c.last = null;
  }
  c.lastId = msg.id;
  c.last = since && Date.parse(m.timestamp) < since ? null : msg.usage;
  c.model = msg.model ?? c.model;
  const u = msg.usage;
  if (!m.isSidechain) c.context = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
}

/**
 * Context in use and estimated cost so far. The scan is kept in cache/ so each call reads only what was appended.
 * @param {string | undefined} transcript
 * @param {number} [since] epoch ms the session joined the crew
 * @returns {Usage}
 */
export function usageOf(transcript, since = 0) {
  if (!transcript || !existsSync(transcript)) return { contextTokens: null, contextMax: null, costUsd: 0, tokens: 0, model: null, turns: 0 };
  const cachePath = join(paths.cache(), `usage-${hash16(`${transcript}|${since}`)}.json`);
  /** @type {UsageScan} */
  const c = { ...freshScan(), ...readJsonLoose(cachePath, {}) };
  const size = statSync(transcript).size;
  if (size < c.offset || c.v !== SCAN_VERSION) Object.assign(c, freshScan());
  if (size > c.offset) {
    const offset = eachLine(transcript, c.offset, (line) => scanUsage(c, line.toString('utf8'), since));
    if (offset !== c.offset) writeJsonAtomic(cachePath, { ...c, offset });
    c.offset = offset;
  }
  const pending = c.last ? costOf(c.last, c.model) : 0;
  const tokens = c.tokens + (c.last ? tokensOf(c.last) : 0);
  return { contextTokens: c.context, contextMax: CONTEXT_MAX, costUsd: cents(c.cost + pending), tokens, model: c.model, turns: c.turns };
}

/** @param {string} dir */
function jsonlIn(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Every transcript a crew folder has had: the one the hooks saw last, the ones they saw before, one per session
 * registered there (next to a known transcript, named by session id), and each one's subagent transcripts
 * (`<session>/subagents/*.jsonl`). Only files that exist.
 * @param {{ transcript?: unknown, transcripts?: unknown, sessionId?: unknown, sessions?: string[] }} m
 * @returns {string[]}
 */
export function transcriptsOf(m) {
  const known = [m.transcript, ...(Array.isArray(m.transcripts) ? m.transcripts : [])].filter((t) => typeof t === 'string' && t);
  const folders = new Set(known.map((t) => dirname(/** @type {string} */ (t))));
  const ids = new Set([...(m.sessions ?? []), ...(typeof m.sessionId === 'string' ? [m.sessionId] : [])]);
  const main = new Set(known.map((t) => resolve(/** @type {string} */ (t))));
  for (const folder of folders) for (const id of ids) main.add(resolve(folder, `${id}.jsonl`));
  /** @type {Set<string>} */
  const all = new Set();
  for (const t of main) {
    if (!existsSync(t)) continue;
    all.add(t);
    for (const sub of jsonlIn(join(t.replace(/\.jsonl$/, ''), 'subagents'))) all.add(sub);
  }
  return [...all];
}

/** The agent id a member runs as: its registered one, or "engineer" for an engineer. @param {{ role: string, agent?: string }} m */
export const agentOf = (m) => m.agent ?? (m.role === 'engineer' ? 'engineer' : null);

/**
 * Estimated spend per crew folder since it joined, across every transcript it has had, summed per ticket (and per role
 * within it) and per role. A role is the agent id (engineer, qa, ...) or "lead". Watch runs have no folder of
 * their own and aren't counted.
 * @param {{ key?: string | null }} [options] only this ticket (any case)
 */
export function costs({ key = null } = {}) {
  const want = key ? String(key).toUpperCase() : null;
  const rows = crewDirs(readRegistry())
    .filter((m) => !want || String(m.key ?? '').toUpperCase() === want)
    .map((m) => {
      const files = transcriptsOf(m);
      let costUsd = 0;
      let tokens = 0;
      /** @type {string | null} */
      let model = null;
      for (const t of files) {
        const u = usageOf(t, m.at);
        costUsd += u.costUsd;
        tokens += u.tokens;
        if (resolve(t) === (typeof m.transcript === 'string' ? resolve(m.transcript) : '')) model = u.model;
        else model ??= u.model;
      }
      return { key: m.key ?? null, agent: agentOf(m), role: m.role, dir: m.dir, sessionId: m.sessionId ?? null, costUsd: cents(costUsd), tokens, model, since: m.at ?? null, transcripts: files.length };
    });
  /** @type {Record<string, Spend & { byRole: Record<string, number> }>} */
  const tickets = {};
  /** @type {Record<string, Spend>} */
  const roles = {};
  for (const r of rows) {
    const role = r.agent ?? r.role;
    const sum = (roles[role] ??= { costUsd: 0, tokens: 0 });
    sum.costUsd = cents(sum.costUsd + r.costUsd);
    sum.tokens += r.tokens;
    if (!r.key) continue;
    const t = (tickets[r.key] ??= { costUsd: 0, tokens: 0, byRole: {} });
    t.costUsd = cents(t.costUsd + r.costUsd);
    t.tokens += r.tokens;
    t.byRole[role] = cents((t.byRole[role] ?? 0) + r.costUsd);
  }
  return { now: Date.now(), members: rows, tickets, roles, totalUsd: cents(rows.reduce((n, r) => n + r.costUsd, 0)) };
}
