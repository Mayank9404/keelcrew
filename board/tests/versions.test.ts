import { describe, expect, it } from 'vitest';
import { deepMerge, diffPatch, fingerprint, stableStringify, versionOf } from '../src/lib/versions';

const snap = (data: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => ({ exists: data !== undefined, data: () => data, ...extra });

describe('versions', () => {
  it('fingerprints bodies regardless of key order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3] } })).toBe(stableStringify({ a: { c: [3], d: 2 }, b: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });

  it("uses the store's own version when the runtime gives one", () => {
    expect(versionOf(snap({ a: 1 }, { version: 7 }))).toBe('v7');
    expect(versionOf(snap({ a: 1 }))).toBe(fingerprint({ a: 1 }));
    expect(versionOf(snap(undefined))).toBe('missing');
  });

  it('patches only changed leaves, nested as nested objects', () => {
    const base = { maxWorkers: 4, intake: { jql: 'a', skipKeys: ['X-1'] }, codeReview: { args: 'high' } };
    const next = { maxWorkers: 4, intake: { jql: 'b', skipKeys: ['X-1'] }, codeReview: { args: 'high' } };
    expect(diffPatch(base, next)).toEqual({ intake: { jql: 'b' } });
    expect(diffPatch(base, base)).toBeNull();
  });

  it('replaces arrays whole and blanks removed keys', () => {
    expect(diffPatch({ a: [1, 2], b: 1 }, { a: [1] })).toEqual({ a: [1], b: null });
  });

  it('merges like update, keeping defaults under null', () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [2], e: null })).toEqual({ a: { b: 1, c: 3 }, d: [2] });
  });
});
