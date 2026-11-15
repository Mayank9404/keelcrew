#!/usr/bin/env node
// @ts-check
// PreToolUse and PostToolUse (or PostToolUseFailure, when the call failed after committing) on Bash in crew engineer
// sessions: the commits a call made, found from HEAD before and after it (so `git -C`, `cd … &&`, cherry-pick, revert
// and merges all count), minus what each merge brought in from its second parent and anything committed before the
// call began (a fast-forward to teammates' commits), go on the ticket's ledger record. A commit a rebase rewrote keeps
// its original's attribution (by patch id). The session and its worktree come from the registry, not the call's folder.
// A snapshot stays until its commits are recorded, so the session's next call retries one cut short. Never blocks and
// never fails the session.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readRegistry } from '../core/crew.mjs';
import { readJsonLoose, writeJsonAtomic } from '../core/fsx.mjs';
import { applyEvent, isLedgerKey, patchIdsOf, readRecord } from '../core/ledger.mjs';
import { paths } from '../core/paths.mjs';

// Three quick git calls (five after a rebase) and the ledger lock, inside the hook's 5 s timeout.
const GIT_MS = 1200;
const LOCK_MS = 800;
const DAY = 86_400_000;
const SAFE = /^[\w.-]+$/;

/** @param {string} dir @param {string[]} args */
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_MS }).trim();
/** @param {string} out */
const lines = (out) => out.split('\n').filter(Boolean);

/** @param {Record<string, any>} input */
function run(input) {
  if (input.tool_name !== 'Bash') return;
  const sid = String(input.session_id ?? '');
  const call = String(input.tool_use_id ?? 'call');
  if (!SAFE.test(sid) || !SAFE.test(call)) return;
  // Only a registered engineer session: the captain's own session in an engineer's worktree isn't crew work.
  const m = readRegistry().sessions[sid];
  if (!m || m.role !== 'engineer' || !m.dir || !isLedgerKey(m.key)) return;
  const heads = join(paths.cache(), 'heads');
  const snap = join(heads, `${sid}-${call}.json`);
  const head = git(m.dir, ['rev-parse', 'HEAD']);
  if (input.hook_event_name === 'PreToolUse') {
    writeJsonAtomic(snap, { head, at: Date.now() });
    prune(heads);
    return;
  }
  if (input.hook_event_name !== 'PostToolUse' && input.hook_event_name !== 'PostToolUseFailure') return;
  const taken = readJsonLoose(snap, null);
  if (taken) {
    // Marked ended first: only a call that ended is retried later, never one still running or one that was denied.
    const ended = { ...taken, end: Date.now() };
    writeJsonAtomic(snap, ended);
    record(m.dir, /** @type {string} */ (m.key), snap, ended, head);
  }
  for (const f of readdirSync(heads)) {
    if (!f.startsWith(`${sid}-`) || join(heads, f) === snap) continue;
    const left = readJsonLoose(join(heads, f), null);
    if (left?.end) record(m.dir, /** @type {string} */ (m.key), join(heads, f), left, head);
  }
}

/**
 * Records the crew commits between a snapshot and HEAD made while its call ran, then drops the snapshot. When git or the
 * lock fails it throws and the snapshot stays.
 * @param {string} dir @param {string} key @param {string} path @param {{ head?: unknown, at?: unknown, end?: unknown }} taken @param {string} head
 */
function record(dir, key, path, taken, head) {
  const before = taken.head;
  if (typeof before === 'string' && before !== head) {
    const merges = lines(git(dir, ['rev-list', '--merges', `${before}..${head}`]));
    // Commit times are whole seconds, so a commit made just after the snapshot can read up to a second before it.
    const since = Math.floor(Number(taken.at) / 1000) - 1;
    const until = Math.floor(Number(taken.end) / 1000) + 1;
    // Right: what the call added. Left: what it rewrote away (a rebase's originals).
    const log = lines(git(dir, ['log', '--left-right', '--format=%m %H %ct', `${before}...${head}`, ...(merges.length ? ['--not', ...merges.map((x) => `${x}^2`)] : [])])).map((l) => l.split(' '));
    let shas = log.filter(([side, , ct]) => side === '>' && Number(ct) >= since && Number(ct) <= until).map(([, sha]) => sha);
    const old = log.filter(([side]) => side === '<').map(([, sha]) => sha);
    if (shas.length && old.length) {
      // A rewritten commit is the crew's only when its original was: the captain's commits a rebase replays stay theirs.
      const crew = new Set(readRecord(key)?.crewShas ?? []);
      const ids = patchIdsOf(dir, [...shas, ...old], GIT_MS);
      /** @type {Map<string, string>} */
      const original = new Map(old.filter((s) => ids.has(s)).map((s) => [/** @type {string} */ (ids.get(s)), s]));
      shas = shas.filter((s) => {
        const was = original.get(ids.get(s) ?? '');
        return !was || crew.has(was);
      });
    }
    if (shas.length) applyEvent('shas', key, { id: `shas:${before}..${head}`, shas }, { lockTimeoutMs: LOCK_MS });
  }
  rmSync(path, { force: true });
}

/** Snapshots a call left behind (it was denied, or its session ended mid-call), once they are a day old. @param {string} dir */
function prune(dir) {
  const now = Date.now();
  for (const f of readdirSync(dir)) {
    try {
      if (now - statSync(join(dir, f)).mtimeMs > DAY) rmSync(join(dir, f), { force: true });
    } catch {
      /* gone already */
    }
  }
}

try {
  run(JSON.parse(readFileSync(0, 'utf8')));
} catch {
  /* the ledger is best effort: a hook never fails the session */
}
