// @ts-check
// Turns what the board and git say into ledger events: task rows and their cards (from a facts file the panel writes,
// since only the panel can read the board), the captain's edits on a crew branch, and each ticket's spend. Every event id
// is derived from the facts it carries, so feeding the same facts again changes nothing.
import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { listAgents } from './agents.mjs';
import { costs } from './costs.mjs';
import { crewDirs, readConfig, readRegistry } from './crew.mjs';
import { CorruptFileError, isObject } from './fsx.mjs';
import { applyEvent, eventIdOf, isLedgerKey, patchIdsOf, readRecord } from './ledger.mjs';
import { baseBranchOf } from './risk.mjs';

const GIT_MS = 10_000;
/** Task statuses after the work is ready: the captain's edits are measured then. */
const READY = new Set(['pr', 'qa', 'done']);

/** @param {unknown} v */
const str = (v) => (typeof v === 'string' && v ? v : null);
/** @param {unknown} v */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * A task row's ledger event data. The row id is the ticket key.
 * @param {Record<string, any>} d
 */
function taskData(d) {
  const agents = isObject(d.agents) ? Object.values(d.agents) : [];
  return {
    title: str(d.title), repo: str(d.repo), kind: str(d.kind), difficulty: str(d.difficulty), risk: str(d.risk),
    role: roleOf(d), goal: str(d.goal), autoStarted: d.autoStarted === true || null,
    model: str(d.model), effort: str(d.effort), status: str(d.status), startedAt: num(d.startedAt), closedAt: num(d.closedAt),
    sessions: [str(d.sessionId), ...agents.map((a) => str(/** @type {any} */ (a)?.sessionId))].filter(Boolean),
    prUrl: str(d.prUrl),
    // Part of the event id only: a row that goes back to an earlier state is still a new event.
    rowVersion: num(d.updatedAt),
  };
}

/**
 * Who worked a row: an engineer session's ticket is the engineer's, a contractor's its own.
 * @param {Record<string, any>} d
 */
function roleOf(d) {
  if (isObject(d.agents?.contractor)) return 'contractor';
  if (isObject(d.agents?.engineer) || str(d.sessionId)) return 'engineer';
  return str(d.assigneeRole);
}

/** The outcome a closed row stands for, or null while it is open. @param {Record<string, any>} d */
function outcomeOf(d) {
  if (d.status === 'cancelled') return 'cancelled';
  if (d.status === 'parked') return 'parked';
  if (d.status === 'done') return str(d.prUrl) ? 'merged' : 'done';
  return null;
}

/** What the captain's answer to a role's card says about its output. @param {string} answer */
const verdictOf = (answer) => (/^(change|edit)/i.test(answer) ? 'edited' : /^(not now|skip|no\b)/i.test(answer) ? 'rejected' : 'accepted');

/**
 * Feeds board facts into the ledger. `tasks` and `inbox` are board docs ({id, data}). Returns how many events changed
 * a record, the keys whose work became ready (their owner edits are measured by the caller), and the keys whose record
 * is damaged (skipped, so one bad file doesn't stop the rest).
 * @param {{ tasks?: { id: string, data: Record<string, any> }[], inbox?: { id: string, data: Record<string, any> }[], merges?: Record<string, any>[] }} facts
 * @param {{ now?: number }} [opts]
 */
export function feed(facts, { now = Date.now() } = {}) {
  let changed = 0;
  /** @type {Set<string>} */
  const ready = new Set();
  /** @type {Set<string>} */
  const damaged = new Set();
  /** @param {string} type @param {string} key @param {Record<string, any>} data */
  const put = (type, key, data) => {
    try {
      if (applyEvent(type, key, { id: eventIdOf(type, key, data), ...data }, { now })) changed++;
    } catch (e) {
      if (!(e instanceof CorruptFileError)) throw e;
      damaged.add(key);
    }
  };
  for (const t of facts.tasks ?? []) {
    if (!isLedgerKey(t.id) || !isObject(t.data)) continue;
    put('task', t.id, taskData(t.data));
    const outcome = outcomeOf(t.data);
    // The row's version is part of the id: done, parked, then done again is a new outcome each time.
    if (outcome) put('outcome', t.id, { outcome, rowVersion: num(t.data.updatedAt) });
    if (READY.has(String(t.data.status))) ready.add(t.id);
  }
  const cards = (facts.inbox ?? []).filter((c) => isObject(c.data) && isLedgerKey(c.data.taskKey));
  cards.sort((a, b) => (num(a.data.createdAt) ?? 0) - (num(b.data.createdAt) ?? 0));
  for (const c of cards) {
    const d = c.data;
    const key = String(d.taskKey);
    put('card', key, {
      cardId: c.id, kind: str(d.kind) ?? 'question', createdAt: num(d.createdAt), answeredAt: num(d.answeredAt),
      answer: str(d.answer),
    });
    // The first QA card with verdicts decides the first pass (the record keeps only the first).
    const cases = Array.isArray(d.cases) ? d.cases : [];
    if (d.kind === 'qa' && cases.length) put('qa', key, { passed: cases.every((x) => x?.verdict === 'pass') });
  }
  // A role's own output (a CTO or PM proposal, a design, a support triage) is judged by the captain's answer to its card.
  const outputRoles = new Set(listAgents().filter((a) => a.outputs?.length && a.memberKind === 'agent').map((a) => a.id));
  for (const c of facts.inbox ?? []) {
    const d = isObject(c.data) ? c.data : null;
    if (!d || !str(d.answer) || !isLedgerKey(c.id)) continue;
    // A suggestion counts toward its source's hit rate; one the Mate started by itself has no answer from the captain to count.
    if (d.autoStarted === true) continue;
    const role = d.from === 'suggest' && str(d.source) ? `suggest:${d.source}` : outputRoles.has(String(d.from)) ? String(d.from) : null;
    if (role) put('output', c.id, { role, verdict: verdictOf(String(d.answer)) });
  }
  for (const m of facts.merges ?? []) {
    if (!isObject(m) || !isLedgerKey(m.key)) continue;
    put('merge', m.key, { prNumber: num(m.prNumber), mergedAt: num(m.mergedAt), mergeSha: str(m.mergeSha) });
  }
  return { changed, ready: [...ready], damaged: [...damaged] };
}

