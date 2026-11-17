/** Spend against the captain's budgets: 85% of a budget is a warning, 100% is over (the health agent asks to pause). */
import type { Budgets, Costs } from '../types';

export const WARN_SHARE = 0.85;

export type BudgetLevel = 'none' | 'ok' | 'warn' | 'over';

export interface BudgetState {
  level: BudgetLevel;
  /** Spend over budget (1 = all of it); null without a budget. */
  share: number | null;
}

/** `none` without a positive budget. */
export function budgetLevel(spend: number, budget: number | null | undefined): BudgetState {
  if (budget == null || !Number.isFinite(budget) || budget <= 0) return { level: 'none', share: null };
  const share = spend / budget;
  return { level: share >= 1 ? 'over' : share >= WARN_SHARE ? 'warn' : 'ok', share };
}

export interface SpendRow {
  id: string;
  spend: number;
  budget: number | null;
  share: number | null;
  level: BudgetLevel;
  /** Per ticket: spend by role. */
  byRole: Record<string, number>;
}

const LEVEL_RANK: Record<BudgetLevel, number> = { over: 0, warn: 1, ok: 2, none: 3 };
const rank = (a: SpendRow, b: SpendRow): number => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || (b.share ?? 0) - (a.share ?? 0) || b.spend - a.spend || a.id.localeCompare(b.id);

/** Each ticket's spend against `perTicketUsd`, worst first. */
export function ticketRows(costs: Costs | null, budgets: Budgets): SpendRow[] {
  if (!costs) return [];
  return Object.entries(costs.tickets)
    .map(([id, t]) => ({ id, spend: t.costUsd, budget: budgets.perTicketUsd, byRole: t.byRole, ...budgetLevel(t.costUsd, budgets.perTicketUsd) }))
    .sort(rank);
}

/** A session's role for budgets: its agent id (qa, shepherd, …), else its role (lead, engineer). */
export const roleOf = (m: Costs['members'][number]): string => m.agent ?? m.role;

export interface SessionSpendRow extends SpendRow {
  role: string;
  key: string | null;
}

/**
 * Each session's spend against its role's budget (`perRoleUsd[role]` is per session, as the health agent reads it),
 * worst first.
 */
export function sessionRows(costs: Costs | null, budgets: Budgets): SessionSpendRow[] {
  if (!costs) return [];
  return costs.members
    .map((m, i) => {
      const role = roleOf(m);
      const budget = budgets.perRoleUsd?.[role] ?? null;
      return { id: `${role}:${m.key ?? i}`, role, key: m.key, spend: m.costUsd, budget, byRole: {}, ...budgetLevel(m.costUsd, budget) };
    })
    .sort(rank);
}

/** Total spend per role, for the summary line. */
export function roleTotals(costs: Costs | null): { role: string; spend: number }[] {
  return Object.entries(costs?.roles ?? {})
    .map(([role, r]) => ({ role, spend: r.costUsd }))
    .sort((a, b) => b.spend - a.spend);
}

/** A ticket's spend: the helper's per-ticket sum when it has one, else what the row or its engineer reported. */
export function ticketSpend(costs: Costs | null, key: string, fallback: number): number {
  return costs?.tickets[key]?.costUsd ?? fallback;
}

/** "$4.20". */
export const usd = (n: number | null | undefined): string => (n == null ? '—' : `$${n >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(2)}`);
