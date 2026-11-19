import { describe, expect, it } from 'vitest';
import { HELPER_TOOLS, isMissingTool } from '../src/lib/helperTools';

describe('helper tools', () => {
  it('declares every tool the board uses, once', () => {
    expect(new Set(HELPER_TOOLS).size).toBe(HELPER_TOOLS.length);
    for (const t of ['ping', 'crew_state', 'approve', 'approve_post', 'risk', 'costs', 'memory_list', 'agents_list']) expect(HELPER_TOOLS).toContain(t);
  });

  it('tells a missing tool from a failing one', () => {
    // not_in_manifest on a host server means the viewer didn't allow the helper for this page, not a helper without the tool.
    expect(isMissingTool('not_in_manifest', '')).toBe(false);
    expect(isMissingTool('-32602', 'Unknown tool: costs')).toBe(true);
    expect(isMissingTool('-32602', 'costs: Missing "key".')).toBe(false);
    expect(isMissingTool('tool_error', 'Unknown tool: risk')).toBe(true);
    expect(isMissingTool('tool_error', 'git failed')).toBe(false);
  });
});
