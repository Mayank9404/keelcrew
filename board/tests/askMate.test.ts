import { afterEach, describe, expect, it } from 'vitest';
import { isAskMateKey, uiStore } from '../src/lib/ui';

const start = uiStore.get();
const target = (inside: boolean) => ({ closest: () => (inside ? {} : null) }) as unknown as EventTarget;
const key = (p: Partial<KeyboardEvent> = {}) => ({ key: '/', metaKey: false, ctrlKey: false, altKey: false, target: target(false), ...p });

describe('the / shortcut to the Mate chat', () => {
  afterEach(() => uiStore.set(start));
  it('opens the chat from the page', () => expect(isAskMateKey(key())).toBe(true));
  it('leaves typing alone', () => expect(isAskMateKey(key({ target: target(true) }))).toBe(false));
  it('needs a bare /', () => expect(isAskMateKey(key({ ctrlKey: true }))).toBe(false));
  it('waits while the palette, a sheet or a task is open', () => {
    for (const p of [{ paletteOpen: true }, { sheet: 'logs' as const }, { task: { key: 'T-1', tab: 'story' as never, evidenceId: null } }]) {
      uiStore.set({ ...start, ...p });
      expect(isAskMateKey(key())).toBe(false);
    }
  });
});
