/**
 * The Keelcrew board's view model: what the board backend (src/board) builds from the artifact database and the helper,
 * and what every component renders. The database's own document shapes are in docs/architecture.md.
 */

export type Difficulty = 'simple' | 'moderate' | 'complex' | 'critical';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** A crew session's role (crew.json): the Mate, an engineer on a ticket, or another agent (QA, analyst, …). */
export type Role = 'lead' | 'engineer' | 'agent';

/** proposed: waiting for the captain's OK. queued: approved, waiting for a free desk. Parked tickets show as active. */
export type TaskStatus = 'proposed' | 'queued' | 'active' | 'pr' | 'qa' | 'done' | 'cancelled';
export type Phase = 'spec' | 'plan' | 'build' | 'verify' | 'review' | 'approval' | 'pr' | 'qa' | 'done';
export type SessionStatus = 'starting' | 'running' | 'idle' | 'parked' | 'interrupted' | 'error' | 'stopped';
/** What the agent is doing right now. */
export type Activity = 'typing' | 'reading' | 'terminal' | 'thinking' | 'waiting' | 'idle';
/** A Jira ticket (`kind: "ticket"`), or a captain’s task (`kind: "adhoc"`, `T-<n>`). */
export type TaskKind = 'ticket' | 'adhoc';

/* ---------- contract, validation, risk ---------- */

/** One assertion of a task's contract (`tasks/{KEY}.contract[]`, ids `VAL-<KEY>-NN`). */
export interface ContractItem {
  id: string;
  text: string;
  kind: 'positive' | 'negative';
}

export type ValidationStatus = 'pass' | 'fail' | 'untested';

/** What an engineer, the reviewer or QA recorded for one assertion (`validation[id]`). */
export interface ValidationEntry {
  status: ValidationStatus;
  /** engineer, reviewer or qa. */
  by: string | null;
  /** "<evidence id>: <one line>", or why it couldn't be tested. */
  evidence: string;
  at: number | null;
}

export type Validation = Record<string, ValidationEntry>;

export type RiskTier = 'low' | 'medium' | 'high' | 'unknown';

/** A diff's risk tier (core risk.mjs `assessRisk`, the helper's `risk`, a launch card's `risk`). */
export interface Risk {
  tier: RiskTier;
  reasons: string[];
  files: number | null;
  added: number | null;
  deleted: number | null;
}

/** Where an approved draft goes: the tool the agent will call and text its input must contain. */
export interface PostTarget {
  tool: string;
  match: string | null;
}

/** The one-shot grant the board made with the helper's `approve_post`. */
export interface PostGrant {
  id: string | null;
  at: number | null;
  expires: number | null;
}

/** One task agent's run (`tasks/{KEY}.agents[id]`). */
export interface TaskAgent {
  id: string;
  /** The verdict it left (QA's PASS / FAIL / PARTIAL). */
  verdict: string | null;
  round: number | null;
  status: string;
  /** Its one-line result (the summary of its KEEL_RESULT line). */
  result: string;
  /** The KEEL_RESULT status word (DONE, DONE_WITH_CONCERNS, BLOCKED, NEEDS_CONTEXT), when the result has one. */
  resultStatus: string | null;
  sessionId: string | null;
  sessionLink: string | null;
  at: number | null;
  /** Crew policy paused it after repeated denials. */
  paused: boolean;
  /** The denials that paused it, when the row has them. */
  pauseReasons: string[];
}

/** One receipt: the review's or the tests' outcome (`{status, at}`, plus `head` when the writer pins it). */
export interface Receipt {
  status: string;
  at: number | null;
  /** The commit it covers, when the receipt names one. */
  head: string | null;
  /** Open findings, rounds and the like, in a few words. */
  detail: string;
}

/** What an engineer proved before shipping (`receipts {head, review, tests}`). */
export interface Receipts {
  head: string | null;
  review: Receipt | null;
  tests: Receipt | null;
  /** True when the review or tests receipt names a different commit than `head`. */
  stale: boolean;
}

