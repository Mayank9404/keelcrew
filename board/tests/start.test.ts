import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boardBackend } from '../src/board/backend';
import { START_OPTIONS, toInbox, type Row } from '../src/board/convert';
import { S, configOf } from '../src/board/state';
import { ApiError, setBackend, type Backend } from '../src/lib/api';
import { HELPER_TOOLS, HELPER_WRITE_TOOLS } from '../src/lib/helperTools';
import { crewStore } from '../src/lib/store';
import { toastStore } from '../src/lib/toast';
import { VARIANT_LABEL, cardVariant, cardsForYou } from '../src/lib/triage';
import { StartCard, openLead, startUse } from '../src/components/cards/StartCard';
import { card, crew } from './build';

const m = vi.hoisted(() => ({ helper: vi.fn(), createOrUpdate: vi.fn(), addDoc: vi.fn() }));
vi.mock('../src/board/runtime', () => ({ helper: m.helper, helperAvailable: () => true, HelperError: class extends Error {} }));
vi.mock('../src/board/db', () => ({ addDoc: m.addDoc, createOrUpdate: m.createOrUpdate, reader: vi.fn(), updateFresh: vi.fn(), updatePinned: vi.fn(), updateWith: vi.fn(), writer: vi.fn() }));

const row = (id: string, body: Record<string, unknown>): Row => ({ ...body, _id: id, _v: 'v1' });
const startCard = card('start-1', { kind: 'start', title: 'Start D-1', body: 'The engineer is **ready**.', options: ['Not now'], start: { proposal: 'task_d1', model: 'claude-opus-5-5', effort: 'xhigh' } });

