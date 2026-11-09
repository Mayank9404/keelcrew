#!/usr/bin/env node
// @ts-check
// git pre-push, through the hooks Keelcrew manages for a registered worktree (core/githooks.mjs): reads what is being
// pushed from standard input and lets it go only with the captain's approval. Exit 1 refuses the push; anything that goes
// wrong here refuses it too, since a check that can't run must not wave a push through.
import { readFileSync } from 'node:fs';

const dir = process.argv[2] ?? '';
let ok = false;
let reason = 'the push check failed';
try {
  const { checkPush, logPushCheck } = await import('../core/githooks.mjs');
  const r = checkPush({ dir, input: readFileSync(0, 'utf8') });
  logPushCheck(dir, r);
  ok = r.ok;
  reason = r.reason;
} catch (e) {
  reason = `the push check failed (${String(/** @type {Error} */ (e)?.message ?? e).split('\n')[0]}), so this push is refused. Run keelctl doctor`;
}
if (!ok) process.stderr.write(`Keelcrew: push refused. ${reason}\n`);
process.exit(ok ? 0 : 1);
