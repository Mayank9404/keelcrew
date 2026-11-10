#!/usr/bin/env node
// @ts-check
// UserPromptSubmit, PostToolUse and Stop: what each crew session is doing, for the board. Writes state/<h16>.json (latest)
// and appends events/<h16>.jsonl (history). Never blocks and never fails the session.
import { join } from 'node:path';
import { memberFor } from '../core/crew.mjs';
import { appendRotating, readInput, readJsonLoose, withLock, writeJsonAtomic } from '../core/fsx.mjs';
import { HOME, hash16, paths } from '../core/paths.mjs';

const MAX_LOG_BYTES = 4 * 1024 * 1024;
/** How long a hook waits for another of the folder's hooks to finish writing its state (they run under a 10 s timeout). */
const STATE_LOCK_MS = 1500;
const FILE_EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const LOOKUPS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch']);

/** What the office shows the session doing, from the tool it just used. @param {string} name */
function activityOf(name) {
  if (name === 'Bash') return 'terminal';
  if (FILE_EDITS.has(name)) return 'typing';
  if (LOOKUPS.has(name) || name.startsWith('mcp__')) return 'reading';
  if (name === 'AskUserQuestion') return 'waiting';
  return 'thinking';
}

/** One line saying what a tool call did: the command, the file, the query. @param {string} name @param {Record<string, any>} inp */
function gist(name, inp) {
  for (const k of ['command', 'file_path', 'pattern', 'path', 'url', 'query', 'description', 'prompt', 'message']) {
    if (typeof inp?.[k] === 'string' && inp[k]) return `${name}: ${inp[k].split('\n')[0].slice(0, 180)}`;
  }
  return name;
}

/** @param {Record<string, any>} input */
function record(input) {
  // Read first: the event's time orders it against the folder's other hooks.
  const now = Date.now();
  const member = memberFor(input.cwd || process.cwd(), input.session_id);
  if (!member || member.role === 'job') return;
  const ev = input.hook_event_name;
  const tool = String(input.tool_name ?? '');
  const ti = input.tool_input ?? {};

  // A mod's own tool calls (the panel reads the board every minute in the Mate's session) aren't the session's work; they
  // only show it is open. Kept in their own file so they never race the turn's updates.
  if (ev === 'PostToolUse' && String(input.tool_use_id ?? '').startsWith('toolu_plugin_')) {
    writeJsonAtomic(paths.alive(member.dir), now);
    return;
  }

  /** @type {Record<string, any>} */
  let change;
  /** @type {{ kind: string, tool?: string, summary: string, isError?: boolean }} */
  let event;
  if (ev === 'UserPromptSubmit') {
    change = { busy: true, activity: 'thinking' };
    event = { kind: 'user', summary: String(input.prompt ?? '').replace(/\s+/g, ' ').slice(0, 300) };
  } else if (ev === 'PostToolUse') {
    const resp = input.tool_response;
    const isError = !!(resp && typeof resp === 'object' && (resp.is_error || resp.isError || (typeof resp.error === 'string' && resp.error)));
    change = { busy: true, activity: activityOf(tool), lastTool: tool, lastText: gist(tool, ti) };
    event = { kind: 'tool', tool, summary: gist(tool, ti), isError };
  } else if (ev === 'Stop') {
    change = { busy: false, activity: 'idle' };
    event = { kind: 'turn_end', summary: 'Turn done' };
  } else return;

  // The folder's hooks (and doctor) change its state one at a time. The lock name matches doctor's checkBusy. A lock wait
  // that times out (or a damaged state file) costs only the state update: the event is still logged below.
  try {
    withLock(
      join(HOME, 'locks', `state-${hash16(member.dir)}`),
      () => {
        const state = readJsonLoose(paths.state(member.dir), {});
        // An event older than the one stored (a step that finished writing after the turn's Stop) leaves busy and activity be.
        if (!(Number(state.lastAt) > now)) Object.assign(state, change);
        if (ev === 'UserPromptSubmit') state.turns = (state.turns ?? 0) + 1;
        // Every transcript the folder has had, so its cost counts sessions that came before the current one.
        const seen = Array.isArray(state.transcripts) ? state.transcripts.filter((/** @type {unknown} */ t) => typeof t === 'string') : [];
        const transcripts = [...new Set([...seen, input.transcript_path].filter(Boolean))].slice(-50);
        Object.assign(state, { sessionId: input.session_id ?? state.sessionId, transcript: input.transcript_path ?? state.transcript, transcripts, lastAt: Math.max(Number(state.lastAt) || 0, now) });
        writeJsonAtomic(paths.state(member.dir), state);
      },
      { timeoutMs: STATE_LOCK_MS },
    );
  } catch {
    /* best effort, like the rest of the hook */
  }
  const who = member.key ?? member.agent ?? member.role;
  appendRotating(paths.events(member.dir), JSON.stringify({ ts: now, key: who, ...event }), MAX_LOG_BYTES);
  appendRotating(join(paths.logs(), 'activity.log'), `${new Date(now).toISOString()} ${who} ${event.kind} ${event.summary}`, MAX_LOG_BYTES);
}

try {
  record(readInput());
} catch {
  /* activity is best effort: a damaged crew file or a full disk must never stop the session */
}
process.exit(0);
