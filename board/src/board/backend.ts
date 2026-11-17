/**
 * The board's actions: writes to the artifact database (captain only, pinned to what the captain saw) that the Mate picks
 * up, and calls to the keelcrew-local helper for what happens on this Mac (diffs, transcripts, apps, approvals).
 */
import rules from '../../../plugins/keelcrew/rules/rules.json';
import { AGENTS } from '../lib/agentCatalog';
import { manifestsFrom } from '../lib/agents';
import { answerItem, unanswerItem } from '../lib/answers';
import { type Backend, ApiError, type DiffResult, errorText, type InboxDecision, type OpenTarget, type PromptFile } from '../lib/api';
import { mergePatches } from '../lib/org';
import { clock } from '../lib/format';
import { evidenceSpec, applySpec } from '../lib/paging';
import { isFullSha } from '../lib/risk';
import { policyText, type Rules } from '../lib/policy';
import { diffPatch, stableStringify } from '../lib/versions';
import { toast } from '../lib/toast';
import type { CrewConfig, CrewEvent, Decision, DoctorCheck, Evidence, InboxItem, LogFile, LogTail, MemoryList, PostGrant, PostTarget, Risk, SearchHit, Task, Transcript } from '../types';
import { type Row, memoryOf, mergesOf, num, orgInfoOf, riskOf, str, toDecision, toEvidence, toInbox, toTask } from './convert';
import { addDoc, createOrUpdate, reader, updateFresh, updatePinned, updateWith, writer } from './db';
import { HelperError, helper, helperAvailable } from './runtime';
import { LOCAL_KEYS, S, configOf, inboxRows, metrics, publish, sessionsOf, sharedSettings, taskRows, tasksNow } from './state';

/** Ship choices (rules.json, in card order) by the card button that records them; "Not yet" clears any approval. */
const [openPr, draftPr, pushOnly, notYet] = rules.ship.choices;
const CHOICE: Partial<Record<InboxDecision, string>> = { approve: openPr, draft: draftPr, push: pushOnly, reject: notYet };

/** Editor links that open a folder straight from a click (helper calls that act on the Mac ask every time). */
const EDITOR_LINKS: Record<string, (dir: string) => string> = {
  pycharm: (d) => `pycharm://open?file=${encodeURIComponent(d)}`,
  vscode: (d) => `vscode://file${encodeURI(d)}`,
  cursor: (d) => `cursor://file${encodeURI(d)}`,
  zed: (d) => `zed://file${encodeURI(d)}`,
};

/** Opens an app link (claude://, pycharm://, …) from the viewer's click. */
function openLink(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.click();
}

/**
 * Asks the Mate to do something: a durable `requests` document `{kind, key, ...details, status: "open", at}`. The
 * Keelcrew panel in the Mate's session sees it within a minute and wakes the Mate; a `scan` and a `ready` compact
 * request are the panels' own, and `closeFinishedRequests` closes them.
 */
async function request(kind: string, key: string | null, details: Record<string, unknown> = {}): Promise<void> {
  await addDoc('requests', { kind, key, ...details, status: 'open', at: Date.now() });
}

const recordOf = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
/** Requests this page is closing right now, so a poll that lands meanwhile doesn't write them again. */
const closing = new Set<string>();

/**
 * Closes the requests this Mac finished without the Mate, from the helper's `crew_state` (owner only): a `compact`
 * request whose session's panel left `compacted/<id>.json` (`compacted: [{id, key, at, error?}]`), and a `scan` request
 * older than the Mate's panel's last Jira scan (`scan`, its scan.json). Each write is pinned to the version this page
 * saw; one that lost a race is looked at again on the next poll.
 */
