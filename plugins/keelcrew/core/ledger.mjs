// @ts-check
// The ledger: one record per ticket (or other role's work item) in ~/.keelcrew/ledger/<key>.json, its own git repo.
// Only code writes it, through events (`keelctl ledger event`, the hooks and the panel); every event carries an id, so
// applying it twice changes nothing. Budgets, proposal hit rates and the weekly report read it; the board reads it through the
// helper. Model sessions are denied it (policy), which makes it tamper-evident, not a security boundary.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CorruptFileError, isObject, readJsonStrict, withLock, writeJsonAtomic } from './fsx.mjs';
import { paths } from './paths.mjs';

export const LEDGER_SCHEMA = 1;
export const OUTCOMES = ['merged', 'done', 'parked', 'cancelled', 'dropped'];
export const OUTPUT_VERDICTS = ['accepted', 'edited', 'rejected'];
/** Event ids kept per record for de-duplication; older ones can't recur (events are dated). */
const MAX_EVENT_IDS = 2000;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** Task-row fields a `task` event copies onto the record. */
const TASK_FIELDS = ['title', 'repo', 'difficulty', 'risk', 'kind', 'role', 'model', 'effort', 'status', 'goal', 'autoStarted', 'startedAt', 'closedAt'];
/** The lists every reader of a record relies on. */
const LIST_FIELDS = ['sessions', 'prs', 'crewShas', 'bugs30d', 'reverts30d', 'events'];
/** A git that died mid-commit leaves .git/index.lock behind; one this old is no live git's. */
const STALE_INDEX_LOCK_MS = 10 * 60_000;

/**
 * @typedef {{ kind: string, createdAt: number | null, answeredAt: number | null, waitMinutes: number | null, answer: string | null }} CardFact
 * @typedef {{ shas: string[], linesChanged: number, linesInFinalDiff: number, ratio: number }} OwnerEdit
 * @typedef {{
 *   schemaVersion: number, key: string, kind: 'ticket' | 'output', title: string | null, repo: string | null,
 *   difficulty: string | null, risk: string | null, role: string | null, autoStarted: boolean | null,
 *   model: string | null, effort: string | null, status: string | null, goal: string | null,
 *   queuedAt: number | null, startedAt: number | null, closedAt: number | null, sessions: string[], prs: string[], prNumber: number | null,
 *   mergedAt: number | null, mergeSha: string | null, crewShas: string[],
 *   ownerEdit: OwnerEdit | null,
 *   spendUsd: number | null, tokens: number | null, cards: Record<string, CardFact>, ciFailuresBeforeReady: number | null,
 *   qaFirstPass: boolean | null, bugs30d: { ticket: string, severity: string | null, at: number }[],
 *   reverts30d: { sha: string, at: number }[], outcome: string | null, verdict: string | null,
 *   events: string[], createdAt: number, updatedAt: number
 * }} LedgerRecord
 */

/** @param {string} key */
const fileOf = (key) => join(paths.ledger(), `${key}.json`);

/** Whether a string can name a ledger record. @param {unknown} key */
export const isLedgerKey = (key) => typeof key === 'string' && KEY.test(key);

/** @param {string} key @param {number} now @returns {LedgerRecord} */
export function emptyRecord(key, now = Date.now()) {
  return {
    schemaVersion: LEDGER_SCHEMA, key, kind: 'ticket', title: null, repo: null, difficulty: null, risk: null,
    role: null, autoStarted: null, model: null, effort: null, status: null, goal: null, queuedAt: null, startedAt: null, closedAt: null,
    sessions: [], prs: [], prNumber: null, mergedAt: null, mergeSha: null, crewShas: [], ownerEdit: null, spendUsd: null,
    tokens: null, cards: {}, ciFailuresBeforeReady: null, qaFirstPass: null, bugs30d: [], reverts30d: [], outcome: null,
    verdict: null, events: [], createdAt: now, updatedAt: now,
  };
}

/** What is wrong with a parsed record's shape, or null. @param {unknown} r */
function recordProblem(r) {
  if (!isObject(r) || typeof r.key !== 'string') return "isn't a ledger record";
  const missing = LIST_FIELDS.find((f) => !Array.isArray(r[f]));
  if (missing) return `has no "${missing}" list`;
  return isObject(r.cards) ? null : 'has no "cards" object';
}

/** One record, or null. Throws CorruptFileError on a damaged file or one of the wrong shape. @param {string} key @returns {LedgerRecord | null} */
export function readRecord(key) {
  if (!isLedgerKey(key)) throw new Error(`"${key}" can't name a ledger record`);
  const r = readJsonStrict(fileOf(key), null);
  const problem = r === null ? null : recordProblem(r);
  if (problem) throw new CorruptFileError(fileOf(key), null, problem);
  return r;
}

