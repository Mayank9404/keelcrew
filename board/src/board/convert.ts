/**
 * Database rows to the board's view model. Pure: no DOM, no runtime, so it's unit tested. Every reader tolerates
 * partial fields: a field a skill hasn't written yet reads as empty, never as an error.
 */
import { isJiraKey, taskKindOf } from '../lib/keys';
import { DIFFICULTIES } from '../lib/org';
import { isObj } from '../lib/versions';
import type {
  Activity, Allowance, ApprovalCheck, CardItem, CardLesson, ChatMessage, ContractItem, Costs, Decision, Difficulty, Draft, Effort, Evidence, EvidenceKind,
  Handoff, InboxItem, InboxKind, InboxStatus, MemoryList, MergeRecord, ModelChoice, OrgInfo, PendingRequest, Phase, PostGrant, PostTarget, QaCase,
  QaVerdict, Receipt, Receipts, Retro, Risk, RiskTier, ScheduleInfo, Session, SpendFlag, SpendState, HealthState, Task, TaskAgent, TaskStatus, Validation,
  ValidationEntry, ValidationStatus, WalkthroughGroup,
} from '../types';

/** A document as the board keeps it: its body plus its id and the version this page saw. */
export type Row = Record<string, unknown> & { _id: string; _v: string };

/** A crew session on this Mac, from the helper's `crew_state`. */
export interface Member {
  dir: string;
  role: 'lead' | 'engineer' | 'agent' | 'job';
  key: string | null;
  /** The agent id (`engineer` for engineers, `qa`, …); null for the Mate. */
  agent: string | null;
  sessionId: string | null;
  lastTool: string | null;
  lastText: string | null;
  activity: string;
  busy: boolean;
  lastAt: number | null;
  /** When a mod last ran in the session: it's open even when nothing happened in it. */
  aliveAt: number | null;
  repo: string | null;
  contextTokens: number | null;
  contextMax: number | null;
  costUsd: number;
  model: string | null;
  turns: number;
  /** Crew policy paused it after repeated denials. */
  paused: boolean;
}

export const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const strings = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split('\n') : [])
    .map((x) => (isObj(x) ? str(x.text) || str(x.why) || str(x.reason) || str(x.title) : typeof x === 'string' ? x : x == null ? '' : String(x)))
    .map((x) => x.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean);
/** A JSON object stored as text, or the object itself. */
const objectOf = (v: unknown): Record<string, unknown> | null => {
  if (isObj(v)) return v;
  if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) return null;
  try {
    const parsed: unknown = JSON.parse(v);
    return isObj(parsed) ? parsed : Array.isArray(parsed) ? { groups: parsed } : null;
  } catch {
    return null;
  }
};

const STATUSES: TaskStatus[] = ['proposed', 'queued', 'active', 'pr', 'qa', 'done', 'cancelled'];
const PHASES: Phase[] = ['spec', 'plan', 'build', 'verify', 'review', 'approval', 'pr', 'qa', 'done'];
const ACTIVITIES: Activity[] = ['typing', 'reading', 'terminal', 'thinking', 'waiting', 'idle'];

/** "pass"/"PASS"/true → pass, "fail"/false → fail, "skip"/"not-testable" → skip. */
function verdictOf(v: unknown): 'pass' | 'fail' | 'skip' | null {
  if (v === true) return 'pass';
  if (v === false) return 'fail';
  const s = str(v).toLowerCase();
  if (/^(pass|passed|ok|green|success)/.test(s)) return 'pass';
  if (/^(fail|failed|error|red|broken)/.test(s)) return 'fail';
  if (/^(skip|skipped|not-testable|n\/a|partial|blocked)/.test(s)) return 'skip';
  return null;
}

/* ---------- contract, validation, risk ---------- */

/** `contract: [{id, text, kind}]`; a bare "VAL-X-01: text" string works too. */
export function contractOf(v: unknown): ContractItem[] {
  if (!Array.isArray(v)) return [];
  const out: ContractItem[] = [];
  v.forEach((c, i) => {
    if (typeof c === 'string') {
      const m = /^\s*(VAL-[\w-]*\d)\s*(?::|·|\s-\s)\s*(.+)$/.exec(c);
      if (c.trim()) out.push({ id: m?.[1] ?? `#${i + 1}`, text: m?.[2] ?? c.trim(), kind: /\b(not|never|unchanged|reject|deny|forbidden|4\d\d)\b/i.test(c) ? 'negative' : 'positive' });
      return;
    }
    if (!isObj(c)) return;
    const id = str(c.id) || `#${i + 1}`;
    const text = str(c.text) || str(c.assertion) || str(c.title);
    if (text) out.push({ id, text, kind: c.kind === 'negative' ? 'negative' : 'positive' });
  });
  return out;
}

/** pass, fail, or untested for anything else (skip, env, blocked, a missing status). */
function validationStatusOf(v: unknown): ValidationStatus {
  const s = str(v).toLowerCase();
  if (v === true || /^(pass|passed|ok|green|flaky)/.test(s)) return 'pass';
  if (v === false || /^(fail|failed|red|broken)/.test(s)) return 'fail';
  return 'untested';
}

