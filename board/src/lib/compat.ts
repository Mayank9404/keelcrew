/** The board's database schema, and whether the local helper on this Mac serves the same one. */

/** The board schema this board reads and writes, which the helper's ping must match (docs/architecture.md, "The Keelcrew board"). */
export const BOARD_SCHEMA = 2;

export type HelperStatus = 'unknown' | 'ok' | 'old' | 'newer' | 'missing';

export interface HelperInfo {
  status: HelperStatus;
  version: string | null;
  schema: number | null;
  /** Why the helper is missing: the failed ping's code (`no_mcp`, `server_not_connected`, `not_in_manifest`, …). */
  reason?: string | null;
}

/**
 * Reads the helper's `ping` answer (`{ok, version, schema, home}`). A helper that answers without `schema` counts
 * as old; a later schema means the helper is ahead of this board; no answer (null) means this view
 * can't reach the helper, for `reason` (the failed call's code).
 */
export function helperStatus(ping: unknown, expected = BOARD_SCHEMA, reason: string | null = null): HelperInfo {
  if (!ping || typeof ping !== 'object') return { status: 'missing', version: null, schema: null, reason };
  const p = ping as Record<string, unknown>;
  const version = typeof p.version === 'string' ? p.version : typeof p.version === 'number' ? String(p.version) : null;
  const schema = typeof p.schema === 'number' && Number.isFinite(p.schema) ? p.schema : typeof p.schema === 'string' && /^\d+$/.test(p.schema) ? Number(p.schema) : null;
  const status: HelperStatus = schema === null || schema < expected ? 'old' : schema > expected ? 'newer' : 'ok';
  return { status, version, schema };
}

/**
 * The note for the captain when the helper can't be reached from this view, by why. With `phone` (Settings → Shipping's phone
 * approvals), answers still work here: the Mate's session on the Mac carries them out.
 */
function missingNote(reason: string | null | undefined, phone: boolean): string {
  const approvals = phone ? 'Approvals from here go through your Mac within a minute while the Mate session is open.' : 'Approvals need your Mac too.';
  switch (reason) {
    case 'no_mcp':
    case 'not_granted':
    case 'capability_disabled':
    case 'capability_removed':
      return `Diffs and transcripts need your Mac: open the Keelcrew board in the Claude app there. ${approvals} Everything else works here.`;
    case 'server_not_connected':
      return `The Keelcrew helper isn’t running in this Claude app, so diffs and transcripts are off. ${approvals} On your Mac, run ~/.keelcrew/bin/keelctl helper bundle --open and click Install in the Claude app (no restart), then reload the board.`;
    case 'not_in_manifest':
      return `This board isn’t allowed to use the Keelcrew helper, so diffs and transcripts are off. ${approvals} Allow it from the artifact’s Permissions menu, then reload.`;
    case 'blocked_by_policy':
      return `Your organization’s policy blocks the Keelcrew helper here, so diffs and transcripts are off. ${approvals}`;
    default:
      return `The Keelcrew helper on your Mac didn’t answer, so diffs and transcripts are off for now. ${approvals} The board tries again when you come back to it.`;
  }
}

/** A check-in older than this means the panel in the Mate session stopped: it reads the board every minute. */
export const PANEL_STALE_MS = 10 * 60_000;

/**
 * The note when the panel in the Mate session hasn't read the board for PANEL_STALE_MS, or null. Only while the helper
 * answers: without it the board can't tell. After the Claude app restarts, a session doesn't run until it's opened.
 */
export function panelNote(panelAt: number | null, now: number, helper: HelperStatus): string | null {
  if (helper !== 'ok' || panelAt === null || now - panelAt < PANEL_STALE_MS) return null;
  const sameDay = new Date(panelAt).toDateString() === new Date(now).toDateString();
  const at = new Date(panelAt).toLocaleString([], sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `The Mate session hasn’t read the board since ${at}: it isn’t open, or it can’t read the board. Your answers wait until it does. Open the Mate session in the Claude app (after a restart it stays closed until opened); if it’s open, its Keelcrew panel says what’s wrong.`;
}

/** The note line for a helper that's missing or doesn't match, or null. */
export function helperNote(info: HelperInfo, phoneApprovals = true): string | null {
  if (info.status === 'missing') return missingNote(info.reason, phoneApprovals);
  if (info.status === 'old') return `The Keelcrew helper on this Mac${info.version ? ` (${info.version})` : ''} is older than this board, so some views may not work. Update the keelcrew plugin, then restart the Claude app.`;
  if (info.status === 'newer') return `This Keelcrew board is older than the Keelcrew helper on this Mac (schema ${info.schema}). Ask the Mate to republish the board.`;
  return null;
}