export interface Task {
  key: string;
  kind: TaskKind;
  title: string;
  description: string;
  repo: string;
  source: string;
  status: TaskStatus;
  /** The row says `parked` (shown with the active tasks). */
  parked: boolean;
  phase: Phase;
  difficulty: Difficulty;
  needsDecision: boolean;
  branch: string | null;
  worktree: string | null;
  prUrl: string | null;
  jiraStatus: string | null;
  spec: string;
  contract: ContractItem[];
  validation: Validation;
  /** True after QA reopened the ticket. */
  reopened: boolean;
  /** Desk index while active, else null. */
  slot: number | null;
  /** The current engineer session id (kept after the task closes, so it can be resumed). */
  sessionId: string | null;
  /** Other active tasks in the same repo that change the same files. */
  overlaps: { key: string; files: string[] }[];
  agents: TaskAgent[];
  receipts: Receipts | null;
  /** The shepherd's PR watch state (`shepherd` on the row), as label/value pairs. */
  shepherd: { label: string; value: string }[];
  costUsd: number;
  /** The captain's raised budget for this ticket (`budgetUsd`), over `settings/main.budgets.perTicketUsd`. */
  budgetUsd?: number | null;
  /** A contractor works it (an engineer with the contractor's skill). */
  contractor: boolean;
  /** The goal the Mate tagged it with. */
  goal: string | null;
  /** The Mate started it by itself from a suggestion. */
  autoStarted: boolean;
  /** When its PR merged (the merge watcher), once the board or the Mate applied it. */
  mergedAt: number | null;
  lastSummary: string;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  closedAt: number | null;
}

export interface Session {
  id: string;
  taskKey: string | null;
  role: Role;
  /** The agent id for `role: 'agent'` sessions (qa, analyst, …). */
  agent: string | null;
  /** A scheduled run (`role: job` on the Mac). */
  job: boolean;
  model: string;
  effort: Effort;
  status: SessionStatus;
  activity: Activity;
  lastTool: string | null;
  lastText: string | null;
  costUsd: number;
  turns: number;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  lastEventAt: number;
  /** Tokens in the context window after the last turn, and the window size; null until the first turn ends. */
  contextTokens: number | null;
  contextMax: number | null;
  /** Crew policy paused it after repeated denials. */
  paused: boolean;
}

export type EventKind = 'user' | 'tool' | 'turn_end' | 'crew';

export interface CrewEvent {
  id: number;
  sessionId: string;
  taskKey: string | null;
  ts: number;
  kind: EventKind;
  tool: string | null;
  summary: string;
  isError: boolean;
}

/**
 * Card kinds as stored (`inbox/{id}.kind`): ship (engineer), proposal (a ticket or fix to start), question (a
 * decision brief, a draft, a batch or a digest), qa (a QA verdict), conflict (two lessons), playbook (lessons to
 * approve), start (a session for the captain to open in the Claude app). Anything else reads as a question.
 */
export type InboxKind = 'ship' | 'proposal' | 'question' | 'qa' | 'conflict' | 'playbook' | 'info' | 'start';
export type InboxStatus = 'open' | 'approved' | 'rejected' | 'answered' | 'dismissed';

export interface ApprovalCheck {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
}

export type QaVerdict = 'pass' | 'fail' | 'flaky' | 'env' | 'blocked' | 'unknown';

/** One QA case (`cases[]` on a QA card); its id is the assertion id. */
export interface QaCase {
  id: string;
  text: string;
  verdict: QaVerdict;
  note: string;
  expected: string;
  actual: string;
  evidenceId: string | null;
  screenshot: string | null;
}

/** A lesson on a conflict or standing-orders card. */
export interface CardLesson {
  key: string;
  text: string;
  type: string;
  status: string;
  scope: string;
  confidence: number | null;
  evidence: string[];
}

/** A draft the captain can approve (writer, reviewer, release, comms and QA cards). */
export interface Draft {
  channel: string;
  destination: string;
  mode: string;
  subject: string;
  body: string;
  evidenceId: string | null;
  /** Inline comments of a GitHub review draft. */
  comments: { path: string; line: number | null; body: string }[];
}

/**
 * One item of a batch question card (a held question) or of a comms digest (a thread that needs the captain). Items are
 * answered one by one; the card holds them in `items[]`.
 */
export interface CardItem {
  id: string;
  title: string;
  summary: string;
  recommendation: string | null;
  options: string[];
  answer: string | null;
  answeredAt: number | null;
  taskKey: string | null;
  urgent: boolean;
  sessionId: string | null;
  /** Digest items: where the thread is and what it asks. */
  channel: string;
  from: string;
  link: string | null;
  ask: string;
  due: string;
  draft: string;
  post: PostTarget | null;
  postGrant: PostGrant | null;
}