/** `validation: {[id]: {status, by, evidence, at}}`; a bare status string per id works too. */
function validationOf(v: unknown): Validation {
  if (!isObj(v)) return {};
  const out: Validation = {};
  for (const [id, e] of Object.entries(v)) {
    const entry: ValidationEntry = isObj(e)
      ? { status: validationStatusOf(e.status), by: strOrNull(e.by), evidence: str(e.evidence) || str(e.note) || str(e.why), at: num(e.at) }
      : { status: validationStatusOf(e), by: null, evidence: '', at: null };
    out[id] = entry;
  }
  return out;
}

const TIERS: RiskTier[] = ['low', 'medium', 'high'];

/** `risk: {tier, reasons, files, added, deleted}` (files may be a list), or a bare tier. */
export function riskOf(v: unknown): Risk | null {
  if (typeof v === 'string' && v.trim()) {
    const t = v.trim().toLowerCase() as RiskTier;
    return { tier: TIERS.includes(t) ? t : 'unknown', reasons: [], files: null, added: null, deleted: null };
  }
  if (!isObj(v)) return null;
  const t = str(v.tier).toLowerCase() as RiskTier;
  return {
    tier: TIERS.includes(t) ? t : 'unknown',
    reasons: strings(v.reasons),
    files: Array.isArray(v.files) ? v.files.length : num(v.files),
    added: num(v.added),
    deleted: num(v.deleted),
  };
}

/** `riskNotes`: a list of lines, one block of text, or `{reason: note}`. */
function riskNotesOf(v: unknown): string[] {
  if (isObj(v)) return Object.entries(v).map(([reason, note]) => (str(note) ? `${reason}: ${str(note)}` : reason));
  return strings(v);
}

function postOf(v: unknown): PostTarget | null {
  if (!isObj(v) || !str(v.tool).trim()) return null;
  return { tool: str(v.tool).trim(), match: strOrNull(v.match) };
}

/** `postGrant`: true, a grant id, or `{id, at, expires}` (the helper's `post`). */
function postGrantOf(v: unknown): PostGrant | null {
  if (v === true) return { id: null, at: null, expires: null };
  if (typeof v === 'string' && v.trim()) return { id: v.trim(), at: null, expires: null };
  if (!isObj(v)) return null;
  return { id: strOrNull(v.id), at: num(v.at) ?? num(v.createdAt), expires: num(v.expires) };
}

/* ---------- tasks ---------- */

function receiptOf(v: unknown): Receipt | null {
  if (typeof v === 'string' && v.trim()) return { status: v, at: null, head: null, detail: '' };
  if (!isObj(v)) return null;
  const findings = Array.isArray(v.findings) ? v.findings.filter((f) => !isObj(f) || f.state === undefined || f.state === 'open').length : null;
  const bits = [findings ? `${findings} finding${findings === 1 ? '' : 's'} open` : '', num(v.round) ? `round ${v.round}` : '', str(v.summary)].filter(Boolean);
  return { status: str(v.status, str(v.verdict, 'done')), at: num(v.at), head: strOrNull(v.head), detail: bits.join(' · ') };
}

/** `receipts {head, review, tests}`, or null when there are none. */
export function receiptsOf(v: unknown): Receipts | null {
  if (!isObj(v)) return null;
  const head = strOrNull(v.head);
  const review = receiptOf(v.review);
  const tests = receiptOf(v.tests);
  if (!head && !review && !tests) return null;
  const stale = !!head && [review, tests].some((r) => !!r?.head && r.head !== head);
  return { head, review, tests, stale };
}

const RESULT_RE = /KEEL_RESULT\b.*?\bstatus=(\S+).*?\bsummary="((?:[^"\\]|\\.)*)"/;

/** A `KEEL_RESULT agent=… status=DONE summary="…"` line as "DONE: …"; any other text as it is. */
export function resultLine(text: string): string {
  const m = RESULT_RE.exec(text);
  return m ? `${m[1]}: ${m[2].replace(/\\"/g, '"')}` : text.trim();
}

/** The status word of a result line: DONE, DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT; null for other text. */
function resultStatusOf(text: string): string | null {
  const m = RESULT_RE.exec(text) ?? /^\s*(DONE_WITH_CONCERNS|DONE|BLOCKED|NEEDS_CONTEXT)\b/.exec(text);
  return m ? m[1] : null;
}

/** `tasks/{KEY}.agents`: `{id: {sessionId, sessionLink, status, result, verdict, round, paused?, denials?}}`. */
function taskAgentsOf(v: unknown): TaskAgent[] {
  if (!isObj(v)) return [];
  return Object.entries(v)
    .filter(([, a]) => isObj(a))
    .map(([id, a]) => {
      const o = a as Record<string, unknown>;
      const raw = str(o.result);
      const denials = isObj(o.denials) ? o.denials : null;
      const pauseReasons = strings(o.pauseReasons ?? o.pausedReasons ?? denials?.reasons);
      return {
        id,
        status: str(o.status, 'unknown'),
        result: resultLine(raw),
        resultStatus: resultStatusOf(raw),
        verdict: strOrNull(o.verdict),
        round: num(o.round),
        sessionId: strOrNull(o.sessionId),
        sessionLink: strOrNull(o.sessionLink),
        at: num(o.at) ?? num(o.updatedAt),
        paused: o.paused === true || denials?.paused === true || /^paused$/i.test(str(o.status)),
        pauseReasons,
      };
    });
}