/** Every record, by key. Damaged files are skipped and named. @returns {{ records: LedgerRecord[], damaged: string[] }} */
export function listRecords() {
  /** @type {LedgerRecord[]} */
  const records = [];
  /** @type {string[]} */
  const damaged = [];
  let files = [];
  try {
    files = readdirSync(paths.ledger()).filter((f) => f.endsWith('.json')).sort();
  } catch {
    /* no ledger yet */
  }
  for (const f of files) {
    try {
      const r = readJsonStrict(join(paths.ledger(), f), null);
      if (r && recordProblem(r)) damaged.push(f);
      else if (r) records.push(r);
    } catch {
      damaged.push(f);
    }
  }
  return { records, damaged };
}

/** @param {unknown} v */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** @param {unknown} v */
const str = (v) => (typeof v === 'string' && v ? v : null);
/** @param {string[]} into @param {unknown} more */
const union = (into, more) => [...new Set([...into, ...(Array.isArray(more) ? more.filter((x) => typeof x === 'string' && x) : [])])];

/**
 * How each event changes a record. Values are absolute (a spend is the total so far, not an increment), so replaying an
 * event is harmless even when its id was forgotten.
 * @type {Record<string, (r: LedgerRecord, d: Record<string, any>, now: number) => void>}
 */
const APPLY = {
  task(r, d, now) {
    for (const f of TASK_FIELDS) if (d[f] !== undefined && d[f] !== null) /** @type {any} */ (r)[f] = d[f];
    // When it first waited for a seat.
    if (d.status === 'queued' && r.queuedAt == null) r.queuedAt = num(d.rowVersion) ?? now;
    // Back at work (a parked ticket resumed): no outcome until it closes again, so the spend alarm watches it.
    if (['proposed', 'queued', 'active', 'pr', 'qa'].includes(d.status)) r.outcome = null;
    r.sessions = union(r.sessions, d.sessions);
    if (str(d.prUrl)) r.prs = union(r.prs, [d.prUrl]);
  },
  card(r, d) {
    const id = str(d.cardId);
    if (!id) throw new Error('a card event needs cardId');
    const createdAt = num(d.createdAt);
    const answeredAt = num(d.answeredAt);
    r.cards[id] = {
      kind: str(d.kind) ?? 'question', createdAt, answeredAt,
      waitMinutes: createdAt !== null && answeredAt !== null ? Math.max(0, Math.round((answeredAt - createdAt) / 60_000)) : null,
      answer: str(d.answer),
    };
  },
  shas(r, d) {
    r.crewShas = union(r.crewShas, d.shas);
  },
  spend(r, d) {
    // Never down: a folder that left the crew, or a session that joined a worktree later, drops out of the costs sum.
    const usd = num(d.usd);
    const tokens = num(d.tokens);
    if (usd !== null) r.spendUsd = Math.max(r.spendUsd ?? 0, usd);
    if (tokens !== null) r.tokens = Math.max(r.tokens ?? 0, tokens);
  },
  merge(r, d) {
    r.prNumber = num(d.prNumber) ?? r.prNumber;
    r.mergedAt = num(d.mergedAt) ?? r.mergedAt;
    r.mergeSha = str(d.mergeSha) ?? r.mergeSha;
  },
  ci(r, d) {
    r.ciFailuresBeforeReady = num(d.failuresBeforeReady);
  },
  qa(r, d) {
    if (r.qaFirstPass === null && typeof d.passed === 'boolean') r.qaFirstPass = d.passed;
  },
  edits(r, d) {
    const changed = num(d.linesChanged) ?? 0;
    const total = num(d.linesInFinalDiff) ?? 0;
    r.ownerEdit = { shas: union([], d.shas), linesChanged: changed, linesInFinalDiff: total, ratio: total > 0 ? Math.min(1, Math.round((changed / total) * 1000) / 1000) : 0 };
  },
  bug(r, d, now) {
    const ticket = str(d.ticket);
    if (!ticket) throw new Error('a bug event needs ticket');
    if (!r.bugs30d.some((b) => b.ticket === ticket)) r.bugs30d.push({ ticket, severity: str(d.severity), at: num(d.at) ?? now });
  },
  revert(r, d, now) {
    const sha = str(d.sha);
    if (!sha) throw new Error('a revert event needs sha');
    if (!r.reverts30d.some((x) => x.sha === sha)) r.reverts30d.push({ sha, at: num(d.at) ?? now });
  },
  outcome(r, d) {
    if (!OUTCOMES.includes(d.outcome)) throw new Error(`outcome must be one of ${OUTCOMES.join(', ')}`);
    r.outcome = d.outcome;
  },
  output(r, d) {
    if (!OUTPUT_VERDICTS.includes(d.verdict)) throw new Error(`verdict must be one of ${OUTPUT_VERDICTS.join(', ')}`);
    r.kind = 'output';
    r.verdict = d.verdict;
    if (str(d.role)) r.role = d.role;
  },
};
export const LEDGER_EVENTS = Object.keys(APPLY);

