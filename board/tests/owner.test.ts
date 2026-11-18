import { describe, expect, it } from 'vitest';
import { READ_ONLY_NOTE, writeAccess } from '../src/lib/owner';

describe('owner gating', () => {
  it('lets only the captain write', () => {
    expect(writeAccess({ hasDb: true, isOwner: true })).toEqual({ canWrite: true, reason: null });
    expect(writeAccess({ hasDb: true, isOwner: false })).toEqual({ canWrite: false, reason: READ_ONLY_NOTE });
  });

  it('stays read-only while ownership is unknown', () => {
    expect(writeAccess({ hasDb: true, isOwner: null }).canWrite).toBe(false);
  });

  it('says why when there is no database', () => {
    const a = writeAccess({ hasDb: false, isOwner: true });
    expect(a.canWrite).toBe(false);
    expect(a.reason).toMatch(/Open the Keelcrew board in Claude/);
  });
});
