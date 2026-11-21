import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { S, configOf } from '../src/board/state';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { SettingsView, forSave, rebaseDraft } from '../src/components/settings/SettingsView';
import { SUBAGENTS, validateOrg } from '../src/lib/org';
import { crewStore } from '../src/lib/store';
import type { CrewConfig, CrewState } from '../src/types';
import { crew } from './build';

/** The whole settings page drawn from a config, as the captain opens it. */
const renderPage = (draft: CrewConfig, p: Partial<CrewState> = {}): string => {
  crewStore.set({ crew: crew({ config: draft, ...p }), conn: 'open', events: [] });
  return renderToStaticMarkup(createElement(SettingsView));
};

afterEach(() => {
  S.settings = null;
});

describe('a damaged settings/main.org', () => {
  it('reads as core does: untitled goals and non-object approved models are dropped', () => {
    S.settings = {
      _id: 'main', _v: 'v1',
      org: {
        goals: [{ id: 'g1' }, { id: 'g2', title: 'Ship sync', weight: 2 }, 'x'],
        models: { approved: { engineer: 'claude-opus-5-5', qa: { model: 'm', effort: 'high' }, analyst: { byDifficulty: 'x' } } },
      },
    };
    const c = configOf();
    expect(c.org.goals).toEqual([{ id: 'g2', title: 'Ship sync', metric: '', target: '', weight: 2 }]);
    expect(c.org.models?.approved).toEqual({ qa: { model: 'm', effort: 'high' } });
    expect(() => validateOrg(c)).not.toThrow();
    expect(() => renderPage(c)).not.toThrow();
  });

  it('reads goals that aren’t a list, and an org that isn’t an object, as unset', () => {
    S.settings = { _id: 'main', _v: 'v1', org: { goals: { a: 1 }, models: 3 } };
    expect(configOf().org).toEqual({});
    S.settings = { _id: 'main', _v: 'v1', org: ['x'] };
    expect(configOf().org).toEqual({});
  });

  it('shows a readable error with a reload instead of a blank page when drawing fails', () => {
    expect(ErrorBoundary.getDerivedStateFromError(new Error('x.name.trim is not a function'))).toEqual({ error: new Error('x.name.trim is not a function') });
    const b = new ErrorBoundary({ children: null });
    b.state = { error: new Error('x.name.trim is not a function') };
    const html = renderToStaticMarkup(createElement('div', null, b.render()));
    expect(html).toContain('role="alert"');
    expect(html).toContain('x.name.trim is not a function');
    expect(html).toMatch(/<button[^>]*>Reload<\/button>/);
  });
});

describe('saving after someone else saved (409)', () => {
  it('keeps a Revoke and a cleared budget, and what was saved meanwhile', () => {
    const base = structuredClone(crew().config);
    base.org = { models: { approved: { [SUBAGENTS]: { model: 'm', effort: 'high' } } }, budgets: { departments: { engineering: 10 } } };
    const draft = structuredClone(base);
    delete draft.org.models!.approved![SUBAGENTS];
    delete draft.org.budgets!.departments!.engineering;
    const live = structuredClone(base);
    live.maxWorkers = 6;
    live.org.goals = [{ id: 'g1', title: 'Ship', metric: '', target: '', weight: 1 }];
    const next = rebaseDraft(base, draft, live);
    expect(next.maxWorkers).toBe(6);
    expect(next.org.models?.approved).toEqual({});
    expect(next.org.budgets?.departments).toEqual({});
    expect(next.org.goals).toEqual(live.org.goals);
  });
});

describe('saving the support source', () => {
  it('trims it only when saving, so a channel name keeps its spaces', () => {
    const c = structuredClone(crew().config);
    c.agents = { support: { source: '  teams:customer issues ' } };
    expect(forSave(c).agents.support.source).toBe('teams:customer issues');
    expect(c.agents.support.source).toBe('  teams:customer issues ');
  });
});
