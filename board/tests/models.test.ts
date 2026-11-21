import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { S as state, sessionsOf } from '../src/board/state';
import { memberOf } from '../src/board/convert';
import { ManageTab } from '../src/components/task/ManageTab';
import { taskView } from '../src/lib/derive';
import { normalizeManifest } from '../src/lib/agents';
import { ENGINEER_LADDER, modelFor, validateModels, withApproved } from '../src/lib/models';
import { SUBAGENTS } from '../src/lib/org';
import { crewStore } from '../src/lib/store';
import type { OrgSettings } from '../src/types';
import { crew, task } from './build';

const S = 'claude-sonnet-5-5';
const O = 'claude-opus-5-5';
const base = { id: 'qa', name: 'QA agent', summary: 's', kind: 'ticket', runAs: 'session', skill: 'keel-qa', defaultEnabled: true };
const qa = normalizeManifest({ ...base, model: O, effort: 'high', proposedModel: { model: S, effort: 'high' } })!;
const engineer = normalizeManifest({ ...base, id: 'engineer', name: 'Engineer', model: O })!;
const cto = normalizeManifest({ ...base, id: 'cto', name: 'CTO', kind: 'scheduled' })!;
const org = (approved: Record<string, unknown>): OrgSettings => ({ models: { approved: approved as never } });

describe('the model a role runs on (one resolver, as core org.mjs modelFor)', () => {
  const approved = org({ engineer: { byDifficulty: { simple: { model: S, effort: 'xhigh' } } }, qa: { model: S, effort: 'low' }, lead: { model: S, effort: 'max' }, [SUBAGENTS]: { model: S, effort: 'xhigh' } });

  it("takes the captain's choice first, per difficulty for the engineer", () => {
    expect(modelFor(approved, 'engineer', engineer, 'simple')).toEqual({ model: S, effort: 'xhigh', source: 'approved' });
    expect(modelFor(approved, 'qa', qa)).toEqual({ model: S, effort: 'low', source: 'approved' });
    expect(modelFor(approved, 'lead', null)).toEqual({ model: S, effort: 'max', source: 'approved' });
    expect(modelFor(approved, SUBAGENTS, null)).toEqual({ model: S, effort: 'xhigh', source: 'approved' });
  });

  it("else the manifest's model and effort, never the proposed one", () => {
    expect(modelFor({}, 'qa', qa)).toEqual({ model: O, effort: 'high', source: 'manifest' });
    expect(modelFor(approved, 'engineer', engineer, 'critical')).toEqual({ model: O, effort: 'xhigh', source: 'manifest' });
  });

  it("else the engineer ladder's default; no difficulty reads as moderate", () => {
    expect((['simple', 'moderate', 'complex', 'critical'] as const).map((d) => modelFor({}, 'engineer', engineer, d).effort)).toEqual(['high', 'xhigh', 'xhigh', 'xhigh']);
    expect(modelFor({}, 'cto', cto)).toEqual({ model: S, effort: 'xhigh', source: 'default' });
    expect(modelFor(undefined, 'lead', null)).toEqual({ model: ENGINEER_LADDER.model, effort: 'xhigh', source: 'default' });
  });
});