/** Scalars of an object as label/value pairs (the shepherd's PR watch state and other generic blocks). */
function pairsOf(v: unknown): { label: string; value: string }[] {
  if (!isObj(v)) return [];
  return Object.entries(v)
    .filter(([, x]) => x !== null && x !== undefined && x !== '' && (typeof x !== 'object' || Array.isArray(x)))
    .map(([k, x]) => ({ label: k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(), value: Array.isArray(x) ? x.map((y) => (isObj(y) ? str(y.title) || str(y.name) || JSON.stringify(y) : String(y))).join(', ') : String(x) }));
}

interface TaskContext {
  member?: Member;
  /** Files each engineer changed (the helper's `changed_files`). */
  overlaps: Record<string, string[]>;
  now: number;
}

export function toTask(r: Row, ctx: TaskContext): Task {
  const key = r._id;
  const m = ctx.member;
  const status = str(r.status, 'proposed');
  const mapped: TaskStatus = status === 'parked' ? 'active' : STATUSES.includes(status as TaskStatus) ? (status as TaskStatus) : 'proposed';
  const files = ctx.overlaps[key] ?? [];
  const overlaps = files.length
    ? Object.entries(ctx.overlaps)
        .filter(([k, f]) => k !== key && f.some((x) => files.includes(x)))
        .map(([k, f]) => ({ key: k, files: f.filter((x) => files.includes(x)) }))
    : [];
  const source = str(r.source) || (isJiraKey(key) ? 'jira' : 'board');
  const live = !!m || status === 'active' || status === 'parked';
  return {
    key,
    kind: r.kind === 'adhoc' || r.kind === 'ticket' ? r.kind : taskKindOf(key, r.source),
    title: str(r.title, key),
    description: str(r.description),
    repo: str(r.repo, m?.repo ?? ''),
    source,
    status: mapped,
    parked: status === 'parked',
    phase: PHASES.includes(r.phase as Phase) ? (r.phase as Phase) : 'spec',
    difficulty: DIFFICULTIES.includes(r.difficulty as Difficulty) ? (r.difficulty as Difficulty) : 'moderate',
    needsDecision: r.waiting === 'you' || r.needsDecision === true,
    branch: strOrNull(r.branch),
    worktree: m?.dir ?? strOrNull(r.worktree),
    prUrl: strOrNull(r.prUrl),
    jiraStatus: strOrNull(r.jiraStatus),
    spec: str(r.spec),
    contract: contractOf(r.contract),
    validation: validationOf(r.validation),
    reopened: r.reopened === true,
    slot: status === 'active' ? num(r.cabin) : null,
    sessionId: m?.sessionId ?? strOrNull(r.sessionId) ?? (live ? `keel-${key}` : null),
    overlaps,
    agents: taskAgentsOf(r.agents),
    receipts: receiptsOf(r.receipts),
    shepherd: pairsOf(r.shepherd),
    costUsd: m?.costUsd ?? num(r.costUsd) ?? 0,
    budgetUsd: num(r.budgetUsd),
    contractor: r.role === 'contractor' || m?.agent === 'contractor' || (isObj(r.agents) && isObj(r.agents.contractor)),
    goal: strOrNull(r.goal),
    autoStarted: r.autoStarted === true,
    mergedAt: num(r.mergedAt),
    lastSummary: str(r.summary ?? r.lastSummary),
    createdAt: num(r.createdAt) ?? num(r.startedAt) ?? num(r.updatedAt) ?? ctx.now,
    startedAt: num(r.startedAt),
    updatedAt: num(r.updatedAt) ?? ctx.now,
    closedAt: num(r.closedAt),
  };
}

/* ---------- cards ---------- */

const KINDS: InboxKind[] = ['ship', 'proposal', 'question', 'qa', 'conflict', 'playbook', 'info', 'start'];

/** Database card kinds; anything unknown reads as a question. */
function inboxKindOf(kind: unknown): InboxKind {
  return KINDS.includes(kind as InboxKind) ? (kind as InboxKind) : 'question';
}

/** Who posted a card: `engineer`, `lead`, or an agent id. */
function fromOf(from: unknown, kind: InboxKind): string {
  const f = str(from);
  if (f) return f;
  return kind === 'ship' ? 'engineer' : kind === 'qa' ? 'qa' : kind === 'playbook' || kind === 'conflict' ? 'learner' : 'lead';
}

