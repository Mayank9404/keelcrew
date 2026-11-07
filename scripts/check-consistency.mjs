#!/usr/bin/env node
// @ts-check
// Checks the places that must agree but can't share code: the mod's copy of the ship choices, health defaults and usage
// guard, the board's copies of the panel's and core's constants, agent manifests and their skills, bullets copied between
// skills, and the helper tools the board declares.
// Exits non-zero with one line per mismatch.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = join(root, 'plugins', 'keelcrew');
const rules = JSON.parse(readFileSync(join(plugin, 'rules', 'rules.json'), 'utf8'));
/** @type {string[]} */
const problems = [];

// The mod's ship choices (its approvals go through `keelctl grant`, so approval times are the helper's alone).
const mod = readFileSync(join(root, 'plugins', 'keelcrew', 'hooks', 'register.tsx'), 'utf8');
const choices = /const CHOICES = (\[[^\]]+\])/.exec(mod)?.[1];
if (!choices || JSON.stringify(JSON.parse(choices.replace(/'/g, '"'))) !== JSON.stringify(rules.ship.choices)) {
  problems.push(`mod CHOICES ${choices} differ from rules ${JSON.stringify(rules.ship.choices)}`);
}
// The mod's health-check defaults and usage guard: the health agent's setting defaults, and the board's default guard.
/** @param {string | undefined} text an object literal with bare keys @returns {unknown} */
const literal = (text) => (text ? JSON.parse(text.replace(/(\w+):/g, '"$1":')) : null);
const healthSettings = JSON.parse(readFileSync(join(plugin, 'agents', 'health.json'), 'utf8')).settings ?? {};
const modHealth = /const HEALTH_DEFAULTS = (\{[^}]+\})/.exec(mod)?.[1];
const wantHealth = { minFreeDiskGB: healthSettings.minFreeDiskGB?.default, usageWarnMargin: healthSettings.usageWarnMargin?.default };
if (JSON.stringify(literal(modHealth)) !== JSON.stringify(wantHealth)) problems.push(`mod HEALTH_DEFAULTS ${modHealth} differ from agents/health.json defaults ${JSON.stringify(wantHealth)}`);
const modGuard = /const USAGE_GUARD = (\{[^}]+\})/.exec(mod)?.[1];
const boardGuard = /usageGuard: (\{[^}]+\})/.exec(readFileSync(join(root, 'board', 'src', 'board', 'state.ts'), 'utf8'))?.[1];
if (!modGuard || JSON.stringify(literal(modGuard)) !== JSON.stringify(literal(boardGuard))) problems.push(`mod USAGE_GUARD ${modGuard} differs from the board's default usageGuard ${boardGuard}`);

const orgRules = rules.org ?? {};
// The mod's copy of how old a phone answer may be when the Mate's panel carries it out.
const phoneAge = Number(/const PHONE_GRANT_MAX_AGE_HOURS = (\d+)/.exec(mod)?.[1]);
if (phoneAge !== orgRules.phoneGrantMaxAgeHours) problems.push(`mod PHONE_GRANT_MAX_AGE_HOURS ${phoneAge} differs from rules org.phoneGrantMaxAgeHours ${orgRules.phoneGrantMaxAgeHours}`);

