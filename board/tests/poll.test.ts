import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPoll } from '../src/lib/poll';

describe('polls', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('skips its turns while the page is hidden and catches up on wake', () => {
    let hidden = false;
    const run = vi.fn();
    const p = startPoll({ run, everyMs: 1000, hidden: () => hidden });
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(run).toHaveBeenCalledTimes(3);
    hidden = true;
    vi.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(3);
    p.wake();
    expect(run).toHaveBeenCalledTimes(3);
    hidden = false;
    p.wake();
    expect(run).toHaveBeenCalledTimes(4);
    p.stop();
    vi.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('does not run at start when the page opens hidden', () => {
    const run = vi.fn();
    startPoll({ run, everyMs: 1000, hidden: () => true }).stop();
    expect(run).not.toHaveBeenCalled();
  });
});
