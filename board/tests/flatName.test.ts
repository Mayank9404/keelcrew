import { describe, expect, it } from 'vitest';
import { flatName } from '../vite.config';

describe('board file names', () => {
  it('names a module by its path, never with a leading underscore the artifact service refuses', () => {
    expect(flatName({ name: 'src/components/chat/ChatPanel' })).toBe('components-chat-ChatPanel.js');
    expect(flatName({ name: '_virtual/_vite/preload-helper' })).toBe('virtual-_vite-preload-helper.js');
  });
});
