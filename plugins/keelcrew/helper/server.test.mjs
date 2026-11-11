// @ts-check
// Talks to the helper over stdio exactly as the Claude app does, against a throwaway crew home and a throwaway git repo.
// node plugins/keelcrew/helper/server.test.mjs
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, '..');
const home = mkdtempSync(join(tmpdir(), 'keelcrew-helper-'));
process.env.KEELCREW_HOME = home;
const { hash16 } = await import(pathToFileURL(join(pluginRoot, 'core', 'paths.mjs')).href);
const { readGrant } = await import(pathToFileURL(join(pluginRoot, 'core', 'grants.mjs')).href);
const { consumePostGrant } = await import(pathToFileURL(join(pluginRoot, 'core', 'posts.mjs')).href);

/* ---------- a crew home and a worktree with an origin ---------- */

/** @param {string} cwd @param {string[]} args */
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=Crew Test', '-c', 'user.email=crew@test.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const wt = join(home, 'wt');
const qaDir = join(home, 'qa');
const origin = join(home, 'origin.git');
const fetchCount = join(home, 'fetches');
mkdirSync(wt, { recursive: true });
mkdirSync(qaDir, { recursive: true });
git(home, 'init', '-q', '--bare', origin);
git(wt, 'init', '-q', '-b', 'main');
writeFileSync(join(wt, 'a.py'), 'print(1)\n');
git(wt, 'add', 'a.py');
git(wt, 'commit', '-q', '-m', 'base');
git(wt, 'remote', 'add', 'origin', origin);
git(wt, 'push', '-q', 'origin', 'main');
// Every fetch from origin runs this wrapper, so the test can count them.
const uploadPack = join(home, 'upload-pack.sh');
writeFileSync(uploadPack, `#!/bin/sh\necho fetch >> '${fetchCount}'\nexec git upload-pack "$@"\n`);
chmodSync(uploadPack, 0o755);
git(wt, 'config', 'remote.origin.uploadpack', uploadPack);
git(wt, 'checkout', '-q', '-b', 'brin-1');
writeFileSync(join(wt, 'b.py'), 'print(2)\n');
git(wt, 'add', 'b.py');
git(wt, 'commit', '-q', '-m', 'feature');
writeFileSync(join(wt, 'a.py'), 'print(3)\n');
const head = git(wt, 'rev-parse', 'HEAD');

const transcript = join(home, 't.jsonl');
/** @param {string} id @param {number} i @param {number} o @param {number} r */
const usage = (id, i, o, r) =>
  JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: 0 } } });
writeFileSync(
  transcript,
  [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Mate: build it' } }),
    usage('m1', 1000, 500, 0),
    usage('m1', 1000, 500, 0),
    JSON.stringify({ type: 'assistant', message: { id: 'm2', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 200000, cache_creation_input_tokens: 0 } } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a.py' }] } }),
  ].join('\n') + '\n',
);
writeFileSync(join(home, 'config.json'), JSON.stringify({ owner: 'Sam', pack: 'brinewick', repos: { demo: { path: wt, baseBranch: 'main' } } }));
writeFileSync(
  join(home, 'crew.json'),
  JSON.stringify({ schemaVersion: 2, dirs: { [wt]: { role: 'engineer', key: 'BRIN-1', at: 0 }, [qaDir]: { role: 'agent', key: 'BRIN-1', agent: 'qa', at: 0 } }, sessions: {} }),
);
mkdirSync(join(home, 'state'), { recursive: true });
mkdirSync(join(home, 'events'), { recursive: true });
writeFileSync(join(home, 'state', `${hash16(wt)}.json`), JSON.stringify({ sessionId: 's1', transcript, activity: 'typing', busy: true, lastTool: 'Edit', lastAt: Date.now() }));
writeFileSync(join(home, 'state', `${hash16(wt)}.alive.json`), '1700000000000');
writeFileSync(join(home, 'state', `${hash16(qaDir)}.json`), JSON.stringify({ sessionId: 's2', activity: 'reading' }));
writeFileSync(join(home, 'events', `${hash16(wt)}.jsonl`), [1, 2, 3].map((ts) => JSON.stringify({ ts, key: 'BRIN-1', kind: 'tool', tool: 'Bash', summary: `step ${ts}` })).join('\n') + '\n');

// A fake `open` first on the helper's PATH writes down what the helper asks to open, so the test opens no app.
const fakeBin = join(home, 'bin');
const opened = join(home, 'opened');
mkdirSync(fakeBin, { recursive: true });
writeFileSync(join(fakeBin, 'open'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${opened}'\n`);
chmodSync(join(fakeBin, 'open'), 0o755);
// The helper puts Homebrew's bin folders ahead of PATH, so an `open` in one of them would run instead of the fake.
const fakeOpenWins = !['/opt/homebrew/bin/open', '/usr/local/bin/open'].some((p) => existsSync(p));

/* ---------- talking to a server ---------- */

const CALL_TIMEOUT_MS = 90_000;

/** Starts a helper process and returns ways to talk to it. @param {string} script */
function startServer(script) {
  const child = spawn(process.execPath, [script], { env: { ...process.env, KEELCREW_HOME: home, PATH: `${fakeBin}:${process.env.PATH ?? ''}` }, stdio: ['pipe', 'pipe', 'inherit'] });
  /** @type {Map<unknown, (msg: any) => void>} */
  const waiting = new Map();
  /** @type {((msg: any) => void)[]} */
  const anonymous = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id === null) anonymous.shift()?.(msg);
      else waiting.get(msg.id)?.(msg);
    }
  });
  /** @param {(done: (msg: any) => void) => void} register @param {string} what @returns {Promise<any>} */
  const reply = (register, what) =>
    new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no reply to ${what}`)), CALL_TIMEOUT_MS);
      register((msg) => {
        clearTimeout(timer);
        done(msg);
      });
    });
  let nextId = 1;
  /** @param {string} method @param {unknown} [params] */
  const rpc = (method, params) => {
    const id = nextId++;
    const p = reply((done) => waiting.set(id, done), method);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return p;
  };
  /** A line answered without an id (unparseable or not a request object). @param {string} line */
  const rawAnonymous = (line) => {
    const p = reply((done) => anonymous.push(done), line);
    child.stdin.write(`${line}\n`);
    return p;
  };
  /** A raw request with its own id. @param {string} id @param {string} line */
  const rawWithId = (id, line) => {
    const p = reply((done) => waiting.set(id, done), line);
    child.stdin.write(`${line}\n`);
    return p;
  };
  /** @param {string} name @param {unknown} [args] */
  const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  const stop = () => new Promise((done) => {
    child.once('exit', done);
    child.stdin.end();
  });
  return { rpc, call, rawAnonymous, rawWithId, stop };
}

let bad = 0;
let n = 0;
/** @type {string[]} */
const notes = [];
/** @param {string} label @param {unknown} got @param {unknown} want */
const expect = (label, got, want) => {
  n++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad++;
    console.log(`FAIL ${label}: ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};
