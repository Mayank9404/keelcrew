/**
 * Every action the UI takes, as one interface. The board backend (src/board/backend.ts) implements it on the artifact
 * database and the local helper; components call `api` (errors toast) or `quietApi` (errors shown inline).
 */
import type {
  CrewConfig, Decision, DiffComment, DoctorCheck, Effort, CrewEvent, Evidence, InboxItem, LogFile, LogTail, MemoryList, Metrics, OrgInfo,
  PolicySummary, Risk, ScheduleId, SearchHit, Session, Task, TaskDetail, Transcript,
} from '../types';
import type { AgentManifest } from './agents';
import { toast } from './toast';

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface DiffResult {
  base: string;
  branch: string;
  diff: string;
  status: string;
}

/**
 * The captain's answer to a card. `approve`/`draft`/`push`/`reject` are the ship choices; `answer` carries text; `post`
 * answers with the card's posting option and makes the one-shot post grant on the Mac.
 */
export type InboxDecision = 'approve' | 'draft' | 'push' | 'reject' | 'answer' | 'dismiss' | 'post';

export interface NewTaskInput {
  text: string;
  /** An agent to route it to; the Mate picks when it's missing. */
  agent?: string;
}

/** `promote` approves a candidate lesson so it enters the standing orders. */
export type MemoryAction = 'pin' | 'forget' | 'edit' | 'promote';

/** A crew session to unpause after crew policy paused it: by task key, and the agent or session when known. */
export interface UnpauseTarget {
  key: string | null;
  agent?: string | null;
  sessionId?: string | null;
}

export interface PromptFile {
  file: string;
  about: string;
  text: string;
}

export type OpenTarget = 'editor' | 'finder' | 'terminal';

export interface Backend {
  chat(text: string): Promise<{ ok: boolean }>;
  /** Answers a card pinned to the version shown; a ship approval is recorded on the Mac only after the card took it. */
  decideInbox(item: InboxItem, decision: InboxDecision, answer?: string, opts?: { neverAsk?: boolean; note?: string }): Promise<InboxItem>;
  /** Answers one item of a batch question or a digest; `post` also makes the item's one-shot post grant. */
  answerCardItem(card: InboxItem, itemId: string, answer: string, opts?: { post?: boolean }): Promise<{ ok: boolean }>;
  /** Asks the Mate to unpause a session crew policy paused (`{kind: "unpause", key}`). */
  unpause(target: UnpauseTarget): Promise<{ ok: boolean }>;
  /** The helper's risk tier for a ticket's committed diff, on demand. */
  risk(key: string): Promise<Risk>;
  newTask(input: NewTaskInput): Promise<{ ok: boolean }>;
  taskDetail(key: string): Promise<TaskDetail>;
  /** One evidence document of a task (a walkthrough a launch card names, say); null when it isn't there. */
  evidenceItem(key: string, id: string): Promise<Evidence | null>;
  startTask(key: string): Promise<Task>;
  stopTask(key: string): Promise<Task>;
  messageTask(key: string, text: string): Promise<{ ok: boolean }>;
  resumeTask(key: string, opts: { text?: string; effort?: Effort }): Promise<Task>;
  cancelTask(key: string): Promise<Task>;
  taskDiff(key: string): Promise<DiffResult>;
  reviewTask(key: string, comments: DiffComment[], summary?: string): Promise<{ ok: boolean }>;
  /** Asks the Mate to run an agent now or stop it (optionally on one task). */
  agentAction(id: string, action: 'run' | 'stop', key?: string): Promise<{ ok: boolean }>;
  sessionEvents(id: string, before?: number, limit?: number): Promise<CrewEvent[]>;
  search(q: string): Promise<SearchHit[]>;
  metrics(): Promise<Metrics>;
  decisions(): Promise<Decision[]>;
  deleteDecision(id: string): Promise<{ ok: boolean }>;
  getConfig(): Promise<CrewConfig>;
  /** Saves what changed from `base` to `next`, pinned to the settings version `base` came from. */
  saveSettings(base: CrewConfig, baseVersion: string | null, next: CrewConfig): Promise<CrewConfig>;
  setPaused(paused: boolean): Promise<{ paused: boolean }>;
  scan(): Promise<{ ok: boolean }>;
  pauseSchedules(paused: boolean): Promise<{ ok: boolean }>;
  runSchedule(id: ScheduleId): Promise<{ ok: boolean }>;
  policy(): Promise<PolicySummary>;
  skip(key: string, skip: boolean, reason?: string): Promise<{ ok: boolean; message: string }>;
  openIn(key: string, app: OpenTarget): Promise<{ ok: boolean }>;
  setDnd(until: number | null): Promise<{ dndUntil: number | null }>;
  doctor(): Promise<DoctorCheck[]>;
  /** Opens the real session in the chosen app. */
  openSession(id: string): Promise<{ command: string }>;
  /** Opens the Mate's session in the Claude app, where the captain clicks Start on a proposed session's New task card. */
  openLeadSession(): Promise<{ command: string }>;
  /** Asks the Mate to post a start card's proposal again, so it's the newest thing in its chat. */
  resurfaceStart(cardId: string, key: string | null): Promise<void>;
  transcript(id: string, offset?: number | null, limit?: number): Promise<Transcript>;
  prompts(): Promise<PromptFile[]>;
  logs(): Promise<LogFile[]>;
  logTail(file: string, lines: number): Promise<LogTail>;
  openLogs(file: string | null): Promise<{ ok: boolean }>;
  /** Opens a file the crew linked on this Mac (documents in their app), or shows it in Finder. */
  openFile(path: string, reveal: boolean): Promise<{ ok: boolean; shown: 'opened' | 'revealed' }>;
  savePrompt(file: string, text: string): Promise<PromptFile[]>;
  compactSession(id: string): Promise<Session>;
  /** The crew's lessons and standing orders from the helper (read-only). */
  memory(): Promise<MemoryList>;
  /** Asks the Mate to pin, forget, edit or promote a lesson. */
  memoryAction(action: MemoryAction, key: string, text?: string): Promise<{ ok: boolean }>;
  /** Extra notes and skills the team pack adds to each agent (the helper's `agents_list`); empty without the helper. */
  agentNotes(): Promise<Record<string, { teamSkills: string[]; teamNotes: string | null }>>;
  /** The role manifests the helper serves (proposed models, departments); empty without the helper. */
  roleManifests(): Promise<AgentManifest[]>;
  /** The company as the helper resolves it (refreshes the board's copy). */
  org(): Promise<OrgInfo | null>;
}

