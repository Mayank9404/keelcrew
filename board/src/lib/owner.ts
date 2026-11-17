/** Who may change the board through this page: only the artifact's owner (the `user` capability's `isOwner()`). */

export interface Access {
  canWrite: boolean;
  /** Why not, in words for the read-only note; null when writing is allowed. */
  reason: string | null;
}

export const READ_ONLY_NOTE = 'Read-only: only the captain of this Keelcrew board can make changes here.';

/**
 * `hasDb`: the page reached the board's database. `isOwner`: the user capability's answer, null while it's unknown or
 * when the capability isn't available (both read as "not the captain": the page never writes on a guess).
 */
export function writeAccess({ hasDb, isOwner }: { hasDb: boolean; isOwner: boolean | null }): Access {
  if (!hasDb) return { canWrite: false, reason: 'Open the Keelcrew board in Claude to see and change it.' };
  if (isOwner === true) return { canWrite: true, reason: null };
  return { canWrite: false, reason: READ_ONLY_NOTE };
}
