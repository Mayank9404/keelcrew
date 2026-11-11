// @ts-check
// Reading crew sessions: context in use, tokens and estimated cost from a transcript (scanned once, then only its new
// lines), cost summed per member, ticket and role, the conversation as readable steps paged from the end, and the activity
// events the hooks record.
import { existsSync, statSync } from 'node:fs';
import { paths } from '../core/paths.mjs';
import { eachLine, readRange, tail } from './io.mjs';
import { findMember } from './members.mjs';

const EVENTS_WINDOW_BYTES = 2 * 1024 * 1024;

/* ---------- context and cost (shared with the crew command, in core/costs.mjs) ---------- */

export { costs, usageOf } from '../core/costs.mjs';

/* ---------- the conversation as readable steps ---------- */

/**
 * @typedef {{ role: string, kind: string, text: string, tool?: string, input?: string, isError?: boolean, sub: boolean }} Step
 * @typedef {{ ino: number, size: number, total: number, pos: number[], len: number[], first: number[], tools: Map<string, string> }} StepIndex
 */

/** Steps per transcript, so a page reads only its own lines. Kept for the most recently read transcripts. @type {Map<string, StepIndex>} */
const indexes = new Map();
const MAX_INDEXES = 16;

/** @param {string} t @param {number} n */
const clip = (t, n) => (t.length > n ? `${t.slice(0, n)}\n… (${(t.length - n).toLocaleString()} more characters)` : t);

/** @param {unknown} content */
const resultText = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((b) => (b?.type === 'text' ? b.text ?? '' : b?.type === 'image' ? '[image]' : '')).join('\n')
      : '';

/** @param {Buffer} buf */
function parseLine(buf) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * The readable steps in one transcript line (said, thought, called, returned). Records tool names by call id so a result
 * can name its tool.
 * @param {any} m the parsed line
 * @param {Map<string, string>} tools
 * @returns {Step[]}
 */
function stepsOf(m, tools) {
  if (!m || m.isMeta) return [];
  const sub = !!m.isSidechain;
  if (m.type === 'system') {
    return m.subtype === 'compact_boundary' || m.content ? [{ role: 'system', kind: 'notice', text: clip(String(m.content ?? 'Conversation compacted'), 600), sub }] : [];
  }
  if (m.type !== 'user' && m.type !== 'assistant') return [];
  const content = m.message?.content;
  if (typeof content === 'string') return content.trim() ? [{ role: m.type, kind: 'text', text: clip(content, 20000), sub }] : [];
  if (!Array.isArray(content)) return [];
  /** @type {Step[]} */
  const steps = [];
  for (const b of content) {
    if (b.type === 'text' && b.text?.trim()) steps.push({ role: m.type, kind: 'text', text: clip(b.text, 20000), sub });
    else if (b.type === 'thinking' && b.thinking?.trim()) steps.push({ role: 'assistant', kind: 'thinking', text: clip(b.thinking, 20000), sub });
    else if (b.type === 'tool_use') {
      tools.set(b.id, b.name);
      steps.push({ role: 'assistant', kind: 'tool', tool: b.name, text: '', input: clip(JSON.stringify(b.input ?? {}, null, 2), 6000), sub });
    } else if (b.type === 'tool_result') {
      steps.push({ role: 'user', kind: 'result', tool: tools.get(b.tool_use_id), text: clip(resultText(b.content), 20000), isError: !!b.is_error, sub });
    }
  }
  return steps;
}

/** @param {number} ino @returns {StepIndex} */
const emptyIndex = (ino) => ({ ino, size: 0, total: 0, pos: [], len: [], first: [], tools: new Map() });

/**
 * Where each transcript line's steps start, brought up to date by reading only the lines appended since the last call.
 * @param {string} path
 * @returns {StepIndex}
 */
function stepIndex(path) {
  const st = statSync(path);
  let idx = indexes.get(path);
  if (!idx || idx.ino !== st.ino || st.size < idx.size) idx = emptyIndex(st.ino);
  const x = idx;
  if (st.size > x.size) {
    x.size = eachLine(path, x.size, (line, position) => {
      const n = stepsOf(parseLine(line), x.tools).length;
      if (!n) return;
      x.pos.push(position);
      x.len.push(line.length);
      x.first.push(x.total);
      x.total += n;
    });
  }
  indexes.delete(path);
  indexes.set(path, x);
  if (indexes.size > MAX_INDEXES) indexes.delete(/** @type {string} */ (indexes.keys().next().value));
  return x;
}

/** The last line whose steps start at or before step `i`. @param {number[]} first @param {number} i */
function lineOfStep(first, i) {
  let lo = 0;
  let hi = first.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (first[mid] <= i) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Steps `start` up to (not including) `end`, read straight from their lines.
 * @param {string} path @param {StepIndex} idx @param {number} start @param {number} end
 */
function readSteps(path, idx, start, end) {
  if (start >= end || !idx.first.length) return [];
  const lo = lineOfStep(idx.first, start);
  let hi = lo;
  while (hi + 1 < idx.first.length && idx.first[hi + 1] < end) hi++;
  const from = idx.pos[lo];
  const buf = readRange(path, from, idx.pos[hi] + idx.len[hi] - from);
  /** @type {(Step & { i: number })[]} */
  const out = [];
  for (let k = lo; k <= hi; k++) {
    const at = idx.pos[k] - from;
    stepsOf(parseLine(buf.subarray(at, at + idx.len[k])), idx.tools).forEach((s, j) => {
      const i = idx.first[k] + j;
      if (i >= start && i < end) out.push({ ...s, i });
    });
  }
  return out;
}

/**
 * The conversation as readable steps: the last `limit` when `offset` is null, else `limit` steps from `offset`.
 * @param {string | undefined} path @param {number | null} offset @param {number} limit
 */
function transcriptOf(path, offset, limit) {
  if (!path || !existsSync(path)) return { entries: [], total: 0, source: 'session' };
  const idx = stepIndex(path);
  const total = idx.total;
  const start = offset == null ? Math.max(0, total - limit) : Math.max(0, Math.min(offset, total));
  return { entries: readSteps(path, idx, start, start + limit), total, source: 'session' };
}

/** @param {unknown} n @param {number} fallback @param {number} max */
const clampCount = (n, fallback, max) => Math.min(Math.max(1, Math.floor(Number(n) || fallback)), max);

/**
 * A crew session's transcript tool: who, then a page of steps.
 * @param {{ key: string, agent?: string, offset?: number | null, limit?: number }} a
 */
export function transcript({ key, agent, offset = null, limit = 300 }) {
  return transcriptOf(findMember(key, agent).transcript, offset ?? null, clampCount(limit, 300, 1000));
}

/**
 * A crew session's recent activity (tool calls, results, turns), newest last.
 * @param {{ key: string, agent?: string, before?: number, limit?: number }} a
 */
export function sessionEvents({ key, agent, before, limit = 200 }) {
  const p = paths.events(findMember(key, agent).dir);
  if (!existsSync(p)) return { events: [] };
  /** @type {any[]} */
  let events = [];
  tail(p, EVENTS_WINDOW_BYTES).forEach((line, id) => {
    try {
      events.push({ id, ...JSON.parse(line) });
    } catch {
      /* a line cut mid-write */
    }
  });
  if (before) events = events.filter((e) => e.ts < before);
  return { events: events.slice(-clampCount(limit, 200, 1000)) };
}
