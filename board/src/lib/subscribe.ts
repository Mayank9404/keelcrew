/** Keeping the board's database subscriptions alive through the store's terminal listener errors. */

/** The pause before opening a failed subscription again: 1 s doubling to a minute (from 15 s for a busy store). */
export const resubscribeDelay = (failures: number, code: string): number =>
  Math.min(60_000, (code === 'resource_exhausted' ? 15_000 : 1_000) * 2 ** Math.min(Math.max(failures - 1, 0), 6));

export interface KeepOptions {
  /** The view lost its grant (`revoked`): terminal for the page load. */
  onRevoked: () => void;
  wait?: (ms: number, fn: () => void) => void;
  now?: () => number;
  log?: (text: string) => void;
}

/**
 * Keeps one subscription alive. `open` subscribes with the given error callback and returns its unsubscribe. A listener
 * the store ends (its error callback gets at most one terminal error, after which it never fires again) is opened again
 * after a pause that grows with each failure in a row (a listener that lived half a minute starts the count again),
 * except after `revoked` (terminal for the page load) and `invalid_argument` (a bug no retry fixes, logged).
 */
export function keepSubscribed(name: string, open: (onError: (e: { code?: string; message?: string }) => void) => () => void, opts: KeepOptions): void {
  const wait = opts.wait ?? ((ms, fn) => void setTimeout(fn, ms));
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((t) => console.error(t));
  let failures = 0;
  const start = () => {
    const began = now();
    let stop: () => void = () => undefined;
    let ended = false;
    stop = open((e) => {
      if (ended) return;
      ended = true;
      stop();
      const code = typeof e?.code === 'string' ? e.code : 'unavailable';
      if (code === 'revoked') return opts.onRevoked();
      if (code === 'invalid_argument' || code === 'transform_error') return log(`Keelcrew board: the ${name} subscription was refused (${code}): ${e?.message ?? ''}`);
      failures = now() - began > 30_000 ? 1 : failures + 1;
      wait(resubscribeDelay(failures, code), start);
    });
  };
  start();
}