export async function closeFinishedRequests(mac: { compacted?: unknown; scan?: unknown }): Promise<void> {
  if (!S.isOwner) return;
  const compacted = new Map((Array.isArray(mac.compacted) ? mac.compacted : []).map(recordOf).filter((c): c is Record<string, unknown> => !!c).map((c) => [str(c.id), c] as const));
  const scan = recordOf(mac.scan);
  const scanAt = num(scan?.at);
  const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  for (const r of [...S.requests.values()]) {
    if (r.status !== 'open' || closing.has(r._id)) continue;
    const c = r.kind === 'compact' ? compacted.get(r._id) : undefined;
    let result: string | null = null;
    if (c) result = c.error ? 'type /compact in that session' : `compacted at ${clock(num(c.at) ?? Date.now())}`;
    else if (r.kind === 'scan' && scan && scanAt !== null && scanAt > (num(r.at) ?? Infinity)) {
      result = scan.ok === true ? `${count(scan.new)} new, ${count(scan.changed)} changed, ${count(scan.updated)} updated` : `Jira scan failed: ${str(scan.error) || 'unknown error'}`;
    }
    if (!result) continue;
    closing.add(r._id);
    try {
      await updatePinned(`requests/${r._id}`, r._v, { status: 'done', result, handledAt: Date.now() }, 'That request');
    } catch {
      /* it changed meanwhile, or the board can't be written now: the next poll looks again */
    } finally {
      closing.delete(r._id);
    }
  }
}

/** Merges this page is writing right now, and the ones it already wrote, so a poll never writes one twice. */
const merging = new Set<string>();

/**
 * Moves the rows whose crew PR merged (the Mate's panel records them in merges.json, handed over by `crew_state`) to the
 * merge's target, done or qa, with `mergedAt` (owner only, with Settings → Shipping's merge switch on; never Jira). Each write is pinned to the row this page saw; one
 * that lost a race is looked at again on the next poll.
 */
export async function applyMerges(mac: { merges?: unknown }): Promise<void> {
  if (!S.isOwner || !configOf().merges.autoStatus) return;
  for (const m of mergePatches(mergesOf(mac.merges), taskRows(), Date.now())) {
    const id = `${m.key}:${String(m.patch.mergedAt)}`;
    if (merging.has(id)) continue;
    merging.add(id);
    try {
      await updatePinned(`tasks/${m.key}`, m.version, m.patch, 'That task');
    } catch {
      merging.delete(id);
    }
  }
}

const taskOrThrow = (key: string): Task => {
  const t = tasksNow().find((x) => x.key === key);
  if (!t) throw new ApiError(`No task ${key} on the board.`, 404);
  return t;
};

/** The helper's address for a session: its key, and the agent when it isn't the engineer. */
function whoOf(sessionId: string): { key: string; agent?: string } {
  const m = S.members.find((x) => x.sessionId === sessionId) ?? S.members.find((x) => `keel-${x.key ?? 'lead'}` === sessionId);
  if (!m) throw new ApiError('That session isn’t on this Mac.', 404);
  if (m.role === 'job' && !m.key) throw new ApiError('A scheduled run has no ticket to address it by; open it from its routine in the Claude app.', 400);
  return { key: m.role === 'lead' ? 'lead' : m.key ?? 'lead', ...(m.agent && m.agent !== 'engineer' && m.role !== 'lead' ? { agent: m.agent } : {}) };
}

const sessionLinkOf = (sessionId: string): string => {
  const m = S.members.find((x) => x.sessionId === sessionId);
  if (m?.role === 'lead' || (!m && S.lead && str(S.lead.sessionId) === sessionId)) return str(S.lead?.sessionLink);
  const row = m?.key ? taskRows().get(m.key) : undefined;
  if (m?.agent && m.agent !== 'engineer') return str((row?.agents as Record<string, Record<string, unknown>> | undefined)?.[m.agent]?.sessionLink);
  return str(row?.sessionLink);
};

const errMessage = errorText;

/**
 * Why a Mac-side approval didn't happen, after the card was put back: a declined confirm never ran; an unconfirmed
 * one may have, so the captain can safely approve again (the approval is rewritten) or clear it with Not yet.
 */
function notApproved(e: unknown, what: string): ApiError {
  if (e instanceof HelperError && e.code === 'cancelled') return new ApiError(`You declined it in the Claude app, so nothing was ${what}. The card is open again.`, 409);
  if (e instanceof HelperError && e.ambiguous) return new ApiError(`Your Mac didn’t confirm it, so the card is open again. It may have been ${what} anyway: doing it again is safe.`, 504);
  return new ApiError(`Nothing was ${what}: ${errMessage(e)}`, 502);
}