const STATUS_OF: InboxStatus[] = ['open', 'approved', 'rejected', 'answered', 'dismissed'];
/** What the Mate acts on for a proposal without its own options. */
export const PROPOSAL_OPTIONS = ['Start it', 'Not now', 'Skip it'];
/** A standing-orders card without its own options. */
const PLAYBOOK_OPTIONS = ['Approve', 'Not now'];
/** A start card's answers besides its Start button, when it sends none. */
export const START_OPTIONS = ['Not now'];

function checksOf(v: unknown): ApprovalCheck[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isObj)
    .map((c) => ({ name: str(c.name, 'check'), status: (verdictOf(c.status) ?? 'skip') as ApprovalCheck['status'], ...(str(c.detail) ? { detail: str(c.detail) } : {}) }));
}

/** A QA case verdict: pass, fail, flaky, env, blocked. */
function qaVerdictOf(v: unknown): QaVerdict {
  if (v === true) return 'pass';
  if (v === false) return 'fail';
  const s = str(v).toLowerCase();
  if (/^flak/.test(s)) return 'flaky';
  if (/^(pass|passed|ok|green|success)/.test(s)) return 'pass';
  if (/^(fail|failed|error|red|broken)/.test(s)) return 'fail';
  if (/^env/.test(s)) return 'env';
  if (/^(block|skip|n\/a|not-testable)/.test(s)) return 'blocked';
  return 'unknown';
}

function casesOf(v: unknown): QaCase[] {
  if (!Array.isArray(v)) return [];
  return v.map((c, i) => {
    if (typeof c === 'string') return { id: `${i + 1}`, text: c, verdict: 'unknown' as QaVerdict, note: '', expected: '', actual: '', evidenceId: null, screenshot: null };
    const o = isObj(c) ? c : {};
    const id = str(o.id, `${i + 1}`);
    return {
      id,
      text: str(o.ac) || str(o.text) || str(o.step) || str(o.name) || str(o.assertion),
      verdict: qaVerdictOf(o.verdict ?? o.status ?? o.result),
      note: str(o.note) || str(o.detail),
      expected: str(o.expected),
      actual: str(o.actual),
      evidenceId: strOrNull(o.evidenceId),
      screenshot: strOrNull(o.screenshot),
    };
  });
}

const scopeText = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (!isObj(v)) return '';
  return Object.entries(v)
    .filter(([, x]) => typeof x === 'string' && x)
    .map(([k, x]) => `${k} ${x}`)
    .join(' · ');
};

function lessonOf(v: unknown): CardLesson | null {
  if (typeof v === 'string' && v.trim()) return { key: v, text: v, type: '', status: '', scope: '', confidence: null, evidence: [] };
  if (!isObj(v)) return null;
  const evidence = Array.isArray(v.evidence) ? v.evidence.map((e) => (isObj(e) ? str(e.quote) || str(e.ref) || str(e.source) : str(e))).filter(Boolean) : [];
  return { key: str(v.key) || str(v.id), text: str(v.text), type: str(v.type), status: str(v.status), scope: scopeText(v.scope), confidence: num(v.confidence), evidence };
}

/** A card's lessons: `lessons: [...]`. */
function lessonsOf(r: Record<string, unknown>): CardLesson[] {
  const raw = Array.isArray(r.lessons) ? r.lessons : [];
  return raw.map(lessonOf).filter((l): l is CardLesson => !!l && !!l.text);
}

function draftOf(v: unknown): Draft | null {
  if (!isObj(v) || !(str(v.body) || Array.isArray(v.comments))) return null;
  return {
    channel: str(v.channel),
    destination: str(v.destination),
    mode: str(v.mode),
    subject: str(v.subject),
    body: str(v.body),
    evidenceId: strOrNull(v.evidenceId),
    comments: Array.isArray(v.comments) ? v.comments.filter(isObj).map((c) => ({ path: str(c.path), line: num(c.line), body: str(c.body) })) : [],
  };
}

/** Batch question items and digest items share one shape. */
function itemsOf(v: unknown): CardItem[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).map((x, i) => ({
    id: str(x.id) || `item-${i + 1}`,
    title: str(x.title) || str(x.subject) || str(x.ask) || `Item ${i + 1}`,
    summary: str(x.summary),
    recommendation: strOrNull(x.recommendation),
    options: Array.isArray(x.options) ? x.options.filter((o): o is string => typeof o === 'string' && !!o.trim()).slice(0, 4) : [],
    answer: strOrNull(x.answer),
    answeredAt: num(x.answeredAt),
    taskKey: strOrNull(x.taskKey),
    urgent: x.urgent === true,
    sessionId: strOrNull(x.sessionId),
    channel: str(x.channel),
    from: str(x.from),
    link: strOrNull(x.link) ?? strOrNull(x.url),
    ask: str(x.ask),
    due: str(x.due),
    draft: typeof x.draft === 'string' ? x.draft : isObj(x.draft) ? str(x.draft.body) : '',
    post: postOf(x.post),
    postGrant: postGrantOf(x.postGrant),
  }));
}

