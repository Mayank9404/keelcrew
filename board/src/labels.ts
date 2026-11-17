/** Display names for the crew's roles and the senders of cards. */
import { agentName } from './lib/agents';
import { AGENTS } from './lib/agentCatalog';
import type { Role, Session } from './types';

export const ROLE_LABEL: Record<Role, string> = { lead: 'Mate', engineer: 'Engineer', agent: 'Agent' };

export const LEAD = ROLE_LABEL.lead;

/** Who posted a card: Engineer, Mate, or the agent's name (QA agent, Learner, …). */
export function fromLabel(from: string): string {
  if (from === 'engineer') return ROLE_LABEL.engineer;
  if (from === 'lead') return LEAD;
  return agentName(AGENTS, from);
}

/** A session's role in words: an agent session shows its agent's name. */
export const sessionRole = (s: Pick<Session, 'role' | 'agent'>): string => (s.role === 'agent' ? agentName(AGENTS, s.agent) : ROLE_LABEL[s.role]);

export const EDITOR_LABEL: Record<'vscode' | 'cursor' | 'pycharm' | 'sublime' | 'zed', string> = { vscode: 'VS Code', cursor: 'Cursor', pycharm: 'PyCharm', sublime: 'Sublime Text', zed: 'Zed' };

/** A model id in words: claude-opus-5-5 is "Opus 5.5"; any other id as it is. */
export function modelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}

/** How hard engineers review their own changes: `/code-review`'s level, in words. */
export const REVIEW_LEVELS: [string, string][] = [
  ['low', 'Quick'],
  ['medium', 'Light'],
  ['high', 'Standard'],
  ['xhigh', 'Thorough'],
  ['max', 'Deepest'],
];