export interface InboxItem {
  /** The card's document id. */
  id: string;
  /** The document's version as this page last saw it, pinned on the captain's answer. */
  version: string;
  kind: InboxKind;
  /** `engineer`, `lead`, or the id of the agent that posted it. */
  from: string;
  taskKey: string | null;
  title: string;
  /** Markdown summary. */
  body: string;
  /** Answer buttons (at most 4 on a decision brief). */
  options: string[];
  recommendation: string | null;
  neverAskKey: string | null;
  /** It can't wait for a question window. */
  urgent: boolean;
  /** Launch cards. */
  diffstat: string | null;
  checks: ApprovalCheck[];
  notes: string | null;
  receipts: Receipts | null;
  risk: Risk | null;
  /** One line per risk reason: why it matters here, or why it's safe. */
  riskNotes: string[];
  validation: Validation | null;
  walkthroughId: string | null;
  /** The Mate took the card back, and why. */
  withdrawn: string | null;
  /** QA cards. */
  verdict: string | null;
  cases: QaCase[];
  flakeRate: number | null;
  url: string | null;
  round: number | null;
  head: string | null;
  /** Conflict and standing-orders cards. */
  lessons: CardLesson[];
  /** The `keelctl memory` commands behind each option. */
  commands: { option: string; commands: string[] }[];
  /** Changes to the standing orders since the captain last approved them. */
  diff: string | null;
  draft: Draft | null;
  post: PostTarget | null;
  postGrant: PostGrant | null;
  /** Batch questions and digests. */
  batch: boolean;
  items: CardItem[];
  /** Proposals (Mate, suggest, shepherd): what would be started. */
  proposal: { title: string; repo: string; difficulty: string; description: string; agent: string; prUrl: string | null; jiraKey: string | null } | null;
  /**
   * Start cards: the Mate's `start_session` proposal id, and the model and effort the new session will use. The Mate
   * proposes the session in its own session (a New task card); the captain opens that session and clicks Start there.
   */
  start: { proposal: string | null; model: string | null; effort: string | null } | null;
  rationale: string | null;
  confidence: number | null;
  fingerprint: string | null;
  /** A suggestion's source (security, errors, perf, ci, tests, health, deps, backlog), and whether it is a security finding. */
  source: string | null;
  security: boolean;
  /** A suggestion the Mate started by itself, within the captain's auto-start settings. */
  autoStarted: boolean;
  /** The Chief of Staff's order (1 first), and a card it held until tomorrow, with why. */
  rank: number | null;
  held: boolean;
  heldReason: string | null;
  /** The posting agent's session, when it says. */
  sessionId: string | null;
  status: InboxStatus;
  answer: string | null;
  note: string | null;
  createdAt: number;
  resolvedAt: number | null;
  /**
   * Answered where the helper couldn't be reached (a phone): the Mate's session on the Mac carries the answer out (stored
   * `grantPending` is the answer's snapshot `{choice, at, key, head?, post?}`; here, whether there is one), then records how
   * it went, `grantResult`, or `grantError`, which opens the card to answer again.
   */
  grantPending: boolean;
  grantResult: string | null;
  grantError: string | null;
}

/** A weekly retro's numbers (`retro: {week, metrics, recommendations}` on its chat document). */
export interface Retro {
  week: string;
  metrics: { label: string; value: string }[];
  recommendations: string[];
}

export interface ChatMessage {
  id: string;
  /** The Mate writes `lead`. */
  who: 'me' | 'lead' | 'system';
  /** Markdown. */
  text: string;
  taskKey: string | null;
  ts: number;
  retro: Retro | null;
}

export type EvidenceKind = 'command' | 'response' | 'diff' | 'plan' | 'review' | 'qa' | 'note' | 'screenshot' | 'context' | 'handoff' | 'walkthrough';

/** A fixed-schema handoff (`kind: "handoff"`): where the work stands and what's next. */
export interface Handoff {
  state: string;
  decisions: string[];
  deadEnds: string[];
  next: string;
  questions: string[];
}

/** One group of a diff walkthrough: hunks for one intent, with the worst open finding. */
export interface WalkthroughGroup {
  intent: string;
  files: string[];
  notes: string;
  severity: 'blocker' | 'major' | 'minor' | 'nit' | 'none';
}

export interface Evidence {
  id: string;
  taskKey: string;
  title: string;
  kind: EvidenceKind;
  /** Text content (markdown or output); structured content as JSON text. */
  content: string;
  handoff: Handoff | null;
  walkthrough: WalkthroughGroup[] | null;
  tags: string[];
  agent: string | null;
  createdAt: number;
}

