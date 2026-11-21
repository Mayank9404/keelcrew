import { describe, expect, it } from 'vitest';
import { departmentOn, mergePatches, roleModelOf, roleOn, uniqueId, validateOrg } from '../src/lib/org';
import type { CrewConfig } from '../src/types';
import { crew } from './build';

const NOW = Date.UTC(2026, 9, 20, 12, 0);

describe('ids', () => {
  it('makes an id nobody has', () => {
    expect(uniqueId('goal', [])).toBe('goal');
    expect(uniqueId('goal', ['goal', 'goal-2'])).toBe('goal-3');
    expect(uniqueId('Frontend Owner!', [])).toBe('frontend-owner');
    expect(uniqueId('9 lives', [])).toBe('id-9-lives');
  });
});

describe('switches and models', () => {
  it('reads department and role switches as core does', () => {
    const support = { id: 'support', switchable: true, defaultEnabled: false };
    expect(departmentOn({}, support)).toBe(false);
    expect(departmentOn({ departments: { support: { enabled: true } } }, support)).toBe(true);
    expect(departmentOn({ departments: { operations: { enabled: false } } }, { id: 'operations', switchable: false, defaultEnabled: true })).toBe(true);
    expect(roleOn({ org: { roles: { qa: { enabled: false } } }, agents: { qa: { enabled: true } } }, 'qa', true)).toBe(false);
    expect(roleOn({ org: {}, agents: { qa: { enabled: false } } }, 'qa', true)).toBe(false);
    expect(roleOn({ org: {}, agents: {} }, 'cto', true)).toBe(true);
  });

  it('reads a proposed model, one choice or per difficulty', () => {
    expect(roleModelOf({ model: 'claude-sonnet-5-5', effort: 'high' })).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' });
    const by = roleModelOf({ byDifficulty: { simple: { model: 's', effort: 'xhigh' }, critical: { model: 'o', effort: 'xhigh' }, moderate: { model: 'o', effort: 'loud' } } });
    expect(by).toEqual({ byDifficulty: { simple: { model: 's', effort: 'xhigh' }, critical: { model: 'o', effort: 'xhigh' } } });
    expect(roleModelOf({ model: 'x' })).toBeNull();
    expect(roleModelOf(null)).toBeNull();
  });

  it('validates budgets, goals and the support source', () => {
    const c = (p: Partial<CrewConfig>): CrewConfig => ({ ...crew().config, ...p });
    expect(validateOrg(c({}))).toEqual({});
    const e = validateOrg(
      c({
        org: {
          budgets: { departments: { engineering: 140, product: null } },
          goals: [1, 2, 3, 4].map((n) => ({ id: `g${n}`, title: n === 1 ? '' : 't', metric: '', target: '', weight: 1 })),
          departments: { support: { enabled: true } },
        },
        agents: { support: { source: 'intercom' } },
      }),
    );
    expect(Object.keys(e).sort()).toEqual(['agents.support.source', 'org.budgets.departments.engineering', 'org.goals', 'org.goals.g1']);
    expect(validateOrg(c({ org: { departments: { support: { enabled: true } } }, agents: { support: { source: 'jira:SUP' } } }))).toEqual({});
    expect(validateOrg(c({ org: { departments: { support: { enabled: true } } }, agents: { support: { source: 'teams:customer-issues' } } }))).toEqual({});
  });
});

describe('merged PRs', () => {
  const rows = new Map([
    ['D-1', { status: 'pr', prUrl: 'https://gh/pull/1', _v: 'v1' }],
    ['D-2', { status: 'pr', prUrl: 'https://gh/pull/2', _v: 'v2' }],
    ['D-3', { status: 'qa', prUrl: 'https://gh/pull/3', _v: 'v3' }],
    ['D-4', { status: 'pr', prUrl: 'https://gh/pull/40', _v: 'v4' }],
    ['D-5', { status: 'pr', prUrl: 'https://gh/pull/5', mergedAt: 500, _v: 'v5' }],
    ['D-6', { status: 'cancelled', _v: 'v6' }],
  ]);
  const m = (key: string, target: 'done' | 'qa', url: string | null, mergedAt: number | null = 100) => ({ key, url, mergedAt, target });

  it('moves rows still at pr to the target, with mergedAt, and closes done ones', () => {
    const out = mergePatches([m('D-1', 'done', 'https://gh/pull/1'), m('D-2', 'qa', null, null)], rows, NOW);
    expect(out).toEqual([
      { key: 'D-1', version: 'v1', patch: { status: 'done', mergedAt: 100, updatedAt: NOW, closedAt: 100 } },
      { key: 'D-2', version: 'v2', patch: { status: 'qa', mergedAt: NOW, updatedAt: NOW } },
    ]);
  });

  it('never touches a row past pr, another PR, one already applied, or one that is missing', () => {
    expect(mergePatches([m('D-3', 'done', 'https://gh/pull/3'), m('D-4', 'done', 'https://gh/pull/4'), m('D-5', 'qa', 'https://gh/pull/5', 500), m('D-6', 'done', null), m('D-9', 'done', null)], rows, NOW)).toEqual([]);
  });
});