// The board's copies of the panel's and core's numbers and lists, read as text since the board is TypeScript.
/** @param {...string} parts a path under the repo root @returns {string} */
const source = (...parts) => (existsSync(join(root, ...parts)) ? readFileSync(join(root, ...parts), 'utf8') : '');
/** @param {string} text @param {string} name @returns {string | undefined} what a `const` of that name is set to */
const valueOf = (text, name) => new RegExp(`const ${name}\\b[^=]*= (.+?);?$`, 'm').exec(text)?.[1];
/** @param {string | undefined} text a number such as `30 * 60_000` @returns {number} */
const product = (text) => (text && /^[\d_. *]+$/.test(text) ? text.split('*').reduce((n, x) => n * Number(x.replace(/_/g, '')), 1) : NaN);
/** @param {string | undefined} text a list of quoted strings */
const list = (text) => (text ? JSON.stringify(JSON.parse(text.replace(/'/g, '"'))) : undefined);
const scanDefaults = JSON.parse(readFileSync(join(plugin, 'agents', 'scan.json'), 'utf8')).settings ?? {};
if (product(valueOf(mod, 'SCAN_PAGES')) !== scanDefaults.maxPages?.default) problems.push(`mod SCAN_PAGES ${valueOf(mod, 'SCAN_PAGES')} differs from agents/scan.json maxPages ${scanDefaults.maxPages?.default}`);
const cadence = valueOf(source('board', 'src', 'lib', 'schedule.ts'), 'SCAN_CADENCE');
const [scanMin, workStart, workEnd] = ['SCAN_MS', 'WORK_START_HOUR', 'WORK_END_HOUR'].map((n) => product(valueOf(mod, n)));
if (!cadence?.includes(`every ${scanMin / 60_000} min`) || !new RegExp(`\\b${workStart}:00[–-]${workEnd}:00\\b`).test(cadence)) problems.push(`board SCAN_CADENCE ${cadence} doesn't say every ${scanMin / 60_000} min, ${workStart}:00–${workEnd}:00 (mod SCAN_MS, WORK_START_HOUR, WORK_END_HOUR)`);
const convert = source('board', 'src', 'board', 'convert.ts');
for (const [name, file, core] of [['RUNNING_FRESH_MS', 'crew.mjs', 'BUSY_STALE_MS'], ['IDLE_SEEN_MS', 'org.mjs', 'SEAT_IDLE_MS']]) {
  const want = product(valueOf(readFileSync(join(plugin, 'core', file), 'utf8'), core));
  if (product(valueOf(convert, name)) !== want) problems.push(`board convert.ts ${name} ${valueOf(convert, name)} differs from core ${file} ${core} (${want})`);
}
const warnShare = valueOf(source('board', 'src', 'lib', 'costs.ts'), 'WARN_SHARE');
if (product(warnShare) !== product(valueOf(mod, 'BUDGET_WARN'))) problems.push(`board WARN_SHARE ${warnShare} differs from mod BUDGET_WARN ${valueOf(mod, 'BUDGET_WARN')}`);
const coreAgents = readFileSync(join(plugin, 'core', 'agents.mjs'), 'utf8');
for (const [name, file] of [['DIFFICULTIES', 'org.ts'], ['EFFORTS', 'agents.ts']]) {
  const theirs = list(valueOf(source('board', 'src', 'lib', file), name));
  if (!theirs || theirs !== list(valueOf(coreAgents, name))) problems.push(`board lib/${file} ${name} ${theirs} differs from core agents.mjs ${list(valueOf(coreAgents, name))}`);
}

// The engineer ladder every model resolver falls back to: core org.mjs and the board's lib/models.ts keep the same one.
/** @param {string} file */
const ladderIn = (file) => (existsSync(file) ? /export const ENGINEER_LADDER = (\{.*\});/.exec(readFileSync(file, 'utf8'))?.[1]?.replace(/'/g, '"') : undefined);
const coreLadder = ladderIn(join(plugin, 'core', 'org.mjs'));
const boardLadder = ladderIn(join(root, 'board', 'src', 'lib', 'models.ts'));
if (!coreLadder || JSON.stringify(literal(coreLadder)) !== JSON.stringify(literal(boardLadder))) problems.push(`board ENGINEER_LADDER ${boardLadder} differs from core org.mjs ${coreLadder}`);
// Skills take every model from `keelctl org model`, never one written into their text.
for (const skill of ['keel-lead', 'keel-engineer']) {
  const text = readFileSync(join(plugin, 'skills', skill, 'SKILL.md'), 'utf8');
  if (!text.includes('keelctl org model')) problems.push(`skills/${skill}/SKILL.md doesn't take models from keelctl org model`);
  const fixed = /\bmodel `(sonnet|opus|haiku)`|claude-(opus|sonnet|haiku)-\d|`models\.worker|effortByDifficulty/.exec(text);
  if (fixed) problems.push(`skills/${skill}/SKILL.md names a model or model settings itself (${fixed[0]})`);
}

// Every agent names a skill that exists, and ids are unique and match file names.
const agentsDir = join(plugin, 'agents');
const ids = new Set();
for (const file of existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith('.json')) : []) {
  const a = JSON.parse(readFileSync(join(agentsDir, file), 'utf8'));
  if (`${a.id}.json` !== file) problems.push(`agents/${file}: id "${a.id}" doesn't match the file name`);
  if (ids.has(a.id)) problems.push(`agents/${file}: duplicate id ${a.id}`);
  ids.add(a.id);
  if (!existsSync(join(plugin, 'skills', a.skill, 'SKILL.md'))) problems.push(`agents/${file}: skill "${a.skill}" has no skills/${a.skill}/SKILL.md`);
  if (a.department && !existsSync(join(plugin, 'departments', `${a.department}.json`))) problems.push(`agents/${file}: department "${a.department}" has no departments/${a.department}.json`);
}

// Every role a department names as its head, and every role an agent reports to, exists (the Mate is the session itself).
const departmentsDir = join(plugin, 'departments');
for (const file of existsSync(departmentsDir) ? readdirSync(departmentsDir).filter((f) => f.endsWith('.json')) : []) {
  const d = JSON.parse(readFileSync(join(departmentsDir, file), 'utf8'));
  if (`${d.id}.json` !== file) problems.push(`departments/${file}: id "${d.id}" doesn't match the file name`);
  if (d.defaultEnabled && !ids.has(d.head)) problems.push(`departments/${file}: head "${d.head}" has no agents/${d.head}.json`);
}
for (const file of existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith('.json')) : []) {
  const a = JSON.parse(readFileSync(join(agentsDir, file), 'utf8'));
  if (a.reportsTo && a.reportsTo !== 'lead' && !ids.has(a.reportsTo)) problems.push(`agents/${file}: reportsTo "${a.reportsTo}" has no agents/${a.reportsTo}.json`);
}

// Every skill's frontmatter name matches its folder.
for (const dir of readdirSync(join(plugin, 'skills'))) {
  const path = join(plugin, 'skills', dir, 'SKILL.md');
  if (!existsSync(path)) continue;
  const name = /^name:\s*(\S+)/m.exec(readFileSync(path, 'utf8'))?.[1];
  if (name !== dir) problems.push(`skills/${dir}/SKILL.md: name "${name}" doesn't match the folder`);
}

// Bullets copied into several skills stay word for word the same, with the skill's agent id read as <id>.
/** @type {Map<string, string>} */
const agentOfSkill = new Map();
for (const file of existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith('.json')) : []) {
  const a = JSON.parse(readFileSync(join(agentsDir, file), 'utf8'));
  agentOfSkill.set(a.skill, a.id);
}
for (const head of ['- **Switched off?**', '- **Record the run.**']) {
  /** @type {Map<string, string[]>} */
  const copies = new Map();
  for (const dir of readdirSync(join(plugin, 'skills'))) {
    const path = join(plugin, 'skills', dir, 'SKILL.md');
    const line = existsSync(path) ? readFileSync(path, 'utf8').split('\n').find((l) => l.startsWith(head)) : undefined;
    if (!line) continue;
    const id = agentOfSkill.get(dir);
    const text = id ? line.replace(new RegExp(`(?<![\\w-])${id.replace(/-/g, '\\-')}(?![\\w-])`, 'g'), '<id>') : line;
    copies.set(text, [...(copies.get(text) ?? []), dir]);
  }
  if (copies.size > 1) problems.push(`skills: the "${head.slice(4).replace(/\*\*$/, '')}" bullet differs between copies (${[...copies.values()].map((d) => d.join(', ')).join(' | ')})`);
}

// The pack only refers to agents that exist.
/** @type {string[]} */
const packReadOnly = [];
for (const packDir of readdirSync(join(plugin, 'packs'))) {
  const pack = JSON.parse(readFileSync(join(plugin, 'packs', packDir, 'pack.json'), 'utf8'));
  for (const id of Object.keys(pack.agents ?? {})) if (ids.size && !ids.has(id)) problems.push(`packs/${packDir}: agents.${id} names no agent`);
  packReadOnly.push(...(pack.policy?.readOnlyServers ?? []));
}

// The board's helper tools are the helper's real tools: the board lists them (HELPER_TOOLS) and which of them write
// (HELPER_WRITE_TOOLS); the helper marks its reads `ro: true`. Both are read as text, since the board is TypeScript.
// No publish manifest file declares the `mcp` tool list: the board is published by hand from skills/keel-setup/SKILL.md.
const server = readFileSync(join(plugin, 'helper', 'server.mjs'), 'utf8');
const table = /^const TOOLS = \{\n([\s\S]*?)^\};/m.exec(server)?.[1] ?? '';
/** @type {Map<string, { ro: boolean, d: string }>} */
const tools = new Map();
const starts = [...table.matchAll(/^ {2}(\w+): \{/gm)];
starts.forEach((m, i) => {
  const body = table.slice(m.index, starts[i + 1]?.index ?? table.length);
  tools.set(m[1], { ro: /\bro: true\b/.test(body), d: /\bd: (['"])((?:\\.|(?!\1)[^\\])*)\1/.exec(body)?.[2] ?? '' });
});
if (!tools.size) problems.push("helper/server.mjs: can't find the TOOLS table");
const board = readFileSync(join(root, 'board', 'src', 'lib', 'helperTools.ts'), 'utf8');
/** @param {string} name */
const boardList = (name) => {
  const body = new RegExp(`export const ${name}\\b[^=]*= \\[([^\\]]*)\\]`).exec(board)?.[1];
  if (body === undefined) problems.push(`board/src/lib/helperTools.ts: can't find ${name}`);
  return new Set([...(body ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1]));
};
const boardTools = boardList('HELPER_TOOLS');
const writeTools = boardList('HELPER_WRITE_TOOLS');
for (const t of boardTools) if (!tools.has(t)) problems.push(`board HELPER_TOOLS lists "${t}", which helper/server.mjs doesn't have`);
for (const t of writeTools) {
  if (!boardTools.has(t)) problems.push(`board HELPER_WRITE_TOOLS lists "${t}", which isn't in HELPER_TOOLS`);
  if (tools.get(t)?.ro) problems.push(`board HELPER_WRITE_TOOLS lists "${t}", which helper/server.mjs marks ro: true`);
}

// rules.json: the board-only tools are exactly the helper tools that say "Board only", and no read-only rule lets a
// helper write run quietly. Both server spellings count (keelcrew-local and keelcrew_local).
const policy = rules.policy ?? {};
const boardOnly = new RegExp(policy.boardOnlyTools ?? '(?!)');
const readOnly = [...(policy.readOnlyServers ?? []), ...packReadOnly].map((s) => new RegExp(s));
for (const [t, { ro, d }] of tools) {
  const names = [`mcp__keelcrew-local__${t}`, `mcp__keelcrew_local__${t}`];
  const saysBoardOnly = /\bBoard only\b/.test(d);
  if (!boardTools.has(t)) problems.push(`helper tool "${t}" is missing from board HELPER_TOOLS`);
  else if (!ro && !writeTools.has(t)) problems.push(`helper tool "${t}" isn't ro: true but is missing from board HELPER_WRITE_TOOLS`);
  if (ro && names.some((x) => boardOnly.test(x))) problems.push(`rules policy.boardOnlyTools matches read-only helper tool "${t}"`);
  else if (!ro && saysBoardOnly && !names.every((x) => boardOnly.test(x))) problems.push(`rules policy.boardOnlyTools misses "${t}", whose description says Board only`);
  else if (!ro && !saysBoardOnly && names.some((x) => boardOnly.test(x))) problems.push(`rules policy.boardOnlyTools blocks "${t}", whose description doesn't say Board only`);
  if (!ro && readOnly.some((re) => names.some((x) => re.test(x)))) problems.push(`rules policy.readOnlyServers lets helper write tool "${t}" run without asking`);
}
// The published board declares exactly the tools it calls (the build writes capabilities.json from HELPER_TOOLS into the plugin).
const capsFile = join(root, 'plugins', 'keelcrew', 'board', 'capabilities.json');
if (existsSync(capsFile)) {
  const declared = new Set(JSON.parse(readFileSync(capsFile, 'utf8')).mcp?.servers?.find((/** @type {any} */ x) => x.server === 'host:keelcrew-local')?.tools ?? []);
  for (const t of boardTools) if (!declared.has(t)) problems.push(`plugins/keelcrew/board/capabilities.json doesn't declare "${t}"; rebuild the board`);
  for (const t of declared) if (!boardTools.has(t)) problems.push(`plugins/keelcrew/board/capabilities.json declares "${t}", which the board doesn't call; rebuild the board`);
}

// The Claude Code settings Keelcrew keeps in the Mate folder.
const sessions = rules.sessions ?? {};
if (!['default', 'acceptEdits', 'auto'].includes(sessions.defaultMode)) problems.push(`rules sessions.defaultMode ${JSON.stringify(sessions.defaultMode)} isn't default, acceptEdits or auto`);
const compact = sessions.compactWindow;
if (compact !== 'auto' && !(Number.isInteger(compact) && compact >= 100_000 && compact <= 1_000_000)) {
  problems.push(`rules sessions.compactWindow ${JSON.stringify(compact)} isn't "auto" or a whole number from 100000 to 1000000`);
}

if (problems.length) {
  console.log(problems.map((p) => `FAIL ${p}`).join('\n'));
  process.exit(1);
}
console.log(`consistency: ok (${ids.size} agents, ${tools.size} helper tools)`);
