/**
 * "What the crew may do", written from plugins/keelcrew/rules/rules.json (imported at build time), so the board never
 * keeps its own copy of the rules. A team pack can add to the policy; the board shows the core rules.
 */
import type { PolicyRule, PolicySummary } from '../types';

export interface Rules {
  ship: { choices: string[]; allows: Record<string, string[]>; grantTtlMinutes: number };
  risk?: { ttlMinutes?: Partial<Record<'low' | 'medium' | 'high', number>> };
  policy: {
    denyBash: { pattern: string; why: string; flags?: string }[];
    protectedBranches: string[];
    secretPath?: string;
    crewFiles?: string;
    readVerbs: string[];
    writeVerbs: string[];
    readTools?: string[];
    boardOnlyTools?: string;
  };
}

const ACTION_WORDS: Record<string, string> = { push: 'push the branch', pr: 'open the PR', 'pr-draft': 'open a draft PR', 'pr-update': 'update the PR' };

const sentence = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "a, b and c". */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "3 hours", "90 minutes". */
export function duration(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `${minutes} minutes`;
}

const verbs = (list: string[], n = 8): string => `${list.slice(0, n).join(', ')}${list.length > n ? ` and ${list.length - n} more` : ''}`;

export function policyText(rules: Rules, roles: { role: string; summary: string }[] = []): PolicySummary {
  const p = rules.policy;
  const ttls = rules.risk?.ttlMinutes ?? {};
  const tiers = (['low', 'medium', 'high'] as const).filter((t) => ttls[t] != null);
  const scope = tiers.length ? 'only on the commit you approved' : `for ${duration(rules.ship.grantTtlMinutes)} and only on the commit you approved`;
  const allowed: PolicyRule[] = [
    { rule: 'Read code, docs and logs', detail: p.secretPath ? 'Except secrets: .env files, keys and credentials.' : undefined },
    { rule: 'Edit, commit, lint and run inside its own worktree' },
    { rule: 'Use connectors', detail: 'Reads and writes, for every role but the read-only and drafts ones; Claude Code’s own permissions judge each call.' },
  ];
  const needsApproval: PolicyRule[] = [];
  for (const choice of rules.ship.choices) {
    const allows = rules.ship.allows[choice];
    if (allows?.length) needsApproval.push({ rule: `Ship: ${choice}`, detail: `Lets the engineer ${listWords(allows.map((a) => ACTION_WORDS[a] ?? a))}, ${scope}.` });
    else needsApproval.push({ rule: `Ship: ${choice}`, detail: 'Clears any approval; nothing goes out.' });
  }
  if (tiers.length) needsApproval.push({ rule: 'Ship approvals hold for the commit you approved', detail: 'A new commit needs a new approval; one left unused for two weeks is cleared.' });
  needsApproval.push({ rule: 'CI builds', detail: 'Triggering, rebuilding or replaying a build, such as through a Jenkins connector.' });
  needsApproval.push({
    rule: 'Connector writes from read-only and drafts roles',
    detail: `Tools whose name starts with a write verb (${verbs(p.writeVerbs)}): drafts roles post once you approve, read-only roles never.`,
  });
  const never: PolicyRule[] = [];
  const seen = new Set<string>();
  for (const d of p.denyBash) {
    const why = sentence(d.why.trim());
    if (why && !seen.has(why)) {
      seen.add(why);
      never.push({ rule: why });
    }
  }
  if (p.protectedBranches.length) never.push({ rule: `Push to ${listWords(p.protectedBranches)}` });
  if (p.secretPath) never.push({ rule: 'Read or edit secrets', detail: '.env files, keys, certificates, credentials, .netrc and .pgpass.' });
  if (p.crewFiles) never.push({ rule: 'Change the crew’s own files', detail: 'Approvals, crew.json, config.json and the memory.' });
  if (p.boardOnlyTools) never.push({ rule: 'Approve their own work', detail: 'Only you approve, on the board, the Keelcrew panel or the engineer’s ship question.' });
  return { allowed, needsApproval, never, roles };
}
