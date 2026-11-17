/** The validation grid: a task's contract against what the engineer, the reviewer and QA recorded for each assertion. */
import type { ContractItem, Validation, ValidationStatus } from '../types';

export interface GridRow {
  id: string;
  text: string;
  /** null for an id that was validated but isn't in the contract (the contract changed). */
  kind: ContractItem['kind'] | null;
  status: ValidationStatus;
  by: string | null;
  /** The evidence line, or why it wasn't tested. */
  evidence: string;
  /** The evidence document named at the start of the evidence line, when there is one. */
  evidenceId: string | null;
  at: number | null;
  /** Someone recorded a result; false means nobody has checked it yet. */
  recorded: boolean;
}

export interface GridSummary {
  pass: number;
  fail: number;
  untested: number;
  total: number;
  /** Untested entries that don't say why (the Mate withdraws a launch card with one of these). */
  unexplained: number;
}

/** "qa-1712-VAL-X-02: 404 for unknown ids" → "qa-1712-VAL-X-02". Only a single token before the colon counts. */
export function evidenceIdOf(evidence: string): string | null {
  const m = /^\s*([A-Za-z0-9][\w.-]{2,120})\s*:/.exec(evidence);
  return m && !/^https?$/i.test(m[1]) ? m[1] : null;
}

/** Natural order for VAL ids: VAL-X-2 before VAL-X-10. */
const byId = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

/** One row per contract assertion (in contract order), then any validated id the contract no longer has. */
export function validationGrid(contract: ContractItem[], validation: Validation | null | undefined): GridRow[] {
  const v = validation ?? {};
  const rows: GridRow[] = contract.map((c) => {
    const e = v[c.id];
    return {
      id: c.id,
      text: c.text,
      kind: c.kind,
      status: e?.status ?? 'untested',
      by: e?.by ?? null,
      evidence: e?.evidence ?? '',
      evidenceId: e ? evidenceIdOf(e.evidence) : null,
      at: e?.at ?? null,
      recorded: !!e,
    };
  });
  const known = new Set(contract.map((c) => c.id));
  for (const id of Object.keys(v).filter((x) => !known.has(x)).sort(byId)) {
    const e = v[id];
    rows.push({ id, text: '', kind: null, status: e.status, by: e.by, evidence: e.evidence, evidenceId: evidenceIdOf(e.evidence), at: e.at, recorded: true });
  }
  return rows;
}

export function gridSummary(rows: GridRow[]): GridSummary {
  const s: GridSummary = { pass: 0, fail: 0, untested: 0, total: rows.length, unexplained: 0 };
  for (const r of rows) {
    s[r.status] += 1;
    if (r.status === 'untested' && !r.evidence.trim()) s.unexplained += 1;
  }
  return s;
}

/** "6 of 8 pass · 1 fails · 1 untested", or "No assertions" for an empty grid. */
export function summaryText(s: GridSummary): string {
  if (!s.total) return 'No assertions';
  const parts = [`${s.pass} of ${s.total} pass`];
  if (s.fail) parts.push(`${s.fail} fail${s.fail === 1 ? 's' : ''}`);
  if (s.untested) parts.push(`${s.untested} untested`);
  return parts.join(' · ');
}
