#!/usr/bin/env node
// @ts-check
// Runs every Keelcrew check in order and stops at the first failure: syntax, consistency, core and hooks, helper, the
// panel mod, and the board. Usage: node scripts/test.mjs [--fast]   (--fast skips the board build and its tests)
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fast = process.argv.includes('--fast');
/** The oldest Claude Code the panel mod is tested on; older engines without `$.theme` don't load it, since it hooks that (docs/install.md). */
const MIN_CLAUDE = [2, 1, 326];
const claudeVersion = (spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout ?? '').match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number) ?? [0, 0, 0];
const claudeOld = claudeVersion.reduce((d, v, i) => d || v - (MIN_CLAUDE[i] ?? 0), 0) < 0;

/** @param {string} dir @returns {string[]} */
const mjsFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name === 'node_modules' || e.name.startsWith('.') ? [] : e.isDirectory() ? mjsFiles(join(dir, e.name)) : e.name.endsWith('.mjs') ? [join(dir, e.name)] : [],
  );

/** @type {[string, string, string[], string?][]} */
const steps = [
  ...mjsFiles(join(root, 'plugins')).map((f) => /** @type {[string, string, string[]]} */ ([`syntax ${f.slice(root.length + 1)}`, 'node', ['--check', f]])),
  ['consistency', 'node', [join(root, 'scripts', 'check-consistency.mjs')]],
  ...readdirSync(join(root, 'plugins', 'keelcrew', 'tests'))
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => /** @type {[string, string, string[]]} */ ([`plugin ${f}`, 'node', [join(root, 'plugins', 'keelcrew', 'tests', f)]])),
  ['helper', 'node', [join(root, 'plugins', 'keelcrew', 'helper', 'server.test.mjs')]],
  ...(claudeOld
    ? /** @type {[string, string, string[]][]} */ ([['claude version', 'node', ['-e', `console.error('claude ${claudeVersion.join('.')} (0.0.0: not found) is too old: the panel mod needs ${MIN_CLAUDE.join('.')} or newer.'); process.exit(1)`]]])
    : []),
  ['mod tests', 'claude', ['plugin', 'test', join(root, 'plugins', 'keelcrew')]],
  ['mod validate', 'claude', ['plugin', 'validate', join(root, 'plugins', 'keelcrew')]],
  ...(fast || !existsSync(join(root, 'board', 'node_modules'))
    ? []
    : /** @type {[string, string, string[], string][]} */ ([
        ['board tests', 'npm', ['test', '--silent'], join(root, 'board')],
        ['board build', 'npm', ['run', 'build', '--silent'], join(root, 'board')],
      ])),
];

if (!fast && !existsSync(join(root, 'board', 'node_modules'))) console.log('skip board tests and build: run `npm ci` in board/ first');

let failed = 0;
for (const [label, cmd, args, cwd] of steps) {
  const r = spawnSync(cmd, args, { cwd: cwd ?? root, encoding: 'utf8', env: process.env });
  const ok = r.status === 0;
  if (!label.startsWith('syntax') || !ok) console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) {
    failed++;
    console.log(`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n'));
    break;
  }
}
process.exit(failed ? 1 : 0);
