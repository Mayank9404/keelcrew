/** View-model builders for tests: a task, a card, a session and a crew state with sensible empty defaults. */
import type { CardItem, CrewState, InboxItem, Session, Task, TaskAgent } from '../src/types';

export const task = (key: string, p: Partial<Task> = {}): Task => ({
  key, kind: 'ticket', title: key, description: '', repo: 'r', source: 'jira', status: 'active', parked: false, phase: 'build', difficulty: 'moderate', needsDecision: false,
  branch: null, worktree: null, prUrl: null, jiraStatus: null, spec: '', contract: [], validation: {}, reopened: false, slot: null, sessionId: null, overlaps: [],
  agents: [], receipts: null, shepherd: [], costUsd: 0, contractor: false, goal: null, autoStarted: false, mergedAt: null, lastSummary: '', createdAt: 1, startedAt: null, updatedAt: 1, closedAt: null, ...p,
});

export const agent = (id: string, p: Partial<TaskAgent> = {}): TaskAgent => ({
  id, verdict: null, round: null, status: 'running', result: '', resultStatus: null, sessionId: null, sessionLink: null, at: null, paused: false, pauseReasons: [], ...p,
});

export const card = (id: string, p: Partial<InboxItem> = {}): InboxItem => ({
  id, version: 'v', kind: 'question', from: 'lead', taskKey: null, title: id, body: '', options: [], recommendation: null, neverAskKey: null, urgent: false,
  diffstat: null, checks: [], notes: null, receipts: null, risk: null, riskNotes: [], validation: null, walkthroughId: null, withdrawn: null, verdict: null, cases: [], flakeRate: null,
  url: null, round: null, head: null, lessons: [], commands: [], diff: null, draft: null, post: null, postGrant: null, batch: false, items: [], proposal: null, start: null, rationale: null,
  confidence: null, fingerprint: null, source: null, security: false, autoStarted: false, rank: null, held: false, heldReason: null, sessionId: null, status: 'open', answer: null, note: null, createdAt: 1, resolvedAt: null,
  grantPending: false, grantResult: null, grantError: null, ...p,
});

export const item = (id: string, p: Partial<CardItem> = {}): CardItem => ({
  id, title: id, summary: '', recommendation: null, options: [], answer: null, answeredAt: null, taskKey: null, urgent: false, sessionId: null,
  channel: '', from: '', link: null, ask: '', due: '', draft: '', post: null, postGrant: null, ...p,
});

export const session = (id: string, p: Partial<Session> = {}): Session => ({
  id, taskKey: null, role: 'engineer', agent: 'engineer', job: false, model: 'm', effort: 'high', status: 'running', activity: 'typing', lastTool: null, lastText: null, costUsd: 0, turns: 0,
  cwd: '/w', createdAt: 1, updatedAt: 1, lastEventAt: 1, contextTokens: null, contextMax: null, paused: false, ...p,
});

export const crew = (p: Partial<CrewState> = {}): CrewState => ({
  tasks: [], sessions: [], inbox: [], chat: [], paused: false, dndUntil: null, schedules: [], schedulesPaused: false, leadSessionId: null, heldQuestions: 0,
  costs: null, feeds: { crew: { at: null, error: null, missing: false }, costs: { at: null, error: null, missing: false }, org: { at: null, error: null, missing: false } },
  org: null, spend: null, health: null,
  archivedCount: 0, archivedMore: false, requests: [],
  usage: { status: 'unknown', fiveHour: null, sevenDay: null, todayCostUsd: 0, updatedAt: 0, guarded: false, guardReason: null },
  config: {
    owner: { name: 'Sam' }, maxWorkers: 4, workingHours: { start: '09:30' }, repos: {},
    intake: { jiraSite: '', jql: '', autoStartMaxDifficulty: 'moderate', skipKeys: ['BRIN-9'] }, usageGuard: { enabled: true, maxFiveHourPct: 85, maxSevenDayPct: 90 }, editor: 'pycharm',
    shipMode: 'free', codeReview: { args: 'high' }, terminal: 'desktop', agents: {}, budgets: { perTicketUsd: null, perRoleUsd: {} }, questionWindows: [],
    sessions: { startMethod: 'card' }, org: {}, merges: { autoStatus: false }, ledger: { enabled: true }, phoneApprovals: true, harbourLook: true, pushNotifications: false,
  },
  settingsVersion: null, access: { canWrite: true, reason: null }, helper: { status: 'ok', version: '1', schema: 2 }, panelAt: null, now: 1, ...p,
});
