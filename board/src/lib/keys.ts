/** Task keys: Jira tickets (BRIN-2401) and captain’s tasks (T-3). */

export const isOwnerTaskKey = (key: string): boolean => /^T-\d+$/.test(key);

/** Jira-style keys can be skipped and linked to Jira; captain’s tasks cannot. */
export const isJiraKey = (key: string): boolean => /^[A-Z][A-Z0-9]+-\d+$/.test(key) && !isOwnerTaskKey(key);

/** BRIN-2401 → #2401; captain’s tasks like T-3 stay as they are. */
export const shortKey = (key: string): string => (isOwnerTaskKey(key) ? key : key.replace(/^[A-Za-z][A-Za-z0-9]*-/, '#'));

/** A task row's kind: captain’s tasks are `adhoc`, Jira tickets `ticket`. */
export function taskKindOf(key: string, source: unknown): 'adhoc' | 'ticket' {
  if (source === 'jira') return 'ticket';
  return source === 'user' || source === 'board' || isOwnerTaskKey(key) ? 'adhoc' : 'ticket';
}
