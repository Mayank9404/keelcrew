/**
 * Every tool of the keelcrew-local helper the board may call. The build writes them into dist/capabilities.json, the
 * artifact's `mcp` capability (server "host:keelcrew-local") that /keel-setup publishes with, so a tool the board calls
 * must be listed here. A tool the
 * installed helper doesn't have fails as "missing" (see `isMissingTool`), and the section that needs it says so.
 */
export const HELPER_TOOLS = [
  'ping',
  'crew_state',
  'session_events',
  'transcript',
  'diff',
  'branch_url',
  'changed_files',
  'open_in',
  'open_session',
  'open_file',
  'logs',
  'log_tail',
  'open_logs',
  'doctor',
  'prompts',
  'prompt_save',
  'config_get',
  'config_set',
  'approve',
  'approve_post',
  'memory_list',
  'agents_list',
  'risk',
  'costs',
  'org',
] as const;

export type HelperTool = (typeof HELPER_TOOLS)[number];

/** Tools that change something on the Mac; the app asks the captain on every call. */
export const HELPER_WRITE_TOOLS: readonly HelperTool[] = ['open_in', 'open_session', 'open_file', 'open_logs', 'prompt_save', 'config_set', 'approve', 'approve_post'];

/**
 * Error codes (the `mcp` capability's McpError codes) that mean the page can't reach the helper at all, as opposed to
 * one call failing. `not_in_manifest` on a host server means the viewer didn't allow it for this page (or turned it
 * off): every tool is out of reach until they allow it again.
 */
export const UNREACHABLE_CODES = new Set(['server_not_connected', 'not_granted', 'capability_disabled', 'capability_removed', 'blocked_by_policy', 'not_in_manifest', 'user_changed']);

/** Codes whose outcome is unknown for a write: the tool may have run even though the call rejected. */
const AMBIGUOUS_CODES = new Set(['server_unavailable', 'upstream_error', 'rate_limited']);

/** True when a failed call means the helper doesn't have the tool (its plugin version lacks it), rather than a failure. */
export function isMissingTool(code: string | undefined, message: string | undefined): boolean {
  if (code === 'tool_not_found' || code === 'method_not_found' || code === '-32601') return true;
  return /\bunknown tool\b|\bno such tool\b|\btool not found\b|\bmethod not found\b/i.test(message ?? '');
}

/** The note a section shows when its tool is missing. */
export const missingToolNote = (tool: HelperTool): string => `The Keelcrew helper on this Mac doesn’t have “${tool}” yet. Update the keelcrew plugin, then restart the Claude app.`;

/** A rejection from the `mcp` capability (McpError), as far as the board reads it. */
export interface McpFailure {
  code?: unknown;
  message?: unknown;
  retryable?: unknown;
  retryAfterMs?: unknown;
  /** On `tool_error`: the tool's whole result envelope. */
  result?: unknown;
}

export interface HelperFailure {
  /** The McpError code, or `missing_tool` for a tool this helper doesn't have. */
  code: string;
  /** What to show the captain, as is. */
  message: string;
  /** The page can't reach the helper at all (sections should say so rather than retry). */
  unreachable: boolean;
  /** A write whose outcome is unknown: it may have run on the Mac. */
  ambiguous: boolean;
}

/** The text a tool failure carries: the helper's own message from a `tool_error` envelope, else the error's message. */
export function failureText(e: McpFailure): string {
  const r = e.result as { content?: { type?: string; text?: string }[] } | undefined;
  const t = Array.isArray(r?.content) ? r.content.find((c) => c?.type === 'text' && typeof c.text === 'string')?.text : undefined;
  const m = typeof e.message === 'string' ? e.message : '';
  return (t || m).trim();
}

/**
 * What a failed helper call means, by McpError code (never by message text, except to spot a helper's "Unknown
 * tool"). `write`: the tool changes something on the Mac (the app asks the captain to confirm it, and a decline comes
 * back as `cancelled`, meaning it never ran).
 */
export function helperFailure(tool: HelperTool, e: McpFailure, write: boolean): HelperFailure {
  const code = typeof e.code === 'string' && e.code ? e.code : 'upstream_error';
  const text = failureText(e);
  const out = (message: string, extra: Partial<HelperFailure> = {}): HelperFailure => ({ code, message, unreachable: UNREACHABLE_CODES.has(code), ambiguous: false, ...extra });
  if (isMissingTool(code, text)) return { code: 'missing_tool', message: missingToolNote(tool), unreachable: false, ambiguous: false };
  switch (code) {
    case 'tool_error':
      return out(text || `The Keelcrew helper couldn’t do “${tool}”.`);
    case 'cancelled':
      return out(write ? 'You declined it in the Claude app, so nothing was done on your Mac.' : 'Cancelled.');
    case 'server_not_connected':
      return out('The Keelcrew helper isn’t running here. Open the board in the Claude app on your Mac; if it’s there and this persists, run ~/.keelcrew/bin/keelctl helper bundle --open on your Mac and click Install.');
    case 'not_in_manifest':
      return out('This board isn’t allowed to use the Keelcrew helper. Allow it from the artifact’s Permissions menu, then reload.');
    case 'approval_required':
    case 'consent_required':
      return out('The Claude app needs your OK for this. Try again and choose Allow.');
    case 'blocked_by_policy':
      return out('Your organization’s policy blocks the Keelcrew helper here.');
    case 'not_granted':
    case 'capability_disabled':
    case 'capability_removed':
      return out('This view can’t reach your Mac. Open the Keelcrew board in the Claude app there.');
    case 'user_changed':
      return out('The signed-in account changed. Reload the board.');
    case 'bad_request':
    case 'transform_error':
      return out(`The board sent “${tool}” something the helper couldn’t read${text ? `: ${text}` : '.'}`);
    default:
      if (write && AMBIGUOUS_CODES.has(code)) return out(`Your Mac didn’t confirm “${tool}”${text ? ` (${text})` : ''}, so it may or may not have run.`, { ambiguous: true });
      return out(`The Keelcrew helper didn’t answer${text ? `: ${text}` : '.'}`);
  }
}

/** Whether a failed read may be repeated once without the captain doing anything (the error says so). */
export const retryableRead = (e: McpFailure): boolean => e.retryable === true;

/** How long to wait before that one retry: the error's own hint (capped at 10 s), else 0.4 to 1.2 s. */
export const retryDelayMs = (e: McpFailure, random = Math.random()): number =>
  typeof e.retryAfterMs === 'number' && Number.isFinite(e.retryAfterMs) && e.retryAfterMs > 0 ? Math.min(e.retryAfterMs, 10_000) : 400 + Math.round(random * 800);