export interface Decision {
  id: string;
  topic: string;
  decision: string;
  taskKey: string | null;
  createdAt: number;
}

/** An open board request the Mate hasn't handled yet. */
export interface PendingRequest {
  id: string;
  kind: string;
  key: string | null;
  /** `action` on memory and agent requests. */
  action: string | null;
  agent: string | null;
  text: string;
  at: number;
}

export interface UsageWindow {
  utilization: number;
  resetsAt: number;
}

export interface Usage {
  status: 'allowed' | 'allowed_warning' | 'rejected' | 'unknown';
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  todayCostUsd: number;
  updatedAt: number;
  /** True while the usage guard holds new work (above the configured share of a limit). */
  guarded: boolean;
  guardReason: string | null;
}

export interface RepoConfig {
  path: string;
  baseBranch: string;
  enabled: boolean;
  /** The repo's pre-PR gate skill (e.g. pre-pr-checks), run just before the PR opens. Null when the repo has none. */
  prGate: string | null;
}

/** One agent's saved settings (`settings/main.agents[id]`): the switch, overrides and its own settings. */
export type AgentSettings = Record<string, unknown> & { enabled?: boolean; schedule?: string };

/** Spend limits (`settings/main.budgets`); the health agent warns at 85% and asks for a pause at 100%. */
export interface Budgets {
  perTicketUsd: number | null;
  perRoleUsd: Record<string, number>;
}

/**
 * The captain's settings: `settings/main` merged over defaults, plus the Mac-side keys from the helper's config. The Mate
 * reads `maxWorkers`, `intake`, `codeReview`, `usageGuard`, `agents`, `budgets`,
 * `questionWindows` and `sessions`.
 */
export interface CrewConfig {
  /** The person this crew works for; the agents address them by this name. */
  owner: { name: string };
  /** How many engineers work at once. */
  maxWorkers: number;
  /** When the captain's day starts; the do-not-disturb menu offers "until tomorrow" at this time. */
  workingHours: { start: string };
  repos: Record<string, RepoConfig>;
  intake: {
    jiraSite: string;
    jql: string;
    /** Highest difficulty the Mate may start without asking. */
    autoStartMaxDifficulty: Difficulty;
    /** Tickets the Mate must never pick up, propose or reopen. */
    skipKeys: string[];
  };
  /** Above these shares of the plan's windows, no new tickets start. */
  usageGuard: { enabled: boolean; maxFiveHourPct: number; maxSevenDayPct: number };
  /** App for "Open in editor". */
  editor: 'vscode' | 'cursor' | 'pycharm' | 'sublime' | 'zed';
  /** free: engineers push their branch and open or update their PR on their own; card: each waits for the launch card. */
  shipMode: 'free' | 'card';
  /** Arguments engineers pass to Claude Code's /code-review when they review their own changes. */
  codeReview: { args: string };
  /** Where Open resumes a session: Warp, Terminal or the Claude app. */
  terminal: 'warp' | 'terminal' | 'desktop';
  /** Context size (tokens) at which crew sessions compact their history; `auto` leaves it to the model's own limit. */
  compactWindow?: 'auto' | number;
  agents: Record<string, AgentSettings>;
  budgets: Budgets;
  /** Times ("HH:MM") when the Mate posts the non-urgent questions it held. */
  questionWindows: string[];
  /**
   * How the Mate starts a new session: `card` proposes it in the Mate's session (the captain clicks Start there),
   * `routine` starts it with no click.
   */
  sessions: { startMethod: StartMethod };
  /** The company (Settings → Crew): only the captain's clicks write it; the Mate's panel mirrors it to the Mac. */
  org: OrgSettings;
  /** Merged crew PRs move their row to done or qa (the Mate's panel watches; off by default). */
  merges: { autoStatus: boolean };
  /** The ticket ledger the Mate's panel keeps (on by default). */
  ledger: { enabled: boolean };
  /** Answers given where the helper can't be reached (a phone) are carried out by the Mate's panel on the Mac (on by default). */
  phoneApprovals: boolean;
  /** The Mate's session wears the Harbour light look: a harbour behind its chat, its status row and crew cards (on by default). */
  harbourLook: boolean;
  /** Launch cards, failed QA and urgent cards pushed to the captain's phone and Mac through the Claude app (off by default). */
  pushNotifications: boolean;
}

export type StartMethod = 'card' | 'routine';

export type ScheduleId = string;

