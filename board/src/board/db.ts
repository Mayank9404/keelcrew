/**
 * The board's writes. The page's db API has no `if_version`, so a pinned write reads the
 * document right before it and writes only if it still matches what the captain saw (lib/versions.ts). Only the captain
 * writes; everyone else gets a read-only board.
 */
import { ApiError } from '../lib/api';
import { sleep } from '../lib/poll';
import { versionOf } from '../lib/versions';
import { type Db, dbP, isOwnerP } from './runtime';

let db: Db | null = null;
let owner = false;

const codeOf = (e: unknown): string | null => (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : null);

/**
 * Runs a store call, once more after a short random pause when the store says `unavailable` (the capability's advice
 * for verbs). Only for calls that are safe to repeat: reads, `update` with the same patch, `set` on a ref already built.
 */
export async function retryOnce<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (codeOf(e) !== 'unavailable') throw e;
    await sleep(300 + Math.round(Math.random() * 700));
    return call();
  }
}

/** The database and owner check, once the runtime has answered. */
export async function initDb(): Promise<{ db: Db | null; isOwner: boolean }> {
  db = await dbP;
  owner = db ? await isOwnerP : false;
  return { db, isOwner: owner };
}

export const conflict = (what: string): ApiError => new ApiError(`${what} changed on the board meanwhile, so nothing was written. Look again and retry.`, 409);

/** The database for a write by the captain; throws a readable error for anyone else. */
export function writer(): Db {
  if (!db) throw new ApiError('Open the Keelcrew board in Claude to make changes.', 503);
  if (!owner) throw new ApiError('Only the captain of this Keelcrew board can make changes.', 403);
  return db;
}

/** The database for reads. */
export function reader(): Db {
  if (!db) throw new ApiError('Open the Keelcrew board in Claude to see it.', 503);
  return db;
}

/**
 * `update` pinned to the version the captain saw. Rejects with 409 when the document changed or is gone; `what` names it
 * in the message ("That card", "Settings").
 */
export async function updatePinned(path: string, seen: string, patch: Record<string, unknown>, what = 'It'): Promise<void> {
  const ref = writer().doc(path);
  const cur = await retryOnce(() => ref.get());
  if (!cur.exists || versionOf(cur) !== seen) throw conflict(what);
  await retryOnce(() => ref.update(patch));
}

/**
 * `update` pinned to a fresh read, for fields the captain sets whatever else the document holds (pause, do not
 * disturb, a cancelled task): `check` may refuse the current state.
 */
export async function updateFresh(path: string, patch: Record<string, unknown>, check?: (data: Record<string, unknown>) => boolean, what = 'It'): Promise<void> {
  const ref = writer().doc(path);
  const cur = await retryOnce(() => ref.get());
  if (!cur.exists) throw new ApiError(`${what} isn’t on the board yet.`, 404);
  if (check && !check(cur.data() ?? {})) throw conflict(what);
  await retryOnce(() => ref.update(patch));
}

/**
 * `update` computed from a fresh read: `patchFor` sees the document as it is now and returns the patch, or null when
 * the change no longer applies (someone else got there first), which rejects with 409. For array fields (a batch
 * card's items) that a page update can only replace whole.
 */
export async function updateWith(path: string, patchFor: (data: Record<string, unknown>) => Record<string, unknown> | null, what = 'It'): Promise<void> {
  const ref = writer().doc(path);
  const cur = await retryOnce(() => ref.get());
  if (!cur.exists) throw new ApiError(`${what} isn’t on the board any more.`, 404);
  const patch = patchFor(cur.data() ?? {});
  if (!patch) throw conflict(what);
  await retryOnce(() => ref.update(patch));
}

/** Creates a document that doesn't exist yet, or updates it pinned to `seen` (null: the captain saw no document). */
export async function createOrUpdate(path: string, seen: string | null, patch: Record<string, unknown>, initial: Record<string, unknown>, what = 'It'): Promise<void> {
  const ref = writer().doc(path);
  const cur = await retryOnce(() => ref.get());
  if (!cur.exists) {
    if (seen !== null && seen !== 'missing') throw conflict(what);
    await retryOnce(() => ref.set(initial));
    return;
  }
  if (seen === null || versionOf(cur) !== seen) throw conflict(what);
  await retryOnce(() => ref.update(patch));
}

/**
 * A new document in a collection (requests, chat lines, decisions). The id is minted first, so the one retry writes the
 * same document rather than a second one.
 */
export async function addDoc(collection: string, data: Record<string, unknown>): Promise<string> {
  const ref = writer().collection(collection).doc();
  await retryOnce(() => ref.set(data));
  return ref.id;
}
