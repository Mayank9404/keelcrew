import { describe, expect, it } from 'vitest';
import { berths, boatOf, homeStation, officeModel, officeSummary, sailorActions, type Office } from '../src/lib/office';
import type { ScheduleInfo } from '../src/types';
import { card, crew, session } from './build';

const NOW = new Date(2026, 0, 12, 14, 0).getTime();
const MIN = 60_000;
const at = (o: Office, id: string) => o.stations.find((s) => s.id === id)!.sailors;
const who = (o: Office, id: string) => o.sailors.find((s) => s.id === id);
const boat = (o: Office, id: string) => o.boats.find((b) => b.id === id)!;
const job = (id: string, agent: string, p: Partial<ScheduleInfo> = {}): ScheduleInfo => ({ id, agent, lastResult: '', openIssues: null, openIssueKeys: [], handoff: null, label: agent, cadence: 'hourly', enabled: true, lastRun: null, nextRun: null, ...p });
const withOrg = (org: Record<string, unknown>, agents: Record<string, { enabled: boolean }> = {}) => crew({ config: { ...crew().config, org, agents } });

describe('the Deck', () => {
  it('always has the Mate on the bridge, and every agent of a department that is on at its post', () => {
    const o = officeModel(crew(), NOW);
    expect(at(o, 'bridge')[0]).toMatchObject({ id: 'lead', name: 'Mate', mood: 'idle', detail: 'Ready' });
    // On by default: an idle hand. Off by default: an empty seat. Departments off (Marketing, Support, CEO): nobody.
    expect(who(o, 'a:reviewer')).toMatchObject({ station: 'lookout', off: false, detail: 'Ready, nothing to do yet' });
    expect(who(o, 'a:analyst')!.station).toBe('yacht');
    expect(who(o, 'off:pm')).toMatchObject({ station: 'yacht', off: true });
    expect(who(o, 'off:contractor')).toMatchObject({ station: 'engine', off: true });
    expect(o.sailors.some((s) => s.agent === 'marketing' || s.agent === 'support' || s.agent === 'chief-of-staff')).toBe(false);
    expect(new Set(o.sailors.map((s) => s.agent)).size).toBe(o.sailors.length);
    expect(officeSummary(o)).toMatch(/^0 at work, \d+ switched off$/);
  });

  it('posts each agent on its department’s boat, and Engineering’s by kind on the flagship', () => {
    expect(homeStation('lead', null)).toBe('bridge');
    expect(homeStation('engineer', null)).toBe('engine');
    expect(homeStation('agent', 'contractor')).toBe('engine');
    expect(homeStation('agent', 'scout')).toBe('bridge');
    expect(homeStation('agent', 'reviewer')).toBe('lookout');
    expect(homeStation('agent', 'qa')).toBe('lookout');
    expect(homeStation('agent', 'shepherd')).toBe('rounds');
    expect(homeStation('agent', 'cto')).toBe('rounds');
    for (const a of ['analyst', 'writer', 'pm', 'designer']) expect(homeStation('agent', a)).toBe('yacht');
    for (const a of ['scan', 'health', 'comms', 'briefs', 'learner']) expect(homeStation('agent', a)).toBe('tug');
    expect(homeStation('agent', 'marketing')).toBe('skiff');
    expect(homeStation('agent', 'support')).toBe('lifeboat');
    expect(homeStation('agent', 'chief-of-staff')).toBe('launch');
    expect(boatOf('rounds')).toBe('flagship');
    expect(boatOf('tug')).toBe('tug');
  });

  it('puts an agent this build does not know in the chart room under its own id', () => {
    const o = officeModel(crew({ sessions: [session('x1', { role: 'agent', agent: 'forecaster', taskKey: 'K-9' })] }), NOW);
    expect(who(o, 's:x1')).toMatchObject({ station: 'chart', agent: 'forecaster', mood: 'working' });
  });

  it('reads the mood from the session: working, thinking, idle, and stuck when paused or in error', () => {
    const o = officeModel(
      crew({
        sessions: [
          session('a', { taskKey: 'K-1', activity: 'terminal', lastText: 'Running the tests\nmore' }),
          session('b', { taskKey: 'K-2', activity: 'thinking' }),
          session('c', { taskKey: 'K-3', status: 'parked' }),
          session('d', { taskKey: 'K-4', paused: true }),
          session('e', { taskKey: 'K-5', status: 'error' }),
          session('f', { taskKey: 'K-6', status: 'stopped' }),
        ],
      }),
      NOW,
    );
    expect(who(o, 's:a')).toMatchObject({ mood: 'working', detail: 'Running the tests', station: 'engine' });
    expect(who(o, 's:b')!.mood).toBe('thinking');
    expect(who(o, 's:c')).toMatchObject({ mood: 'idle', detail: 'Parked' });
    expect(who(o, 's:d')!.mood).toBe('stuck');
    expect(who(o, 's:e')!.mood).toBe('stuck');
    expect(who(o, 's:f')).toBeUndefined();
    // With engineers aboard, there is no extra idle engineer.
    expect(who(o, 'a:engineer')).toBeUndefined();
    expect(o).toMatchObject({ working: 2, stuck: 2 });
  });

  it('keeps whoever has something waiting for you at its post, waving, with the item to open', () => {
    const c = crew({
      sessions: [session('e1', { taskKey: 'K-1' }), session('e2', { taskKey: 'K-2' })],
      inbox: [card('ship-1', { kind: 'ship', from: 'engineer', taskKey: 'K-1', title: 'Push K-1', sessionId: 'e1' }), card('q-1', { from: 'engineer', taskKey: 'K-1', title: 'Second thing' })],
    });
    const o = officeModel(c, NOW);
    expect(who(o, 's:e1')).toMatchObject({ station: 'engine', mood: 'waiting', cardId: 'ship-1', cards: 2, detail: 'Push K-1' });
    expect(sailorActions(who(o, 's:e1')!)).toEqual([{ kind: 'card', id: 'ship-1' }, { kind: 'task', key: 'K-1' }, { kind: 'transcript', id: 'e1' }]);
    expect(sailorActions(who(o, 's:e2')!)).toEqual([{ kind: 'task', key: 'K-2' }, { kind: 'transcript', id: 'e2' }]);
    expect(o.waiting).toBe(2);
  });

  it('keeps the Mate on the bridge however many items it has for you', () => {
    const inbox = Array.from({ length: 13 }, (_, i) => card(`l-${i}`, { from: 'lead', title: `Question ${i}` }));
    const o = officeModel(crew({ sessions: [session('lead-1', { role: 'lead', agent: null, activity: 'thinking' })], leadSessionId: 'lead-1', inbox }), NOW);
    expect(who(o, 'lead')).toMatchObject({ station: 'bridge', mood: 'thinking', cards: 13 });
    expect(sailorActions(who(o, 'lead')!).map((x) => x.kind)).toEqual(['card', 'chat', 'transcript']);
    expect(o.waiting).toBe(13);
  });

  it('gives an item from a switched-off agent to its empty seat, which fills again while the item waits', () => {
    const o = officeModel(crew({ inbox: [card('p-1', { kind: 'proposal', from: 'suggest', title: 'Fix the flaky test' })] }), NOW);
    expect(o.sailors.filter((s) => s.agent === 'suggest')).toHaveLength(1);
    expect(who(o, 'off:suggest')).toMatchObject({ station: 'rounds', off: false, mood: 'waiting', cardId: 'p-1' });
  });

  it('gives each agent one sailor for its watches: blocked first, then just done, then the next due', () => {
    const c = crew({
      sessions: [session('job-sh', { role: 'agent', agent: 'shepherd', job: true, activity: 'terminal' })],
      schedules: [
        job('keel-health', 'health', { label: 'Health check', lastRun: NOW - 10 * MIN, lastResult: 'DONE: nothing to report' }),
        job('keel-learner', 'learner', { label: 'Learner', lastRun: NOW - 600 * MIN, nextRun: NOW + 60 * MIN, lastResult: 'DONE: 3 candidates' }),
        job('keel-learner-card', 'learner', { label: 'Learner, weekly', lastRun: NOW - 5 * MIN, lastResult: 'DONE: card posted' }),
        job('keel-scan', 'scan', { label: 'Jira scan', lastRun: NOW - 5 * MIN, lastResult: 'BLOCKED: helper unreachable' }),
        job('keel-shepherd', 'shepherd', { label: 'PR shepherd' }),
        job('keel-release', 'release', { enabled: false }),
      ],
    });
    const o = officeModel(c, NOW);
    expect(who(o, 'job:health')).toMatchObject({ station: 'tug', mood: 'done' });
    expect(who(o, 'job:health')!.detail).toMatch(/^Done \d\d:\d\d: nothing to report$/);
    expect(o.sailors.filter((s) => s.agent === 'learner')).toHaveLength(1);
    expect(who(o, 'job:learner')).toMatchObject({ mood: 'done' });
    expect(who(o, 'job:scan')).toMatchObject({ mood: 'stuck' });
    expect(who(o, 'job:shepherd')).toBeUndefined();
    expect(who(o, 's:job-sh')).toMatchObject({ station: 'rounds', mood: 'working' });
    expect(who(o, 'off:release')).toMatchObject({ off: true });
    expect(sailorActions(who(o, 'job:health')!)).toEqual([{ kind: 'crew' }]);
    expect(o.nextRound).toBe(NOW + 60 * MIN);
    expect(officeModel({ ...c, schedulesPaused: true }, NOW).nextRound).toBeNull();
  });

  it('keeps a watch at its post when its last session is only parked', () => {
    const c = crew({ sessions: [session('old-sh', { role: 'agent', agent: 'shepherd', job: true, status: 'parked' })], schedules: [job('keel-shepherd', 'shepherd', { lastRun: NOW - 5 * MIN, lastResult: 'BLOCKED: gh not signed in' })] });
    expect(who(officeModel(c, NOW), 'job:shepherd')).toMatchObject({ station: 'rounds', mood: 'stuck' });
  });

  it('counts each boat’s agents that are on, and brings a department’s boat out when it is switched on', () => {
    const off = officeModel(crew(), NOW);
    expect(boat(off, 'skiff')).toMatchObject({ on: false, deptName: 'Marketing' });
    expect(boat(off, 'yacht')).toMatchObject({ on: true, agentsOn: 2, agents: 4 });
    const on = officeModel(withOrg({ departments: { marketing: { enabled: true } } }, { marketing: { enabled: true }, pm: { enabled: true } }), NOW);
    expect(boat(on, 'skiff')).toMatchObject({ on: true, agentsOn: 1, agents: 1 });
    expect(who(on, 'a:marketing')).toMatchObject({ station: 'skiff', off: false });
    expect(who(on, 'a:pm')).toMatchObject({ station: 'yacht', off: false });
    expect(boat(on, 'yacht').agentsOn).toBe(3);
    expect(sailorActions(who(on, 'a:pm')!)).toEqual([{ kind: 'agent' }]);
  });

  it('sums up the harbour for the board, the radio cabinet, the signal mast and the lighthouse', () => {
    const c = crew({
      usage: { status: 'allowed', fiveHour: { utilization: 0.46, resetsAt: 0 }, sevenDay: { utilization: 0.71, resetsAt: 0 }, todayCostUsd: 12.4, updatedAt: 0, guarded: true, guardReason: 'x' },
      paused: true,
      dndUntil: NOW + 30 * MIN,
      helper: { status: 'missing', version: null, schema: null },
      inbox: [card('q-1', { from: 'lead', title: 'Q' })],
    });
    expect(officeModel(c, NOW).harbour).toEqual({
      fiveHour: 46, sevenDay: 71, spendToday: 12.4, waiting: 1, stuck: 0, nextRound: null, paused: true, quiet: true, guarded: true, helper: 'down',
    });
    const calm = officeModel(crew({ dndUntil: NOW - MIN, helper: { status: 'old', version: '1', schema: 1 } }), NOW).harbour;
    expect(calm).toMatchObject({ quiet: false, paused: false, helper: 'old', fiveHour: null });
  });

  it('draws only as many sailors as a post has berths, and counts the rest', () => {
    const sessions = Array.from({ length: 9 }, (_, i) => session(`e${i}`, { taskKey: `K-${i}` }));
    const engine = officeModel(crew({ sessions }), NOW).stations.find((s) => s.id === 'engine')!;
    expect(engine.sailors.filter((s) => !s.off)).toHaveLength(9);
    expect(berths(engine, 6)).toMatchObject({ more: engine.sailors.length - 6 });
    expect(berths(engine, 6).shown).toHaveLength(6);
  });

  it('orders a post by who needs attention first, empty seats last, and sums the Deck up', () => {
    const c = crew({ sessions: [session('a', { taskKey: 'K-1', status: 'parked' }), session('b', { taskKey: 'K-2' }), session('c', { taskKey: 'K-3', paused: true })] });
    const o = officeModel(c, NOW);
    const engine = at(o, 'engine').map((s) => s.id);
    expect(engine.slice(0, 3)).toEqual(['s:c', 's:b', 's:a']);
    expect(engine.at(-1)).toBe('off:contractor');
    expect(officeSummary(o)).toMatch(/^1 at work, 1 stuck, \d+ switched off$/);
  });
});