export interface ScheduleInfo {
  id: ScheduleId;
  /** The agent this schedule runs (crew/schedules items are keyed by agent). */
  agent: string | null;
  lastResult: string;
  /** How many issues the job is tracking (`openIssues`, a count or a map of issue keys). */
  openIssues: number | null;
  openIssueKeys: string[];
  /** The handoff a BLOCKED run left for the next one. */
  handoff: Handoff | null;
  label: string;
  /** Plain-language cadence, e.g. "Every 30 min, working hours". */
  cadence: string;
  enabled: boolean;
  lastRun: number | null;
  nextRun: number | null;
}

/** Spend per crew member, ticket and role (the helper's read-only `costs`). */
export interface Costs {
  members: { key: string | null; agent: string | null; role: string; costUsd: number; tokens: number; since: number | null }[];
  tickets: Record<string, { costUsd: number; tokens: number; byRole: Record<string, number> }>;
  roles: Record<string, { costUsd: number; tokens: number }>;
  totalUsd: number;
}

export type FeedName = 'crew' | 'costs' | 'org';

/** A helper-backed section's freshness: when it last loaded, and the last error since then. */
export interface Feed {
  at: number | null;
  error: string | null;
  /** The helper doesn't have this tool (its plugin version lacks it), so the section can't load. */
  missing: boolean;
}

export interface PolicyRule {
  rule: string;
  detail?: string;
}

/** Human-readable summary of what crew sessions may do, generated from rules.json (src/lib/policy.ts). */
export interface PolicySummary {
  allowed: PolicyRule[];
  needsApproval: PolicyRule[];
  never: PolicyRule[];
  roles: { role: string; summary: string }[];
}

export interface LogFile {
  file: string;
  label: string;
  sessionId: string | null;
  size: number;
  mtime: number;
}

export interface LogTail {
  file: string;
  lines: string[];
  /** Lines in the part of the file that was read. */
  total: number;
  size: number;
  mtime: number;
  path: string;
}

/** One step of an agent's conversation, flattened for reading. */
export interface TranscriptEntry {
  /** Position in the whole transcript. */
  i: number;
  role: 'user' | 'assistant' | 'system';
  kind: 'text' | 'thinking' | 'tool' | 'result' | 'notice';
  text: string;
  /** Tool name, for tool calls and their results. */
  tool?: string;
  /** Tool input as pretty JSON (truncated). */
  input?: string;
  isError?: boolean;
  /** Inside a subagent. */
  sub?: boolean;
}

export interface Transcript {
  entries: TranscriptEntry[];
  total: number;
  /** "session" reads Claude Code's own transcript; "events" falls back to the crew's activity log. */
  source: 'session' | 'events';
}

/* ---------- the company ---------- */

export interface ModelChoice {
  model: string;
  effort: Effort;
}

/** A role's model: one choice, or one per ticket difficulty (the engineer). */
export type RoleModel = ModelChoice | { byDifficulty: Partial<Record<Difficulty, ModelChoice>> };

export interface Goal {
  id: string;
  title: string;
  metric: string;
  target: string;
  weight: number;
}

/** `settings/main.org` as stored: every key optional until the captain sets it. */
export interface OrgSettings {
  departments?: Record<string, { enabled: boolean }>;
  roles?: Record<string, { enabled: boolean }>;
  /** Models per role id, plus `lead` and `subagents` (Settings → Crew, the only place they are set). */
  models?: { approved?: Record<string, RoleModel | null> };
  /** Percent of the weekly usage bar. */
  budgets?: { departments?: Record<string, number | null>; spendAlarm?: boolean };
  goals?: Goal[];
  compaction?: { enabled: boolean };
}

/** A department (plugins/keelcrew/departments). */
export interface Department {
  id: string;
  name: string;
  summary: string;
  head: string | null;
  order: number;
  colour: string;
  budgetShare: number;
  defaultEnabled: boolean;
  switchable: boolean;
}

/** The helper's `org`: departments, and the org as code resolves it from the captain's settings and the pack. */
export interface OrgInfo {
  departments: (Department & { enabled: boolean })[];
  ceo: boolean;
  roles: { id: string; department: string | null; memberKind: string; enabled: boolean }[];
  approved: Record<string, RoleModel>;
  goals: Goal[];
}

/** A weekly allowance in percent of the usage bar. */
export interface Allowance {
  allowancePct: number | null;
  usedPct: number | null;
  spentUsd: number;
}

/** A ticket past a spend line: soft shows a flag, hard paused its session. */
export interface SpendFlag {
  level: 'soft' | 'hard';
  spendUsd: number | null;
  softUsd: number | null;
  hardUsd: number | null;
  at: number | null;
}

