/** A repeating background read that skips its turns while the tab is hidden and catches up when it's shown again. */

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PollOptions {
  run: () => unknown;
  everyMs: number;
  /** Whether the page is hidden right now (document.hidden). */
  hidden: () => boolean;
}

export interface Poll {
  /** Runs it now if the page is visible (call on visibilitychange). */
  wake(): void;
  stop(): void;
}

export function startPoll({ run, everyMs, hidden }: PollOptions): Poll {
  let stopped = false;
  const tick = () => {
    if (!stopped && !hidden()) void run();
  };
  tick();
  const timer = setInterval(tick, everyMs);
  return {
    wake: tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
