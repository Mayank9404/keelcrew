import { describe, expect, it } from 'vitest';
import { MAX_LIMIT, SUBSCRIPTIONS, applySpec, evidenceSpec, isBounded, isFull, mergeById, type QueryLike, type QuerySpec } from '../src/lib/paging';

/** Records the builder calls a spec makes. */
class Recorder implements QueryLike<Recorder> {
  calls: string[] = [];
  private add(c: string): Recorder {
    const r = new Recorder();
    r.calls = [...this.calls, c];
    return r;
  }
  where(f: string, op: string, v: unknown) {
    return this.add(`where ${f} ${op} ${JSON.stringify(v)}`);
  }
  orderBy(f: string, dir?: string) {
    return this.add(`orderBy ${f} ${dir}`);
  }
  limit(n: number) {
    return this.add(`limit ${n}`);
  }
}

describe('paging', () => {
  it('bounds every live subscription', () => {
    for (const [name, spec] of Object.entries(SUBSCRIPTIONS)) {
      expect(isBounded(spec), name).toBe(true);
      expect(spec.limit).toBeLessThanOrEqual(MAX_LIMIT);
    }
  });

  it('bounds evidence reads', () => {
    expect(isBounded(evidenceSpec('BRIN-1'))).toBe(true);
  });

  it('builds filters, the order, then the limit', () => {
    const q = applySpec(new Recorder(), SUBSCRIPTIONS.tasksClosed);
    expect(q.calls).toEqual(['where status in ["done","cancelled"]', 'orderBy closedAt desc', 'limit 100']);
  });

  it('refuses unbounded specs', () => {
    const unbounded: QuerySpec = { collection: 'tasks', limit: 50 };
    expect(isBounded(unbounded)).toBe(false);
    expect(() => applySpec(new Recorder(), unbounded)).toThrow(/Unbounded/);
    expect(isBounded({ collection: 'chat', orderBy: ['ts', 'desc'], limit: 5000 })).toBe(false);
    expect(isBounded({ collection: 'chat', orderBy: ['ts', 'desc'], limit: 0 })).toBe(false);
  });

  it('tells a full window from a partial one', () => {
    expect(isFull(SUBSCRIPTIONS.tasksClosed, 100)).toBe(true);
    expect(isFull(SUBSCRIPTIONS.tasksClosed, 99)).toBe(false);
  });

  it('merges windows by id, later ones winning', () => {
    const a = new Map([['x', 1], ['y', 2]]);
    const b = new Map([['y', 3]]);
    expect([...mergeById(a, b)]).toEqual([['x', 1], ['y', 3]]);
  });
});