/**
 * Whether a failed helper call means this view can't reach the helper at all (a phone, a browser), so nothing ran: its
 * ping already failed, the page has no `mcp` capability, or no helper is connected. A call the captain declined, or one
 * this view isn't granted, is an answer on the Mac: nothing is approved and the card opens again.
 */
const outOfReach = (e: unknown): boolean => e instanceof HelperError && (S.helper.status === 'missing' || e.code === 'no_mcp' || e.code === 'server_not_connected');

/**
 * Whether answers go to the Mac's Mate session from the start: phone approvals are on and this view's helper ping failed.
 * When the helper answered, or hasn't been tried yet, the board calls it first.
 */
const viaLead = (): boolean => configOf().phoneApprovals && S.helper.status === 'missing';

/** A card being answered again after the Mac couldn't carry out the last answer: its outcome goes, and the Mate looks again. */
const answerAgain = (item: InboxItem): Record<string, unknown> => (item.grantError ? { grantError: null, grantResult: null, handledAt: null } : {});

/**
 * The captain's answer as the Mac carries it out (`grantPending`): the choice, when, and the ticket, commit and post target
 * this view showed. The Mate's panel reads only this, never the card's other fields, which crew sessions may change.
 */
function snapshotOf(item: InboxItem, choice: string, at: number, post?: PostTarget): Record<string, unknown> {
  const head = item.receipts?.head ?? null;
  return { choice, at, key: item.taskKey, ...(post ? { post: { tool: post.tool, match: post.match ?? null } } : head ? { head } : {}) };
}

/**
 * Hands an answer this view couldn't carry out to the Mate's session on the Mac (`grantPending`: its snapshot), for the
 * card answered at `snapshot.at`. False when the card can't be marked, or phone approvals are off.
 */
async function handToMac(item: InboxItem, snapshot: Record<string, unknown>): Promise<boolean> {
  if (!configOf().phoneApprovals) return false;
  return updateFresh(`inbox/${item.id}`, { grantPending: snapshot }, (d) => d.answeredAt === snapshot.at).then(() => true, () => false);
}

/**
 * Answers a launch card: the card first (pinned to the version shown), then the approval on the Mac, bound to the commit
 * the card ships (`receipts.head`, which the helper checks against the worktree). A failed approval reopens the card.
 * Where the helper can't be reached (a phone), the card takes `grantPending`, the answer's snapshot, instead and the
 * Mate's session on the Mac carries it out within a minute, with the same checks.
 */
async function decideShip(item: InboxItem, decision: InboxDecision, note?: string): Promise<InboxItem> {
  const choice = CHOICE[decision];
  if (!choice || !item.taskKey) throw new ApiError('A launch card takes Open PR, Draft PR, Push only or Not yet.', 400);
  if (item.withdrawn && choice !== 'Not yet') throw new ApiError(`The Mate withdrew this card: ${item.withdrawn}`, 409);
  const head = item.receipts?.head ?? null;
  if (choice !== 'Not yet' && !(head && isFullSha(head))) throw new ApiError(head ? `The card names commit ${head}, not a full commit id, so the approval can’t be pinned to it. Ask for a new launch card.` : 'The card names no commit, so the approval can’t be pinned to one. Ask for a new launch card.', 400);
  const now = Date.now();
  const status = choice === 'Not yet' ? 'rejected' : 'approved';
  const answered: InboxItem = { ...item, status, answer: choice, resolvedAt: now, grantError: null, grantResult: null };
  const toMac = viaLead();
  const snapshot = snapshotOf(item, choice, now);
  await updatePinned(`inbox/${item.id}`, item.version, { status, answer: choice, ...(note ? { note } : {}), answeredAt: now, resolvedAt: now, ...answerAgain(item), ...(toMac ? { grantPending: snapshot } : {}) }, 'That card');
  if (toMac) return { ...answered, grantPending: true };
  try {
    await helper('approve', { key: item.taskKey, choice, ...(head && choice !== 'Not yet' ? { head } : {}) });
  } catch (e) {
    if (outOfReach(e) && (await handToMac(item, snapshot))) return { ...answered, grantPending: true };
    if (choice === 'Not yet') {
      // Nothing to clear when the helper isn't here; the card says Not yet either way.
      if (!(e instanceof HelperError) || helperAvailable()) throw new ApiError(`Marked Not yet, but the Mac couldn’t clear an earlier approval: ${errMessage(e)}`, 502);
    } else {
      await updateFresh(`inbox/${item.id}`, { status: 'open', answer: null, note: null, answeredAt: null, resolvedAt: null }).catch(() => undefined);
      throw notApproved(e, 'approved');
    }
  }
  return answered;
}

