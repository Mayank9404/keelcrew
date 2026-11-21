import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMerges, boardBackend } from '../src/board/backend';
import type { Row } from '../src/board/convert';
import { S } from '../src/board/state';
import { card } from './build';

const m = vi.hoisted(() => ({ addDoc: vi.fn(), updatePinned: vi.fn(), updateWith: vi.fn(), updateFresh: vi.fn(), createOrUpdate: vi.fn(), helper: vi.fn(), toast: vi.fn() }));
vi.mock('../src/lib/toast', () => ({ toast: m.toast }));
vi.mock('../src/board/runtime', () => ({ helper: m.helper, helperAvailable: () => true, HelperError: class extends Error {} }));
vi.mock('../src/board/db', () => ({ addDoc: m.addDoc, createOrUpdate: m.createOrUpdate, reader: vi.fn(), updateFresh: m.updateFresh, updatePinned: m.updatePinned, updateWith: m.updateWith, writer: vi.fn() }));

const row = (id: string, body: Record<string, unknown>): Row => ({ ...body, _id: id, _v: `v-${id}` });

afterEach(() => {
  vi.clearAllMocks();
  S.tasksOpen = new Map();
  S.settings = null;
  S.org = null;
  S.isOwner = false;
});

describe('merged PRs on the board', () => {
  it('moves a row at pr to the merge target, pinned to the row it saw, once', async () => {
    S.isOwner = true;
    S.settings = row('main', { merges: { autoStatus: true } });
    S.tasksOpen = new Map([
      ['D-1', row('D-1', { status: 'pr', prUrl: 'u1' })],
      ['D-2', row('D-2', { status: 'qa', prUrl: 'u2' })],
    ]);
    const mac = { merges: { at: 1, merges: [{ key: 'D-1', prUrl: 'u1', mergedAt: 50, target: 'done' }, { key: 'D-2', prUrl: 'u2', mergedAt: 60, target: 'done' }] } };
    await applyMerges(mac);
    await applyMerges(mac);
    expect(m.updatePinned.mock.calls).toEqual([['tasks/D-1', 'v-D-1', { status: 'done', mergedAt: 50, closedAt: 50, updatedAt: expect.any(Number) }, 'That task']]);
  });

  it('leaves rows alone for a viewer who is not the captain or with the switch off, and retries a write that lost a race', async () => {
    S.tasksOpen = new Map([['D-1', row('D-1', { status: 'pr' })]]);
    S.settings = row('main', { merges: { autoStatus: true } });
    const mac = { merges: { at: 1, merges: [{ key: 'D-1', mergedAt: 70, target: 'qa' }] } };
    await applyMerges(mac);
    S.isOwner = true;
    S.settings = row('main', {});
    await applyMerges(mac);
    expect(m.updatePinned).not.toHaveBeenCalled();
    S.settings = row('main', { merges: { autoStatus: true } });
    m.updatePinned.mockRejectedValueOnce(new Error('changed meanwhile'));
    await applyMerges(mac);
    await applyMerges(mac);
    expect(m.updatePinned).toHaveBeenCalledTimes(2);
    expect(m.updatePinned.mock.calls[1][2]).toEqual({ status: 'qa', mergedAt: 70, updatedAt: expect.any(Number) });
  });
});

describe('the org', () => {
  it('answers a card without touching the org settings', async () => {
    S.settings = row('main', {});
    await boardBackend().decideInbox(card('q-1', { options: ['Yes', 'Not now'] }), 'answer', 'Yes');
    expect(m.updatePinned).toHaveBeenCalledWith('inbox/q-1', 'v', expect.objectContaining({ status: 'answered', answer: 'Yes' }), 'That card');
    expect(m.updateWith).not.toHaveBeenCalled();
    expect(m.createOrUpdate).not.toHaveBeenCalled();
    expect(m.addDoc).not.toHaveBeenCalled();
  });
});

