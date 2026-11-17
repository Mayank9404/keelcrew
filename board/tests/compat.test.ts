import { describe, expect, it } from 'vitest';
import { BOARD_SCHEMA, PANEL_STALE_MS, helperNote, helperStatus, panelNote } from '../src/lib/compat';

describe('helper version check', () => {
  it('accepts a helper on the board schema', () => {
    expect(helperStatus({ ok: true, version: '1.0.0', schema: BOARD_SCHEMA, home: '/x' })).toEqual({ status: 'ok', version: '1.0.0', schema: 2 });
  });

  it('flags a helper that doesn’t report schema 2', () => {
    const h = helperStatus({ ok: true, version: '1.0.0', home: '/x' });
    expect(h.status).toBe('old');
    expect(helperNote(h)).toMatch(/older than this board/);
  });

  it('flags a helper newer than the board', () => {
    const h = helperStatus({ version: '2.0.0', schema: 3 });
    expect(h.status).toBe('newer');
    expect(helperNote(h)).toMatch(/republish/);
  });

  it('reports a missing helper with why, so the captain knows what to do', () => {
    const h = helperStatus(null);
    expect(h.status).toBe('missing');
    expect(helperNote(h)).toMatch(/didn’t answer/);
    expect(helperNote(helperStatus(null, BOARD_SCHEMA, 'server_not_connected'))).toMatch(/isn’t running/);
    expect(helperNote(helperStatus(null, BOARD_SCHEMA, 'not_in_manifest'))).toMatch(/Permissions menu/);
    expect(helperNote(helperStatus(null, BOARD_SCHEMA, 'no_mcp'))).toMatch(/Claude app/);
  });
});

describe('Mate panel check-in', () => {
  const now = new Date(2026, 9, 23, 18, 0).getTime();
  it('says nothing while the panel reads the board, or when the helper cannot tell', () => {
    expect(panelNote(now - 2 * 60_000, now, 'ok')).toBeNull();
    expect(panelNote(null, now, 'ok')).toBeNull();
    expect(panelNote(now - 60 * 60_000, now, 'missing')).toBeNull();
  });

  it('tells the captain to open the Mate session once the panel has been quiet for 10 minutes', () => {
    expect(panelNote(now - PANEL_STALE_MS, now, 'ok')).toMatch(/hasn’t read the board since .*Open the Mate session/);
  });
});
