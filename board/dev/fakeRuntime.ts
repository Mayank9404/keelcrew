/**
 * A stand-in for the artifact runtime (`window.claude`): an in-memory board database with live snapshots, the
 * viewer, and the keelcrew-local helper. Dev only: dev/main.ts installs it before the board starts; the production
 * entry (src/main.tsx) never imports it.
 *
 * It follows the real capability contracts (artifact-capabilities db.d.ts, mcp.d.ts, user.d.ts) where they differ from
 * a naive fake: snapshots carry no version, rejections are plain `{code, message}` objects with the documented codes,
 * a tool failure rejects `tool_error` with the result envelope, a declined confirm on a write tool rejects `cancelled`,
 * and the helper checks arguments the way plugins/keelcrew/helper/server.mjs does.
 */
type Data = Record<string, unknown>;
type Listener = () => void;

const isObj = (v: unknown): v is Data => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = <T,>(v: T): T => structuredClone(v);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dbError = (code: string, message: string) => ({ code, message });
const META = Object.freeze({ fromCache: false, hasPendingWrites: false });

function merge(a: Data, b: Data): Data {
  const out: Data = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? merge(out[k] as Data, v) : clone(v);
  return out;
}

/** Orders like the store: by the field, documents missing it last in either direction. */
function compare(a: unknown, b: unknown, dir: string): number {
  const missA = a === undefined || a === null;
  const missB = b === undefined || b === null;
  if (missA || missB) return missA === missB ? 0 : missA ? 1 : -1;
  const c = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
  return dir === 'desc' ? -c : c;
}

export class FakeDb {
  readonly docs = new Map<string, { data: Data; rev: number }>();
  private readonly listeners = new Set<Listener>();
  private seq = 0;
  /** Writes left to fail with `unavailable` (the store's transient code), to try the board's one retry. */
  flakyWrites = 0;
  /** Every write, in order, when set (shared with the helper's call log). */
  log: string[] | null = null;
  constructor(seed: Record<string, Data>) {
    for (const [p, d] of Object.entries(seed)) this.docs.set(p, { data: clone(d), rev: 1 });
  }
  /** Live listeners, to spot subscriptions that leak or double up. */
  get listenerCount(): number {
    return this.listeners.size;
  }
  private emit() {
    queueMicrotask(() => {
      for (const l of [...this.listeners]) l();
    });
  }
  private snap(path: string) {
    const d = this.docs.get(path);
    const id = path.split('/').pop()!;
    const body = d ? Object.freeze(clone(d.data)) : undefined;
    return { id, exists: !!d, metadata: META, data: () => body };
  }
  private async writeGate() {
    await wait(60);
    if (this.flakyWrites > 0) {
      this.flakyWrites--;
      throw dbError('unavailable', 'The store is briefly unavailable');
    }
  }
  write(path: string, fn: (cur: Data | undefined) => Data | null) {
    const cur = this.docs.get(path);
    const next = fn(cur?.data);
    if (next === null) this.docs.delete(path);
    else this.docs.set(path, { data: next, rev: (cur?.rev ?? 0) + 1 });
    this.emit();
  }
  doc(path: string): any {
    if (path.split('/').length % 2) throw new TypeError(`A document path needs an even number of segments: ${path}`);
    const self = this;
    return {
      id: path.split('/').pop(),
      path,
      async get() {
        await wait(30);
        return self.snap(path);
      },
      async set(data: Data) {
        if (!isObj(data)) throw dbError('invalid_argument', 'A document body must be an object');
        self.log?.push(`db set ${path}`);
        await self.writeGate();
        self.write(path, () => clone(data));
      },
      async update(data: Data) {
        self.log?.push(`db update ${path} ${JSON.stringify(data).slice(0, 80)}`);
        await self.writeGate();
        if (!self.docs.has(path)) throw dbError('invalid_argument', `update: ${path} does not exist`);
        self.write(path, (cur) => merge(cur ?? {}, data));
      },
      async delete() {
        await wait(40);
        self.write(path, () => null);
      },
      async acquire() {
        return { acquired: true, version: 1, expiresAt: new Date(Date.now() + 30_000).toISOString() };
      },
      onSnapshot(next: (s: unknown) => void) {
        let last = '';
        let live = true;
        const fire = () => {
          if (!live) return;
          const d = self.docs.get(path);
          const sig = `${!!d}:${d?.rev}`;
          if (sig === last) return;
          last = sig;
          next(self.snap(path));
        };
        self.listeners.add(fire);
        queueMicrotask(fire);
        return () => {
          live = false;
          self.listeners.delete(fire);
        };
      },
      collection: (sub: string) => self.collection(`${path}/${sub}`),
    };
  }
  collection(path: string, filters: [string, string, unknown][] = [], order: [string, string] | null = null, lim = 1000): any {
    if (path.split('/').length % 2 === 0) throw new TypeError(`A collection path needs an odd number of segments: ${path}`);
    const self = this;
    const depth = path.split('/').length + 1;
    const run = () => {
      let rows = [...self.docs.entries()].filter(([p]) => p.startsWith(`${path}/`) && p.split('/').length === depth);
      for (const [f, op, v] of filters) {
        rows = rows.filter(([, d]) => {
          const x = d.data[f];
          if (op === '==') return x === v;
          if (op === '!=') return x !== undefined && x !== v;
          if (op === 'in') return (v as unknown[]).includes(x);
          if (op === 'not-in') return x !== undefined && !(v as unknown[]).includes(x);
          if (op === 'array-contains') return Array.isArray(x) && x.includes(v);
          return true;
        });
      }
      if (order) rows.sort(([pa, a], [pb, b]) => compare(a.data[order[0]], b.data[order[0]], order[1]) || pa.localeCompare(pb));
      else rows.sort(([pa], [pb]) => pa.localeCompare(pb));
      return rows.slice(0, lim);
    };
    const snapOf = (rows: [string, { data: Data; rev: number }][]) => {
      const docs = rows.map(([p]) => self.snap(p));
      return { docs, size: docs.length, empty: !docs.length, metadata: META, docChanges: () => [] };
    };
    return {
      path,
      where: (f: string, op: string, v: unknown) => self.collection(path, [...filters, [f, op, v]], order, lim),
      orderBy: (f: string, dir = 'asc') => self.collection(path, filters, [f, dir], lim),
      limit: (n: number) => {
        if (!Number.isInteger(n) || n < 1 || n > 1000) throw dbError('invalid_argument', `limit must be 1-1000, got ${n}`);
        return self.collection(path, filters, order, n);
      },
      async get() {
        await wait(40);
        return snapOf(run());
      },
      onSnapshot(next: (s: unknown) => void) {
        let last = '';
        let live = true;
        const fire = () => {
          if (!live) return;
          const rows = run();
          const sig = rows.map(([p, d]) => `${p}:${d.rev}`).join(',');
          if (sig === last) return;
          last = sig;
          next(snapOf(rows));
        };
        self.listeners.add(fire);
        queueMicrotask(fire);
        return () => {
          live = false;
          self.listeners.delete(fire);
        };
      },
      doc: (id?: string) => self.doc(`${path}/${id ?? `auto-${Date.now().toString(36)}-${++self.seq}`}`),
      async add(data: Data) {
        const ref = self.doc(`${path}/auto-${Date.now().toString(36)}-${++self.seq}`);
        await ref.set(data);
        return ref;
      },
    };
  }
}