function commandsOf(v: unknown): InboxItem['commands'] {
  if (Array.isArray(v)) return v.filter(isObj).map((c) => ({ option: str(c.option) || str(c.label), commands: (Array.isArray(c.commands) ? c.commands : [c.command ?? c.commands]).map((x) => str(x)).filter(Boolean) }));
  if (isObj(v)) return Object.entries(v).map(([option, c]) => ({ option, commands: (Array.isArray(c) ? c : [c]).map((x) => str(x)).filter(Boolean) }));
  return [];
}

function proposalOf(v: unknown): InboxItem['proposal'] {
  if (!isObj(v)) return null;
  return { title: str(v.title), repo: str(v.repo), difficulty: str(v.difficulty), description: str(v.description), agent: str(v.agent), prUrl: strOrNull(v.prUrl), jiraKey: strOrNull(v.jiraKey) };
}

/** A start card's `start: {proposal, model, effort}` (a card's `brief` field is ignored); null when it isn't an object. */
export function startOf(v: unknown): InboxItem['start'] {
  if (!isObj(v)) return null;
  return { proposal: strOrNull(v.proposal), model: strOrNull(v.model), effort: strOrNull(v.effort) };
}

const fraction = (v: unknown): number | null => {
  const n = num(v);
  return n == null ? null : n > 1 ? n / 100 : n;
};

/** Whether a card's `grantPending` hands its answer to the Mac: the answer's snapshot (anything but false or null). */
const handedToMac = (v: unknown): boolean => v !== undefined && v !== null && v !== false;

export function toInbox(r: Row): InboxItem {
  const kind = inboxKindOf(r.kind);
  let options = Array.isArray(r.options) ? r.options.filter((o): o is string => typeof o === 'string' && !!o.trim()) : [];
  if (kind !== 'ship') options = options.slice(0, 4);
  if (kind === 'proposal' && !options.length) options = PROPOSAL_OPTIONS;
  if (kind === 'playbook' && !options.length) options = PLAYBOOK_OPTIONS;
  if (kind === 'start' && !options.length) options = START_OPTIONS;
  const title = str(r.title);
  return {
    id: r._id,
    version: r._v,
    kind,
    from: fromOf(r.from, kind),
    taskKey: strOrNull(r.taskKey),
    title,
    body: kind === 'ship' ? str(r.body) || str(r.summary) : str(r.summary) || str(r.body),
    options,
    recommendation: strOrNull(r.recommendation),
    neverAskKey: strOrNull(r.neverAskKey),
    urgent: r.urgent === true,
    diffstat: strOrNull(r.diffstat),
    checks: checksOf(r.checks),
    notes: strOrNull(r.notes),
    receipts: receiptsOf(r.receipts),
    risk: riskOf(r.risk),
    riskNotes: riskNotesOf(r.riskNotes),
    validation: isObj(r.validation) ? validationOf(r.validation) : null,
    walkthroughId: strOrNull(r.walkthroughId),
    withdrawn: strOrNull(r.withdrawn),
    verdict: strOrNull(r.verdict),
    cases: casesOf(r.cases ?? r.steps),
    flakeRate: fraction(r.flakeRate),
    url: strOrNull(r.url),
    round: num(r.round),
    head: strOrNull(r.head),
    lessons: kind === 'conflict' || kind === 'playbook' ? lessonsOf(r) : [],
    commands: commandsOf(r.commands),
    diff: strOrNull(r.diff),
    draft: draftOf(r.draft),
    post: postOf(r.post),
    postGrant: postGrantOf(r.postGrant),
    batch: r.batch === true,
    items: itemsOf(r.items),
    proposal: proposalOf(r.proposal),
    start: startOf(r.start),
    rationale: strOrNull(r.rationale),
    confidence: fraction(r.confidence),
    fingerprint: strOrNull(r.fingerprint),
    source: strOrNull(isObj(r.source) ? r.source.kind : r.source),
    security: r.security === true,
    autoStarted: r.autoStarted === true,
    rank: num(r.rank),
    held: r.held === true,
    heldReason: strOrNull(r.heldReason),
    sessionId: strOrNull(r.sessionId),
    // A phone answer the Mac couldn't carry out is open again for the captain.
    status: !handedToMac(r.grantPending) && str(r.grantError) ? 'open' : STATUS_OF.includes(r.status as InboxStatus) ? (r.status as InboxStatus) : 'open',
    answer: strOrNull(r.answer),
    note: strOrNull(r.note),
    createdAt: num(r.createdAt) ?? 0,
    resolvedAt: num(r.resolvedAt ?? r.answeredAt),
    grantPending: handedToMac(r.grantPending),
    grantResult: strOrNull(r.grantResult),
    grantError: strOrNull(r.grantError),
  };
}

/* ---------- chat, decisions, requests ---------- */

function metricValue(v: unknown): string {
  if (!isObj(v)) return v == null ? 'unavailable' : String(v);
  const cur = v.thisWeek ?? v.this ?? v.value ?? v.current;
  const last = v.lastWeek ?? v.last ?? v.previous;
  const change = v.change ?? v.delta;
  const extra = [last !== undefined ? String(last) : '', change !== undefined ? String(change) : ''].filter(Boolean).join(', ');
  return `${cur ?? 'unavailable'}${extra ? ` (${extra})` : ''}`;
}