/** @param {string} dir @param {string[]} args */
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_MS }).trim();

/** Added plus removed lines in numstat output (binary files count 0). @param {string} out */
const numstatLines = (out) =>
  out
    .split('\n')
    .map((l) => l.split('\t'))
    .reduce((n, [a, r]) => n + (Number(a) || 0) + (Number(r) || 0), 0);

/**
 * Measures the captain's edits on a ticket's branch: the non-merge commits since the base that the crew didn't make (by
 * sha, or by patch id once a rebase rewrote them) and that no merge brought in from its second parent, as a share of
 * the branch's whole diff. Needs the engineer's worktree (from the registry); null when it is gone.
 * @param {string} key @param {{ packName?: string | null }} [opts]
 */
export function measureEdits(key, { packName } = {}) {
  const r = readRecord(key);
  if (!r) return null;
  const m = crewDirs(readRegistry()).find((x) => x.role === 'engineer' && String(x.key ?? '').toUpperCase() === key.toUpperCase());
  if (!m || !isAbsolute(m.dir)) return null;
  const base = baseBranchOf(m.dir, packName ?? readConfig().pack);
  if (!base) return null;
  let from;
  try {
    from = git(m.dir, ['merge-base', `origin/${base}`, 'HEAD']);
  } catch {
    return null;
  }
  const crew = new Set(r.crewShas);
  // As in the commit hook: what a merge brought in from a teammate's or a stacked branch isn't the captain's.
  const merges = git(m.dir, ['rev-list', '--merges', `${from}..HEAD`]).split('\n').filter(Boolean);
  let owner = git(m.dir, ['rev-list', '--no-merges', `${from}..HEAD`, ...(merges.length ? ['--not', ...merges.map((x) => `${x}^2`)] : [])]).split('\n').filter((s) => s && !crew.has(s));
  if (owner.length && crew.size) {
    const crewIds = new Set(patchIdsOf(m.dir, [...crew], GIT_MS).values());
    const ids = patchIdsOf(m.dir, owner, GIT_MS);
    owner = owner.filter((s) => !crewIds.has(ids.get(s) ?? ''));
  }
  const linesChanged = owner.reduce((n, sha) => n + numstatLines(git(m.dir, ['show', '--numstat', '--format=', sha])), 0);
  const linesInFinalDiff = numstatLines(git(m.dir, ['diff', '--numstat', `${from}..HEAD`]));
  const head = git(m.dir, ['rev-parse', 'HEAD']);
  applyEvent('edits', key, { id: `edits:${head}`, shas: owner, linesChanged, linesInFinalDiff });
  return { owner: owner.length, linesChanged, linesInFinalDiff };
}

/**
 * Records each ticket's spend so far (subagents included), from the crew's transcripts. Only tickets that already have a
 * record get one. Returns the keys updated, and those whose record is damaged (skipped).
 * @param {{ now?: number }} [opts]
 */
export function recordSpend({ now = Date.now() } = {}) {
  const c = costs();
  /** @type {string[]} */
  const updated = [];
  /** @type {string[]} */
  const damaged = [];
  for (const [key, t] of Object.entries(c.tickets)) {
    try {
      if (!isLedgerKey(key) || !readRecord(key)) continue;
      const data = { usd: t.costUsd, tokens: t.tokens };
      if (applyEvent('spend', key, { id: eventIdOf('spend', key, data), ...data }, { now })) updated.push(key);
    } catch (e) {
      if (!(e instanceof CorruptFileError)) throw e;
      damaged.push(key);
    }
  }
  return { updated, damaged };
}