/** @param {any} r */
const text = (r) => String(r?.content?.[0]?.text ?? '');

const { rpc, call, rawAnonymous, rawWithId, stop } = startServer(join(here, 'server.mjs'));

/* ---------- protocol and tool list ---------- */

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
expect('initialize names the server', init.result.serverInfo.name, 'keelcrew-local');
const list = await rpc('tools/list', {});
const names = list.result.tools.map((/** @type {any} */ t) => t.name);
const ALL = ['ping', 'crew_state', 'session_events', 'transcript', 'diff', 'branch_url', 'changed_files', 'open_in', 'open_session', 'open_file', 'logs', 'log_tail', 'open_logs', 'doctor', 'prompts', 'prompt_save', 'config_get', 'config_set', 'approve', 'memory_list', 'agents_list', 'risk', 'costs', 'approve_post', 'org'];
expect('lists every contract tool', ALL.filter((t) => !names.includes(t)), []);
/** @param {string} name */
const ro = (name) => list.result.tools.find((/** @type {any} */ t) => t.name === name)?.annotations?.readOnlyHint;
expect('board polling and views are read-only', ['crew_state', 'changed_files', 'memory_list', 'agents_list', 'doctor', 'transcript', 'diff', 'risk', 'costs'].every(ro), true);
expect('actions are not read-only', ['approve', 'approve_post', 'config_set', 'prompt_save', 'open_in', 'open_session', 'open_file', 'open_logs'].some(ro), false);
expect('approve offers the rules ship choices', list.result.tools.find((/** @type {any} */ t) => t.name === 'approve').inputSchema.properties.choice.enum, ['Open PR', 'Draft PR', 'Push only', 'Not yet']);

expect('the org view is read-only', ro('org'), true);
const orgView = (await call('org')).structuredContent;
expect('org: departments and the resolved org', [orgView.departments.some((/** @type {any} */ d) => d.id === 'engineering'), Array.isArray(orgView.org.roles), typeof orgView.org.seats], [true, true, 'number']);
const ping = (await call('ping')).structuredContent;
expect('ping', [ping.ok, ping.version, ping.schema, ping.home], [true, '1.0.0', 2, home]);

/* ---------- a bad request can't stop the server ---------- */

expect('unparseable line: parse error', (await rawAnonymous('{not json')).error.code, -32700);
expect('a batch is an invalid request', (await rawAnonymous('[1,2]')).error.code, -32600);
expect('unknown method', (await rawWithId('x1', '{"jsonrpc":"2.0","id":"x1","method":"resources/nope"}')).error.code, -32601);
const unknownTool = await rpc('tools/call', { name: 'nope', arguments: {} });
expect('unknown tool is a JSON-RPC error', [unknownTool.error?.code, unknownTool.error?.message], [-32602, 'Unknown tool: nope']);
expect('a prototype name is not a tool', (await rpc('tools/call', { name: 'constructor' })).error?.code, -32602);
expect('arguments must be an object', text(await call('transcript', 'BRIN-1')), 'transcript: The arguments must be an object.');
expect('argument types are checked', (await call('transcript', { key: 42 })).isError, true);
expect('required arguments are checked', text(await call('diff', {})), 'diff: Missing "key".');
expect('still answers after bad requests', (await call('ping')).structuredContent.ok, true);

/* ---------- crew state, events, transcript ---------- */