/** A retro chat document's `retro: {week, metrics, recommendations}`. */
export function retroOf(v: unknown): Retro | null {
  if (!isObj(v)) return null;
  const metrics = Array.isArray(v.metrics)
    ? v.metrics.filter(isObj).map((m) => ({ label: str(m.label) || str(m.name) || 'metric', value: metricValue(m) }))
    : isObj(v.metrics)
      ? Object.entries(v.metrics).map(([label, m]) => ({ label, value: metricValue(m) }))
      : [];
  const recommendations = Array.isArray(v.recommendations)
    ? v.recommendations.map((x) => (isObj(x) ? [str(x.text) || str(x.title), str(x.status) || str(x.score)].filter(Boolean).join(' · ') : str(x))).filter(Boolean)
    : [];
  return { week: str(v.week) || (typeof v.week === 'number' ? String(v.week) : ''), metrics, recommendations };
}

/** Chat `who`: `me`; `lead` (or unset); anything else is a crew note. */
export function whoOf(who: unknown): ChatMessage['who'] {
  if (who === 'me') return 'me';
  if (who === 'lead' || who === undefined || who === null) return 'lead';
  return 'system';
}

export function toChat(r: Row): ChatMessage {
  return { id: r._id, who: whoOf(r.who), text: str(r.text), taskKey: strOrNull(r.taskKey), ts: num(r.ts) ?? 0, retro: retroOf(r.retro) };
}

export function toDecision(r: Row): Decision {
  return { id: r._id, topic: str(r.topic), decision: str(r.decision), taskKey: strOrNull(r.taskKey), createdAt: num(r.createdAt) ?? 0 };
}

export function toRequest(r: Row): PendingRequest {
  return {
    id: r._id,
    kind: str(r.kind),
    key: strOrNull(r.key),
    action: strOrNull(r.action) ?? strOrNull(r.op),
    agent: strOrNull(r.agent) ?? (r.kind === 'agent' ? strOrNull(r.id) : null),
    text: str(r.text) || str(r.note),
    at: num(r.at) ?? num(r.createdAt) ?? 0,
  };
}

/* ---------- evidence ---------- */

const EVIDENCE_KINDS: EvidenceKind[] = ['command', 'response', 'diff', 'plan', 'review', 'qa', 'note', 'screenshot', 'context', 'handoff', 'walkthrough'];

/** A handoff's `{state, decisions, deadEnds, next, questions}`, from an object or JSON text. */
function handoffOf(v: unknown): Handoff | null {
  const o = objectOf(v);
  if (!o) return null;
  const h = { state: str(o.state), decisions: strings(o.decisions), deadEnds: strings(o.deadEnds ?? o.dead_ends), next: str(o.next), questions: strings(o.questions) };
  return h.state || h.next || h.decisions.length || h.deadEnds.length || h.questions.length ? h : null;
}

const SEVERITIES: WalkthroughGroup['severity'][] = ['blocker', 'major', 'minor', 'nit', 'none'];

/** A walkthrough's `{groups: [{intent, files, notes, severity}]}`, from an object or JSON text. */
function walkthroughOf(v: unknown): WalkthroughGroup[] | null {
  const o = objectOf(v);
  if (!o || !Array.isArray(o.groups)) return null;
  return o.groups.filter(isObj).map((g) => {
    const sev = str(g.severity).toLowerCase() as WalkthroughGroup['severity'];
    return { intent: str(g.intent) || 'Changes', files: strings(g.files), notes: Array.isArray(g.notes) ? strings(g.notes).join('\n') : str(g.notes), severity: SEVERITIES.includes(sev) ? sev : 'none' };
  });
}

export function toEvidence(r: Row, taskKey: string): Evidence {
  const kind = EVIDENCE_KINDS.includes(r.kind as EvidenceKind) ? (r.kind as EvidenceKind) : 'note';
  const raw = r.content;
  const content = typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw, null, 2);
  return {
    id: r._id,
    taskKey,
    title: str(r.title, 'Evidence'),
    kind,
    content,
    handoff: kind === 'handoff' ? handoffOf(raw) : null,
    walkthrough: kind === 'walkthrough' ? walkthroughOf(raw) : null,
    tags: strings(r.tags),
    agent: strOrNull(r.agent),
    createdAt: num(r.createdAt) ?? 0,
  };
}

/* ---------- sessions ---------- */

const RUNNING_FRESH_MS = 30 * 60_000;
const IDLE_SEEN_MS = 15 * 60_000;

/** A session's state from what the helper saw: running while busy and fresh, idle while seen lately, else parked. */
function sessionStatus(m: Pick<Member, 'busy' | 'lastAt' | 'aliveAt'>, now: number): Session['status'] {
  if (m.busy && m.lastAt && now - m.lastAt < RUNNING_FRESH_MS) return 'running';
  const seen = Math.max(m.lastAt ?? 0, m.aliveAt ?? 0);
  return seen && now - seen < IDLE_SEEN_MS ? 'idle' : 'parked';
}

