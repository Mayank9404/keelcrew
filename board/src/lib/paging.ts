/**
 * Every list the board reads is bounded: a `limit` (at most 1000, the store's page size) plus an `orderBy` or a `where`.
 * The page's db API has no cursor, so each list is a window; these specs say which window.
 */

export type Filter = [field: string, op: '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not-in' | 'array-contains', value: unknown];

export interface QuerySpec {
  collection: string;
  where?: Filter[];
  orderBy?: [field: string, dir: 'asc' | 'desc'];
  limit: number;
}

/** The store's largest page. */
export const MAX_LIMIT = 1000;

export const CLOSED_STATUSES = ['done', 'cancelled'] as const;

/** The board's live subscriptions, each one window of its collection. */
export const SUBSCRIPTIONS = {
  /** Every task that isn't finished. */
  tasksOpen: { collection: 'tasks', where: [['status', 'not-in', [...CLOSED_STATUSES]]], limit: 500 },
  /** The newest finished tasks; older ones stay in the database (the archive). */
  tasksClosed: { collection: 'tasks', where: [['status', 'in', [...CLOSED_STATUSES]]], orderBy: ['closedAt', 'desc'], limit: 100 },
  /** Every card still waiting for an answer. */
  inboxOpen: { collection: 'inbox', where: [['status', '==', 'open']], limit: 300 },
  /** Recent cards, answered or not, for task history. */
  inboxRecent: { collection: 'inbox', orderBy: ['createdAt', 'desc'], limit: 150 },
  chat: { collection: 'chat', orderBy: ['ts', 'desc'], limit: 200 },
  decisions: { collection: 'decisions', orderBy: ['createdAt', 'desc'], limit: 500 },
  /** Requests the Mate hasn't handled, so the board can show them as pending. */
  requestsOpen: { collection: 'requests', where: [['status', '==', 'open']], limit: 200 },
} satisfies Record<string, QuerySpec>;

export type SubscriptionName = keyof typeof SUBSCRIPTIONS;

/** A task's evidence, newest first. */
export const evidenceSpec = (key: string): QuerySpec => ({ collection: `tasks/${key}/evidence`, orderBy: ['createdAt', 'desc'], limit: 200 });

/** A spec reads a bounded window: a limit within the store's page size, and an order or a filter. */
export function isBounded(spec: QuerySpec): boolean {
  return Number.isInteger(spec.limit) && spec.limit >= 1 && spec.limit <= MAX_LIMIT && (!!spec.orderBy || !!spec.where?.length);
}

/** The minimal query surface specs are applied to (the runtime's Query and test fakes). */
export interface QueryLike<Q> {
  where(field: string, op: string, value: unknown): Q;
  orderBy(field: string, dir?: 'asc' | 'desc'): Q;
  limit(n: number): Q;
}

/** Builds the spec's query on a collection. Throws on an unbounded spec, so no unbounded read can ship. */
export function applySpec<Q extends QueryLike<Q>>(col: QueryLike<Q>, spec: QuerySpec): Q {
  if (!isBounded(spec)) throw new Error(`Unbounded read of ${spec.collection}`);
  let q: QueryLike<Q> = col;
  for (const [f, op, v] of spec.where ?? []) q = q.where(f, op, v);
  if (spec.orderBy) q = q.orderBy(spec.orderBy[0], spec.orderBy[1]);
  return q.limit(spec.limit);
}

/** True when a window came back full, so there may be more beyond it. */
export const isFull = (spec: QuerySpec, size: number): boolean => size >= spec.limit;

/** Merges windows of one collection by document id; later windows win (they're the fresher view of a document). */
export function mergeById<T>(...windows: Map<string, T>[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const w of windows) for (const [k, v] of w) out.set(k, v);
  return out;
}