/** `crew_state.spend`. */
export interface SpendState {
  at: number;
  departments: Record<string, Allowance>;
  flags: Record<string, SpendFlag>;
}

/** `crew_state.health` (health.json): the Mate panel's last health check. */
export interface HealthState {
  at: number;
  issues: { id: string; severity: 'now' | 'soon'; text: string }[];
  ok: string[];
}

/** One merged crew PR the Mate's panel saw (`crew_state.merges.merges[]`): the row's status should become `target`. */
export interface MergeRecord {
  key: string;
  url: string | null;
  mergedAt: number | null;
  target: 'done' | 'qa';
}

/** What the helper's `crew_state` returns, as far as the board reads it. */
export interface MacCrewState {
  members?: unknown[];
  usage?: unknown;
  compacted?: unknown;
  scan?: unknown;
  /** Each null until its file is written. */
  merges?: { at: number; merges: unknown[] } | null;
  spend?: unknown;
  health?: unknown;
  /** When the panel in the Mate session last read the board; null until it has. */
  panel?: { at: number } | null;
}

export interface CrewState {
  tasks: Task[];
  sessions: Session[];
  inbox: InboxItem[];
  chat: ChatMessage[];
  usage: Usage;
  paused: boolean;
  /** Notifications muted until this time, or null. */
  dndUntil: number | null;
  schedules: ScheduleInfo[];
  /** All schedules paused (`crew/schedules.paused`, which the Mate keeps). */
  schedulesPaused: boolean;
  leadSessionId: string | null;
  /** Non-urgent questions the Mate holds for the next question window (`crew/lead.heldQuestions`). */
  heldQuestions: number;
  costs: Costs | null;
  /** Freshness of the helper-backed feeds: crew (crew_state), costs, org. */
  feeds: Record<FeedName, Feed>;
  /** The helper's `org`, once loaded. */
  org: OrgInfo | null;
  /** Weekly allowances from the Mac (crew_state), null until written. */
  spend: SpendState | null;
  /** The Mate panel's last health check (crew_state), null until written. */
  health: HealthState | null;
  /** Finished tickets loaded (the newest ones; `archivedMore` when older ones exist beyond the window). */
  archivedCount: number;
  archivedMore: boolean;
  requests: PendingRequest[];
  config: CrewConfig;
  /** The settings document's version as this page last saw it (`missing` before it exists, null before it loads). */
  settingsVersion: string | null;
  /** Whether this viewer may change the board (only the artifact's owner can) and why not. */
  access: { canWrite: boolean; reason: string | null };
  /** The local helper: `old` when it is behind the board's schema, `missing` when this view can't reach it. */
  helper: { status: 'unknown' | 'ok' | 'old' | 'newer' | 'missing'; version: string | null; schema: number | null };
  /** When the panel in the Mate session last read the board, from the helper; null when unknown (no helper, or before
   * the panel first ran). */
  panelAt: number | null;
  now: number;
}

export interface TaskDetail {
  task: Task;
  sessions: Session[];
  evidence: Evidence[];
  inbox: InboxItem[];
  events: CrewEvent[];
  /** GitHub's compare page for the branch against its base, once the branch is pushed. */
  branchUrl: string | null;
}

export interface DiffComment {
  file: string;
  line: number | null;
  body: string;
}

export interface Metrics {
  totals: {
    done7d: number;
    done30d: number;
    avgCycleHours: number | null;
    avgWaitOnYouHours: number | null;
    reopenRate: number | null;
  };
  daily: { date: string; done: number }[];
}

export interface DoctorCheck {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  /** A command to run in a terminal to fix it. */
  command?: string;
  fixed?: boolean;
}

export interface SearchHit {
  kind: 'task' | 'chat' | 'decision';
  ref: string;
  taskKey: string | null;
  snippet: string;
  ts: number;
}

export type LessonStatus = 'candidate' | 'active' | 'pinned' | 'retired';

/** One lesson in the crew's memory (core memory.mjs), as the helper's `memory_list` returns it. */
export interface Lesson {
  id: string;
  at: number | null;
  type: string;
  key: string;
  text: string;
  scope: { repo?: string; agent?: string; area?: string };
  evidence: { source: string; ref: string; quote?: string }[];
  confidence: number | null;
  status: LessonStatus;
}

export interface MemoryList {
  lessons: Lesson[];
  playbook: string;
}