describe('setting and clearing a row', () => {
  it("sets one difficulty of the engineer's and keeps the others", () => {
    const one = withApproved({}, 'engineer', { model: S, effort: 'high' }, 'simple');
    expect(one).toEqual({ engineer: { byDifficulty: { simple: { model: S, effort: 'high' } } } });
    const two = withApproved(one, 'engineer', { model: O, effort: 'max' }, 'critical');
    expect(two.engineer).toEqual({ byDifficulty: { simple: { model: S, effort: 'high' }, critical: { model: O, effort: 'max' } } });
    expect(withApproved(two, 'engineer', null, 'simple')).toEqual({ engineer: { byDifficulty: { critical: { model: O, effort: 'max' } } } });
    expect(withApproved(withApproved(two, 'engineer', null, 'simple'), 'engineer', null, 'critical')).toEqual({});
  });

  it('turns one choice for every difficulty into a per-difficulty one when a single difficulty changes', () => {
    const next = withApproved({ engineer: { model: S, effort: 'high' } }, 'engineer', { model: O, effort: 'max' }, 'critical');
    expect(next.engineer).toEqual({ byDifficulty: { simple: { model: S, effort: 'high' }, moderate: { model: S, effort: 'high' }, complex: { model: S, effort: 'high' }, critical: { model: O, effort: 'max' } } });
  });

  it('sets and clears any other role whole, leaving the rest', () => {
    const next = withApproved({ lead: { model: O, effort: 'max' } }, 'qa', { model: S, effort: 'high' });
    expect(next).toEqual({ lead: { model: O, effort: 'max' }, qa: { model: S, effort: 'high' } });
    expect(withApproved(next, 'qa', null)).toEqual({ lead: { model: O, effort: 'max' } });
  });

  it('asks for a model name before saving', () => {
    const c = structuredClone(crew().config);
    c.org = org({ qa: { model: ' ', effort: 'high' }, engineer: { byDifficulty: { simple: { model: 'bad name', effort: 'high' } } }, lead: { model: O, effort: 'max' } });
    expect(Object.keys(validateModels(c)).sort()).toEqual(['models.engineer.simple', 'models.qa']);
  });
});

describe("the board's own fallbacks read the same resolver", () => {
  afterEach(() => {
    state.settings = null;
    state.lead = null;
    state.members = [];
    state.tasksOpen.clear();
  });
  const settings = (approved: Record<string, unknown>) => void (state.settings = { _id: 'main', _v: 'v1', org: { models: { approved } } });

  it("the Mate's session without the helper", () => {
    state.lead = { _id: 'lead', _v: 'v1', sessionId: 'lead-1', heartbeatAt: Date.now(), status: 'working' };
    expect(sessionsOf([]).find((x) => x.role === 'lead')).toMatchObject({ model: S, effort: 'xhigh' });
    settings({ lead: { model: S, effort: 'max' } });
    expect(sessionsOf([]).find((x) => x.role === 'lead')).toMatchObject({ model: S, effort: 'max' });
  });

  it("an engineer's session from its row, at the ticket's difficulty", () => {
    state.tasksOpen.set('D-1', { _id: 'D-1', _v: 'v1', difficulty: 'critical' });
    const t = task('D-1', { sessionId: 's-1', difficulty: 'critical' });
    expect(sessionsOf([t]).find((x) => x.id === 's-1')).toMatchObject({ model: S, effort: 'xhigh' });
    settings({ engineer: { byDifficulty: { critical: { model: S, effort: 'high' } } } });
    expect(sessionsOf([t]).find((x) => x.id === 's-1')).toMatchObject({ model: S, effort: 'high' });
  });

  it("a session the helper reports, when neither it nor the row names a model", () => {
    state.tasksOpen.set('D-2', { _id: 'D-2', _v: 'v1', difficulty: 'simple' });
    state.members = [memberOf({ dir: '/w/D-2', role: 'engineer', key: 'D-2', sessionId: 'eng-2' })!, memberOf({ dir: '/w/qa', role: 'agent', key: 'D-3', agent: 'qa', sessionId: 'qa-3' })!];
    settings({ qa: { model: S, effort: 'low' } });
    const all = sessionsOf([]);
    expect(all.find((x) => x.id === 'eng-2')).toMatchObject({ model: S, effort: 'high' });
    expect(all.find((x) => x.id === 'qa-3')).toMatchObject({ model: S, effort: 'low' });
  });
});

describe('the task page', () => {
  it("says the effort a proposed ticket's engineer will start at, from Settings → Crew", () => {
    const c = crew({ tasks: [task('D-9', { status: 'proposed', difficulty: 'critical' })] });
    c.config.org = org({ engineer: { byDifficulty: { critical: { model: S, effort: 'high' } } } });
    crewStore.set({ crew: c, conn: 'open', events: [] });
    const html = renderToStaticMarkup(createElement(ManageTab, { crew: c, task: c.tasks[0]!, view: taskView(c, c.tasks[0]!, []) }));
    expect(html).toContain('at high effort');
  });
});