expect('state: no usage before the Mate session has read it', (await call('crew_state')).structuredContent.usage, null);
const savedUsage = { fiveHour: { utilization: 0.41, resetsAt: 1760659200220 }, sevenDay: { utilization: 0.34, resetsAt: 1761173999685 }, updatedAt: 1760650000000 };
writeFileSync(join(home, 'usage.json'), JSON.stringify({ ...savedUsage, extra: 'ignored' }));
expect('state: the usage the Mate session saved', (await call('crew_state')).structuredContent.usage, savedUsage);
writeFileSync(join(home, 'usage.json'), '{broken');
expect('state: a damaged usage file is no usage', (await call('crew_state')).structuredContent.usage, null);
expect('state: no panel check-in before the Mate panel wrote one', (await call('crew_state')).structuredContent.panel, null);
writeFileSync(join(home, 'summary.json'), JSON.stringify({ at: 1760650000000, tickets: { X: {} }, compact: [] }));
expect("state: only when the Mate panel last read the board", (await call('crew_state')).structuredContent.panel, { at: 1760650000000 });
{
  const before = (await call('crew_state')).structuredContent;
  expect('state: no compactions, scan or health before the panels wrote them', [before.compacted, before.scan, before.health], [[], null, null]);
  mkdirSync(join(home, 'compacted'), { recursive: true });
  writeFileSync(join(home, 'compacted', 'c1.json'), JSON.stringify({ key: 'BRIN-1', at: 1760650000000 }));
  writeFileSync(join(home, 'compacted', 'c2.json'), JSON.stringify({ key: 'BRIN-2', at: 1760650060000, error: 'refused' }));
  writeFileSync(join(home, 'compacted', 'c3.json'), '{broken');
  const scan = { at: 1760650000000, ok: true, new: [{ key: 'BRIN-7', title: 'New one', status: 'To Do', updated: '2026-10-19T09:00:00.000+0000' }], changed: [], updated: [] };
  const health = { at: 1760650000000, issues: [{ id: 'disk:near', severity: 'soon', text: '8.0 GB free on disk, under 10 GB' }], ok: ['doctor'] };
  writeFileSync(join(home, 'scan.json'), JSON.stringify(scan));
  writeFileSync(join(home, 'health.json'), JSON.stringify(health));
  const after = (await call('crew_state')).structuredContent;
  expect(
    'state: the compactions sessions ran, skipping a damaged file',
    [...after.compacted].sort((/** @type {any} */ a, /** @type {any} */ b) => a.id.localeCompare(b.id)),
    [{ id: 'c1', key: 'BRIN-1', at: 1760650000000 }, { id: 'c2', key: 'BRIN-2', at: 1760650060000, error: 'refused' }],
  );
  expect("state: the Mate panel's last scan and health check", [after.scan, after.health], [scan, health]);
  writeFileSync(join(home, 'scan.json'), '{broken');
  writeFileSync(join(home, 'health.json'), JSON.stringify(['not', 'an', 'object']));
  rmSync(join(home, 'compacted'), { recursive: true, force: true });
  const damaged = (await call('crew_state')).structuredContent;
  expect('state: damaged scan and health files are null, and no compacted folder is none', [damaged.compacted, damaged.scan, damaged.health], [[], null, null]);
}
const members = (await call('crew_state')).structuredContent.members;
const eng = members.find((/** @type {any} */ m) => m.role === 'engineer');
const qa = members.find((/** @type {any} */ m) => m.role === 'agent');
expect('state: key', eng.key, 'BRIN-1');
expect('state: activity', eng.activity, 'typing');
expect('state: repo', eng.repo, 'demo');
expect('state: engineer agent', eng.agent, 'engineer');
expect('state: agent session', [qa.agent, qa.key, qa.sessionId], ['qa', 'BRIN-1', 's2']);
expect('state: aliveAt', eng.aliveAt, 1700000000000);
expect('state: pause', eng.paused, false);
{
  // Policy never holds the Mate to a pause, so none shows for it, even one its session took in an earlier role.
  const leadDir = join(home, 'lead-paused');
  const before = readFileSync(join(home, 'crew.json'), 'utf8');
  const reg = JSON.parse(before);
  reg.dirs[leadDir] = { role: 'lead', key: null, at: 0 };
  writeFileSync(join(home, 'crew.json'), JSON.stringify(reg));
  writeFileSync(join(home, 'state', `${hash16(leadDir)}.json`), JSON.stringify({ sessionId: 'lead-p' }));
  mkdirSync(join(home, 'denials'), { recursive: true });
  for (const s of ['s1', 'lead-p']) writeFileSync(join(home, 'denials', `${s}.json`), JSON.stringify({ consecutive: 0, total: 3, reasons: [], paused: true }));
  const now = (await call('crew_state')).structuredContent.members;
  expect('state: a paused engineer shows paused, the Mate never does', [now.find((/** @type {any} */ m) => m.role === 'engineer').paused, now.find((/** @type {any} */ m) => m.role === 'lead')?.paused], [true, false]);
  writeFileSync(join(home, 'crew.json'), before);
  rmSync(join(home, 'state', `${hash16(leadDir)}.json`));
  for (const s of ['s1', 'lead-p']) rmSync(join(home, 'denials', `${s}.json`));
}
expect('state: context from the latest step', eng.contextTokens, 10 + 20 + 200000);
// m1 counted once (1000 in, 500 out) + m2 (10 in, 20 out, 200k cache reads) at Opus 5.5 rates.
expect('state: estimated cost', eng.costUsd, Math.round(((1000 * 4 + 500 * 20) + (10 * 4 + 20 * 20 + 200000 * 0.2)) / 1e6 * 100) / 100);

const ev = (await call('session_events', { key: 'BRIN-1' })).structuredContent.events;
expect('events: newest last', ev.map((/** @type {any} */ e) => e.ts), [1, 2, 3]);
expect('events: limit and before', (await call('session_events', { key: 'BRIN-1', before: 3, limit: 1 })).structuredContent.events.map((/** @type {any} */ e) => e.ts), [2]);

