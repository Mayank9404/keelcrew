import { describe, expect, it } from 'vitest';
import { evidenceIdOf, gridSummary, summaryText, validationGrid } from '../src/lib/validation';
import type { ContractItem } from '../src/types';

const contract: ContractItem[] = [
  { id: 'VAL-D-01', text: 'GET /x returns totals', kind: 'positive' },
  { id: 'VAL-D-02', text: 'Unknown id returns 404', kind: 'negative' },
  { id: 'VAL-D-10', text: 'Other callers unchanged', kind: 'negative' },
];

describe('validation grid', () => {
  it('lists the contract in order, with an untested row where nobody recorded a result', () => {
    const rows = validationGrid(contract, { 'VAL-D-01': { status: 'pass', by: 'engineer', evidence: 'cmd-17: 200 with totals', at: 5 } });
    expect(rows.map((r) => [r.id, r.status, r.recorded])).toEqual([
      ['VAL-D-01', 'pass', true],
      ['VAL-D-02', 'untested', false],
      ['VAL-D-10', 'untested', false],
    ]);
    expect(rows[0]).toMatchObject({ by: 'engineer', evidenceId: 'cmd-17', kind: 'positive' });
  });

  it('keeps validated ids the contract no longer has, after the contract', () => {
    const rows = validationGrid(contract.slice(0, 1), { 'VAL-D-09': { status: 'fail', by: 'qa', evidence: 'qa-1: 500', at: 1 }, 'VAL-D-03': { status: 'pass', by: 'qa', evidence: '', at: 1 } });
    expect(rows.map((r) => [r.id, r.kind])).toEqual([
      ['VAL-D-01', 'positive'],
      ['VAL-D-03', null],
      ['VAL-D-09', null],
    ]);
  });

  it('counts pass, fail and untested, and untested rows that give no reason', () => {
    const rows = validationGrid(contract, {
      'VAL-D-01': { status: 'pass', by: 'engineer', evidence: 'e1: ok', at: 1 },
      'VAL-D-02': { status: 'fail', by: 'qa', evidence: 'qa-2: 500', at: 1 },
      'VAL-D-10': { status: 'untested', by: 'engineer', evidence: 'needs prod data', at: 1 },
    });
    const s = gridSummary(rows);
    expect(s).toEqual({ pass: 1, fail: 1, untested: 1, total: 3, unexplained: 0 });
    expect(summaryText(s)).toBe('1 of 3 pass · 1 fails · 1 untested');
    expect(gridSummary(validationGrid(contract, {})).unexplained).toBe(3);
    expect(summaryText(gridSummary([]))).toBe('No assertions');
  });

  it('reads the evidence id only when the line starts with one token and a colon', () => {
    expect(evidenceIdOf('qa-1712-VAL-D-02: 404 for unknown ids')).toBe('qa-1712-VAL-D-02');
    expect(evidenceIdOf('needs prod data: not on dev')).toBeNull();
    expect(evidenceIdOf('https://x.y/z')).toBeNull();
    expect(evidenceIdOf('')).toBeNull();
  });
});
