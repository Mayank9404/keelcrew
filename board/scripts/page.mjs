// @ts-check
/**
 * Turns the Vite build into the files the Keelcrew board artifact publishes. Each module and the stylesheet is named by its
 * content (`lib-ui.<hash>.js`), and modules import each other by a stable bare name (`crew/lib-ui`) that the import map
 * in dist/index.html resolves, along with React and three.js from the CDN. So a release adds files only for the modules
 * it changed, the live page keeps loading its own files until the new index.html is up, and the old ones can then go.
 * Then writes the published files into the plugin's board/ folder, which /keel-setup and the Mate publish from, with
 * capabilities.json (the capabilities the board is published with: its `mcp` tools come from HELPER_TOOLS, so a tool
 * the board calls is always declared) and manifest.json: each file's hash.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
if (!existsSync(`${dist}main.js`) || !existsSync(`${dist}app.css`)) {
  console.error('page: run vite build first (dist/main.js and dist/app.css are missing).');
  process.exit(1);
}
const deps = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).dependencies;
const CDN = 'https://cdn.jsdelivr.net/npm/';
/** @param {string} text */
const hashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 10);

/** @type {Record<string, string>} published name -> content */
const out = {};
/** @type {Record<string, string>} */
const imports = {
  react: `${CDN}react@${deps.react}/+esm`,
  'react/jsx-runtime': `${CDN}react@${deps.react}/jsx-runtime/+esm`,
  'react-dom/client': `${CDN}react-dom@${deps['react-dom']}/client/+esm`,
  // The Deck's 3D scene: loaded only when the Deck opens.
  three: `${CDN}three@${deps.three}/build/three.module.min.js`,
  'three/addons/': `${CDN}three@${deps.three}/examples/jsm/`,
  // react-dom asks for react by a version range: point it at the same React the board uses.
  [`${CDN}react@%5E${deps.react}/+esm`]: `${CDN}react@${deps.react}/+esm`,
};
const modules = readdirSync(dist).filter((f) => f.endsWith('.js'));
const known = new Set(modules);
for (const f of modules.sort()) {
  const stem = f.slice(0, -3);
  const text = readFileSync(`${dist}${f}`, 'utf8').replace(/(["'`])\.\/([\w.-]+\.js)\1/g, (m, q, n) => (known.has(n) ? `${q}crew/${n.slice(0, -3)}${q}` : m));
  const name = `${stem}.${hashOf(text)}.js`;
  out[name] = text;
  imports[`crew/${stem}`] = `./${name}`;
}
const css = readFileSync(`${dist}app.css`, 'utf8');
const cssName = `app.${hashOf(css)}.css`;
out[cssName] = css;

const FONTS = 'https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Literata:opsz,wght@7..72,500;7..72,600&display=swap';
const html = `<title>Keelcrew</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 56 56'><rect width='56' height='56' rx='12' fill='%23F7F5EF'/><circle cx='19' cy='10.5' r='3' fill='none' stroke='%231B4F72' stroke-width='2.6'/><rect x='12' y='15' width='14' height='3.4' rx='1.7' fill='%231B4F72'/><rect x='16.5' y='13' width='5' height='32' rx='1.2' fill='%231B4F72'/><path d='M21 30 L37 13' stroke='%231B4F72' stroke-width='5' stroke-linecap='round'/><path d='M21 30 Q31 34 38 43' stroke='%231B4F72' stroke-width='5' fill='none' stroke-linecap='round'/><path d='M32.5 45 L41.5 46 L39.5 37 Z' fill='%239C1F74'/></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<style>
[hidden] { display: none !important; }
html, body { height: 100%; }
</style>
<link rel="stylesheet" href="./${cssName}">
<script type="importmap">
${JSON.stringify({ imports }, null, 1)}
</script>
<div id="root"></div>
<script type="module">import 'crew/main';</script>
`;
out['index.html'] = html;
/** @param {number} n */
const kb = (n) => `${Math.round(n / 1024)} KB`;
const sizes = Object.values(out).map((t) => Buffer.byteLength(t));
console.log(`page: ${Object.keys(out).length} files, ${kb(sizes.reduce((a, n) => a + n, 0))}; largest ${kb(Math.max(...sizes))}; index.html ${kb(Buffer.byteLength(html))}`);

const tools = readFileSync(fileURLToPath(new URL('../src/lib/helperTools.ts', import.meta.url)), 'utf8').match(/HELPER_TOOLS\s*=\s*\[([^\]]*)\]/)?.[1];
if (!tools) {
  console.error('page: HELPER_TOOLS not found in src/lib/helperTools.ts.');
  process.exit(1);
}
const capabilities = {
  // Only the owner answers cards: nobody the board is shared with, at any level, writes an inbox card.
  db: { rules: [{ path: 'settings', write: 'admin' }, { path: 'inbox', write: 'owner' }] },
  mcp: { servers: [{ server: 'host:keelcrew-local', tools: [...tools.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) }] },
  user: {},
};

const shipped = fileURLToPath(new URL('../../plugins/keelcrew/board/', import.meta.url));
mkdirSync(shipped, { recursive: true });
out['capabilities.json'] = `${JSON.stringify(capabilities, null, 2)}\n`;
// A module a release dropped or changed must not linger in the plugin (and so get published).
for (const f of readdirSync(shipped)) if (/\.(html|js|css|json)$/.test(f) && !(f in out)) rmSync(`${shipped}${f}`);
/** @type {Record<string, string>} */
const manifest = {};
for (const [name, text] of Object.entries(out)) {
  writeFileSync(`${shipped}${name}`, text);
  manifest[name] = hashOf(text);
}
writeFileSync(`${shipped}manifest.json`, `${JSON.stringify({ files: manifest }, null, 2)}\n`);
console.log('page: copied to plugins/keelcrew/board/ with manifest.json');
