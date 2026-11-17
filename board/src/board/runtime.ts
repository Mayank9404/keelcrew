/**
 * The page's runtime (`window.claude`): the board's database (`db`), the viewer (`user`), and the keelcrew-local helper
 * on this Mac (`mcp`, server "host:keelcrew-local"). Each may be missing (a phone, a viewer without access, a browser
 * tab), so every caller handles null. Types follow the artifact runtime's contract (db, user, mcp).
 */
import { HELPER_WRITE_TOOLS, helperFailure, retryDelayMs, retryableRead, type HelperTool, type McpFailure } from '../lib/helperTools';
import { sleep } from '../lib/poll';

export interface DocSnap {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}
export interface QuerySnap {
  docs: DocSnap[];
  size?: number;
}
export type Unsubscribe = () => void;
export interface DbError {
  code: string;
  message?: string;
}
export interface DocRef {
  id: string;
  get(): Promise<DocSnap>;
  set(data: Record<string, unknown>): Promise<void>;
  update(data: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
  acquire?(options: { holder: string; ttlMs?: number }): Promise<{ acquired: boolean }>;
  onSnapshot(next: (s: DocSnap) => void, error?: (e: DbError) => void): Unsubscribe;
  collection(path: string): CollectionRef;
}
export interface Query {
  where(field: string, op: string, value: unknown): Query;
  orderBy(field: string, dir?: 'asc' | 'desc'): Query;
  limit(n: number): Query;
  get(): Promise<QuerySnap>;
  onSnapshot(next: (s: QuerySnap) => void, error?: (e: DbError) => void): Unsubscribe;
}
export interface CollectionRef extends Query {
  doc(id?: string): DocRef;
  add(data: Record<string, unknown>): Promise<DocRef>;
}
export interface Db {
  doc(path: string): DocRef;
  collection(path: string): CollectionRef;
}
/** The `mcp` capability's CallToolResult, as far as the board reads it. */
interface McpResult {
  payload?: unknown;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
}
interface Mcp {
  callTool(server: string, tool: string, input?: unknown, options?: { cache?: false }): Promise<McpResult>;
}
interface User {
  isOwner(): Promise<boolean>;
  id(): Promise<string | null>;
}
interface ClaudeRuntime {
  use(name: string): Promise<unknown>;
}

/** The helper's server name in the page's `mcp` capability. */
export const HELPER = 'host:keelcrew-local';

const runtime = (): ClaudeRuntime | null => (window as unknown as { claude?: ClaudeRuntime }).claude ?? null;
const once = <T>(name: string): Promise<T | null> => runtime()?.use(name).then((x) => (x ?? null) as T | null, () => null) ?? Promise.resolve(null);

export const dbP = once<Db>('db');
export const userP = once<User>('user');
const mcpP = once<Mcp>('mcp');


/** Whether this viewer owns the artifact; false when the user capability is missing (the page then stays read-only). */
export const isOwnerP: Promise<boolean> = userP.then((u) => (u ? u.isOwner().then((x) => x === true, () => false) : false));

/** Whether the helper answered on this view: false on a phone or a Mac without it, null before the first call. */
let helperUp: boolean | null = null;
export const helperAvailable = (): boolean => helperUp === true;

export class HelperError extends Error {
  readonly code: string;
  /** A write whose outcome is unknown: the call failed in a way that doesn't prove it didn't run on the Mac. */
  readonly ambiguous: boolean;
  constructor(message: string, code: string, ambiguous = false) {
    super(message);
    this.name = 'HelperError';
    this.code = code;
    this.ambiguous = ambiguous;
  }
}

/** The tool's JSON answer: the runtime's `payload` (structuredContent, else the first text block parsed). */
function payloadOf<T>(r: McpResult): T {
  const payload = r.payload ?? r.structuredContent;
  if (payload !== undefined) return payload as T;
  const text = r.content?.find((c) => c.type === 'text')?.text ?? '{}';
  try {
    return JSON.parse(text) as T;
  } catch {
    return { result: text } as T;
  }
}

/** The input as plain JSON: keys whose value is undefined are left out (the capability takes JSON only). */
const plain = (input: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));

/**
 * Calls a keelcrew-local tool. Rejects with a HelperError whose message can be shown as is (by McpError code: a tool the
 * helper doesn't have is `missing_tool`, a declined confirm on a write is `cancelled` and never ran). A read the
 * runtime marks retryable is repeated once after the delay it asks for; a write never is.
 */
export async function helper<T>(tool: HelperTool, input: Record<string, unknown> = {}): Promise<T> {
  const mcp = await mcpP;
  if (!mcp) {
    helperUp = false;
    throw new HelperError('This needs your Mac: open the Keelcrew board in the Claude app there.', 'no_mcp');
  }
  const write = HELPER_WRITE_TOOLS.includes(tool);
  const args = plain(input);
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await mcp.callTool(HELPER, tool, args, { cache: false });
      helperUp = true;
      return payloadOf<T>(r);
    } catch (e) {
      const err = (e && typeof e === 'object' ? e : { message: String(e) }) as McpFailure;
      if (!write && attempt === 0 && retryableRead(err)) {
        await sleep(retryDelayMs(err));
        continue;
      }
      const f = helperFailure(tool, err, write);
      if (f.unreachable) helperUp = false;
      throw new HelperError(f.message, f.code, f.ambiguous);
    }
  }
}
