import { describe, expect, it } from 'vitest';
import rules from '../../plugins/keelcrew/rules/rules.json';
import { duration, listWords, policyText, type Rules } from '../src/lib/policy';

const r = rules as Rules;

describe('policy text from rules.json', () => {
  const p = policyText(r, [{ role: 'QA agent', summary: 'Tests deployed tickets.' }]);
  const text = (list: { rule: string; detail?: string }[]) => list.map((x) => `${x.rule} ${x.detail ?? ''}`).join('\n').toLowerCase();

  it('lists every denied command', () => {
    for (const d of r.policy.denyBash) expect(text(p.never)).toContain(d.why.toLowerCase());
  });

  it('names the protected branches and the secrets rule', () => {
    for (const b of r.policy.protectedBranches) expect(text(p.never)).toContain(b);
    expect(text(p.never)).toContain('secrets');
  });

  it('describes every ship choice, and that an approval holds for its commit', () => {
    for (const c of r.ship.choices) expect(text(p.needsApproval)).toContain(c.toLowerCase());
    expect(text(p.needsApproval)).toContain('hold for the commit you approved');
  });

  it('falls back to the single grant time without risk tiers', () => {
    const q = policyText({ ...r, risk: undefined });
    expect(text(q.needsApproval)).toContain(`for ${duration(r.ship.grantTtlMinutes)} and only on the commit you approved`);
    expect(text(q.needsApproval)).not.toContain('expire');
  });

  it('opens connectors and keeps CI builds asking', () => {
    expect(text(p.allowed)).toContain('use connectors');
    expect(text(p.needsApproval)).toContain('ci builds');
    expect(text(p.needsApproval)).not.toContain('trust');
  });

  it('passes the roles through', () => {
    expect(p.roles).toEqual([{ role: 'QA agent', summary: 'Tests deployed tickets.' }]);
  });

  it('follows the rules, not a copy', () => {
    const changed: Rules = { ...r, policy: { ...r.policy, denyBash: [{ pattern: 'x', why: 'a brand new rule' }] } };
    const q = policyText(changed);
    expect(text(q.never)).toContain('a brand new rule');
  });

  it('writes lists and durations in words', () => {
    expect(listWords(['a', 'b', 'c'])).toBe('a, b and c');
    expect(duration(180)).toBe('3 hours');
    expect(duration(60)).toBe('1 hour');
  });
});