/** The helper's member to a session. The engineer of a task gets the task's effort; `inUse` (Settings → Crew) fills what neither says. */
export function memberSession(m: Member, row: Row | undefined, now: number, inUse: ModelChoice): Session {
  const status = sessionStatus(m, now);
  const role: Session['role'] = m.role === 'lead' ? 'lead' : m.role === 'engineer' || m.agent === 'engineer' ? 'engineer' : 'agent';
  return {
    id: m.sessionId ?? `keel-${m.key ?? (m.role === 'job' ? 'job' : 'lead')}${role === 'agent' && m.agent ? `-${m.agent}` : ''}`,
    taskKey: role === 'lead' ? null : m.key,
    role,
    agent: role === 'agent' ? m.agent : role === 'engineer' ? 'engineer' : null,
    job: m.role === 'job',
    model: m.model ?? (str(row?.model) || inUse.model),
    effort: ((row?.effort as Effort) ?? inUse.effort) as Effort,
    status,
    activity: (status === 'running' && ACTIVITIES.includes(m.activity as Activity) ? m.activity : 'idle') as Activity,
    lastTool: m.lastTool,
    lastText: m.lastText,
    costUsd: m.costUsd,
    turns: m.turns,
    cwd: m.dir,
    createdAt: m.lastAt ?? now,
    updatedAt: m.lastAt ?? now,
    lastEventAt: m.lastAt ?? now,
    contextTokens: m.contextTokens,
    contextMax: m.contextMax,
    paused: m.paused,
  };
}

/** A `crew_state` member, tolerant of helpers that leave out `agent`, `aliveAt` or `paused`. */
export function memberOf(v: unknown): Member | null {
  if (!isObj(v) || !str(v.dir)) return null;
  const role = v.role === 'lead' || v.role === 'engineer' || v.role === 'agent' || v.role === 'job' ? v.role : 'engineer';
  return {
    dir: str(v.dir),
    role,
    key: strOrNull(v.key),
    agent: strOrNull(v.agent) ?? (role === 'engineer' ? 'engineer' : null),
    sessionId: strOrNull(v.sessionId),
    lastTool: strOrNull(v.lastTool),
    lastText: strOrNull(v.lastText),
    activity: str(v.activity, 'idle'),
    busy: v.busy === true,
    lastAt: num(v.lastAt),
    aliveAt: num(v.aliveAt),
    repo: strOrNull(v.repo),
    contextTokens: num(v.contextTokens),
    contextMax: num(v.contextMax),
    costUsd: num(v.costUsd) ?? 0,
    model: strOrNull(v.model),
    turns: num(v.turns) ?? 0,
    paused: v.paused === true,
  };
}

/* ---------- crew documents ---------- */

/** One `crew/schedules.items[]` entry (the Mate writes them, keyed by agent; jobs add lastResult, openIssues, handoff). */
export function toSchedule(v: unknown): ScheduleInfo | null {
  if (!isObj(v) || !str(v.id)) return null;
  const issues = v.openIssues;
  const keys = isObj(issues) ? Object.keys(issues) : Array.isArray(issues) ? issues.map((x) => str(x)).filter(Boolean) : [];
  return {
    id: str(v.id),
    agent: strOrNull(v.agent),
    label: str(v.label) || str(v.id),
    cadence: str(v.cadence),
    enabled: v.enabled !== false,
    lastRun: num(v.lastRun),
    nextRun: num(v.nextRun),
    lastResult: resultLine(str(v.lastResult)),
    openIssues: num(issues) ?? (keys.length ? keys.length : null),
    openIssueKeys: keys,
    handoff: handoffOf(v.handoff),
  };
}

/** The helper's `costs` answer, tolerant of missing parts. */
export function costsOf(v: unknown): Costs | null {
  if (!isObj(v)) return null;
  const spend = (x: unknown) => (isObj(x) ? { costUsd: num(x.costUsd) ?? 0, tokens: num(x.tokens) ?? 0 } : { costUsd: num(x) ?? 0, tokens: 0 });
  const tickets: Costs['tickets'] = {};
  if (isObj(v.tickets))
    for (const [k, t] of Object.entries(v.tickets)) {
      const byRole: Record<string, number> = {};
      if (isObj(t) && isObj(t.byRole)) for (const [r, c] of Object.entries(t.byRole)) byRole[r] = num(c) ?? 0;
      tickets[k] = { ...spend(t), byRole };
    }
  const roles: Costs['roles'] = {};
  if (isObj(v.roles)) for (const [k, r] of Object.entries(v.roles)) roles[k] = spend(r);
  const members = Array.isArray(v.members)
    ? v.members.filter(isObj).map((m) => ({ key: strOrNull(m.key), agent: strOrNull(m.agent), role: str(m.role, 'agent'), costUsd: num(m.costUsd) ?? 0, tokens: num(m.tokens) ?? 0, since: num(m.since) }))
    : [];
  return { members, tickets, roles, totalUsd: num(v.totalUsd) ?? members.reduce((a, m) => a + m.costUsd, 0) };
}

