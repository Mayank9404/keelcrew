/**
 * Starts the board: owner check, the database subscriptions (each a
 * bounded window), and the helper polls (owner only; the activity and changed-files polls pause while the tab
 * is hidden).
 */
import { setBackend } from '../lib/api';
import { helperStatus } from '../lib/compat';
import { SUBSCRIPTIONS, applySpec, isFull, type SubscriptionName } from '../lib/paging';
import { startPoll } from '../lib/poll';
import { keepSubscribed } from '../lib/subscribe';
import { crewStore } from '../lib/store';
import type { MacCrewState } from '../types';
import { applyMerges, boardBackend, closeFinishedRequests } from './backend';
import { costsOf, healthOf, memberOf, orgInfoOf, spendOf } from './convert';
import { initDb } from './db';
import { type Db, HelperError, helper } from './runtime';
import { S, buildState, docRow, emitActivity, publish, rowsOf } from './state';

const hidden = (): boolean => document.hidden;

/** The window each subscription fills. */
const TARGET: Record<SubscriptionName, (rows: ReturnType<typeof rowsOf>, full: boolean) => void> = {
  tasksOpen: (r) => void (S.tasksOpen = r),
  tasksClosed: (r, full) => {
    S.tasksClosed = r;
    S.tasksClosedFull = full;
  },
  inboxOpen: (r) => void (S.inboxOpen = r),
  inboxRecent: (r) => void (S.inboxRecent = r),
  chat: (r) => void (S.chat = r),
  decisions: (r) => void (S.decisions = r),
  requestsOpen: (r) => void (S.requests = r),
};

/** The view lost its grant: terminal for this page load, so the board stays as last seen, read-only. */
function revoked(): void {
  S.hasDb = false;
  crewStore.set((s) => ({ ...s, conn: 'down' }));
  publish();
}

function subscribe(db: Db): void {
  const keep = (name: string, open: Parameters<typeof keepSubscribed>[1]) => keepSubscribed(name, open, { onRevoked: revoked });
  for (const [name, spec] of Object.entries(SUBSCRIPTIONS) as [SubscriptionName, (typeof SUBSCRIPTIONS)[SubscriptionName]][]) {
    keep(name, (onError) =>
      applySpec(db.collection(spec.collection), spec).onSnapshot((snap) => {
        TARGET[name](rowsOf(snap), isFull(spec, snap.docs.length));
        publish();
      }, onError),
    );
  }
  const doc = (path: string, set: (r: ReturnType<typeof docRow>) => void) =>
    keep(path, (onError) =>
      db.doc(path).onSnapshot((s) => {
        set(docRow(s, s.id));
        publish();
      }, onError),
    );
  doc('crew/lead', (r) => void (S.lead = r));
  doc('crew/usage', (r) => void (S.usage = r));
  doc('crew/schedules', (r) => void (S.schedules = r));
  doc('settings/main', (r) => {
    S.settings = r;
    S.settingsSeen = true;
  });
}

/**
 * Runs one helper read for a feed: on success records the time and clears the error; on failure keeps the last good
 * data and records why (a missing tool marks the feed as missing, so its section can say so).
 */
async function feed<T>(name: keyof typeof S.feeds, read: () => Promise<T>, apply: (r: T) => void): Promise<void> {
  try {
    apply(await read());
    S.feeds[name] = { at: Date.now(), error: null, missing: false };
  } catch (e) {
    const missing = e instanceof HelperError && e.code === 'missing_tool';
    S.feeds[name] = { ...S.feeds[name], error: e instanceof Error ? e.message : String(e), missing };
  }
  publish();
}

/** The company as the helper resolves it (departments, roles, goals), for Settings → Crew. */
function loadOrg(): Promise<void> {
  return feed('org', () => helper<unknown>('org'), (r) => void (S.org = orgInfoOf(r) ?? S.org));
}

/**
 * The helper's polls: crew activity (which also closes the requests the Mac finished without the Mate, and moves rows
 * whose PR merged), changed files, costs and the org. Each skips its turn while the tab is hidden.
 */
function startHelper(): void {
  const crew = () =>
    feed('crew', () => helper<MacCrewState>('crew_state'), (r) => {
      S.members = (r.members ?? []).map(memberOf).filter((m): m is NonNullable<typeof m> => !!m);
      S.macUsage = r.usage && typeof r.usage === 'object' ? (r.usage as Record<string, unknown>) : null;
      S.macScan = r.scan && typeof r.scan === 'object' ? (r.scan as Record<string, unknown>) : null;
      S.spend = spendOf(r.spend);
      S.health = healthOf(r.health);
      S.panelAt = typeof r.panel?.at === 'number' ? r.panel.at : null;
      for (const m of S.members) emitActivity(m);
      void closeFinishedRequests(r);
      void applyMerges(r);
    });
  const files = () => helper<{ files: Record<string, string[]> }>('changed_files').then((r) => ((S.overlaps = r.files ?? {}), publish()), () => undefined);
  const costs = () => feed('costs', () => helper<unknown>('costs'), (r) => void (S.costs = costsOf(r) ?? S.costs));
  const polls = [
    startPoll({ run: crew, everyMs: 15_000, hidden }),
    startPoll({ run: files, everyMs: 60_000, hidden }),
    startPoll({ run: costs, everyMs: 60_000, hidden }),
    startPoll({ run: loadOrg, everyMs: 5 * 60_000, hidden }),
  ];
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) for (const p of polls) p.wake();
  });
  void helper<{ config: Record<string, unknown> }>('config_get').then((r) => ((S.local = r.config), publish()), () => undefined);
}

export async function startBoard(): Promise<void> {
  setBackend(boardBackend());
  crewStore.set((s) => ({ ...s, crew: buildState(), conn: 'connecting' }));
  const { db, isOwner } = await initDb();
  S.hasDb = !!db;
  S.isOwner = isOwner;
  if (!db) {
    crewStore.set((s) => ({ ...s, crew: buildState(), conn: 'down' }));
    return;
  }
  publish();
  subscribe(db);
  // Only the artifact's owner can use the Mac's helper; other viewers see what the crew wrote to the board.
  if (!isOwner) return;
  let connected = false;
  const connect = async (): Promise<boolean> => {
    if (connected) return true;
    let reason: string | null = null;
    const ping = await helper<unknown>('ping').catch((e: unknown) => {
      reason = e instanceof HelperError ? e.code : 'unknown';
      return null;
    });
    if (connected) return true;
    S.helper = helperStatus(ping, undefined, reason);
    publish();
    if (ping) {
      connected = true;
      startHelper();
    }
    return !!ping;
  };
  if (await connect()) return;
  // Not reachable now (the app was still starting the helper): try again shortly, and when the captain comes back to the tab.
  for (const ms of [5_000, 15_000, 60_000]) setTimeout(() => void connect(), ms);
  const retry = () => {
    if (connected) return document.removeEventListener('visibilitychange', retry);
    if (document.hidden) return;
    document.removeEventListener('visibilitychange', retry);
    void connect().then((ok) => {
      if (!ok) document.addEventListener('visibilitychange', retry);
    });
  };
  document.addEventListener('visibilitychange', retry);
}