const tx = (await call('transcript', { key: 'BRIN-1' })).structuredContent;
expect('transcript: steps', tx.total, 5);
expect('transcript: tool result paired name', tx.entries.find((/** @type {any} */ e) => e.kind === 'result')?.tool, 'Bash');
expect('transcript: a page from an offset', (await call('transcript', { key: 'BRIN-1', offset: 1, limit: 2 })).structuredContent.entries.map((/** @type {any} */ e) => e.i), [1, 2]);
const lastTwo = (await call('transcript', { key: 'BRIN-1', offset: null, limit: 2 })).structuredContent.entries;
expect('transcript: the tail', lastTwo.map((/** @type {any} */ e) => [e.i, e.kind]), [[3, 'tool'], [4, 'result']]);
appendFileSync(transcript, `${JSON.stringify({ type: 'system', subtype: 'compact_boundary' })}\n{"type":"user","message":{"role":"user","content":"hal`);
const grown = (await call('transcript', { key: 'BRIN-1', limit: 1 })).structuredContent;
expect('transcript: new lines counted, a half-written one waits', [grown.total, grown.entries[0]?.kind], [6, 'notice']);
appendFileSync(transcript, 'f done"}}\n');
const done = (await call('transcript', { key: 'BRIN-1', limit: 1 })).structuredContent;
expect('transcript: the finished line joins', [done.total, done.entries[0]?.i, done.entries[0]?.text], [7, 6, 'half done']);
expect('transcript: an agent session by id', (await call('transcript', { key: 'BRIN-1', agent: 'qa' })).structuredContent.total, 0);
expect('unknown ticket is an error', (await call('transcript', { key: 'NOPE-1' })).isError, true);

/* ---------- git: diff, its fetch cache, changed files ---------- */

const d1 = (await call('diff', { key: 'BRIN-1' })).structuredContent;
expect('diff: base and branch', [d1.base, d1.branch], ['main', 'brin-1']);
expect('diff: committed and uncommitted changes', [d1.diff.includes('b/b.py'), d1.diff.includes('+print(3)')], [true, true]);
expect('diff: not pushed, no compare link', d1.branchUrl, null);
await call('diff', { key: 'BRIN-1' });
const fetches = existsSync(fetchCount) ? readFileSync(fetchCount, 'utf8').split('\n').filter(Boolean).length : 0;
expect('diff: fetches once per repo per five minutes', fetches, 1);
expect('branch_url before a push', (await call('branch_url', { key: 'BRIN-1' })).structuredContent.branchUrl, null);
expect('changed files', (await call('changed_files')).structuredContent.files['BRIN-1']?.sort(), ['a.py', 'b.py']);

/* ---------- approvals ---------- */

const grantPath = join(home, 'grants', `${hash16(wt)}.json`);
const ap = (await call('approve', { key: 'BRIN-1', choice: 'Draft PR' })).structuredContent;
expect('approve returns the grant with HEAD', [ap.grant?.choice, ap.grant?.head, ap.head], ['Draft PR', head, head]);
const onDisk = JSON.parse(readFileSync(grantPath, 'utf8'));
expect('approve: the grant file', [onDisk.key, onDisk.dir, onDisk.choice, onDisk.via, onDisk.head], ['BRIN-1', wt, 'Draft PR', 'board', head]);
expect('approve: a low-risk change records its tier, with the 14-day cap', [onDisk.risk, onDisk.expires - onDisk.at, ap.risk?.tier], ['low', 14 * 24 * 60 * 60_000, 'low']);
expect('approve: core reads it back', readGrant(wt, 'BRIN-1')?.head, head);
const cleared = (await call('approve', { key: 'BRIN-1', choice: 'Not yet' })).structuredContent;
expect('approve: Not yet clears', [cleared.grant, existsSync(grantPath)], [null, false]);
expect('approve: bad choice is an error', (await call('approve', { key: 'BRIN-1', choice: 'Merge' })).isError, true);
expect('approve: unknown ticket is an error', (await call('approve', { key: 'NOPE-1', choice: 'Push only' })).isError, true);
// The board passes the card's commit: the approval pins what the captain reviewed, which must be HEAD or before it.
const baseSha = git(wt, 'rev-parse', 'main');
const pinned = (await call('approve', { key: 'BRIN-1', choice: 'Push only', head: baseSha })).structuredContent;
expect("approve: pins the card's commit, an ancestor of HEAD", [pinned.head, JSON.parse(readFileSync(grantPath, 'utf8')).head], [baseSha, baseSha]);
expect('approve: a commit outside the history is an error', (await call('approve', { key: 'BRIN-1', choice: 'Push only', head: 'f'.repeat(40) })).isError, true);
expect('approve: a head that is not a sha is an error', (await call('approve', { key: 'BRIN-1', choice: 'Push only', head: 'HEAD~1' })).isError, true);
await call('approve', { key: 'BRIN-1', choice: 'Not yet' });

/* ---------- keelctl grant: a phone answer carried out on the Mac, through the same code ---------- */

