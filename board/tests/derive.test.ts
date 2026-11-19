import { describe, expect, it } from 'vitest';
import { groupTasks, isJiraKey, leadAsked, needsYouInbox, shortKey, taskView } from '../src/lib/derive';
import { schedulesNow, schedulesToShow } from '../src/lib/schedule';
import { normalizeManifest } from '../src/lib/agents';
import { taskKindOf } from '../src/lib/keys';
import type { ChatMessage } from '../src/types';
import { card, crew, task } from './build';

describe('keys', () => {
  it('treats T-n as captain’s tasks, not Jira tickets', () => {
    expect(isJiraKey('BRIN-2401')).toBe(true);
    expect(isJiraKey('T-3')).toBe(false);
    expect(shortKey('BRIN-2401')).toBe('#2401');
    expect(shortKey('T-3')).toBe('T-3');
    expect(taskKindOf('T-4', undefined)).toBe('adhoc');
    expect(taskKindOf('ABC-12', 'user')).toBe('adhoc');
    expect(taskKindOf('ABC-12', undefined)).toBe('ticket');
    expect(taskKindOf('T-4', 'jira')).toBe('ticket');
  });
});

describe('task views', () => {
  it('puts a launch card on its task in "Needs you"', () => {
    const c = crew({ tasks: [task('D-1')], inbox: [card('ship-1', { kind: 'ship', from: 'engineer', taskKey: 'D-1' })] });
    const v = taskView(c, c.tasks[0], c.inbox);
    expect(v.group).toBe('need');
    expect(v.label).toBe('Needs your approval');
  });

  it('shows a queued task with a start card as “Ready to start” in “Needs you”', () => {
    const c = crew({ tasks: [task('D-1', { status: 'queued' })], inbox: [card('start-1', { kind: 'start', taskKey: 'D-1', start: { proposal: 'task_d1', model: null, effort: null } })] });
    expect(taskView(c, c.tasks[0], c.inbox)).toMatchObject({ group: 'need', label: 'Ready to start' });
    expect(taskView(c, c.tasks[0], []).group).toBe('queued');
  });

  it('shows an engineer question to the captain', () => {
    const c = crew({ tasks: [task('D-1')], inbox: [card('q', { from: 'engineer', taskKey: 'D-1' })] });
    expect(needsYouInbox(c).map((i) => i.id)).toEqual(['q']);
    expect(taskView(c, c.tasks[0], c.inbox).group).toBe('need');
  });

  it('groups captain’s tasks like tickets and hides skipped proposals', () => {
    const c = crew({ tasks: [task('T-1', { kind: 'adhoc', status: 'queued' }), task('BRIN-9', { status: 'proposed' }), task('D-2', { status: 'pr' }), task('D-3', { status: 'done', closedAt: 5 })] });
    const g = groupTasks(c);
    expect(g.queued.map((v) => v.task.key)).toEqual(['T-1']);
    expect(g.proposed).toEqual([]);
    expect(g.review.map((v) => v.task.key)).toEqual(['D-2']);
    expect(g.done.map((v) => v.task.key)).toEqual(['D-3']);
  });

  it('notices when the Mate ended on a question', () => {
    const line = (who: ChatMessage['who'], text: string, ts: number): ChatMessage => ({ id: String(ts), who, text, ts, taskKey: null, retro: null });
    expect(leadAsked(crew({ chat: [line('me', 'hi', 1), line('lead', 'Start it now?', 2)] }))).toBe(true);
    expect(leadAsked(crew({ chat: [line('lead', 'Start it now?', 1), line('me', 'yes', 2)] }))).toBe(false);
  });
});

describe('schedules to show', () => {
  const scan = normalizeManifest({ id: 'scan', name: 'Jira scan', summary: 's', kind: 'scheduled', runAs: 'schedule', skill: 'keel-scan', defaultEnabled: true, schedule: { cron: '*/30 9-18 * * 1-5', label: 'every 30 min' } })!;
  it("uses the Mate's list when there is one", () => {
    const item = { id: 'keel-scan', agent: 'scan', label: 'Jira scan', cadence: 'x', enabled: true, lastRun: 1, nextRun: 2, lastResult: '', openIssues: null, openIssueKeys: [], handoff: null };
    expect(schedulesToShow([item], [scan], { org: {}, agents: {} })).toEqual([item]);
  });
  it("reads on and off from Settings, and the Jira scan from the panel's last scan", () => {
    const job = (id: string, agent: string, enabled: boolean) => ({ id, agent, label: id, cadence: 'x', enabled, lastRun: 1, nextRun: 2, lastResult: 'old', openIssues: null, openIssueKeys: [], handoff: null });
    const [jira, other] = schedulesNow([job('jiraScan', 'scan', false), job('learn', 'learner', true)], [scan], { org: {}, agents: { scan: { enabled: true } } }, { at: 9, ok: true, new: [1], changed: [], updated: [1, 2] });
    expect(jira).toMatchObject({ enabled: true, lastRun: 9, nextRun: null, lastResult: 'DONE: 1 new, 0 changed, 2 updated.' });
    expect(other.enabled).toBe(true);
    expect(schedulesNow([job('jiraScan', 'scan', true)], [scan], { org: {}, agents: { scan: { enabled: false } } }, null)[0]).toMatchObject({ enabled: false, lastRun: 1, lastResult: 'old' });
  });
  it('falls back to the scheduled agents and their saved settings', () => {
    expect(schedulesToShow([], [scan], { org: {}, agents: { scan: { enabled: false, schedule: '0 * * * *' } } })[0]).toMatchObject({ id: 'scan', agent: 'scan', enabled: false, cadence: 'cron 0 * * * *' });
  });
});