/** The helper's `memory_list` answer, tolerant of shapes from other helper versions. */
export function memoryOf(r: unknown): MemoryList {
  const o = (r ?? {}) as { lessons?: unknown; playbook?: unknown };
  const lessons = Array.isArray(o.lessons) ? o.lessons : Array.isArray(r) ? (r as unknown[]) : [];
  return {
    playbook: typeof o.playbook === 'string' ? o.playbook : '',
    lessons: lessons
      .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
      .map((l) => ({
        id: str(l.id) || str(l.key),
        at: num(l.at),
        type: str(l.type, 'preference'),
        key: str(l.key) || str(l.id),
        text: str(l.text),
        scope: (l.scope && typeof l.scope === 'object' ? l.scope : {}) as MemoryList['lessons'][number]['scope'],
        evidence: Array.isArray(l.evidence) ? (l.evidence as MemoryList['lessons'][number]['evidence']) : [],
        confidence: num(l.confidence),
        status: l.status === 'pinned' || l.status === 'retired' || l.status === 'candidate' ? l.status : 'active',
      })),
  };
}

/* ---------- the company ---------- */

const record = <T>(v: unknown, read: (x: unknown) => T | null): Record<string, T> => {
  if (!isObj(v)) return {};
  const out: Record<string, T> = {};
  for (const [k, x] of Object.entries(v)) {
    const r = read(x);
    if (r !== null) out[k] = r;
  }
  return out;
};
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);

const allowanceOf = (v: unknown): Allowance | null =>
  isObj(v) ? { allowancePct: num(v.allowancePct), usedPct: num(v.usedPct), spentUsd: num(v.spentUsd) ?? 0 } : null;

const flagOf = (v: unknown): SpendFlag | null =>
  isObj(v) && (v.level === 'soft' || v.level === 'hard') ? { level: v.level, spendUsd: num(v.spendUsd), softUsd: num(v.softUsd), hardUsd: num(v.hardUsd), at: num(v.at) } : null;

/** `crew_state.spend` (spend.json), or null before it's written. */
export function spendOf(v: unknown): SpendState | null {
  if (!isObj(v) || num(v.at) === null) return null;
  return { at: num(v.at)!, departments: record(v.departments, allowanceOf), flags: record(v.flags, flagOf) };
}

/** `crew_state.health` (health.json), or null before it's written. */
export function healthOf(v: unknown): HealthState | null {
  if (!isObj(v) || num(v.at) === null) return null;
  const issues = (Array.isArray(v.issues) ? v.issues : []).filter(isObj).flatMap((i) => (str(i.id) ? [{ id: str(i.id), severity: i.severity === 'now' ? ('now' as const) : ('soon' as const), text: str(i.text) || str(i.id) }] : []));
  return { at: num(v.at)!, issues, ok: texts(v.ok) };
}

/** `crew_state.merges.merges[]`: entries with a key and a target the board knows. */
export function mergesOf(v: unknown): MergeRecord[] {
  const list = isObj(v) && Array.isArray(v.merges) ? v.merges : [];
  return list.filter(isObj).flatMap((m): MergeRecord[] => {
    const key = str(m.key);
    if (!key || (m.target !== 'done' && m.target !== 'qa')) return [];
    return [{ key, url: strOrNull(m.url) ?? strOrNull(m.prUrl), mergedAt: num(m.mergedAt), target: m.target }];
  });
}

/** The helper's `org` answer: `{departments, org}`. */
export function orgInfoOf(v: unknown): OrgInfo | null {
  if (!isObj(v) || !isObj(v.org)) return null;
  const o = v.org;
  const enabledOf = new Map((Array.isArray(o.departments) ? o.departments : []).filter(isObj).map((d) => [str(d.id), d.enabled === true]));
  const departments = (Array.isArray(v.departments) ? v.departments : []).filter(isObj).flatMap((d) => {
    const id = str(d.id);
    if (!id) return [];
    const switchable = d.switchable !== false;
    return [{
      id, name: str(d.name, id), summary: str(d.summary), head: strOrNull(d.head), order: num(d.order) ?? 0, colour: str(d.colour, '#7a8494'),
      budgetShare: num(d.budgetShare) ?? 0, defaultEnabled: d.defaultEnabled === true, switchable, enabled: enabledOf.get(id) ?? (!switchable || d.defaultEnabled === true),
    }];
  }).sort((a, b) => a.order - b.order);
  return {
    departments,
    ceo: o.ceo === true,
    roles: (Array.isArray(o.roles) ? o.roles : []).filter(isObj).map((r) => ({ id: str(r.id), department: strOrNull(r.department), memberKind: str(r.memberKind, 'agent'), enabled: r.enabled === true })).filter((r) => r.id),
    approved: isObj(o.approved) ? (o.approved as OrgInfo['approved']) : {},
    goals: (Array.isArray(o.goals) ? o.goals : []).filter(isObj).map((g) => ({ id: str(g.id), title: str(g.title), metric: str(g.metric), target: str(g.target), weight: num(g.weight) ?? 1 })).filter((g) => g.id),
  };
}