/** A stable id for an event that brings none: its type, key and data. @param {string} type @param {string} key @param {unknown} data */
export const eventIdOf = (type, key, data) => `${type}:${createHash('sha256').update(JSON.stringify([key, data])).digest('hex').slice(0, 16)}`;

/**
 * Applies one event to a record, creating it if needed, under the ledger lock. Returns whether anything changed (false
 * when the event id was already applied).
 * @param {string} type @param {string} key @param {Record<string, any>} data `id` optional
 * @param {{ now?: number, lockTimeoutMs?: number }} [opts]
 */
export function applyEvent(type, key, data, { now = Date.now(), lockTimeoutMs = 5000 } = {}) {
  const apply = APPLY[type];
  if (!apply) throw new Error(`unknown ledger event "${type}" (one of ${LEDGER_EVENTS.join(', ')})`);
  if (!isLedgerKey(key)) throw new Error(`"${key}" can't name a ledger record`);
  if (!isObject(data)) throw new Error('event data must be a JSON object');
  const id = str(data.id) ?? eventIdOf(type, key, data);
  mkdirSync(paths.ledger(), { recursive: true });
  return withLock(join(paths.ledger(), '.lock'), () => {
    const r = readRecord(key) ?? emptyRecord(key, now);
    if (r.events.includes(id)) return false;
    apply(r, data, now);
    r.events = [...r.events, id].slice(-MAX_EVENT_IDS);
    r.updatedAt = now;
    writeJsonAtomic(fileOf(key), r);
    return true;
  }, { timeoutMs: lockTimeoutMs });
}

/** @param {string[]} args */
function git(args) {
  const config = ['user.name=Keelcrew', 'user.email=keelcrew@localhost', 'commit.gpgsign=false', 'core.hooksPath=/dev/null', 'init.defaultBranch=main'];
  return execFileSync('git', [...config.flatMap((c) => ['-c', c]), '-C', paths.ledger(), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Commits every change in the ledger as one commit (the repo is created on first use). The panel calls it on a timer,
 * so a hook never waits on git. Returns whether a commit was made.
 * @param {string} [message]
 */
export function commitLedger(message = 'ledger') {
  mkdirSync(paths.ledger(), { recursive: true });
  if (!existsSync(join(paths.ledger(), '.git'))) {
    git(['init', '-q']);
    git(['config', 'core.excludesFile', '/dev/null']);
  }
  return withLock(join(paths.ledger(), '.lock'), () => {
    const indexLock = join(paths.ledger(), '.git', 'index.lock');
    try {
      if (Date.now() - statSync(indexLock).mtimeMs > STALE_INDEX_LOCK_MS) rmSync(indexLock, { force: true });
    } catch {
      /* none */
    }
    git(['add', '-A', '--', ':(glob)*.json']);
    try {
      git(['diff', '--cached', '--quiet']);
      return false;
    } catch {
      git(['commit', '-q', '-m', message]);
      return true;
    }
  });
}

/**
 * Each commit's patch id (`git patch-id --stable`), which a rebase keeps while it gives the commit a new sha. Merges,
 * empty commits and shas git no longer has get none.
 * @param {string} dir @param {string[]} shas @param {number} timeout ms per git call
 * @returns {Map<string, string>} sha to patch id
 */
export function patchIdsOf(dir, shas, timeout) {
  if (!shas.length) return new Map();
  const opts = { encoding: /** @type {const} */ ('utf8'), timeout, maxBuffer: 256 * 1024 * 1024 };
  const diff = execFileSync('git', ['-C', dir, 'log', '--no-walk=unsorted', '--ignore-missing', '--no-merges', '--no-color', '--no-ext-diff', '-p', '--format=commit %H', ...shas], { ...opts, stdio: ['ignore', 'pipe', 'ignore'] });
  const out = execFileSync('git', ['-C', dir, 'patch-id', '--stable'], { ...opts, input: diff, stdio: ['pipe', 'pipe', 'ignore'] });
  return new Map(out.split('\n').filter(Boolean).map((l) => /** @type {[string, string]} */ (l.split(' ').reverse())));
}