/* ---------- the helper's argument checks (as plugins/keelcrew/helper/server.mjs) ---------- */

type Prop = { type?: string | string[]; enum?: unknown[] };
const SHIP_CHOICES = ['Open PR', 'Draft PR', 'Push only', 'Not yet'];
const WHO: Record<string, Prop> = { key: { type: 'string' }, agent: { type: 'string' } };
/** Each tool's properties and required keys, and whether it writes (the app asks to confirm those). */
export const SCHEMAS: Record<string, { props: Record<string, Prop>; required: string[]; write?: boolean }> = {
  ping: { props: {}, required: [] },
  crew_state: { props: {}, required: [] },
  session_events: { props: { ...WHO, before: { type: 'number' }, limit: { type: 'number' } }, required: ['key'] },
  transcript: { props: { ...WHO, offset: { type: ['number', 'null'] }, limit: { type: 'number' } }, required: ['key'] },
  diff: { props: { key: { type: 'string' } }, required: ['key'] },
  risk: { props: { key: { type: 'string' } }, required: ['key'] },
  costs: { props: {}, required: [] },
  branch_url: { props: { key: { type: 'string' } }, required: ['key'] },
  changed_files: { props: {}, required: [] },
  open_in: { props: { ...WHO, app: { type: 'string', enum: ['editor', 'finder', 'terminal'] } }, required: ['key', 'app'], write: true },
  open_session: { props: { ...WHO, app: { type: 'string', enum: ['desktop', 'warp', 'terminal'] } }, required: ['key'], write: true },
  logs: { props: {}, required: [] },
  log_tail: { props: { file: { type: 'string' }, lines: { type: 'number' } }, required: ['file'] },
  open_logs: { props: { file: { type: ['string', 'null'] } }, required: [], write: true },
  doctor: { props: {}, required: [] },
  prompts: { props: {}, required: [] },
  prompt_save: { props: { file: { type: 'string' }, text: { type: 'string' } }, required: ['file', 'text'], write: true },
  config_get: { props: {}, required: [] },
  config_set: { props: { patch: { type: 'object' } }, required: ['patch'], write: true },
  approve: { props: { key: { type: 'string' }, choice: { type: 'string', enum: SHIP_CHOICES }, head: { type: 'string' } }, required: ['key', 'choice'], write: true },
  approve_post: { props: { key: { type: 'string' }, tool: { type: 'string' }, match: { type: 'string' } }, required: ['key', 'tool'], write: true },
  memory_list: { props: { repo: { type: 'string' }, agent: { type: 'string' } }, required: [] },
  agents_list: { props: {}, required: [] },
  org: { props: {}, required: [] },
};

