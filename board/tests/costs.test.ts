import { describe, expect, it } from 'vitest';
import { budgetLevel, roleTotals, sessionRows, ticketRows, ticketSpend, usd } from '../src/lib/costs';
import type { Costs } from '../src/types';

const costs: Costs = {
  members: [
    { key: 'D-1', agent: 'engineer', role: 'engineer', costUsd: 30, tokens: 1, since: null },
    { key: 'D-2', agent: 'engineer', role: 'engineer', costUsd: 41, tokens: 1, since: null },
    { key: 'D-1', agent: 'reviewer', role: 'agent', costUsd: 4, tokens: 1, since: null },
    { key: null, agent: null, role: 'lead', costUsd: 9, tokens: 1, since: null },
  ],
  tickets: { 'D-1': { costUsd: 34, tokens: 1, byRole: { engineer: 30, reviewer: 4 } }, 'D-2': { costUsd: 41, tokens: 1, byRole: { engineer: 41 } }, 'D-3': { costUsd: 5, tokens: 1, byRole: {} } },
  roles: { engineer: { costUsd: 71, tokens: 1 }, reviewer: { costUsd: 4, tokens: 1 } },
  totalUsd: 80,
};

describe('cost thresholds', () => {
  it('warns at 85% and is over at 100%', () => {
    expect(budgetLevel(33.9, 40)).toMatchObject({ level: 'ok' });
    expect(budgetLevel(34, 40)).toMatchObject({ level: 'warn', share: 0.85 });
    expect(budgetLevel(40, 40)).toMatchObject({ level: 'over', share: 1 });
    expect(budgetLevel(41, 40).level).toBe('over');
  });

  it('has no level without a positive budget', () => {
    expect(budgetLevel(10, null)).toEqual({ level: 'none', share: null });
    expect(budgetLevel(10, 0)).toEqual({ level: 'none', share: null });
    expect(budgetLevel(10, undefined)).toEqual({ level: 'none', share: null });
  });

  it('lists tickets worst first against the per-ticket budget', () => {
    expect(ticketRows(costs, { perTicketUsd: 40, perRoleUsd: {} }).map((r) => [r.id, r.level])).toEqual([
      ['D-2', 'over'],
      ['D-1', 'warn'],
      ['D-3', 'ok'],
    ]);
    expect(ticketRows(null, { perTicketUsd: 40, perRoleUsd: {} })).toEqual([]);
  });

  it('compares each session with its role’s per-session budget, worst first', () => {
    const rows = sessionRows(costs, { perTicketUsd: null, perRoleUsd: { engineer: 35, reviewer: 8 } });
    expect(rows.map((r) => [r.role, r.key, r.level])).toEqual([
      ['engineer', 'D-2', 'over'],
      ['engineer', 'D-1', 'warn'],
      ['reviewer', 'D-1', 'ok'],
      ['lead', null, 'none'],
    ]);
    expect(roleTotals(costs).map((r) => r.role)).toEqual(['engineer', 'reviewer']);
  });

  it('prefers the helper’s per-ticket spend and formats money', () => {
    expect(ticketSpend(costs, 'D-1', 2)).toBe(34);
    expect(ticketSpend(costs, 'D-9', 2)).toBe(2);
    expect(usd(4.2)).toBe('$4.20');
    expect(usd(null)).toBe('—');
  });
});