/** The helper's `approve_post` answer as the card's `postGrant`. */
function grantOf(r: { post?: Record<string, unknown> } | null, now: number): PostGrant {
  const p = r?.post ?? {};
  return { id: typeof p.id === 'string' ? p.id : null, at: now, expires: typeof p.expires === 'number' ? p.expires : null };
}

/** Makes the one-shot post grant on the Mac for a draft's destination. */
async function approvePost(key: string | null, post: PostTarget): Promise<PostGrant> {
  const r = await helper<{ post?: Record<string, unknown> }>('approve_post', { key: key ?? 'CREW', tool: post.tool, ...(post.match ? { match: post.match } : {}) });
  return grantOf(r, Date.now());
}

/**
 * "Approve and post": the card takes the answer first (pinned), then the helper makes a grant for exactly one matching
 * post, then the card records the grant (`postGrant`) for the Mate. A failed grant reopens the card. Where the helper
 * can't be reached (a phone), the card says `grantPending` instead and the Mate's session on the Mac makes the grant.
 */
async function decidePost(item: InboxItem, option: string): Promise<InboxItem> {
  if (!item.post) throw new ApiError('This draft doesn’t say where it would post, so the crew can’t post it. Copy it and post it yourself.', 400);
  if (item.withdrawn) throw new ApiError(`The Mate withdrew this card: ${item.withdrawn}`, 409);
  const now = Date.now();
  const path = `inbox/${item.id}`;
  const answered: InboxItem = { ...item, status: 'answered', answer: option, resolvedAt: now, grantError: null, grantResult: null };
  const toMac = viaLead();
  const snapshot = snapshotOf(item, option, now, item.post);
  await updatePinned(path, item.version, { status: 'answered', answer: option, answeredAt: now, resolvedAt: now, ...answerAgain(item), ...(toMac ? { grantPending: snapshot } : {}) }, 'That card');
  if (toMac) return { ...answered, grantPending: true };
  let grant: PostGrant;
  try {
    grant = await approvePost(item.taskKey, item.post);
  } catch (e) {
    if (outOfReach(e) && (await handToMac(item, snapshot))) return { ...answered, grantPending: true };
    await updateFresh(path, { status: 'open', answer: null, answeredAt: null, resolvedAt: null }).catch(() => undefined);
    throw notApproved(e, 'approved to post');
  }
  await updateFresh(path, { postGrant: grant }).catch(() => toast('Approved on your Mac, but the card couldn’t record it. Tell the Mate it’s approved to post once.', 'warn'));
  return { ...answered, postGrant: grant };
}

/**
 * One item of a batch question or digest: the stored items are re-read and only that item changes (someone may have
 * answered another meanwhile). A batch card closes when its last item is answered. With `post`, the item's grant is
 * made next, and a failed grant takes the answer back.
 */
