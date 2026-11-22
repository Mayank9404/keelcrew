// @ts-check
/** Writes dev-dist/index.html around the fixture build, the way scripts/page.mjs does for the real board. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../dev-dist/index.html', import.meta.url));
const v = Date.now().toString(36);
const three = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).dependencies.three;
const THREE = `https://cdn.jsdelivr.net/npm/three@${three}/`;
const FONTS = 'https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Literata:opsz,wght@7..72,500;7..72,600&display=swap';
writeFileSync(
  out,
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Keelcrew (dev fixture)</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 56 56'><rect width='56' height='56' rx='12' fill='%23F7F5EF'/><circle cx='19' cy='10.5' r='3' fill='none' stroke='%231B4F72' stroke-width='2.6'/><rect x='12' y='15' width='14' height='3.4' rx='1.7' fill='%231B4F72'/><rect x='16.5' y='13' width='5' height='32' rx='1.2' fill='%231B4F72'/><path d='M21 30 L37 13' stroke='%231B4F72' stroke-width='5' stroke-linecap='round'/><path d='M21 30 Q31 34 38 43' stroke='%231B4F72' stroke-width='5' fill='none' stroke-linecap='round'/><path d='M32.5 45 L41.5 46 L39.5 37 Z' fill='%239C1F74'/></svg>">
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="app.css?v=${v}">
<script type="importmap">{"imports":{"three":"${THREE}build/three.module.min.js","three/addons/":"${THREE}examples/jsm/"}}</script>
</head><body><div id="root"></div><script type="module" src="board-dev-main.js?v=${v}"></script></body></html>
`,
);
console.log('dev: dev-dist/index.html');
