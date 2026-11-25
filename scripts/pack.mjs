#!/usr/bin/env node
// @ts-check
// Packs Keelcrew to share: a zip of the committed marketplace (the plugin, with the built board), the docs and the
// license and NOTICE, without tests or the board's source. Commit first: it packs HEAD. Usage: node scripts/pack.mjs
// → dist/keelcrew-<version>.zip, which unzips to a keelcrew/ folder that `/plugin marketplace add` takes.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PATHS = ['.claude-plugin', 'plugins', 'docs', 'README.md', 'CONTRIBUTING.md', 'LICENSE', 'NOTICE'];
const LEFT_OUT = [':(exclude)plugins/*/tests', ':(exclude)plugins/*.test.*', ':(exclude)docs/media'];

const git = (/** @type {string[]} */ ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const dirty = git('status', '--porcelain', '--', ...PATHS);
if (dirty) {
  console.error(`pack: commit these first, it packs HEAD:\n${dirty}`);
  process.exit(1);
}
const { version } = JSON.parse(readFileSync(join(root, 'plugins', 'keelcrew', '.claude-plugin', 'plugin.json'), 'utf8'));
const out = join(root, 'dist', `keelcrew-${version}.zip`);
mkdirSync(dirname(out), { recursive: true });
git('archive', '--format=zip', '--prefix=keelcrew/', '-o', out, 'HEAD', '--', ...PATHS, ...LEFT_OUT);
console.log(`pack: ${out} (${git('rev-parse', '--short', 'HEAD')})`);