const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function argumentProblem(tool: string, args: unknown): string | null {
  const s = SCHEMAS[tool];
  if (typeOf(args) !== 'object') return 'The arguments must be an object.';
  const a = args as Data;
  for (const k of s.required) if (a[k] === undefined || a[k] === null || a[k] === '') return `Missing "${k}".`;
  for (const [k, p] of Object.entries(s.props)) {
    const v = a[k];
    if (v === undefined) continue;
    const types = [p.type ?? []].flat();
    if (types.length && !types.includes(typeOf(v))) return `"${k}" must be ${types.join(' or ')}.`;
    if (p.enum && !p.enum.includes(v)) return `"${k}" must be one of: ${p.enum.join(', ')}.`;
  }
  return null;
}

const toolFailure = (text: string) => ({ code: 'tool_error', message: text, result: { content: [{ type: 'text', text }], isError: true } });

export interface FakeOptions {
  db: FakeDb;
  owner: boolean;
  /** Helper tools by name; null leaves the page without the `mcp` capability (a phone, another viewer). */
  tools: Record<string, (input: Data) => unknown> | null;
  /**
   * How the helper misbehaves, comma-separated: `down` (not running: server_not_connected), `denied` (not allowed for
   * this page: not_in_manifest), `old` (a helper that doesn't report schema 2), `decline` (the captain declines every write's
   * confirm), `fail-approve` (approve fails on the Mac), `timeout-approve` (approve's answer never comes back), `slow`
   * (writes wait 2.5 s for the confirm).
   */
  helperMode?: string | null;
  /** Every call made, for checking order (approve after the card's update). */
  log?: string[];
}

export function installRuntime({ db, owner, tools, helperMode = null, log }: FakeOptions): void {
  const mode = new Set((helperMode ?? '').split(',').filter(Boolean));
  const mcp = tools
    ? {
        async callTool(server: string, tool: string, input: Data = {}, options?: { cache?: false }) {
          void options;
          log?.push(`mcp ${tool}`);
          await wait(tool === 'approve' || tool === 'approve_post' ? 400 : 120);
          if (mode.has('down') || server !== 'host:keelcrew-local') throw { code: 'server_not_connected', server, message: 'No host bridge for this server' };
          if (mode.has('denied')) throw { code: 'not_in_manifest', server, message: 'The viewer did not allow this connector for this page' };
          const schema = SCHEMAS[tool];
          const fn = tools[tool];
          if (!schema || !fn) throw { code: 'upstream_error', server, message: `Unknown tool: ${tool}` };
          if (schema.write) {
            if (mode.has('slow')) await wait(2500);
            if (mode.has('decline')) throw { code: 'cancelled', server, message: 'The viewer declined the call' };
          }
          const problem = argumentProblem(tool, input);
          if (problem) throw toolFailure(`${tool}: ${problem}`);
          if (tool === 'approve') {
            const head = input.head;
            if (head !== undefined && head !== null && !/^[0-9a-f]{40,64}$/.test(String(head))) throw toolFailure('head must be the full commit sha from the launch card (40 to 64 hex digits).');
            if (mode.has('fail-approve') && input.choice !== 'Not yet') throw toolFailure(`Couldn't read the current commit in /w/${String(input.key).toLowerCase()}, so nothing was approved. Try again.`);
            if (mode.has('timeout-approve')) {
              await wait(1500);
              throw { code: 'server_unavailable', server, retryable: true, message: 'The host did not answer in time' };
            }
          }
          let out: unknown;
          try {
            out = mode.has('old') && tool === 'ping' ? { ok: true, version: '0.9.0', home: '/Users/sam/.keelcrew' } : fn(input);
          } catch (e) {
            throw toolFailure(e instanceof Error ? e.message : String(e));
          }
          const structured = isObj(out) ? out : { result: out ?? null };
          return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, payload: structured };
        },
      }
    : null;
  const user = { isOwner: async () => owner, canEdit: async () => owner, can: async () => owner, id: async () => (owner ? 'u_owner' : 'u_guest') };
  (window as unknown as { claude: unknown }).claude = {
    use: async (name: string) => (name === 'db' ? db : name === 'user' ? user : name === 'mcp' ? mcp : null),
  };
}