async function answerCardItem(card: InboxItem, itemId: string, answer: string, post: boolean): Promise<void> {
  const path = `inbox/${card.id}`;
  const now = Date.now();
  const it = card.items.find((x) => x.id === itemId);
  if (!it) throw new ApiError('That item isn’t on the card any more.', 404);
  if (post && !it.post) throw new ApiError('This item doesn’t say where it would post.', 400);
  await updateWith(
    path,
    (d) => {
      const r = answerItem(d.items, itemId, answer, now, { batch: d.batch === true });
      if (!r) return null;
      return { items: r.items, answeredAt: now, ...(r.allAnswered && d.batch === true ? { status: 'answered', resolvedAt: now } : {}) };
    },
    'That question',
  );
  if (!post || !it.post) return;
  let grant: PostGrant;
  try {
    grant = await approvePost(it.taskKey ?? card.taskKey, it.post);
  } catch (e) {
    await updateWith(path, (d) => {
      const items = unanswerItem(d.items, itemId);
      return items ? { items, ...(d.batch === true ? { status: 'open', resolvedAt: null } : {}), ...(items.some((x) => !!x?.answer) ? {} : { answeredAt: null }) } : null;
    }).catch(() => undefined);
    throw notApproved(e, 'approved to post');
  }
  await updateWith(path, (d) => {
    if (!Array.isArray(d.items)) return null;
    return { items: d.items.map((x, i) => (x && typeof x === 'object' && ((x as Record<string, unknown>).id ?? `item-${i + 1}`) === itemId ? { ...(x as object), postGrant: grant } : x)) };
  }).catch(() => toast('Approved on your Mac, but the card couldn’t record it. Tell the Mate it’s approved to post once.', 'warn'));
}

/** A crew session's recent activity from the helper, as board events. */
async function sessionEvents(id: string, before?: number, limit = 300): Promise<CrewEvent[]> {
  const who = whoOf(id);
  const r = await helper<{ events: { id: number; ts: number; key: string; kind: string; tool?: string; summary: string; isError?: boolean }[] }>('session_events', { ...who, ...(before ? { before } : {}), limit });
  return r.events.map((e): CrewEvent => ({ id: e.ts * 1000 + (e.id % 1000), sessionId: id, taskKey: who.key === 'lead' ? null : who.key, ts: e.ts, kind: e.kind === 'user' || e.kind === 'tool' || e.kind === 'turn_end' ? e.kind : 'crew', tool: e.tool ?? null, summary: e.summary, isError: !!e.isError }));
}