beforeEach(() => {
  vi.stubGlobal('window', { setTimeout: () => 0 });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  toastStore.set([]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  S.settings = null;
  S.local = null;
});

describe('start cards', () => {
  it('reads the proposal, model and effort, and ignores a card’s `brief` field', () => {
    const c = toInbox(row('s-1', { kind: 'start', start: { proposal: 'task_d1', model: 'claude-opus-5-5', effort: 'xhigh' } }));
    expect(c).toMatchObject({ kind: 'start', start: { proposal: 'task_d1', model: 'claude-opus-5-5', effort: 'xhigh' }, options: START_OPTIONS });
    expect(toInbox(row('s-2', { kind: 'start', start: { brief: 'd-1-engineer', model: 'claude-opus-5-5' } })).start).toEqual({ proposal: null, model: 'claude-opus-5-5', effort: null });
    for (const start of [undefined, 'd-1', ['x']]) expect(toInbox(row('s-3', { kind: 'start', start })).start).toBeNull();
    expect(toInbox(row('s-4', { kind: 'start', options: ['Not now', 'Skip it'] })).options).toEqual(['Not now', 'Skip it']);
  });

  it('shows as “Start session” and needs the captain', () => {
    expect(cardVariant(startCard)).toBe('start');
    expect(VARIANT_LABEL.start).toBe('Start session');
    expect(cardsForYou(crew({ inbox: [startCard] })).map((c) => c.id)).toEqual(['start-1']);
  });

  it('says which model and effort to use', () => {
    expect(startUse(startCard.start)).toBe('Opus 5.5 · xhigh · Auto');
    expect(startUse({ proposal: null, model: null, effort: 'high' })).toBe('high · Auto');
    expect(startUse({ proposal: null, model: null, effort: null })).toBeNull();
  });

  it('draws the body, the ask, the model line, the open button and the other options for the captain only', () => {
    crewStore.set({ crew: crew(), conn: 'open', events: [] });
    const html = renderToStaticMarkup(createElement(StartCard, { item: startCard }));
    expect(html).toContain('<strong>ready</strong>');
    expect(html).toContain('The Mate is asking to start this session. Open its session: a fresh Start card comes up at the bottom of its chat within a minute');
    expect(html).toContain('Use: <b>Opus 5.5 · xhigh · Auto</b>');
    expect(html).toMatch(/<button[^>]*class="btn primary"[^>]*>Open the Mate session<\/button>/);
    expect(html).toContain('>Not now</button>');
    const engineer = renderToStaticMarkup(createElement(StartCard, { item: { ...startCard, taskKey: 'D-2', start: { proposal: null, model: null, effort: null } } }));
    expect(engineer).toContain('Open its session: a &quot;Start D-2&quot; button comes up at the bottom of its chat within a minute');
    const bare = renderToStaticMarkup(createElement(StartCard, { item: { ...startCard, start: null } }));
    expect(bare).toContain('>Open the Mate session</button>');
    expect(bare).not.toContain('Use:');
    crewStore.set({ crew: crew({ access: { canWrite: false, reason: null } }), conn: 'open', events: [] });
    const ro = renderToStaticMarkup(createElement(StartCard, { item: startCard }));
    expect(ro).not.toContain('>Open the Mate session</button>');
    expect(ro).not.toContain('>Not now</button>');
  });

  it('opens the Mate session and asks the Mate to post the card again', async () => {
    const openLeadSession = vi.fn().mockResolvedValue({ command: '' });
    const resurfaceStart = vi.fn().mockResolvedValue(undefined);
    setBackend({ openLeadSession, resurfaceStart } as unknown as Backend);
    expect(await openLead({ id: 'start-keel-d-1', taskKey: 'D-1' }, () => 42)).toBe(42);
    expect(openLeadSession).toHaveBeenCalledWith();
    expect(resurfaceStart).toHaveBeenCalledWith('start-keel-d-1', 'D-1');
    expect(toastStore.get().map((t) => t.text)).toEqual(['Opened the Mate session. Its Start card comes up at the bottom of the chat within a minute.']);
  });

  it('shows the helper’s error when opening fails, and the Mate still gets the request', async () => {
    const resurfaceStart = vi.fn().mockResolvedValue(undefined);
    setBackend({ resurfaceStart, openLeadSession: vi.fn().mockRejectedValue(new ApiError('That session isn’t on this Mac.', 404)) } as unknown as Backend);
    expect(await openLead({ id: 'start-1', taskKey: null })).toBeNull();
    expect(resurfaceStart).toHaveBeenCalledWith('start-1', null);
    expect(toastStore.get().map((t) => [t.level, t.text])).toEqual([['error', 'That session isn’t on this Mac.']]);
  });

  it('for an engineer’s start card, says a Start <KEY> button comes up in the Mate chat', async () => {
    setBackend({ openLeadSession: vi.fn().mockResolvedValue({ command: '' }), resurfaceStart: vi.fn().mockResolvedValue(undefined) } as unknown as Backend);
    await openLead({ id: 'start-keel-d-2', taskKey: 'D-2', start: { proposal: null, model: null, effort: null } });
    expect(toastStore.get().map((t) => t.text)).toEqual(['Opened the Mate session. A "Start D-2" button comes up at the bottom of its chat within a minute.']);
  });

  it('opens the Mate through the helper’s open_session in the Claude app; open_new_session is gone', async () => {
    expect(HELPER_TOOLS).not.toContain('open_new_session');
    expect(HELPER_WRITE_TOOLS).toContain('open_session');
    m.helper.mockResolvedValue({ command: 'claude --desktop --resume lead-1' });
    await boardBackend().openLeadSession();
    expect(m.helper).toHaveBeenCalledWith('open_session', { key: 'lead', app: 'desktop' });
  });
});

describe('sessions.startMethod setting', () => {
  it('defaults to card when missing, unknown or the removed link', () => {
    expect(configOf().sessions).toEqual({ startMethod: 'card' });
    for (const sessions of [{ startMethod: 'bogus' }, { startMethod: 'link' }, 'routine']) {
      S.settings = { _id: 'main', _v: 'v1', sessions };
      expect(configOf().sessions.startMethod).toBe('card');
    }
    S.settings = { _id: 'main', _v: 'v1', sessions: { startMethod: 'routine' } };
    expect(configOf().sessions.startMethod).toBe('routine');
  });

  it('saves only what changed and reads it back', async () => {
    const base = configOf();
    const next = structuredClone(base);
    next.sessions.startMethod = 'routine';
    await boardBackend().saveSettings(base, 'missing', next);
    expect(m.createOrUpdate).toHaveBeenCalledTimes(1);
    const [path, version, patch, full] = m.createOrUpdate.mock.calls[0];
    expect([path, version]).toEqual(['settings/main', 'missing']);
    expect(patch).toEqual({ sessions: { startMethod: 'routine' }, updatedAt: expect.any(Number) });
    S.settings = { ...full, _id: 'main', _v: 'v2' };
    expect(configOf().sessions.startMethod).toBe('routine');
  });
});

describe('compactWindow (Mac-side)', () => {
  it('is auto unless the helper names a size', () => {
    expect(configOf().compactWindow).toBe('auto');
    S.local = {};
    expect(configOf().compactWindow).toBe('auto');
    S.local = { compactWindow: 'auto' };
    expect(configOf().compactWindow).toBe('auto');
    S.local = { compactWindow: 400_000 };
    expect(configOf().compactWindow).toBe(400_000);
  });

  it('saves a chosen size through config_set, not settings/main', async () => {
    S.local = {};
    const base = configOf();
    const next = { ...structuredClone(base), compactWindow: 600_000 };
    m.helper.mockResolvedValue({ config: { compactWindow: 600_000 } });
    await boardBackend().saveSettings(base, 'v1', next);
    expect(m.helper).toHaveBeenCalledWith('config_set', { patch: { compactWindow: 600_000 } });
    expect(m.createOrUpdate).not.toHaveBeenCalled();
    expect(configOf().compactWindow).toBe(600_000);
  });
});

describe('files the crew links', () => {
  it('opens a file on the Mac through open_file', async () => {
    m.helper.mockResolvedValue({ ok: true, shown: 'opened' });
    await boardBackend().openFile('file:///Users/me/a.csv', false);
    expect(m.helper).toHaveBeenCalledWith('open_file', { path: 'file:///Users/me/a.csv', reveal: false });
  });
});
