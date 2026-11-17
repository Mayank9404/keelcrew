/**
 * Answering cards: batch questions one item at a time, and drafts that post somewhere once approved. Pure, so the
 * backend's read-modify-write and the card's buttons agree on the same rules.
 */
import type { CardItem, InboxItem } from '../types';

/**
 * An option that lets the crew post the draft ("Post it", "Approve it", "Accept and post the Jira note"). "I'll post
 * it" means the captain posts it, so it isn't one.
 */
export function isPostingOption(option: string): boolean {
  const o = option.trim();
  if (/^i\s*[’']?ll\b/i.test(o) || /^i will\b/i.test(o)) return false;
  return /\bpost\b/i.test(o) || /^approve it$/i.test(o);
}

/** Items the captain answers: every item of a batch question; digest items only when they offer options or a post. */
export function isAnswerable(card: Pick<InboxItem, 'batch'>, item: CardItem): boolean {
  return card.batch || item.options.length > 0 || !!item.post;
}

export interface BatchProgress {
  answered: number;
  total: number;
  /** The first answerable item still open. */
  next: CardItem | null;
  done: boolean;
}

export function batchProgress(card: Pick<InboxItem, 'batch' | 'items'>): BatchProgress {
  const list = card.items.filter((i) => isAnswerable(card, i));
  const answered = list.filter((i) => !!i.answer).length;
  const next = list.find((i) => !i.answer) ?? null;
  return { answered, total: list.length, next, done: list.length > 0 && answered === list.length };
}

type RawItem = Record<string, unknown>;

/**
 * The card's stored `items` with one item answered, as written back to the board. Works on the stored objects so
 * fields the board doesn't know survive. Returns null when the item is missing or already answered (someone else
 * answered it meanwhile). `allAnswered` says whether every answerable item now has an answer.
 */
export function answerItem(raw: unknown, itemId: string, answer: string, now: number, opts: { batch: boolean; extra?: RawItem } = { batch: true }): { items: RawItem[]; allAnswered: boolean } | null {
  if (!Array.isArray(raw)) return null;
  const items = raw.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? { ...(x as RawItem) } : x)) as RawItem[];
  const idOf = (x: RawItem, i: number) => (typeof x.id === 'string' && x.id ? x.id : `item-${i + 1}`);
  const idx = items.findIndex((x, i) => x && typeof x === 'object' && idOf(x, i) === itemId);
  if (idx < 0) return null;
  const cur = items[idx];
  if (typeof cur.answer === 'string' && cur.answer.trim()) return null;
  items[idx] = { ...cur, answer, answeredAt: now, ...(opts.extra ?? {}) };
  const answerable = (x: RawItem) => opts.batch || (Array.isArray(x.options) && x.options.length > 0) || !!x.post;
  const allAnswered = items.filter((x) => x && typeof x === 'object' && answerable(x)).every((x) => typeof x.answer === 'string' && !!x.answer.trim());
  return { items, allAnswered };
}

/** The same item with its answer taken back (a post approval failed on the Mac). */
export function unanswerItem(raw: unknown, itemId: string): RawItem[] | null {
  if (!Array.isArray(raw)) return null;
  let found = false;
  const items = raw.map((x, i) => {
    if (!x || typeof x !== 'object') return x as RawItem;
    const o = x as RawItem;
    const id = typeof o.id === 'string' && o.id ? o.id : `item-${i + 1}`;
    if (id !== itemId) return o;
    found = true;
    return { ...o, answer: null, answeredAt: null };
  });
  return found ? items : null;
}