export function boardBackend(): Backend {
  return {
    async chat(text) {
      await addDoc('chat', { who: 'me', text, ts: Date.now() });
      return { ok: true };
    },
    async decideInbox(item, decision, answer, opts) {
      if (item.kind === 'ship') return decideShip(item, decision, answer);
      if (decision === 'post') return decidePost(item, answer ?? '');
      const now = Date.now();
      const status = decision === 'dismiss' ? 'dismissed' : decision === 'reject' ? 'rejected' : decision === 'approve' ? 'approved' : 'answered';
      const text = decision === 'answer' ? (answer ?? '').trim() : decision === 'dismiss' ? 'dismissed' : answer ?? decision;
      await updatePinned(`inbox/${item.id}`, item.version, { status, answer: text, ...(opts?.note ? { note: opts.note } : {}), answeredAt: now, resolvedAt: now }, 'That card');
      if (opts?.neverAsk && item.neverAskKey) await addDoc('decisions', { topic: `never-ask:${item.neverAskKey}`, decision: text, ...(item.taskKey ? { taskKey: item.taskKey } : {}), createdAt: now });
      return { ...item, status, answer: text, resolvedAt: now };
    },
    async answerCardItem(card, itemId, answer, opts) {
      await answerCardItem(card, itemId, answer, opts?.post === true);
      return { ok: true };
    },
    async unpause(target) {
      await request('unpause', target.key, { ...(target.agent ? { agent: target.agent } : {}), ...(target.sessionId ? { sessionId: target.sessionId } : {}) });
      return { ok: true };
    },
    async risk(key): Promise<Risk> {
      const r = await helper<Record<string, unknown>>('risk', { key });
      return riskOf(r) ?? { tier: 'unknown', reasons: [], files: null, added: null, deleted: null };
    },
    async newTask(input) {
      const text = input.text.trim();
      if (!text) throw new ApiError('Say what needs doing.', 400);
      await request('task', null, { text, ...(input.agent ? { agent: input.agent } : {}) });
      return { ok: true };
    },
    async taskDetail(key) {
      const task = taskOrThrow(key);
      const ev = await applySpec(reader().collection(`tasks/${key}/evidence`), evidenceSpec(key)).get().catch(() => ({ docs: [] }));
      const evidence: Evidence[] = ev.docs.map((d) => toEvidence({ ...(d.data() ?? {}), _id: d.id, _v: '' }, key)).sort((a, b) => a.createdAt - b.createdAt);
      const events = helperAvailable() && task.sessionId ? await sessionEvents(task.sessionId, undefined, 300).catch(() => []) : [];
      const branchUrl = helperAvailable() ? await helper<{ branchUrl: string | null }>('branch_url', { key }).then((r) => r.branchUrl, () => null) : null;
      return { task, sessions: sessionsOf([task]).filter((s) => s.taskKey === key), evidence, inbox: [...inboxRows().values()].map(toInbox).filter((i) => i.taskKey === key), events, branchUrl };
    },
    async evidenceItem(key, id) {
      const d = await reader().doc(`tasks/${key}/evidence/${id}`).get();
      return d.exists ? toEvidence({ ...(d.data() ?? {}), _id: d.id, _v: '' }, key) : null;
    },
    async startTask(key) {
      await request('start', key);
      return taskOrThrow(key);
    },
    async stopTask(key) {
      await request('stop', key);
      return taskOrThrow(key);
    },
    async messageTask(key, text) {
      await request('message', key, { text });
      return { ok: true };
    },
    async resumeTask(key, opts) {
      await request('resume', key, { text: opts.text ?? '', effort: opts.effort ?? null });
      return taskOrThrow(key);
    },
    async cancelTask(key) {
      await request('cancel', key);
      const now = Date.now();
      await updateFresh(`tasks/${key}`, { status: 'cancelled', closedAt: now, updatedAt: now }, (d) => d.status !== 'done', key);
      const row = taskRows().get(key);
      return toTask({ ...(row ?? { _id: key, _v: '' }), status: 'cancelled', closedAt: now } as Row, { overlaps: S.overlaps, now });
    },
    async taskDiff(key): Promise<DiffResult> {
      return helper<DiffResult>('diff', { key });
    },
    async reviewTask(key, comments, summary) {
      await request('review', key, { comments, summary: summary ?? '' });
      return { ok: true };
    },
    async agentAction(id, action, key) {
      await request('agent', key ?? null, { id, action });
      return { ok: true };
    },
    sessionEvents,
    async search(q): Promise<SearchHit[]> {
      const n = q.trim().toLowerCase();
      if (!n) return [];
      const hits: SearchHit[] = [];
      for (const t of tasksNow()) if (`${t.key} ${t.title} ${t.spec} ${t.lastSummary}`.toLowerCase().includes(n)) hits.push({ kind: 'task', ref: t.key, taskKey: t.key, snippet: t.title, ts: t.updatedAt });
      for (const c of S.chat.values()) if (str(c.text).toLowerCase().includes(n)) hits.push({ kind: 'chat', ref: c._id, taskKey: str(c.taskKey) || null, snippet: str(c.text).slice(0, 160), ts: num(c.ts) ?? 0 });
      for (const d of S.decisions.values()) if (`${str(d.topic)} ${str(d.decision)}`.toLowerCase().includes(n)) hits.push({ kind: 'decision', ref: d._id, taskKey: str(d.taskKey) || null, snippet: `${str(d.topic)}: ${str(d.decision)}`, ts: num(d.createdAt) ?? 0 });
      return hits.sort((a, b) => b.ts - a.ts).slice(0, 50);
    },
    async metrics() {
      return metrics();
    },
    async decisions(): Promise<Decision[]> {
      return [...S.decisions.values()].map(toDecision).sort((a, b) => b.createdAt - a.createdAt);
    },
    async deleteDecision(id) {
      await writer().doc(`decisions/${id}`).delete();
      return { ok: true };
    },
    async getConfig() {
      if (helperAvailable() || !S.local) S.local = await helper<{ config: Record<string, unknown> }>('config_get').then((r) => r.config, () => S.local);
      return configOf();
    },
    async saveSettings(base: CrewConfig, baseVersion: string | null, next: CrewConfig) {
      const shared = (c: CrewConfig): Record<string, unknown> => {
        const o: Record<string, unknown> = { ...c };
        for (const k of LOCAL_KEYS) delete o[k];
        delete o.agents;
        return o;
      };
      const agents = diffPatch(base.agents ?? {}, next.agents ?? {});
      const patch = agents ? { ...diffPatch(shared(base), shared(next)), agents } : diffPatch(shared(base), shared(next));
      if (patch) {
        const now = Date.now();
        await createOrUpdate('settings/main', baseVersion, { ...patch, updatedAt: now }, { ...sharedSettings(), ...shared(next), ...(agents ? { agents } : {}), updatedAt: now }, 'Settings');
      }
      const local: Record<string, unknown> = {};
      if (next.editor !== base.editor || next.terminal !== base.terminal) local.ide = { editor: next.editor, terminal: next.terminal };
      if (next.owner.name !== base.owner.name) local.owner = next.owner.name;
      if (next.compactWindow !== base.compactWindow) local.compactWindow = next.compactWindow ?? 'auto';
      if (next.shipMode !== base.shipMode) local.shipMode = next.shipMode;
      if (stableStringify(next.repos) !== stableStringify(base.repos)) {
        const cur = (S.local?.repos ?? {}) as Record<string, Record<string, unknown>>;
        local.repos = Object.fromEntries(Object.entries(next.repos).map(([name, r]) => [name, { ...(cur[name] ?? { path: r.path }), baseBranch: r.baseBranch, enabled: r.enabled }]));
      }
      // The shared part is saved already: the Mate applies it even when this Mac's part failed, whose error is the one shown.
      const mac = Object.keys(local).length ? helper<{ config: Record<string, unknown> }>('config_set', { patch: local }).then((r) => r.config) : null;
      const saved = await mac?.then((c) => ({ c }), (e: unknown) => ({ e }));
      if (saved && 'c' in saved) S.local = saved.c;
      publish();
      if (patch || Object.keys(local).length) await request('settings', null).catch((e) => { if (!saved || 'c' in saved) throw e; });
      if (saved && 'e' in saved) throw saved.e;
      return next;
    },
    async setPaused(paused) {
      await updateFresh('crew/lead', { paused }, undefined, 'The Mate’s status');
      await request(paused ? 'pause' : 'unpause', null);
      return { paused };
    },
    async scan() {
      await request('scan', null);
      return { ok: true };
    },
    async pauseSchedules(paused) {
      await request('schedules', null, { paused });
      return { ok: true };
    },
    async runSchedule(id) {
      await request('run', null, { id });
      return { ok: true };
    },
    async policy() {
      const roles = [{ role: 'Mate', summary: 'A Code session in the folder that holds your repos. Takes in work, writes specs, staffs agents, answers them and keeps you informed.' }, ...AGENTS.map((a) => ({ role: a.name, summary: a.summary }))];
      return policyText(rules as Rules, roles);
    },
    async skip(key, skip, reason) {
      // The scan reads settings/main.intake.skipKeys, which only the captain writes: the board keeps it, the request tells the Mate.
      const keys = new Set(configOf().intake.skipKeys ?? []);
      if (skip) keys.add(key);
      else keys.delete(key);
      const own = S.settings?.intake;
      const intake = { ...(own && typeof own === 'object' && !Array.isArray(own) ? own : {}), skipKeys: [...keys].sort() };
      const now = Date.now();
      if (S.settings) await updateFresh('settings/main', { intake, updatedAt: now }, undefined, 'Settings');
      else await createOrUpdate('settings/main', 'missing', {}, { ...sharedSettings(), intake, updatedAt: now }, 'Settings');
      await request(skip ? 'skip' : 'unskip', key, { reason: reason ?? '' });
      return { ok: true, message: skip ? `${key} is on the skip list.` : `${key} is off the skip list.` };
    },
    async openIn(key, app: OpenTarget) {
      const dir = S.members.find((m) => m.key === key && m.agent === 'engineer')?.dir;
      const link = EDITOR_LINKS[configOf().editor];
      if (app === 'editor' && dir && link) {
        openLink(link(dir));
        return { ok: true };
      }
      return helper<{ ok: boolean }>('open_in', { key, app });
    },
    async setDnd(until) {
      await updateFresh('crew/lead', { dndUntil: until }, undefined, 'The Mate’s status');
      return { dndUntil: until };
    },
    async doctor() {
      return (await helper<{ checks: DoctorCheck[] }>('doctor')).checks;
    },
    async openSession(id) {
      const link = sessionLinkOf(id);
      if (configOf().terminal === 'desktop' && link) {
        openLink(link);
        return { command: '' };
      }
      return helper<{ command: string }>('open_session', { ...whoOf(id), app: configOf().terminal });
    },
    async openLeadSession() {
      return helper<{ command: string }>('open_session', { key: 'lead', app: 'desktop' });
    },
    async resurfaceStart(cardId: string, key: string | null) {
      await request('surface', key, { card: cardId });
    },
    async transcript(id, offset = null, limit = 300): Promise<Transcript> {
      return helper<Transcript>('transcript', { ...whoOf(id), offset, limit });
    },
    async prompts(): Promise<PromptFile[]> {
      return (await helper<{ prompts: PromptFile[] }>('prompts')).prompts;
    },
    async logs(): Promise<LogFile[]> {
      return (await helper<{ logs: LogFile[] }>('logs')).logs;
    },
    async logTail(file, lines): Promise<LogTail> {
      return helper<LogTail>('log_tail', { file, lines });
    },
    async openLogs(file) {
      return helper<{ ok: boolean }>('open_logs', { file });
    },
    async openFile(path, reveal) {
      return helper<{ ok: boolean; shown: 'opened' | 'revealed' }>('open_file', { path, reveal });
    },
    async savePrompt(file, text) {
      return (await helper<{ prompts: PromptFile[] }>('prompt_save', { file, text })).prompts;
    },
    async compactSession(id) {
      const m = S.members.find((x) => x.sessionId === id);
      const key = m?.role === 'lead' ? null : m?.key ?? null;
      // With a key, that session's own panel compacts it and this board closes the request; without one, the Mate asks you.
      await request('compact', key, { ...(m?.agent && m.agent !== 'engineer' ? { agent: m.agent } : {}), ...(key ? { ready: true } : {}) });
      const s = sessionsOf(tasksNow()).find((x) => x.id === id);
      if (!s) throw new ApiError('That session isn’t on this Mac.', 404);
      return s;
    },
    async memory(): Promise<MemoryList> {
      const r = await helper<{ lessons?: unknown; playbook?: unknown }>('memory_list', {});
      return memoryOf(r);
    },
    async memoryAction(action, key, text) {
      await request('memory', key, { action, ...(text !== undefined ? { text } : {}) });
      return { ok: true };
    },
    async agentNotes() {
      if (!helperAvailable()) return {};
      const r = await helper<{ agents?: { id?: string; teamSkills?: string[]; teamNotes?: string | null }[] }>('agents_list').catch(() => ({ agents: [] }));
      return Object.fromEntries((r.agents ?? []).filter((a) => a.id).map((a) => [a.id!, { teamSkills: a.teamSkills ?? [], teamNotes: a.teamNotes ?? null }]));
    },
    async roleManifests() {
      if (!helperAvailable()) return [];
      const r = await helper<{ agents?: Record<string, unknown>[] }>('agents_list').catch(() => ({ agents: [] }));
      return manifestsFrom(Object.fromEntries((r.agents ?? []).map((a, i) => [`${str(a.id) || `agent-${i}`}.json`, a])));
    },
    async org() {
      S.org = orgInfoOf(await helper<unknown>('org')) ?? S.org;
      publish();
      return S.org;
    },
  };
}