const notReady = new Proxy({} as Backend, {
  get: () => () => Promise.reject(new ApiError('The Keelcrew board is still starting.', 503)),
});

let backend: Backend = notReady;

export function setBackend(next: Backend): void {
  backend = next;
}

/**
 * Words for a `db` capability rejection (`{code, message}`, a plain object, not an Error), by its stable code; null
 * for anything that isn't one.
 */
export function dbErrorText(e: unknown): string | null {
  if (!e || typeof e !== 'object' || e instanceof Error) return null;
  const { code, message } = e as { code?: unknown; message?: unknown };
  if (typeof code !== 'string') return null;
  const detail = typeof message === 'string' && message.trim() ? message.trim() : '';
  switch (code) {
    case 'quota_exceeded':
      return `The board’s database is full${detail ? ` (${detail})` : ''}. Ask the Mate to prune old chat lines and evidence, then try again.`;
    case 'resource_exhausted':
      return 'The board is making too many changes at once. Wait a few seconds and try again.';
    case 'invalid_argument':
    case 'transform_error':
      return `The board’s database refused that change${detail ? `: ${detail}` : '.'}`;
    case 'revoked':
      return 'This view lost access to the board. Reload to try again.';
    case 'not_granted':
    case 'capability_disabled':
    case 'capability_removed':
      return 'This view can’t change the board. Open the Keelcrew board in Claude.';
    default:
      return `The board’s database didn’t answer${detail ? ` (${detail})` : ''}. Try again in a moment.`;
  }
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return dbErrorText(e) ?? 'Something went wrong';
}

type Method = (...args: unknown[]) => Promise<unknown>;

function wrap(notify: boolean): Backend {
  return new Proxy({} as Backend, {
    get(_target, prop) {
      return async (...args: unknown[]) => {
        const fn = backend[prop as keyof Backend] as unknown as Method;
        try {
          return await fn(...args);
        } catch (e) {
          if (notify) toast(errorText(e), 'error');
          throw e;
        }
      };
    },
  });
}

/** Board actions; errors surface as toasts and still reject. */
export const api = wrap(true);
/** Same calls without the toast, for callers that show the error inline. */
export const quietApi = wrap(false);