/** @param {string[]} args */
const grantCli = (...args) => spawnSync(process.execPath, [join(pluginRoot, 'cli', 'keelctl.mjs'), 'grant', ...args], { env: { ...process.env, KEELCREW_HOME: home }, encoding: 'utf8' });
const viaHelper = (await call('approve', { key: 'BRIN-1', choice: 'Push only', head: baseSha })).structuredContent.grant;
await call('approve', { key: 'BRIN-1', choice: 'Not yet' });
const phone = grantCli('ship', 'BRIN-1', '--choice', 'Push only', '--head', baseSha, '--answered-at', String(Date.now() - 60_000), '--json');
const phoneOut = phone.status === 0 ? JSON.parse(phone.stdout) : {};
const phoneGrant = existsSync(grantPath) ? JSON.parse(readFileSync(grantPath, 'utf8')) : {};
/** @param {Record<string, any>} g */
const shape = (g) => [g.key, g.dir, g.choice, g.via, g.head, g.risk, g.expires - g.at];
expect('keelctl grant ship: the same approval the helper writes', [phone.status, ...shape(phoneGrant)], [0, ...shape(viaHelper)]);
expect('keelctl grant ship: says what it did', [phoneOut.ok, phoneOut.choice, phoneOut.head, phoneOut.risk, phoneOut.expires], [true, 'Push only', baseSha, viaHelper.risk, phoneGrant.expires]);
expect('keelctl grant ship: Not yet clears', [grantCli('ship', 'BRIN-1', '--choice', 'Not yet', '--json').status, existsSync(grantPath)], [0, false]);
const outside = grantCli('ship', 'BRIN-1', '--choice', 'Open PR', '--head', 'f'.repeat(40), '--json');
expect("keelctl grant ship: a head outside the worktree's history approves nothing", [outside.status, /isn't in .*history/.test(outside.stderr), existsSync(grantPath)], [1, true, false]);
const stale = grantCli('ship', 'BRIN-1', '--choice', 'Open PR', '--answered-at', String(Date.now() - 25 * 3_600_000));
expect('keelctl grant ship: an answer over 24 hours old does nothing', [stale.status, /over 24 hours old/.test(stale.stderr), existsSync(grantPath)], [1, true, false]);
expect('keelctl grant: needs ship or post, a key and a choice', [grantCli('merge', 'BRIN-1').status, grantCli('ship', 'BRIN-1').status, grantCli('ship', 'NOPE-1', '--choice', 'Push only').status], [1, 1, 1]);
const phonePost = grantCli('post', 'brin-1', '--tool', 'mcp__x__teams_send_message', '--match', 'Sprint notes', '--json');
const postOut = phonePost.status === 0 ? JSON.parse(phonePost.stdout) : {};
const postFile = postOut.id ? JSON.parse(readFileSync(join(home, 'posts', `${postOut.id}.json`), 'utf8')) : {};
expect('keelctl grant post: the one-shot post approval approve_post writes', [phonePost.status, postFile.key, postFile.tool, postFile.match, postFile.uses, postFile.via, postFile.expires - postFile.at], [0, 'BRIN-1', 'mcp__x__teams_send_message', 'Sprint notes', 1, 'board', 30 * 60_000]);
expect('keelctl grant post: used up once by the policy', [consumePostGrant('mcp__x__teams_send_message', { text: 'Sprint notes for the week' }, { key: 'BRIN-1' })?.id, consumePostGrant('mcp__x__teams_send_message', { text: 'Sprint notes' })], [postOut.id, null]);

/* ---------- risk, one-shot posts, costs ---------- */

const low = (await call('risk', { key: 'BRIN-1' })).structuredContent;
expect('risk: the committed diff against origin', [low.key, low.tier, low.files, low.added, low.deleted, low.base, low.reasons], ['BRIN-1', 'low', 1, 1, 0, 'origin/main', []]);
mkdirSync(join(wt, 'app', 'migrations'), { recursive: true });
writeFileSync(join(wt, 'app', 'migrations', '0002_add_x.py'), 'ops = []\n');
git(wt, 'add', 'app/migrations/0002_add_x.py');
git(wt, 'commit', '-q', '-m', 'migration');
const high = (await call('risk', { key: 'BRIN-1' })).structuredContent;
expect('risk: a migration (from the brinewick pack) is high', [high.tier, high.files, high.reasons.some((/** @type {string} */ r) => r.startsWith('database migrations: app/migrations/0002_add_x.py'))], ['high', 2, true]);
const hiGrant = (await call('approve', { key: 'BRIN-1', choice: 'Push only' })).structuredContent.grant;
expect('approve: a high-risk change records its tier, with the 14-day cap', [hiGrant.risk, hiGrant.expires - hiGrant.at], ['high', 14 * 24 * 60 * 60_000]);
await call('approve', { key: 'BRIN-1', choice: 'Not yet' });
expect('risk: unknown ticket is an error', (await call('risk', { key: 'NOPE-1' })).isError, true);
{
  // A repo not in config.json, no origin/HEAD: the board finds the base the policy does (brinewick-api ships from develop in
  // the pack), and when the policy can't tell, the board's risk is high like the policy's, not a diff against main.
  const { assessRisk, baseBranchOf } = await import(pathToFileURL(join(pluginRoot, 'core', 'risk.mjs')).href);
  const api = join(home, 'elsewhere', 'brinewick-api');
  const lonely = join(home, 'elsewhere', 'lonely');
  for (const [dir, branches] of /** @type {[string, string[]][]} */ ([[api, ['main', 'develop']], [lonely, ['main']]])) {
    mkdirSync(dir, { recursive: true });
    git(home, 'init', '-q', '--bare', `${dir}-origin.git`);
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a.py'), 'x\n');
    git(dir, 'add', 'a.py');
    git(dir, 'commit', '-q', '-m', 'base');
    git(dir, 'remote', 'add', 'origin', `${dir}-origin.git`);
    for (const b of branches) git(dir, 'push', '-q', 'origin', `HEAD:${b}`);
    git(dir, 'checkout', '-q', '-b', 'work');
  }
  const before = readFileSync(join(home, 'crew.json'), 'utf8');
  const reg = JSON.parse(before);
  reg.dirs[api] = { role: 'engineer', key: 'BRIN-2', at: 0 };
  reg.dirs[lonely] = { role: 'engineer', key: 'BRIN-3', at: 0 };
  writeFileSync(join(home, 'crew.json'), JSON.stringify(reg));
  const apiDiff = (await call('diff', { key: 'BRIN-2' })).structuredContent;
  const apiRisk = (await call('risk', { key: 'BRIN-2' })).structuredContent;
  expect('base: an unconfigured pack repo, as the policy finds it', [apiDiff.base, apiRisk.base, baseBranchOf(api, 'brinewick')], ['develop', 'origin/develop', 'develop']);
  const lonelyRisk = (await call('risk', { key: 'BRIN-3' })).structuredContent;
  expect("base: when the policy can't tell, the board's risk is high too", [lonelyRisk.tier, lonelyRisk.base, (await call('diff', { key: 'BRIN-3' })).structuredContent.base], [assessRisk(lonely, null, { packName: 'brinewick' }).tier, null, 'main']);
  writeFileSync(join(home, 'crew.json'), before);
}

const post = (await call('approve_post', { key: 'brin-1', tool: 'mcp__x__teams_send_message', match: 'Release notes  for 1.2' })).structuredContent.post;
expect('approve_post: one use for the ticket, from the board', [post.key, post.tool, post.match, post.uses, post.via, post.expires - post.at], ['BRIN-1', 'mcp__x__teams_send_message', 'Release notes for 1.2', 1, 'board', 30 * 60_000]);
expect('approve_post: the file core reads', JSON.parse(readFileSync(join(home, 'posts', `${post.id}.json`), 'utf8')).id, post.id);
expect('approve_post: core uses it up once', [consumePostGrant('mcp__x__teams_send_message', { body: { content: 'Release notes for 1.2: ...' } }, { key: 'BRIN-1' })?.id, consumePostGrant('mcp__x__teams_send_message', { body: 'Release notes for 1.2' })], [post.id, null]);
expect('approve_post: a bad tool pattern is an error', (await call('approve_post', { key: 'X-1', tool: '/(/' })).isError, true);
expect('approve_post: needs a tool', text(await call('approve_post', { key: 'X-1' })), 'approve_post: Missing "tool".');

const spend = (await call('costs')).structuredContent;
const engSpend = spend.members.find((/** @type {any} */ m) => m.role === 'engineer');
expect('costs: per member, since it joined', [engSpend.key, engSpend.agent, engSpend.costUsd, engSpend.tokens, engSpend.since], ['BRIN-1', 'engineer', eng.costUsd, 1000 + 500 + 10 + 20 + 200000, 0]);
expect('costs: per ticket, with each role', [spend.tickets['BRIN-1'].costUsd, spend.tickets['BRIN-1'].byRole, spend.tickets['BRIN-1'].tokens], [eng.costUsd, { engineer: eng.costUsd, qa: 0 }, 201530]);
expect('costs: per role and in total', [spend.roles.engineer.costUsd, spend.roles.qa.costUsd, spend.totalUsd], [eng.costUsd, 0, eng.costUsd]);
// A folder's cost counts its subagents' transcripts and earlier sessions too (core/costs.mjs, shared with keelctl costs).
mkdirSync(join(home, 't', 'subagents'), { recursive: true });
writeFileSync(join(home, 't', 'subagents', 'agent-1.jsonl'), `${usage('s1', 100000, 0, 0)}\n${usage('s2', 1, 0, 0)}\n`);
writeFileSync(join(home, 'earlier.jsonl'), `${usage('e1', 0, 100000, 0)}\n${usage('e2', 1, 0, 0)}\n`);
const st = JSON.parse(readFileSync(join(home, 'state', `${hash16(wt)}.json`), 'utf8'));
writeFileSync(join(home, 'state', `${hash16(wt)}.json`), JSON.stringify({ ...st, transcripts: [join(home, 'earlier.jsonl'), transcript] }));
const more = (await call('costs')).structuredContent.members.find((/** @type {any} */ m) => m.role === 'engineer');
expect('costs: subagents and earlier sessions count', [more.transcripts, Math.round((more.costUsd - eng.costUsd) * 100) / 100], [3, Math.round((0.4 + 2) * 100) / 100]);

/* ---------- memory, agents, doctor ---------- */

/** @param {string} file */
const hasCore = (file) => existsSync(join(pluginRoot, 'core', file));
const mem = await call('memory_list', {});
if (hasCore('memory.mjs')) {
  expect('memory_list: lessons and standing orders', [mem.isError ?? false, Array.isArray(mem.structuredContent?.lessons), typeof mem.structuredContent?.playbook], [false, true, 'string']);
  const scoped = await call('memory_list', { repo: 'brinewick-api', agent: 'qa' });
  expect('memory_list: scoped by repo and agent', scoped.isError ?? false, false);
} else {
  expect('memory_list without core/memory.mjs: a clear error', [mem.isError, text(mem).includes('core/memory.mjs')], [true, true]);
  notes.push('SKIP memory_list contents: core/memory.mjs is not there yet (checked its clear error instead).');
}
const ag = await call('agents_list');
if (hasCore('agents.mjs')) {
  const agents = ag.structuredContent?.agents;
  expect('agents_list: manifests with the pack additions', [ag.isError ?? false, Array.isArray(agents), (agents ?? []).every((/** @type {any} */ a) => Array.isArray(a.teamSkills))], [false, true, true]);
  const qaAgent = (agents ?? []).find((/** @type {any} */ a) => a.id === 'qa');
  if (qaAgent) expect('agents_list: the brinewick pack adds QA skills', qaAgent.teamSkills.includes('smoke-test'), true);
  else notes.push('SKIP agents_list pack merge: no qa manifest in agents/ yet.');
} else {
  expect('agents_list without core/agents.mjs: a clear error', [ag.isError, text(ag).includes('core/agents.mjs')], [true, true]);
  notes.push('SKIP agents_list contents: core/agents.mjs is not there yet (checked its clear error instead).');
}
const checks = (await call('doctor')).structuredContent.checks;
expect('doctor: every check has a status', checks.every((/** @type {any} */ c) => ['ok', 'warn', 'fail'].includes(c.status)), true);
expect('doctor: the board link is checked', checks.some((/** @type {any} */ c) => c.id === 'board' && c.status === 'fail'), true);
if (!hasCore('doctor.mjs')) {
  expect('doctor without core/doctor.mjs: says so', checks.some((/** @type {any} */ c) => c.id === 'core-doctor' && c.status === 'fail' && c.detail.includes('core/doctor.mjs')), true);
  notes.push('SKIP doctor core checks: core/doctor.mjs is not there yet (checked the failing check instead).');
}

/* ---------- prompts, settings, logs ---------- */

const pr = (await call('prompts')).structuredContent.prompts;
expect('prompts: the plugin skills', pr.some((/** @type {any} */ p) => p.file === 'keel-lead.md' && p.text.length > 0), true);
const saved = (await call('prompt_save', { file: 'lead.md', text: 'Repos live in ~/code' })).structuredContent.prompts;
expect('prompt_save: the Mate notes', [readFileSync(join(home, 'lead.md'), 'utf8'), saved.some((/** @type {any} */ p) => p.file === 'lead.md')], ['Repos live in ~/code\n', true]);
expect('prompt_save: unknown file is an error', (await call('prompt_save', { file: '../../x.md', text: 'x' })).isError, true);
expect('prompt_save: empty text is an error', (await call('prompt_save', { file: 'lead.md', text: '  ' })).isError, true);

const set = (await call('config_set', { patch: { ide: { editor: 'zed' }, board: 'https://elsewhere', bogus: 1 } })).structuredContent.config;
expect('config_set: allowed keys only', [set.ide?.editor, set.board, set.bogus, set.schemaVersion, set.owner], ['zed', undefined, undefined, 2, 'Sam']);
expect('config_get', (await call('config_get')).structuredContent.config.ide, { editor: 'zed' });
expect('config_get: the rules default compact window', (await call('config_get')).structuredContent.config.compactWindow, 600000);
expect('config_set: compact window', (await call('config_set', { patch: { compactWindow: 400000 } })).structuredContent.config.compactWindow, 400000);
expect('config_set: a compact window out of range is an error', (await call('config_set', { patch: { compactWindow: 5 } })).isError, true);
expect('config_get: keeps the chosen compact window', (await call('config_get')).structuredContent.config.compactWindow, 400000);
{
  // A settings file Keelcrew can't write leaves config.json unchanged too.
  const leadDir = join(home, 'lead-cfg');
  mkdirSync(join(leadDir, '.claude'), { recursive: true });
  writeFileSync(join(leadDir, '.claude', 'settings.local.json'), '[1, 2]');
  const cfgPath = join(home, 'config.json');
  const before = JSON.parse(readFileSync(cfgPath, 'utf8'));
  writeFileSync(cfgPath, JSON.stringify({ ...before, leadDir }));
  expect('config_set: a settings file that is not an object is an error', (await call('config_set', { patch: { compactWindow: 300000 } })).isError, true);
  expect('config_set: and config.json keeps the old window', JSON.parse(readFileSync(cfgPath, 'utf8')).compactWindow, 400000);
  expect('config_set: and the file is untouched', readFileSync(join(leadDir, '.claude', 'settings.local.json'), 'utf8'), '[1, 2]');
  writeFileSync(cfgPath, JSON.stringify(before));
}

const logList = (await call('logs')).structuredContent.logs;
expect('logs: the helper log', logList.find((/** @type {any} */ l) => l.file === 'helper.log')?.label, 'Crew helper');
expect('log_tail: helper log lines', (await call('log_tail', { file: 'helper.log', lines: 5 })).structuredContent.lines.length > 0, true);
expect('log name guard', (await call('log_tail', { file: '../../etc/passwd' })).isError, true);

/* ---------- opening a file the crew linked ---------- */

if (fakeOpenWins) {
  /** Calls open_file and returns whether it failed, what it showed and what `open` got. @param {Record<string, unknown>} args */
  const openFile = async (args) => {
    writeFileSync(opened, '');
    const r = await call('open_file', args);
    return [!!r.isError, r.structuredContent?.shown ?? null, readFileSync(opened, 'utf8').trim()];
  };
  const csv = join(home, 'shared report.csv');
  writeFileSync(csv, 'a,b\n');
  const script = join(home, 'run.command');
  writeFileSync(script, 'echo hi\n');
  symlinkSync('/etc/hosts', join(home, 'hosts.txt'));
  symlinkSync(script, join(home, 'notes.txt'));
  mkdirSync(join(home, 'x.pdf'));
  const odd = join(home, 'a#b, (1).csv');
  writeFileSync(odd, 'a\n');
  expect('open_file: a document opens in its app', await openFile({ path: `file://${encodeURI(csv)}` }), [false, 'opened', realpathSync(csv)]);
  expect('open_file: or shows in Finder', await openFile({ path: csv, reveal: true }), [false, 'revealed', `-R\n${realpathSync(csv)}`]);
  expect('open_file: a script is only shown', await openFile({ path: script }), [false, 'revealed', `-R\n${realpathSync(script)}`]);
  expect('open_file: a folder is only shown', await openFile({ path: home }), [false, 'revealed', `-R\n${realpathSync(home)}`]);
  expect('open_file: nothing outside home or temp', await openFile({ path: '/etc/hosts' }), [true, null, '']);
  expect('open_file: nor through a link', await openFile({ path: join(home, 'hosts.txt') }), [true, null, '']);
  expect('open_file: a file URL with # , and ( )', await openFile({ path: pathToFileURL(odd).href }), [false, 'opened', realpathSync(odd)]);
  expect('open_file: a link to a script is only shown', await openFile({ path: join(home, 'notes.txt') }), [false, 'revealed', `-R\n${realpathSync(script)}`]);
  expect('open_file: a folder named like a document is only shown', await openFile({ path: join(home, 'x.pdf') }), [false, 'revealed', `-R\n${realpathSync(join(home, 'x.pdf'))}`]);
  expect('open_file: ~ is the home folder', await openFile({ path: '~' }), [false, 'revealed', `-R\n${realpathSync(homedir())}`]);
  expect('open_file: a missing file', await openFile({ path: join(home, 'nope.csv') }), [true, null, '']);
  expect('open_file: a relative path', await openFile({ path: 'shared report.csv' }), [true, null, '']);
}

/* ---------- opening a session in the Claude app ---------- */

if (fakeOpenWins) {
  // The Mate opens by the app's own id for its session (its hostId in crew.json sessions); without one, by session id.
  const leadDir = join(home, 'lead');
  const reg = JSON.parse(readFileSync(join(home, 'crew.json'), 'utf8'));
  reg.dirs[leadDir] = { role: 'lead', key: null, at: 0 };
  reg.sessions['lead-s1'] = { role: 'lead', key: null, dir: leadDir, hostId: 'local_lead-host-1', at: 0 };
  writeFileSync(join(home, 'crew.json'), JSON.stringify(reg));
  /** Calls open_session and returns whether it failed and what it opened. @param {Record<string, unknown>} args */
  const openSession = async (args) => {
    writeFileSync(opened, '');
    const r = await call('open_session', args);
    return [!!r.isError, readFileSync(opened, 'utf8').trim()];
  };
  expect('open_session: the Mate opens by its app session id', await openSession({ key: 'lead', app: 'desktop' }), [false, 'claude://claude.ai/epitaxy/local_lead-host-1']);
  expect('open_session: no app session id resumes by session id', await openSession({ key: 'BRIN-1', app: 'desktop' }), [false, 'claude://resume?session=s1']);
  // A job registered in the Mate folder later is never opened for the Mate, even when the Mate has no app id.
  reg.sessions['job-s2'] = { role: 'job', key: null, dir: leadDir, hostId: 'local_job-host', at: 5 };
  writeFileSync(join(home, 'crew.json'), JSON.stringify(reg));
  expect('open_session: a job in the Mate folder is not the Mate', await openSession({ key: 'lead', app: 'desktop' }), [false, 'claude://claude.ai/epitaxy/local_lead-host-1']);
  reg.sessions['lead-s1'].hostId = null;
  writeFileSync(join(home, 'crew.json'), JSON.stringify(reg));
  expect("open_session: without the Mate's app id, it resumes the Mate, not the job", await openSession({ key: 'lead', app: 'desktop' }), [false, 'claude://resume?session=lead-s1']);
  // A re-staffed task opens its newest session, never an older one's window.
  const [engDir] = Object.entries(reg.dirs).find(([, d]) => d.role === 'engineer' && d.key === 'BRIN-1') ?? [];
  if (engDir) {
    reg.sessions['eng-old'] = { role: 'engineer', key: 'BRIN-1', dir: engDir, hostId: 'local_eng-old', at: 1 };
    reg.sessions['eng-new'] = { role: 'engineer', key: 'BRIN-1', dir: engDir, hostId: null, at: 9 };
    writeFileSync(join(home, 'crew.json'), JSON.stringify(reg));
    expect('open_session: a re-staffed task resumes its newest session', await openSession({ key: 'BRIN-1', app: 'desktop' }), [false, 'claude://resume?session=eng-new']);
  } else notes.push('SKIP re-staffed open_session: no BRIN-1 engineer folder in this test crew.');
} else notes.push('SKIP open_session links: an `open` in /opt/homebrew/bin or /usr/local/bin would run instead of the fake one.');

await stop();

if (home.startsWith(tmpdir())) rmSync(home, { recursive: true, force: true });
for (const note of notes) console.log(note);
console.log(`${n - bad}/${n} helper checks pass`);
process.exit(bad ? 1 : 0);
