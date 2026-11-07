// Tests the shared core (rules, agents, memory, doctor), the policy's fail-closed and HEAD-bound behavior, agent members,
// and the crew command, each against throwaway crew homes. node plugins/keelcrew/tests/core.test.mjs
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Built from pieces so no shell guard mistakes this file's text for the command itself.
const PR_CREATE = ['gh', 'pr', 'create'].join(' ');
const tmp = (name) => mkdtempSync(join(tmpdir(), `keelcrew-${name}-`));

// Core modules read KEELCREW_HOME when first imported, so set it before importing them.
const home = tmp('core');
process.env.KEELCREW_HOME = home;
// The user's own Claude settings, so doctor never reads the real ones.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'keelcrew-claudecfg-'));
// The Claude app's config, so doctor and `keelctl helper install` never touch the real one.
process.env.KEELCREW_DESKTOP_CONFIG = join(tmp('desktop'), 'claude_desktop_config.json');
writeFileSync(process.env.KEELCREW_DESKTOP_CONFIG, JSON.stringify({ mcpServers: { 'keelcrew-local': { command: 'node', args: [join(root, 'helper', 'server.mjs')] } } }));
const { loadRules, pushesProtected, connectorKind } = await import('../core/rules.mjs');
const { scanAgents, listAgents, agentById } = await import('../core/agents.mjs');
const memory = await import('../core/memory.mjs');
const { runDoctor } = await import('../core/doctor.mjs');
const { hash16 } = await import('../core/paths.mjs');

let bad = 0;
let n = 0;
const expect = (label, got, want) => {
  n++;
  if (got !== want) {
    bad++;
    console.log(`FAIL ${label}: ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => expect(label, !!cond, true);
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

/* ---------- rules and packs ---------- */
{
  const base = loadRules(undefined);
  const brinewick = loadRules('brinewick');
  expect('rules: base protects main and master only', base.policy.protectedBranches.join(','), 'main,master');
  ok('rules: the brinewick pack adds develop', brinewick.policy.protectedBranches.includes('develop'));
  ok('rules: pack deny rules are added', brinewick.policy.denyBash.some((r) => /migrations/.test(r.why)));
  ok('rules: base deny rules stay with a pack', brinewick.policy.denyBash.some((r) => /force-push/.test(r.why)));
  ok('rules: pack read-only servers', brinewick.policy.readOnlyServers.some((re) => re.test('mcp__brinewick-db-prod__query')));
  expect('rules: ship cap from rules.json (14 days)', brinewick.ship.grantTtlMs, 14 * 24 * 60 * 60_000);
  expect('rules: ship choices from rules.json', brinewick.ship.choices.join('|'), 'Open PR|Draft PR|Push only|Not yet');
  expect('rules: jira connector kind', connectorKind('mcp__1a2b__transitionJiraIssue', brinewick), 'jira');
  expect('rules: other connectors are external', connectorKind('mcp__0a1__outlook_send_mail', brinewick), 'external');

  mkdirSync(join(home, 'packs', 'mine'), { recursive: true });
  writeFileSync(
    join(home, 'packs', 'mine', 'pack.json'),
    JSON.stringify({ name: 'mine', policy: { protectedBranches: ['develop'], denyBash: [{ pattern: '\\bnpm\\s+publish\\b', why: 'publishing is for people' }], readTools: ['peekThing'] } }),
  );
  mkdirSync(join(home, 'packs', 'lax'), { recursive: true });
  writeFileSync(join(home, 'packs', 'lax', 'pack.json'), JSON.stringify({ name: 'lax', policy: { protectedBranches: [], denyBash: [] } }));
  const mine = loadRules('mine');
  ok("rules: a user's own pack adds branches", mine.policy.protectedBranches.includes('develop') && mine.policy.protectedBranches.includes('main'));
  ok("rules: a user's own pack adds deny rules", mine.policy.denyBash.some((r) => r.re.test('npm publish')));
  ok("rules: a user's own pack adds read tools", mine.policy.readTools.has('peekThing') && mine.policy.readTools.has('executeRead'));
  const lax = loadRules('lax');
  ok('rules: a pack cannot remove base rules', lax.policy.protectedBranches.includes('main') && lax.policy.denyBash.some((r) => /force-push/.test(r.why)));
  ok('rules: an unknown pack throws', throws(() => loadRules('no-such-pack')));
  ok('rules: push to a pack branch is protected', pushesProtected('git push origin develop', mine.policy.protectedBranches));
  ok('rules: a branch named after one is not', !pushesProtected('git push origin develop-2', mine.policy.protectedBranches));
  ok('rules: checkout of a pack branch denied', mine.policy.denyBash.some((r) => r.re.test('git checkout develop')));
}

/* ---------- agents ---------- */
{
  const dir = tmp('agents');
  const good = (id, extra = {}) => ({ id, name: `${id} agent`, summary: 'Does a thing.', kind: 'ticket', runAs: 'session', skill: `keel-${id}`, defaultEnabled: true, ...extra });
  writeFileSync(join(dir, 'scout.json'), JSON.stringify(good('scout', { runAs: 'subagent' })));
  writeFileSync(join(dir, 'qa.json'), JSON.stringify(good('qa', { trigger: 'after-deploy', settings: { maxRounds: { type: 'number', default: 2 } } })));
  writeFileSync(join(dir, 'briefs.json'), JSON.stringify(good('briefs', { kind: 'scheduled', runAs: 'schedule', schedule: [{ cron: '30 9 * * 1-5', label: 'morning' }] })));
  writeFileSync(join(dir, 'broken.json'), '{ "id": ');
  writeFileSync(join(dir, 'nosummary.json'), JSON.stringify({ ...good('nosummary'), summary: '' }));
  writeFileSync(join(dir, 'badkind.json'), JSON.stringify(good('badkind', { kind: 'weekly' })));
  writeFileSync(join(dir, 'mismatch.json'), JSON.stringify(good('other')));
  writeFileSync(join(dir, 'notes.txt'), 'not a manifest');
  const { agents, invalid } = scanAgents(dir);
  expect('agents: valid ones, sorted', agents.map((a) => a.id).join(','), 'briefs,qa,scout');
  expect('agents: invalid files reported', invalid.map((i) => i.file).join(','), 'badkind.json,broken.json,mismatch.json,nosummary.json');
  ok('agents: the problem is named', invalid.find((i) => i.file === 'nosummary.json')?.problems.includes('summary is required'));
  expect('agents: listAgents', listAgents(dir).length, 3);
  expect('agents: by id', agentById('qa', dir)?.trigger, 'after-deploy');
  expect('agents: unknown id', agentById('nope', dir), null);
  ok("agents: the plugin's catalog scans", Array.isArray(scanAgents().agents));
}

/* ---------- org fields and departments ---------- */
{
  const { agentProblems } = await import('../core/agents.mjs');
  const { scanDepartments, departmentProblems } = await import('../core/departments.mjs');
  const base = { id: 'x', name: 'x', summary: 'x', skill: 'x', kind: 'ticket', runAs: 'session', defaultEnabled: true };
  const choice = (model, effort) => ({ model, effort });
  expect('org: a manifest without org fields is valid', JSON.stringify(agentProblems(base)), JSON.stringify([]));
  expect('org: all fields valid', JSON.stringify(agentProblems({ ...base, department: 'engineering', reportsTo: 'lead', memberKind: 'engineer', policy: 'code', reads: ['jira'], drafts: ['figma'], outputs: [{ id: 'pr', label: 'Pull request' }], metrics: ['bugs', 'cost'], cards: ['ship', 'question'], budgetShare: 0.5, proposedModel: { byDifficulty: { simple: choice('s', 'xhigh'), moderate: choice('o', 'high'), complex: choice('o', 'xhigh'), critical: choice('o', 'xhigh') } } })), JSON.stringify([]));
  expect('org: unknown member kind', JSON.stringify(agentProblems({ ...base, memberKind: 'intern' })), JSON.stringify(['memberKind must be one of human, engineer, contractor, agent']));
  ok('org: unknown policy profile', agentProblems({ ...base, policy: 'root' })[0]?.startsWith('policy must be one of'));
  ok('org: unknown metric', agentProblems({ ...base, metrics: ['vibes'] })[0]?.startsWith('metrics must come from'));
  ok('org: a new card kind is refused', agentProblems({ ...base, cards: ['hire'] })[0]?.startsWith('cards must come from'));
  expect('org: budget share over 1', JSON.stringify(agentProblems({ ...base, budgetShare: 2 })), JSON.stringify(['budgetShare must be a number from 0 to 1']));
  ok('org: proposed model needs every difficulty', agentProblems({ ...base, proposedModel: { byDifficulty: { simple: choice('s', 'high') } } })[0]?.startsWith('proposedModel'));
  ok('org: proposed model effort is checked', agentProblems({ ...base, proposedModel: choice('s', 'turbo') })[0]?.startsWith('proposedModel'));
  expect('org: plain proposed model', JSON.stringify(agentProblems({ ...base, proposedModel: choice('claude-sonnet-5-5', 'medium') })), JSON.stringify([]));

  const dir = tmp('departments');
  const dept = (id, extra = {}) => ({ id, name: id, summary: 'A department.', head: 'lead', order: 1, colour: '#123abc', budgetShare: 0.2, defaultEnabled: true, switchable: true, ...extra });
  writeFileSync(join(dir, 'eng.json'), JSON.stringify(dept('eng', { order: 2 })));
  writeFileSync(join(dir, 'ceo.json'), JSON.stringify(dept('ceo', { order: 0, defaultEnabled: false })));
  writeFileSync(join(dir, 'bad.json'), JSON.stringify(dept('bad', { colour: 'blue' })));
  const r = scanDepartments(dir);
  expect('departments: valid ones, in order', r.departments.map((d) => d.id).join(','), 'ceo,eng');
  expect('departments: invalid reported', JSON.stringify(r.invalid.map((i) => i.problems).flat()), JSON.stringify(['colour must be #rrggbb']));
  expect('departments: id must match the file', JSON.stringify(departmentProblems(dept('a'), 'b')), JSON.stringify(['id "a" doesn\'t match the file name']));
  ok("departments: the plugin's set scans clean", scanDepartments().invalid.length === 0 && scanDepartments().departments.length >= 5);
}

/* ---------- memory ---------- */
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' }).trim();
{
  const first = memory.addLesson({ type: 'preference', key: 'pr-body', text: 'Keep PR bodies short.', evidence: [{ source: 'chat', ref: 'c1' }], confidence: 0.8 });
  ok('memory: the repo is created on first write', existsSync(join(home, 'memory', '.git')));
  expect('memory: one commit per change', git(join(home, 'memory'), 'rev-list', '--count', 'HEAD'), '1');
  expect('memory: commits are by Keelcrew', git(join(home, 'memory'), 'log', '-1', '--format=%an <%ae>'), 'Keelcrew <keelcrew@localhost>');
  memory.addLesson({ type: 'preference', key: 'pr-body', text: 'Keep PR bodies to an overview.', evidence: [{ source: 'chat', ref: 'c2' }], confidence: 0.8 });
  const v2 = memory.listLessons().find((l) => l.key === 'pr-body');
  expect('memory: newest line wins', v2.text, 'Keep PR bodies to an overview.');
  expect('memory: evidence carries over', v2.seen, 2);
  expect('memory: the new version supersedes the old', v2.supersedes, first.id);
  expect('memory: since is the first sighting', v2.since, first.at);
  expect('memory: one key, one lesson', memory.listLessons().filter((l) => l.key === 'pr-body').length, 1);
  ok('memory: bad type rejected', throws(() => memory.addLesson({ type: 'vibe', key: 'x', text: 'y' })));
  ok('memory: bad confidence rejected', throws(() => memory.addLesson({ type: 'style', key: 'x', text: 'y', confidence: 2 })));
  ok('memory: bad evidence source rejected', throws(() => memory.addLesson({ type: 'style', key: 'x', text: 'y', evidence: [{ source: 'rumor', ref: '' }] })));

  expect('memory: two sightings keep it a candidate (the Mate promotes it)', v2.status, 'candidate');
  memory.promoteLesson('pr-body');
  const owner = [{ source: 'owner', ref: 'o1' }];
  memory.addLesson({ type: 'repo-fact', key: 'api-base', text: 'brinewick-api PRs target develop.', scope: { repo: 'brinewick-api' }, evidence: owner });
  memory.addLesson({ type: 'process', key: 'qa-shots', text: 'QA attaches screenshots.', scope: { agent: 'qa' }, evidence: owner });
  memory.addLesson({ type: 'style', key: 'eng-commits', text: 'Engineers make small commits.', scope: { agent: 'engineer' }, evidence: owner });
  const eng = memory.playbookFor({ role: 'engineer', repo: 'brinewick-api' });
  ok('standing orders: unscoped lessons apply everywhere', eng.includes('Keep PR bodies to an overview.'));
  ok('standing orders: repo lessons apply in their repo', eng.includes('brinewick-api PRs target develop.'));
  ok('standing orders: engineer lessons reach engineers', eng.includes('Engineers make small commits.'));
  ok("standing orders: another agent's lessons don't", !eng.includes('QA attaches screenshots.'));
  ok("standing orders: another repo's lessons don't", !memory.playbookFor({ role: 'engineer', repo: 'other' }).includes('brinewick-api PRs target develop.'));
  const qa = memory.playbookFor({ role: 'agent', agent: 'qa', repo: 'brinewick-api' });
  ok('standing orders: agent lessons reach that agent', qa.includes('QA attaches screenshots.') && !qa.includes('Engineers make small commits.'));
  const lead = memory.playbookFor({ role: 'lead' });
  ok('standing orders: the Mate sees everything', ['overview', 'target develop', 'screenshots', 'small commits'].every((t) => lead.includes(t)));
  ok('standing orders: line format', /- brinewick-api PRs target develop\. \(repo brinewick-api, seen 1×, since \d{4}-\d\d-\d\d\)/.test(lead));
  ok('standing orders: unscoped reads "everywhere"', lead.includes('(everywhere, seen 2×'));
  ok('standing orders: say lessons are never permission', lead.includes('never permission'));
  ok('standing orders: grouped by type', lead.indexOf('## Preferences') < lead.indexOf('## Style') && lead.indexOf('## Process') < lead.indexOf('## Repo facts'));

  memory.addLesson({ type: 'decision', key: 'k7-scope', text: 'Ticket K-7 keeps its old URL.', scope: { repo: 'brinewick-api', task: 'K-7' }, evidence: owner });
  ok("standing orders: a task's lesson reaches that task's session", memory.playbookFor({ role: 'engineer', repo: 'brinewick-api', task: 'k-7' }).includes('keeps its old URL'));
  ok("standing orders: but not another task's", !memory.playbookFor({ role: 'engineer', repo: 'brinewick-api', task: 'K-8' }).includes('keeps its old URL'));
  ok('standing orders: the Mate sees task lessons, marked', memory.playbookFor({ role: 'lead' }).includes('(task K-7, repo brinewick-api'));
  ok("memory: a repo's list shows its tasks' lessons", memory.listLessons({ scope: { repo: 'brinewick-api' } }).some((l) => l.key === 'k7-scope'));
  ok("memory: a task's list leaves out another task's", !memory.listLessons({ scope: { repo: 'brinewick-api', task: 'K-8' } }).some((l) => l.key === 'k7-scope'));
  memory.addLesson({ type: 'decision', key: 'k9-later', text: 'K-9 waits for design.', evidence: owner });
  expect('memory: scope adds a task', memory.scopeLesson('k9-later', { task: 'K-9' })?.scope.task, 'K-9');
  ok('memory: a rescoped lesson keeps its text', memory.listLessons().find((l) => l.key === 'k9-later')?.text === 'K-9 waits for design.');
  ok("standing orders: a rescoped lesson leaves other sessions' orders", !memory.playbookFor({ role: 'engineer', repo: 'brinewick-api' }).includes('K-9 waits'));
  expect('memory: an empty value clears a part', JSON.stringify(memory.scopeLesson('k9-later', { task: '' })?.scope), '{}');
  expect('memory: scoping an unknown key', memory.scopeLesson('nope', { task: 'K-1' }), null);
  memory.addLesson({ type: 'style', key: 'pinned-scope', text: 'Pinned rule.', evidence: owner });
  memory.pinLesson('pinned-scope');
  ok("memory: a pinned lesson's scope stays the captain's", throws(() => memory.scopeLesson('pinned-scope', { repo: 'nope' })));
  memory.forgetLesson('pinned-scope');
  memory.forgetLesson('k7-scope');
  memory.forgetLesson('k9-later');

  expect('memory: forget', memory.forgetLesson('api-base')?.status, 'retired');
  ok('memory: forgotten lessons leave the list', !memory.listLessons().some((l) => l.key === 'api-base'));
  expect('memory: but stay in history', memory.listLessons({ includeRetired: true }).find((l) => l.key === 'api-base')?.status, 'retired');
  ok('memory: and leave the standing orders', !readFileSync(memory.playbookPath(), 'utf8').includes('target develop'));
  expect('memory: forgetting an unknown key', memory.forgetLesson('nope'), null);

  memory.addLesson({ type: 'style', key: 'low', text: 'A hunch about naming.', confidence: 0.3 });
  ok('standing orders: low confidence left out', !memory.compilePlaybook().includes('A hunch about naming.'));
  expect('memory: pin', memory.pinLesson('low')?.status, 'pinned');
  const pinned = memory.compilePlaybook();
  ok('standing orders: pinned stays in at any confidence', pinned.includes('A hunch about naming.'));
  ok('standing orders: pinned comes first in its group', pinned.indexOf('A hunch about naming.') < pinned.indexOf('Engineers make small commits.'));

  const edited = memory.editLesson('pr-body', 'Keep PR bodies to three lines.');
  expect('memory: edit keeps the type', edited?.type, 'preference');
  expect('memory: edit changes the text', memory.listLessons().find((l) => l.key === 'pr-body')?.text, 'Keep PR bodies to three lines.');
  expect('memory: edit of an unknown key', memory.editLesson('nope', 'x'), null);

  const again = memory.addLesson({ type: 'repo-fact', key: 'api-base', text: 'brinewick-api PRs target develop.', scope: { repo: 'brinewick-api' }, evidence: owner });
  expect('memory: relearning a forgotten key restarts since', memory.listLessons().find((l) => l.key === 'api-base')?.since, again.at);
  const history = readFileSync(memory.lessonsPath(), 'utf8').trim().split('\n');
  ok('memory: lessons.jsonl is append-only', history.length === 20 && JSON.parse(history[0]).text === 'Keep PR bodies short.');
  expect('memory: every change committed', git(join(home, 'memory'), 'status', '--porcelain'), '');

  // The size cap: 400 long lessons straight into the history, then one compile.
  const many = Array.from({ length: 400 }, (_, i) => ({
    id: `bulk${i}`, at: Date.now(), type: 'decision', key: `bulk-${i}`, text: `Bulk decision ${String(i).padStart(3, '0')}: ${'x'.repeat(90)}`,
    scope: {}, evidence: [], confidence: 0.5 + (i / 400) * 0.5, status: 'active',
  }));
  appendFileSync(memory.lessonsPath(), many.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const big = memory.compilePlaybook();
  ok('standing orders: stay under 12 KB', Buffer.byteLength(big) <= 12 * 1024);
  ok('standing orders: keep the most trusted', big.includes('Bulk decision 399'));
  ok('standing orders: drop the least trusted first', !big.includes('Bulk decision 000'));
  ok('standing orders: say what they left out', /lower-confidence lessons left out/.test(big));
  ok('standing orders: pinned survives the cut', big.includes('A hunch about naming.'));
}

/* ---------- doctor ---------- */
{
  const now = Date.now();
  renameSync(join(home, 'memory'), join(home, 'memory-before-doctor'));
  // The example pack's repos are elsewhere on a real Mac: the pack check warns until they're in the Mate folder.
  writeFileSync(join(home, 'config.json'), JSON.stringify({ schemaVersion: 2, owner: 'Sam', shipMode: 'card', pack: 'brinewick' }));
  const elsewhere = runDoctor({ only: 'pack' }).checks.find((c) => c.id === 'pack');
  ok("doctor: a pack whose repos aren't in the Mate folder warns", elsewhere?.status === 'warn' && /brinewick-api, brinewick-web aren't in your Mate folder/.test(elsewhere.detail));
  const brinewickRepos = { 'brinewick-api': { path: '/x/brinewick-api', baseBranch: 'develop' }, 'brinewick-web': { path: '/x/brinewick-web', baseBranch: 'develop' } };
  writeFileSync(join(home, 'config.json'), JSON.stringify({ schemaVersion: 2, owner: 'Sam', shipMode: 'card', pack: 'brinewick', repos: brinewickRepos }));
  writeFileSync(join(home, 'crew.json'), JSON.stringify({ schemaVersion: 2, dirs: {}, sessions: { old: { role: 'job', key: null, dir: home, at: now - 25 * 3600_000 }, fresh: { role: 'job', key: null, dir: home, at: now } } }));
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'state', 'stuck.json'), JSON.stringify({ busy: true, activity: 'typing', lastAt: now - 31 * 60_000 }));
  writeFileSync(join(home, 'state', 'working.json'), JSON.stringify({ busy: true, activity: 'typing', lastAt: now }));
  writeFileSync(join(home, 'state', 'stuck.alive.json'), String(now - 31 * 60_000));
  mkdirSync(join(home, 'locks', 'dead'), { recursive: true });
  utimesSync(join(home, 'locks', 'dead'), new Date(now - 120_000), new Date(now - 120_000));
  mkdirSync(join(home, 'locks', 'live'), { recursive: true });
  mkdirSync(join(home, 'logs'), { recursive: true });
  writeFileSync(join(home, 'logs', 'policy.log'), Buffer.alloc(4 * 1024 * 1024 + 10, 'a'));
  writeFileSync(join(home, 'logs', 'small.log'), 'x\n');

  const status = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c.fixed ? 'fixed' : c.status]));
  const before = status(runDoctor({ now }));
  expect('doctor: finds', JSON.stringify(before), JSON.stringify({ locks: 'warn', config: 'ok', registry: 'ok', rules: 'ok', pack: 'ok', jobs: 'warn', busy: 'warn', logs: 'warn', memory: 'warn', lessons: 'ok', work: 'ok', members: 'ok', alerts: 'ok', denials: 'ok', orphans: 'ok', attic: 'ok', pushguard: 'ok', leadsettings: 'ok', claudeguard: 'ok', plugincode: 'ok', helper: 'ok' }));
  ok('doctor: looking changes nothing', !existsSync(join(home, 'memory')));
  const fixed = status(runDoctor({ fix: true, now }));
  expect('doctor: fixes', JSON.stringify(fixed), JSON.stringify({ locks: 'fixed', config: 'ok', registry: 'ok', rules: 'ok', pack: 'ok', jobs: 'fixed', busy: 'fixed', logs: 'fixed', memory: 'fixed', lessons: 'ok', work: 'ok', members: 'ok', alerts: 'ok', denials: 'ok', orphans: 'ok', attic: 'ok', pushguard: 'ok', leadsettings: 'ok', claudeguard: 'ok', plugincode: 'ok', helper: 'ok' }));
  const reg = JSON.parse(readFileSync(join(home, 'crew.json'), 'utf8'));
  ok('doctor: old jobs pruned', !reg.sessions.old && !!reg.sessions.fresh);
  const stuck = JSON.parse(readFileSync(join(home, 'state', 'stuck.json'), 'utf8'));
  ok('doctor: stale busy flag cleared', stuck.busy === false && stuck.activity === 'idle');
  expect('doctor: a working session left alone', JSON.parse(readFileSync(join(home, 'state', 'working.json'), 'utf8')).busy, true);
  ok('doctor: dead lock removed, live lock kept', !existsSync(join(home, 'locks', 'dead')) && existsSync(join(home, 'locks', 'live')));
  ok('doctor: big log rotated', existsSync(join(home, 'logs', 'policy.log.1')) && !existsSync(join(home, 'logs', 'policy.log')) && existsSync(join(home, 'logs', 'small.log')));
  ok('doctor: memory repo created', existsSync(join(home, 'memory', '.git')));
  const after = runDoctor({ now }).checks.filter((c) => c.status !== 'ok').map((c) => c.id);
  expect('doctor: clean after fixing', after.join(','), '');

  writeFileSync(join(home, 'config.json'), '{ "owner": "Sam", ');
  const damaged = runDoctor({ fix: true, now }).checks.find((c) => c.id === 'config');
  expect('doctor: a damaged file fails', damaged?.status, 'fail');
  ok('doctor: and is never deleted or rewritten', readFileSync(join(home, 'config.json'), 'utf8') === '{ "owner": "Sam", ');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ schemaVersion: 2, owner: 'Sam', shipMode: 'card', pack: 'brinewick' }));

  // Housekeeping: handled alerts and gone sessions' denials after 14 days, gone folders' activity after 30, briefs no
  // member uses after 14, attic items after 30; --safe makes only these and the other housekeeping fixes.
  const aged = (p, days) => utimesSync(p, new Date(now - days * 86_400_000), new Date(now - days * 86_400_000));
  mkdirSync(join(home, 'alerts', 'seen'), { recursive: true });
  for (const [f, d] of [['old.json', 15], ['new.json', 3]]) aged((writeFileSync(join(home, 'alerts', 'seen', f), '{}'), join(home, 'alerts', 'seen', f)), d);
  mkdirSync(join(home, 'denials'), { recursive: true });
  const live = Object.keys(JSON.parse(readFileSync(join(home, 'crew.json'), 'utf8')).sessions)[0];
  const counts = { paused: false, consecutive: 1, total: 1 };
  for (const [f, d, body] of [['gone-sess.json', 20, counts], [`${live}.json`, 20, counts], ['recent-sess.json', 2, counts], ['paused-sess.json', 20, { ...counts, paused: true, cause: 'spend' }]]) aged((writeFileSync(join(home, 'denials', f), JSON.stringify(body)), join(home, 'denials', f)), d);
  mkdirSync(join(home, 'events'), { recursive: true });
  for (const [f, d] of [['aaaaaaaaaaaaaaaa.jsonl', 40], ['aaaaaaaaaaaaaaaa.jsonl.1', 40], ['bbbbbbbbbbbbbbbb.jsonl', 5]]) aged((writeFileSync(join(home, 'events', f), ''), join(home, 'events', f)), d);
  mkdirSync(join(home, 'attic', 'work', `x-${now - 40 * 86_400_000}`), { recursive: true });
  mkdirSync(join(home, 'attic', 'work', `y-${now - 2 * 86_400_000}`), { recursive: true });
  mkdirSync(join(home, 'cache'), { recursive: true });
  for (const [f, d] of [['usage-cccccccccccccccc.json', 40], ['usage-dddddddddddddddd.json', 5]]) aged((writeFileSync(join(home, 'cache', f), '{}'), join(home, 'cache', f)), d);
  const seen = status(runDoctor({ now }));
  expect('doctor: housekeeping found', ['alerts', 'denials', 'orphans', 'attic'].map((id) => seen[id]).join(','), 'warn,warn,warn,warn');
  writeFileSync(join(home, 'config.json'), JSON.stringify({ schemaVersion: 2, owner: 'Sam', shipMode: 'card', pack: 'brinewick', leadDir: '/nowhere-lead' }));
  const safe = status(runDoctor({ fix: true, safe: true, now }));
  expect('doctor --safe: housekeeping fixed', ['alerts', 'denials', 'orphans', 'attic'].map((id) => safe[id]).join(','), 'fixed,fixed,fixed,fixed');
  ok('doctor --safe: only the old handled alert went', !existsSync(join(home, 'alerts', 'seen', 'old.json')) && existsSync(join(home, 'alerts', 'seen', 'new.json')));
  ok("doctor --safe: a live session's denials, a recent one and a pause stay", !existsSync(join(home, 'denials', 'gone-sess.json')) && existsSync(join(home, 'denials', `${live}.json`)) && existsSync(join(home, 'denials', 'recent-sess.json')) && existsSync(join(home, 'denials', 'paused-sess.json')));
  ok('doctor --safe: old activity files of gone folders went, a recent one stays', !existsSync(join(home, 'events', 'aaaaaaaaaaaaaaaa.jsonl')) && !existsSync(join(home, 'events', 'aaaaaaaaaaaaaaaa.jsonl.1')) && existsSync(join(home, 'events', 'bbbbbbbbbbbbbbbb.jsonl')));
  ok('doctor --safe: a cost scan unread for 30 days went, a recent one stays', !existsSync(join(home, 'cache', 'usage-cccccccccccccccc.json')) && existsSync(join(home, 'cache', 'usage-dddddddddddddddd.json')));
  ok('doctor --safe: an old attic item went, a recent one stays', !existsSync(join(home, 'attic', 'work', `x-${now - 40 * 86_400_000}`)) && existsSync(join(home, 'attic', 'work', `y-${now - 2 * 86_400_000}`)));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ schemaVersion: 2, owner: 'Sam', shipMode: 'card', pack: 'brinewick' }));

  appendFileSync(memory.lessonsPath(), 'not json\n');
  expect('memory: damaged lines are skipped and counted', memory.memoryStatus().damaged, 1);
  expect('doctor: reports damaged memory lines', runDoctor({ now }).checks.find((c) => c.id === 'memory')?.status, 'warn');
}

/* ---------- hooks: fail closed ---------- */
const hook = (h, name, input) => {
  const r = spawnSync('node', [join(root, 'hooks', name)], { input: JSON.stringify(input), env: { ...process.env, KEELCREW_HOME: h }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${name} exited ${r.status}: ${r.stderr}`);
  const out = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  return { decision: out?.permissionDecision ?? 'none', reason: out?.permissionDecisionReason ?? '' };
};
const pre = (h, cwd, tool_name, tool_input, session_id) => hook(h, 'policy.mjs', { hook_event_name: 'PreToolUse', cwd, session_id, tool_name, tool_input });
const bash = (h, cwd, command, sid) => pre(h, cwd, 'Bash', { command }, sid);
{
  // crew.json damaged: nobody can tell who is crew, so every session asks before shipping.
  const h = tmp('corrupt-crew');
  const anywhere = tmp('anywhere');
  writeFileSync(join(h, 'config.json'), JSON.stringify({ schemaVersion: 2, owner: 'Sam', shipMode: 'card', pack: 'brinewick' }));
  writeFileSync(join(h, 'crew.json'), '{"dirs": {');
  const push = bash(h, anywhere, 'git push origin HEAD');
  expect('fail closed: push asks', push.decision, 'ask');
  ok('fail closed: the reason names keelctl doctor and the file', push.reason.includes('keelctl doctor') && push.reason.includes('crew.json is damaged'));
  expect('fail closed: PR command asks', bash(h, anywhere, `${PR_CREATE} --draft --title x`).decision, 'ask');
  expect('fail closed: GitHub write asks', bash(h, anywhere, 'gh api -X POST repos/o/r/issues').decision, 'ask');
  expect('fail closed: connector write asks', pre(h, anywhere, 'mcp__0a1__outlook_send_mail', {}).decision, 'ask');
  expect('fail closed: connector read passes', pre(h, anywhere, 'mcp__0a1__outlook_email_search', {}).decision, 'none');
  expect('fail closed: other commands pass', bash(h, anywhere, 'ls -la').decision, 'none');
  expect('fail closed: edits pass', pre(h, anywhere, 'Edit', { file_path: join(anywhere, 'a.py') }).decision, 'none');
  expect('fail closed: board-only tools still denied', pre(h, anywhere, 'mcp__keelcrew-local__approve', {}).decision, 'deny');

  // config.json damaged: crew.json still says who is crew, so only members are held back.
  const h2 = tmp('corrupt-config');
  const wt = tmp('wt');
  writeFileSync(join(h2, 'config.json'), '{ "owner": ');
  writeFileSync(join(h2, 'crew.json'), JSON.stringify({ schemaVersion: 2, dirs: { [wt]: { role: 'engineer', key: 'X-1', at: 1 } }, sessions: {} }));
  const p2 = bash(h2, wt, 'git push origin HEAD');
  ok('fail closed: damaged config asks a member', p2.decision === 'ask' && p2.reason.includes('config.json is damaged') && p2.reason.includes('keelctl doctor'));
  expect('fail closed: a known non-member is untouched', bash(h2, anywhere, 'git push origin HEAD').decision, 'none');

  // The pack is missing: its rules can't be known, so shipping asks.
  const h3 = tmp('missing-pack');
  writeFileSync(join(h3, 'config.json'), JSON.stringify({ schemaVersion: 2, owner: 'Sam', shipMode: 'card', pack: 'gone' }));
  writeFileSync(join(h3, 'crew.json'), JSON.stringify({ schemaVersion: 2, dirs: { [wt]: { role: 'engineer', key: 'X-1', at: 1 } }, sessions: {} }));
  const p3 = bash(h3, wt, 'git push origin HEAD');
  ok('fail closed: missing pack asks', p3.decision === 'ask' && p3.reason.includes('"gone"') && p3.reason.includes('keelctl doctor'));
  expect('fail closed: missing pack, PR command asks', bash(h3, wt, `${PR_CREATE} --title x`).decision, 'ask');
  expect('fail closed: missing pack, edits pass', pre(h3, wt, 'Edit', { file_path: join(wt, 'a.py') }).decision, 'none');

  // A damaged pack file reads as damaged, not as an empty pack.
  const h4 = tmp('bad-pack');
  mkdirSync(join(h4, 'packs', 'bad'), { recursive: true });
  writeFileSync(join(h4, 'packs', 'bad', 'pack.json'), '{ nope');
  writeFileSync(join(h4, 'config.json'), JSON.stringify({ schemaVersion: 2, owner: 'Sam', shipMode: 'card', pack: 'bad' }));
  writeFileSync(join(h4, 'crew.json'), JSON.stringify({ schemaVersion: 2, dirs: { [wt]: { role: 'engineer', key: 'X-1', at: 1 } }, sessions: {} }));
  const p4 = bash(h4, wt, 'git push origin HEAD');
  ok('fail closed: damaged pack asks', p4.decision === 'ask' && p4.reason.includes('pack.json is damaged'));

  // A grant can't be recorded against unreadable rules; the hook still exits cleanly.
  const g = hook(h3, 'grant.mjs', { hook_event_name: 'PostToolUse', cwd: wt, tool_name: 'AskUserQuestion', tool_input: { questions: [{ header: 'Ship', question: 'Ship?' }] }, tool_response: { answers: { 'Ship?': 'Push only' } } });
  ok('fail closed: no approval recorded', g.decision === 'none' && !existsSync(join(h3, 'grants')));
}

/* ---------- the crew command, memory on register, agents, HEAD-bound approvals ---------- */
const hq = tmp('crew');
const leadDir = join(hq, 'mate-home');
const repo = join(leadDir, 'app');
const qaDir = join(hq, 'qa-work');
mkdirSync(repo, { recursive: true });
mkdirSync(qaDir, { recursive: true });
writeFileSync(join(hq, 'config.json'), JSON.stringify({ schemaVersion: 2, owner: 'Sam', shipMode: 'card', pack: 'brinewick', leadDir, trust: [], promptMode: 'ask' }));
const crew = (args, sid = '', extraEnv = {}) =>
  spawnSync('node', [join(root, 'cli', 'keelctl.mjs'), ...args], {
    env: { ...process.env, KEELCREW_HOME: hq, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_CODE_HOST_SESSION_ID: sid ? `local_${sid}` : '', ...extraEnv },
    encoding: 'utf8',
  });
const registry = () => JSON.parse(readFileSync(join(hq, 'crew.json'), 'utf8'));
{
  expect('cli: memory add with flags', crew(['memory', 'add', '--type', 'preference', '--key', 'short-prs', '--text', 'Short PR bodies.', '--source', 'owner', '--ref', 'chat-1', '--confidence', '0.9']).status, 0);
  crew(['memory', 'add', '--type', 'repo-fact', '--key', 'app-base', '--text', 'The app repo ships from develop.', '--repo', 'app', '--source', 'pr-review', '--ref', 'pr-12']);
  crew(['memory', 'add', '--type', 'process', '--key', 'qa-video', '--text', 'QA records a video.', '--agent', 'qa', '--source', 'card', '--ref', 'inbox-3', '--quote', 'show me']);
  expect('cli: memory add positional form', crew(['memory', 'add', 'style', 'tabs', 'Two-space', 'indents.']).status, 0);
  const candidates = JSON.parse(crew(['memory', 'list', '--json']).stdout);
  ok('cli: a lesson seen once is a candidate, an owner one is active', candidates.find((l) => l.key === 'app-base')?.status === 'candidate' && candidates.find((l) => l.key === 'short-prs')?.status === 'active');
  expect('cli: memory promote', crew(['memory', 'promote', 'app-base']).status, 0);
  ok('cli: memory promote says so', crew(['memory', 'promote', 'qa-video']).stdout.includes('"qa-video" is active'));
  expect('cli: memory promote unknown fails', crew(['memory', 'promote', 'nope']).status, 1);
  const listed = JSON.parse(crew(['memory', 'list', '--json']).stdout);
  const shortPrs = listed.find((l) => l.key === 'short-prs');
  ok('cli: memory list --json has at, evidence and confidence', typeof shortPrs?.at === 'number' && shortPrs.evidence[0].ref === 'chat-1' && shortPrs.confidence === 0.9);
  ok('cli: quote kept as evidence', listed.find((l) => l.key === 'qa-video')?.evidence[0].quote === 'show me');
  expect('cli: memory list --repo filters', JSON.parse(crew(['memory', 'list', '--json', '--repo', 'other']).stdout).some((l) => l.key === 'app-base'), false);
  {
    const areaEnv = { KEELCREW_HOME: tmp('area') };
    crew(['memory', 'add', '--type', 'process', '--key', 'billing-retry', '--text', 'Retry billing calls.', '--repo', 'app', '--area', 'billing', '--source', 'card', '--ref', 'c-1'], '', areaEnv);
    const keysFor = (/** @type {string} */ area) => JSON.parse(crew(['memory', 'list', '--json', '--repo', 'app', '--area', area], '', areaEnv).stdout).map((l) => l.key);
    ok('cli: memory list --area filters', keysFor('billing').includes('billing-retry') && !keysFor('search').includes('billing-retry'));
    expect('cli: spend --json prints null before the panel runs', crew(['spend', '--json'], '', areaEnv).stdout.trim(), 'null');
  }
  ok('cli: memory list text shows when', /\d{4}-\d\d-\d\d \d\d:\d\d {2}short-prs/.test(crew(['memory', 'list']).stdout));
  expect('cli: memory edit', crew(['memory', 'edit', 'tabs', '--text', 'Four-space indents.']).status, 0);
  const tabs = JSON.parse(crew(['memory', 'list', '--json']).stdout).find((l) => l.key === 'tabs');
  ok('cli: edit keeps type, changes text', tabs.type === 'style' && tabs.text === 'Four-space indents.');
  expect('cli: memory pin', crew(['memory', 'pin', 'tabs']).status, 0);
  expect('cli: memory forget unknown fails', crew(['memory', 'forget', 'nope']).status, 1);
  expect('cli: memory compile', crew(['memory', 'compile']).status, 0);
  ok('cli: memory show', crew(['memory', 'show']).stdout.includes('Four-space indents.'));
  const doctorOut = crew(['doctor', '--json']);
  const doctorChecks = JSON.parse(doctorOut.stdout).checks;
  ok(
    'cli: doctor --json lists each check with its status, and exits 1 on a failing one',
    doctorChecks.length > 5 && doctorChecks.every((/** @type {any} */ c) => c.id && c.label && ['ok', 'warn', 'fail'].includes(c.status)) && doctorOut.status === (doctorChecks.some((/** @type {any} */ c) => c.status === 'fail') ? 1 : 0),
  );

  const leadOut = crew(['register', 'lead', '-', leadDir], 'lead-h');
  ok('register lead: prints the standing orders', leadOut.status === 0 && ['Short PR bodies.', 'develop', 'QA records a video.'].every((t) => leadOut.stdout.includes(t)));

  git(repo, 'init', '-q');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'one');
  const one = git(repo, 'rev-parse', 'HEAD');
  const engOut = crew(['register', 'engineer', 'app-1', repo], 'eng-h');
  ok('register engineer: scoped lessons', engOut.status === 0 && engOut.stdout.includes('develop') && engOut.stdout.includes('Short PR bodies.') && !engOut.stdout.includes('QA records a video.'));

  // Agents follow engineer rules in their own folder.
  const qaOut = crew(['register', 'agent', '--agent', 'qa', 'app-2', qaDir], 'qa-h');
  ok('register agent: flags anywhere, scoped lessons', qaOut.status === 0 && qaOut.stdout.includes('QA records a video.') && !qaOut.stdout.includes('develop'));
  ok('register agent: recorded with its id', registry().sessions['qa-h']?.agent === 'qa' && registry().dirs[qaDir]?.agent === 'qa' && registry().dirs[qaDir]?.key === 'APP-2');
  expect('register agent: needs --agent', crew(['register', 'agent', 'app-3', qaDir], 'qa-2').status, 1);
  expect('register agent: not in the Mate folder', crew(['register', 'agent', 'app-3', leadDir, '--agent', 'qa'], 'qa-3').status, 1);
  expect('register job --agent', crew(['register', 'job', '-', leadDir, '--agent', 'learner'], 'job-h').status, 0);
  ok('register job: agent on the session, no folder', registry().sessions['job-h']?.agent === 'learner' && registry().dirs[leadDir]?.role === 'lead');
  expect('agent: edit outside its folder denied', pre(hq, qaDir, 'Edit', { file_path: join(homedir(), 'keelcrew-test-elsewhere', 'a.py') }, 'qa-h').decision, 'deny');
  expect('agent: edit inside its folder', pre(hq, qaDir, 'Edit', { file_path: join(qaDir, 'notes.md') }, 'qa-h').decision, 'none');
  // QA never ships (canShip: false in its manifest), so its pushes are denied outright, not asked about.
  expect('agent: QA push denied outright', bash(hq, qaDir, 'git push origin HEAD', 'qa-h').decision, 'deny');
  const qaAsk = pre(hq, qaDir, 'AskUserQuestion', { questions: [{ header: 'Scope', question: 'Which?', options: [] }] }, 'qa-h');
  ok('agent: asks the Mate, not the session', qaAsk.decision === 'deny' && qaAsk.reason.includes('send_message to local_lead-h'));
  expect('agent: may message the Mate', pre(hq, qaDir, 'mcp__ccd_session_mgmt__send_message', { session_id: 'local_lead-h' }, 'qa-h').decision, 'allow');
  expect('agent: cannot unregister', bash(hq, qaDir, 'keelctl unregister', 'qa-h').decision, 'deny');

  // Approvals are bound to the commit the captain saw.
  const shipQ = 'Ship APP-1?';
  const answer = (choice) => hook(hq, 'grant.mjs', { hook_event_name: 'PostToolUse', cwd: repo, session_id: 'eng-h', tool_name: 'AskUserQuestion', tool_input: { questions: [{ header: 'Ship', question: shipQ }] }, tool_response: { answers: { [shipQ]: choice } } });
  answer('Push only');
  const grant = JSON.parse(readFileSync(join(hq, 'grants', `${hash16(repo)}.json`), 'utf8'));
  ok('grant: written through core with via and head', grant.via === 'session' && grant.head === one && grant.key === 'APP-1' && grant.choice === 'Push only');
  ok('grant: no base to compare with counts as high risk, with the 14-day cap', grant.risk === 'high' && grant.expires - grant.at === 14 * 24 * 60 * 60_000);
  expect('head: approved commit pushes', bash(hq, repo, 'git push -u origin HEAD', 'eng-h').decision, 'allow');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'two');
  const moved = bash(hq, repo, 'git push -u origin HEAD', 'eng-h');
  ok('head: an engineer pushes a new commit to its own branch freely', moved.decision === 'allow' && moved.reason.includes('push their own branch freely'));
  expect('head: a PR command asks too', bash(hq, repo, `${PR_CREATE} --draft --title x`, 'eng-h').decision, 'ask');
  answer('Draft PR');
  expect('head: a fresh approval covers the new commit', bash(hq, repo, `git push -u origin HEAD && ${PR_CREATE} --draft --title x`, 'eng-h').decision, 'allow');
  answer('Not yet');
  ok('grant: "Not yet" clears it', !existsSync(join(hq, 'grants', `${hash16(repo)}.json`)));

  // When git can't read the worktree, a head-bound approval asks.
  const broken = join(leadDir, 'broken-wt');
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, '.git'), 'gitdir: /nowhere\n');
  crew(['register', 'engineer', 'app-9', broken], 'eng-b');
  mkdirSync(join(hq, 'grants'), { recursive: true });
  const t = Date.now();
  writeFileSync(join(hq, 'grants', `${hash16(broken)}.json`), JSON.stringify({ key: 'APP-9', dir: broken, choice: 'Open PR', at: t, expires: t + 60_000, via: 'board', head: 'a'.repeat(40) }));
  const noGit = bash(hq, broken, `${PR_CREATE} --title x`, 'eng-b');
  ok('head: unreadable HEAD asks', noGit.decision === 'ask' && noGit.reason.includes("can't read this worktree's commit"));
  writeFileSync(join(hq, 'grants', `${hash16(broken)}.json`), JSON.stringify({ key: 'APP-9', dir: broken, choice: 'Open PR', at: t, expires: t + 60_000, via: 'board' }));
  expect('head: an approval without a head still allows', bash(hq, broken, `${PR_CREATE} --title x`, 'eng-b').decision, 'allow');

  // The rest of the command.
  ok('cli: status shows the pack and agents', /Team pack: brinewick/.test(crew(['status']).stdout) && /Agents: /.test(crew(['status']).stdout));
  const packJson = JSON.parse(crew(['pack', '--json']).stdout);
  ok('cli: pack --json', packJson.name === 'brinewick' && packJson.effective.protectedBranches.includes('develop'));
  ok('cli: agents --json', Array.isArray(JSON.parse(crew(['agents', '--json']).stdout).agents));
  expect('cli: agents <id> --json shows that one', JSON.stringify(JSON.parse(crew(['agents', 'engineer', '--json']).stdout).agents.map((a) => a.id)), '["engineer"]');
  const noAgent = crew(['agents', 'nope']);
  ok('cli: agents <unknown id> fails, naming it', noAgent.status !== 0 && `${noAgent.stdout}${noAgent.stderr}`.includes('No agent "nope"'));
  expect('cli: setup rejects an unknown pack', crew(['setup', '--board', 'https://b', '--owner', 'Sam', '--pack', 'nope', '--lead-dir', leadDir]).status, 1);
  expect('cli: setup with a pack', crew(['setup', '--board', 'https://b', '--owner', 'Sam', '--pack', 'brinewick', '--lead-dir', leadDir]).status, 0);
  const cfg = JSON.parse(readFileSync(join(hq, 'config.json'), 'utf8'));
  ok('cli: setup keeps the schema', cfg.schemaVersion === 2 && cfg.pack === 'brinewick' && statSync(join(hq, 'bin', 'keelctl')).isFile());
  expect('cli: setup links the helper', realpathSync(join(hq, 'bin', 'keelcrew-helper')), realpathSync(join(root, 'helper', 'server.mjs')));
  // Setup finds the repos in the Mate folder; pack init makes the captain's own pack from them.
  const mate = tmp('mate');
  for (const [name, branch] of [['shop-api', 'develop'], ['shop-web', 'main']]) {
    mkdirSync(join(mate, name));
    git(join(mate, name), 'init', '-q', '-b', branch);
  }
  mkdirSync(join(mate, 'notes'));
  git(join(mate, 'shop-web'), 'commit', '-q', '--allow-empty', '-m', 'x');
  git(join(mate, 'shop-web'), 'worktree', 'add', '-q', join(mate, 'wt'), '-b', 'feat');
  // Checked out on a feature branch with no origin: main, not the feature branch, is the base.
  git(join(mate, 'shop-web'), 'checkout', '-q', '-b', 'wip');
  const made = crew(['pack', 'init', 'shop', '--lead-dir', mate, '--jira-site', 'https://shop.atlassian.net/']);
  const mine = JSON.parse(readFileSync(join(hq, 'packs', 'shop', 'pack.json'), 'utf8'));
  ok('cli: pack init writes the captain\'s pack from the Mate folder\'s repos', made.status === 0 && JSON.stringify(mine.repos) === '{"shop-api":{"baseBranch":"develop"},"shop-web":{"baseBranch":"main"}}' && mine.policy.protectedBranches.join() === 'develop,main' && mine.jira.site === 'https://shop.atlassian.net' && /currentUser/.test(mine.jira.jql));
  expect('cli: pack init never overwrites a pack', crew(['pack', 'init', 'shop', '--lead-dir', mate]).status, 1);
  const shipped = crew(['pack', 'init', 'brinewick', '--lead-dir', mate]);
  ok('cli: pack init refuses a shipped pack\'s name, which it would replace', shipped.status === 1 && /ships with Keelcrew/.test(shipped.stderr) && !existsSync(join(hq, 'packs', 'brinewick')));
  expect('cli: pack init refuses a query without a site', crew(['pack', 'init', 'shop2', '--lead-dir', mate, '--jql', 'x']).status, 1);
  expect('cli: setup with the captain\'s pack', crew(['setup', '--board', 'https://b', '--owner', 'Sam', '--pack', 'shop', '--lead-dir', mate]).status, 0);
  const withRepos = JSON.parse(readFileSync(join(hq, 'config.json'), 'utf8'));
  ok('cli: setup records the Mate folder\'s repos and starts the Mate\'s notes', withRepos.repos['shop-api']?.path === join(mate, 'shop-api') && withRepos.repos['shop-web']?.baseBranch === 'main' && !withRepos.repos.notes && existsSync(join(hq, 'lead.md')));
  expect('cli: helper needs a subcommand', crew(['helper']).status, 1);
  const desktop = String(process.env.KEELCREW_DESKTOP_CONFIG);
  const kept = readFileSync(desktop, 'utf8');
  const { MIN_NODE_MAJOR } = await import('../core/install.mjs');
  // The app runs the helper with the node that ran `keelctl helper install`, so run it with this one.
  const installed = spawnSync(process.execPath, [join(root, 'cli', 'keelctl.mjs'), 'helper', 'install'], { env: { ...process.env, KEELCREW_HOME: hq }, encoding: 'utf8' });
  if (Number(process.versions.node.split('.')[0]) < MIN_NODE_MAJOR) {
    // An older node finds a newer one beside it (nvm, Homebrew, /usr/local) for the app to run, or refuses, saying which.
    const entry = installed.status === 0 ? JSON.parse(readFileSync(desktop, 'utf8')).mcpServers['keelcrew-local'] : null;
    const major = entry ? Number(spawnSync(entry.command, ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.split('.')[0]) : 0;
    ok(`cli: helper install on node older than ${MIN_NODE_MAJOR} uses a newer node or refuses, saying which`, entry ? major >= MIN_NODE_MAJOR && entry.command !== process.execPath : installed.status === 1 && installed.stderr.includes(`node ${process.versions.node}`) && readFileSync(desktop, 'utf8') === kept);
  } else {
    expect('cli: helper install', installed.status, 0);
    expect('cli: helper install points the app at the link, run by this node', JSON.stringify(JSON.parse(readFileSync(desktop, 'utf8')).mcpServers['keelcrew-local']), JSON.stringify({ command: process.execPath, args: [join(hq, 'bin', 'keelcrew-helper')] }));
  }
  writeFileSync(desktop, kept);
  expect('cli: the session-start hook never fails', spawnSync('node', [join(root, 'hooks', 'links.mjs')], { env: { ...process.env, KEELCREW_HOME: hq }, input: '{}' }).status, 0);
  expect('cli: no trust command', crew(['trust', 'jira']).stdout.startsWith('keelctl <command>'), true);
  expect('cli: status has no trust line', crew(['status']).stdout.includes('Skip approval'), false);
  expect('cli: doctor runs', crew(['doctor']).status, 0);
}

/* ---------- concurrent registration ---------- */
{
  const hc = tmp('race');
  const lead = join(hc, 'mate-home');
  mkdirSync(lead, { recursive: true });
  writeFileSync(join(hc, 'config.json'), JSON.stringify({ schemaVersion: 2, owner: 'Sam', shipMode: 'card', pack: 'brinewick', leadDir: lead }));
  const runs = Array.from({ length: 8 }, (_, i) => {
    const wt = join(lead, 'app', 'worktrees', `w${i}`);
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: x\n');
    return new Promise((resolve) => {
      const child = spawn('node', [join(root, 'cli', 'keelctl.mjs'), 'register', 'engineer', `race-${i}`, wt], {
        env: { ...process.env, KEELCREW_HOME: hc, CLAUDE_CODE_SESSION_ID: `race-${i}`, CLAUDE_CODE_HOST_SESSION_ID: `local_race-${i}` },
        stdio: 'ignore',
      });
      child.on('exit', (code) => resolve(code));
    });
  });
  const codes = await Promise.all(runs);
  expect('race: every registration succeeds', codes.join(','), '0,0,0,0,0,0,0,0');
  const reg = JSON.parse(readFileSync(join(hc, 'crew.json'), 'utf8'));
  expect('race: all 8 sessions survive', Object.keys(reg.sessions).length, 8);
  expect('race: all 8 worktrees survive', Object.keys(reg.dirs).length, 8);
}

/* ---------- Mate folder settings ---------- */
{
  const lead = await import('../core/leadsettings.mjs');
  const leadDir = tmp('leaddir');
  const file = join(leadDir, '.claude', 'settings.local.json');
  const saved = readFileSync(join(home, 'config.json'), 'utf8');
  const cfg = { owner: 'Sam', pack: 'brinewick', leadDir, schemaVersion: 2 };
  writeFileSync(join(home, 'config.json'), JSON.stringify(cfg));
  expect('lead settings: rules defaults', JSON.stringify(lead.wantedLeadSettings(cfg)), JSON.stringify({ defaultMode: 'auto', compactWindow: 600000, allowTools: [], subagentModel: null }));
  expect('lead settings: no file is drift on both keys', lead.leadSettingsStatus(cfg).drift.length, 2);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(ls)', 'mcp__ccd_session__start_session'] }, env: { A: '1' } }));
  const check = () => runDoctor({}).checks.find((c) => c.id === 'leadsettings');
  expect('lead settings: doctor warns on drift', check()?.status, 'warn');
  expect('lead settings: doctor --fix applies', runDoctor({ fix: true }).checks.find((c) => c.id === 'leadsettings')?.fixed, true);
  const after = JSON.parse(readFileSync(file, 'utf8'));
  expect('lead settings: both keys written', `${after.permissions.defaultMode} ${after.autoCompactWindow}`, 'auto 600000');
  expect("lead settings: the captain's keys kept, the allow entry Keelcrew no longer adds removed", JSON.stringify([after.permissions.allow, after.env]), JSON.stringify([['Bash(ls)'], { A: '1' }]));
  expect('lead settings: then no drift', check()?.status, 'ok');
  const autoCfg = { ...cfg, compactWindow: 'auto' };
  lead.applyLeadSettings(autoCfg);
  ok("lead settings: the captain's auto removes the window", !('autoCompactWindow' in JSON.parse(readFileSync(file, 'utf8'))));
  lead.applyLeadSettings({ ...cfg, compactWindow: 300000 });
  expect("lead settings: the captain's size wins over the rules", JSON.parse(readFileSync(file, 'utf8')).autoCompactWindow, 300000);
  lead.applyLeadSettings(cfg);
  ok('lead settings: a bad size is ignored for the rules default', lead.wantedLeadSettings({ ...cfg, compactWindow: 50 }).compactWindow === 600000);
  writeFileSync(file, JSON.stringify({ permissions: {}, modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 900000, effortLevel: 'high' } } }));
  ok('lead settings: a per-model window is drift', lead.leadSettingsStatus(cfg).drift.some((d) => d.includes('per-model')));
  lead.applyLeadSettings(cfg);
  const pm = JSON.parse(readFileSync(file, 'utf8'));
  ok('lead settings: --fix drops the per-model window and keeps the rest', pm.modelSettings['claude-opus-5-5'].autoCompactWindow === undefined && pm.modelSettings['claude-opus-5-5'].effortLevel === 'high');
  ok('lead settings: a missing pack does not block them', lead.wantedLeadSettings({ ...cfg, pack: 'no-such-pack' }).compactWindow === 600000);
  {
    writeFileSync(file, JSON.stringify({ env: { A: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'opus' } }));
    lead.applyLeadSettings(cfg);
    expect('lead settings: no approved subagent model leaves the env alone', JSON.parse(readFileSync(file, 'utf8')).env.CLAUDE_CODE_SUBAGENT_MODEL, 'opus');
    const orgFile = join(home, 'org.json');
    writeFileSync(orgFile, JSON.stringify({ models: { proposed: { subagents: { model: 'haiku', effort: 'low' } } } }));
    ok('lead settings: a proposed subagent model is never used', lead.wantedLeadSettings(cfg).subagentModel === null);
    writeFileSync(orgFile, JSON.stringify({ models: { approved: { subagents: { model: 'sonnet', effort: 'xhigh' } } } }));
    ok('lead settings: an approved subagent model is drift until written', lead.leadSettingsStatus(cfg).drift.some((d) => d.includes('approved sonnet')));
    lead.applyLeadSettings(cfg);
    expect('lead settings: the approved subagent model written, the captain env kept', JSON.stringify(JSON.parse(readFileSync(file, 'utf8')).env), JSON.stringify({ A: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' }));
    expect('lead settings: then no drift', lead.leadSettingsStatus(cfg).drift.length, 0);
    writeFileSync(orgFile, JSON.stringify({ models: { approved: { subagents: { model: 'haiku', effort: 'xhigh' } } } }));
    const one = runDoctor({ fix: true, only: 'leadsettings' }).checks;
    expect('doctor: one check on its own, fixed', JSON.stringify([one.map((c) => c.id), one[0]?.fixed, JSON.parse(readFileSync(file, 'utf8')).env.CLAUDE_CODE_SUBAGENT_MODEL]), JSON.stringify([['leadsettings'], true, 'haiku']));
    const doctorCli = (/** @type {string[]} */ args) => spawnSync('node', [join(root, 'cli', 'keelctl.mjs'), 'doctor', ...args], { env: { ...process.env, KEELCREW_HOME: home }, encoding: 'utf8' });
    const cli = doctorCli(['leadsettings', '--fix', '--json']);
    expect('cli: keelctl doctor <check> runs just that check', JSON.stringify([cli.status, JSON.parse(cli.stdout || '{}').checks?.map((/** @type {any} */ c) => c.id)]), JSON.stringify([0, ['leadsettings']]));
    expect('cli: keelctl doctor with an unknown check fails', doctorCli(['nope']).status, 1);
    writeFileSync(orgFile, '{}');
    expect('lead settings: a revoked model Keelcrew wrote is drift, then taken out', JSON.stringify([lead.leadSettingsStatus(cfg).drift.length, (lead.applyLeadSettings(cfg), JSON.parse(readFileSync(file, 'utf8')).env)]), JSON.stringify([1, { A: '1' }]));
    writeFileSync(file, JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' } }));
    expect("lead settings: the captain's own subagent model is never taken out", JSON.stringify([lead.leadSettingsStatus(cfg).drift.some((d) => d.includes('subagents')), (lead.applyLeadSettings(cfg), JSON.parse(readFileSync(file, 'utf8')).env.CLAUDE_CODE_SUBAGENT_MODEL)]), JSON.stringify([false, 'haiku']));
    writeFileSync(orgFile, JSON.stringify({ models: { approved: { subagents: { model: 'sonnet; rm -rf /', effort: 'xhigh' } } } }));
    ok('lead settings: a model that is not a plain name is ignored', lead.wantedLeadSettings(cfg).subagentModel === null);
    rmSync(orgFile);
  }
  for (const bad of ['null', '[1]', '"x"', '{"permissions":"strict"}', '{"env":"x"}']) {
    writeFileSync(file, bad);
    let refused = false;
    try {
      lead.applyLeadSettings(cfg);
    } catch {
      refused = true;
    }
    ok(`lead settings: ${bad} is refused and left alone`, refused && readFileSync(file, 'utf8') === bad);
  }
  const goneCfg = { ...cfg, leadDir: join(leadDir, 'gone') };
  ok('lead settings: a Mate folder that is gone is reported', lead.leadSettingsStatus(goneCfg).missing === true);
  ok('lead settings: and not recreated', lead.applyLeadSettings(goneCfg).missing === true && !existsSync(join(leadDir, 'gone')));
  writeFileSync(file, '{ "permissions": ');
  let threw = false;
  try {
    lead.applyLeadSettings(cfg);
  } catch {
    threw = true;
  }
  ok('lead settings: a corrupt file is left alone', threw && readFileSync(file, 'utf8') === '{ "permissions": ');
  writeFileSync(file, JSON.stringify({ disableAllHooks: true }));
  const guard = runDoctor({}).checks.find((c) => c.id === 'claudeguard');
  ok('claude guard: disableAllHooks in the Mate folder fails doctor', guard?.status === 'fail' && /disableAllHooks/.test(guard.detail));
  writeFileSync(file, '{}');
  writeFileSync(join(String(process.env.CLAUDE_CONFIG_DIR), 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
  ok("claude guard: bypassPermissions in the user's settings fails doctor", /bypassPermissions/.test(runDoctor({}).checks.find((c) => c.id === 'claudeguard')?.detail ?? ''));
  writeFileSync(join(String(process.env.CLAUDE_CONFIG_DIR), 'settings.json'), '{}');
  ok('claude guard: clean settings pass', runDoctor({}).checks.find((c) => c.id === 'claudeguard')?.status === 'ok');
  writeFileSync(join(home, 'config.json'), saved);
}

/* ---------- install: the ~/.keelcrew/bin links and the Claude app's helper entry ---------- */
{
  const { HELPER_SERVER, bundleHelper, healLinks, installHelperEntry, linkAll, waitForHelperExtension } = await import('../core/install.mjs');
  const bin = join(home, 'bin');
  /** A stand-in installed version in Claude Code's plugin cache. @param {string} v */
  const cached = (v) => {
    const r = join(home, 'cc', 'plugins', 'cache', 'keelcrew', 'keelcrew', v);
    for (const f of ['cli/keelctl.mjs', 'helper/server.mjs', '.claude-plugin/plugin.json']) {
      mkdirSync(dirname(join(r, f)), { recursive: true });
      writeFileSync(join(r, f), f.endsWith('.json') ? JSON.stringify({ version: v }) : '');
    }
    return r;
  };
  const v1 = cached('0.1.0');
  const v2 = cached('0.1.1');
  linkAll(v1);
  expect('install: setup links keelctl', readlinkSync(join(bin, 'keelctl')), join(v1, 'cli', 'keelctl.mjs'));
  expect('install: and keelcrew-helper', readlinkSync(join(bin, 'keelcrew-helper')), join(v1, 'helper', 'server.mjs'));
  expect('install: an update re-points both', healLinks(v2).length, 2);
  expect('install: at the running copy', readlinkSync(join(bin, 'keelcrew-helper')), join(v2, 'helper', 'server.mjs'));
  expect('install: and then leaves them', healLinks(v2).length, 0);
  expect('install: a session still on the old version leaves them', healLinks(v1).length, 0);
  const v10 = cached('0.1.10');
  expect('install: versions compare as numbers', healLinks(v10).length, 2);
  rmSync(v10, { recursive: true });
  linkAll(v2);
  rmSync(v2, { recursive: true });
  expect('install: broken links are re-pointed', healLinks(v1).length, 2);
  linkAll(root);
  expect('install: a link to a checkout is left alone', healLinks(v1).length, 0);
  mkdirSync(join(v1, 'bin'), { recursive: true });
  writeFileSync(join(v1, 'bin', 'run.mjs'), '');
  linkAll(v1);
  rmSync(join(bin, 'keelctl'));
  symlinkSync(join(v1, 'bin', 'run.mjs'), join(bin, 'keelctl'));
  expect('install: a file the copy no longer uses is swapped for the one it does', JSON.stringify([healLinks(v1), readlinkSync(join(bin, 'keelctl'))]), JSON.stringify([[join(bin, 'keelctl')], join(v1, 'cli', 'keelctl.mjs')]));
  linkAll(root);
  const synced = (/** @type {string} */ gen, /** @type {string} */ v) => {
    const r = join(home, 'cc', 'plugins', 'synced', 'acct_org', gen);
    for (const f of ['cli/keelctl.mjs', 'helper/server.mjs', '.claude-plugin/plugin.json']) {
      mkdirSync(dirname(join(r, f)), { recursive: true });
      writeFileSync(join(r, f), f.endsWith('.json') ? JSON.stringify({ version: v }) : '');
    }
    return r;
  };
  linkAll(synced('keelcrew', '3.1.0'));
  expect('install: a newer copy synced from claude.ai takes the links', healLinks(synced('keelcrew~g2', '3.1.1')).length, 2);
  linkAll(root);
  rmSync(join(bin, 'keelcrew-helper'));
  expect('install: a missing link is made again', JSON.stringify(healLinks(root)), JSON.stringify([join(bin, 'keelcrew-helper')]));
  const cfgPath = join(home, 'config.json');
  const cfgText = readFileSync(cfgPath, 'utf8');
  rmSync(cfgPath);
  rmSync(join(bin, 'keelcrew-helper'));
  expect('install: nothing before setup', healLinks(root).length, 0);
  writeFileSync(cfgPath, cfgText);
  writeFileSync(join(bin, 'keelcrew-helper'), '#!/bin/sh\n');
  ok("install: a file that isn't a link is left alone", healLinks(root).length === 0 && readFileSync(join(bin, 'keelcrew-helper'), 'utf8') === '#!/bin/sh\n');
  linkAll(root);

  const desktop = String(process.env.KEELCREW_DESKTOP_CONFIG);
  const kept = readFileSync(desktop, 'utf8');
  const helperCheck = () => runDoctor({ only: 'helper' }).checks[0];
  rmSync(`${desktop}.keelcrew-backup`, { force: true });
  writeFileSync(desktop, JSON.stringify({ mcpServers: { other: { command: 'x', env: { K: 'v' } } }, globalShortcut: 'Alt+Space' }));
  chmodSync(desktop, 0o600);
  expect('doctor: no helper entry warns', helperCheck().status, 'warn');
  const r = installHelperEntry('/usr/local/bin/node');
  const after = JSON.parse(readFileSync(desktop, 'utf8'));
  ok('helper install: adds only its entry', after.globalShortcut === 'Alt+Space' && after.mcpServers.other.env.K === 'v' && after.mcpServers[HELPER_SERVER].command === '/usr/local/bin/node' && after.mcpServers[HELPER_SERVER].args[0] === join(bin, 'keelcrew-helper'));
  ok('helper install: keeps the old file', r.backup === `${desktop}.keelcrew-backup` && JSON.parse(readFileSync(r.backup, 'utf8')).mcpServers[HELPER_SERVER] === undefined);
  expect('doctor: the entry runs the link', helperCheck().status, 'ok');
  expect('helper install: keeps the file private', statSync(desktop).mode & 0o777, 0o600);
  installHelperEntry('/usr/local/bin/node');
  ok('helper install: a second run keeps the first copy', JSON.parse(readFileSync(String(r.backup), 'utf8')).mcpServers[HELPER_SERVER] === undefined);
  writeFileSync(desktop, JSON.stringify({ mcpServers: { [HELPER_SERVER]: { command: join(home, 'gone', 'node'), args: [join(bin, 'keelcrew-helper')] } } }));
  ok("doctor: an entry whose node is gone fails", helperCheck().status === 'fail' && /node was moved or upgraded/.test(helperCheck().detail));
  const elsewhere = join(home, 'real-desktop.json');
  writeFileSync(elsewhere, '{}');
  rmSync(desktop);
  symlinkSync(elsewhere, desktop);
  installHelperEntry('/usr/local/bin/node');
  ok('helper install: writes through a symlinked config', lstatSync(desktop).isSymbolicLink() && JSON.parse(readFileSync(elsewhere, 'utf8')).mcpServers[HELPER_SERVER] !== undefined);
  rmSync(desktop);
  writeFileSync(desktop, JSON.stringify({ mcpServers: { [HELPER_SERVER]: { command: 'node', args: [join(home, 'gone', 'server.mjs')] } } }));
  expect('doctor: an entry running a missing file fails', helperCheck().status, 'fail');
  writeFileSync(desktop, '{ "mcpServers": ');
  ok('helper install: a damaged config is left alone', throws(() => installHelperEntry()) && readFileSync(desktop, 'utf8') === '{ "mcpServers": ');
  expect('doctor: a damaged config warns', helperCheck().status, 'warn');
  // The helper as a Claude app extension: the app keeps it in a folder ending in .keelcrew-local beside its config.
  const exts = join(dirname(desktop), 'Claude Extensions');
  const extDir = join(exts, `local.mcpb.keelcrew-contributors.${HELPER_SERVER}`);
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(extDir, 'manifest.json'), JSON.stringify({ name: HELPER_SERVER, display_name: 'Keelcrew helper' }));
  ok("doctor: an extension the app names otherwise fails (the board can't reach it)", helperCheck().status === 'fail' && /older build/.test(helperCheck().detail));
  ok('helper bundle: the wait goes on past an older build', !waitForHelperExtension(0));
  writeFileSync(join(extDir, 'manifest.json'), JSON.stringify({ name: HELPER_SERVER, display_name: HELPER_SERVER }));
  expect('doctor: the helper extension counts, even beside a damaged config', helperCheck().status, 'ok');
  ok('helper bundle: the wait ends once the extension is installed', waitForHelperExtension(0));
  writeFileSync(desktop, '{}');
  expect('doctor: the helper extension alone is ok', helperCheck().status, 'ok');
  writeFileSync(desktop, JSON.stringify({ mcpServers: { [HELPER_SERVER]: { command: 'node', args: ['x'] } } }));
  ok('doctor: an old config entry beside the extension warns', helperCheck().status === 'warn' && /older keelcrew-local entry/.test(helperCheck().detail));
  rmSync(exts, { recursive: true, force: true });
  ok('helper bundle: the wait gives up when nothing is installed', !waitForHelperExtension(0));
  const bundle = bundleHelper();
  const inBundle = (f) => spawnSync('unzip', ['-p', bundle, f], { encoding: 'utf8' }).stdout;
  const manifest = JSON.parse(inBundle('manifest.json'));
  ok("helper bundle: an extension named as the board calls it, run by the app's node for this home", manifest.name === HELPER_SERVER && manifest.display_name === HELPER_SERVER && manifest.server.type === 'node' && manifest.server.mcp_config.command === 'node' && manifest.server.mcp_config.env.KEELCREW_HOME === home);
  ok('helper bundle: its entry runs the keelcrew-helper link', inBundle('server/index.mjs').includes(pathToFileURL(join(bin, 'keelcrew-helper')).href));
  writeFileSync(desktop, kept);
}

/* ---------- concurrency: lock takeover, log rotation, spend continues, activity order ---------- */
{
  const fsx = await import('../core/fsx.mjs');
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  // fsx's own fs calls are patched through the CommonJS module (syncBuiltinESMExports carries it to ES imports), so a
  // second process can be acted out at the exact moment a race needs it.
  const cjsFs = createRequire(import.meta.url)('node:fs');
  const real = { kill: process.kill, renameSync: cjsFs.renameSync, rmSync: cjsFs.rmSync, statSync: cjsFs.statSync };
  const restore = () => {
    process.kill = real.kill;
    Object.assign(cjsFs, { renameSync: real.renameSync, rmSync: real.rmSync, statSync: real.statSync });
    syncBuiltinESMExports();
  };
  const DEAD = 2147483646;
  const deadOwner = (lock) => {
    real.rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: DEAD, token: 'dead', at: Date.now() }));
  };

  // A waiter judged the holder dead; before it acts, another waiter took the lock over and a fresh holder has it. The
  // waiter must leave that lock alone (it used to move it aside and back, which let two holders run fn at once).
  const lock = join(home, 'locks', 'race');
  deadOwner(lock);
  let swapped = false;
  let touched = false;
  let ran = false;
  let timedOut = false;
  process.kill = (pid, sig) => {
    if (pid !== DEAD) return real.kill.call(process, pid, sig);
    if (!swapped) {
      swapped = true;
      real.rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'fresh', at: Date.now() }));
    }
    throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
  };
  cjsFs.renameSync = (a, b) => ((touched ||= a === lock), real.renameSync(a, b));
  cjsFs.rmSync = (p, o) => ((touched ||= p === lock), real.rmSync(p, o));
  syncBuiltinESMExports();
  try {
    fsx.withLock(lock, () => (ran = true), { timeoutMs: 100 });
  } catch (e) {
    timedOut = e instanceof fsx.LockTimeoutError;
  } finally {
    restore();
  }
  ok('lock race: a stale view of a dead holder never moves a fresh holder\'s lock', swapped && !ran && timedOut && !touched && fsx.lockOwner(lock)?.token === 'fresh');

  // Takeovers go one at a time: while another process is mid-takeover (its breaker in place) a waiter waits, then takes over.
  deadOwner(lock);
  mkdirSync(`${lock}.break`);
  ok('lock race: a takeover in progress is waited for', throws(() => fsx.withLock(lock, () => 'ran', { timeoutMs: 100 })) && fsx.lockOwner(lock)?.token === 'dead');
  rmSync(`${lock}.break`, { recursive: true });
  expect('lock race: then the dead holder is taken over', fsx.withLock(lock, () => 'ran', { timeoutMs: 500 }), 'ran');
  ok('lock race: no breaker left behind', !existsSync(lock) && !existsSync(`${lock}.break`));

  // A live pid past the held-too-long limit is a reused one: its lock is taken over, not waited on until doctor runs.
  const doctorLimits = await import('../core/doctor.mjs');
  expect('lock age: fsx and doctor share one held-too-long limit', fsx.LOCK_HELD_MAX_MS, doctorLimits.LOCK_HELD_MAX_MS);
  const liveOwner = (at) => {
    real.rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 1, token: 'reused', ...(at === undefined ? {} : { at }) }));
  };
  liveOwner(Date.now() - fsx.LOCK_HELD_MAX_MS - 60_000);
  expect('lock age: a live pid holding past the limit is taken over', fsx.withLock(lock, () => 'ran', { timeoutMs: 500 }), 'ran');
  ok('lock age: and the lock is released after', !existsSync(lock) && !existsSync(`${lock}.break`));
  liveOwner(Date.now());
  ok('lock age: a live pid within the limit is still waited on', throws(() => fsx.withLock(lock, () => 'ran', { timeoutMs: 100 })) && fsx.lockOwner(lock)?.token === 'reused');
  liveOwner(undefined);
  ok('lock age: an owner file without a time is judged by the folder\'s age, not taken at once', !fsx.lockAbandoned(lock, 15_000));
  utimesSync(lock, new Date(Date.now() - fsx.LOCK_HELD_MAX_MS - 60_000), new Date(Date.now() - fsx.LOCK_HELD_MAX_MS - 60_000));
  ok('lock age: ... and taken once the folder is past the limit', fsx.lockAbandoned(lock, 15_000));
  real.rmSync(lock, { recursive: true, force: true });

  // Two processes see the same full log: the other rotates first and appends to a fresh file. This one must not move
  // that fresh file over the full one in .1.
  const log = join(home, 'logs', 'race.log');
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, 'old\n'.repeat(10));
  writeFileSync(`${log}.1`, 'older\n');
  let rotated = false;
  cjsFs.statSync = (p, o) => {
    const st = real.statSync(p, o);
    if (p === log && !rotated) {
      rotated = true;
      real.renameSync(log, `${log}.1`);
      appendFileSync(log, 'theirs\n');
    }
    return st;
  };
  syncBuiltinESMExports();
  try {
    fsx.appendRotating(log, 'mine', 20);
  } finally {
    restore();
  }
  ok('rotate race: the full generation in .1 survives a rotation by another process', rotated && readFileSync(`${log}.1`, 'utf8') === 'old\n'.repeat(10));
  expect('rotate race: no line lost', readFileSync(log, 'utf8'), 'theirs\nmine\n');

  // spend.continued: a continue-once line goes with its ticket's close, or 30 days after its record went.
  const { computeSpend } = await import('../core/spend.mjs');
  const now = Date.now();
  const DAY = 86_400_000;
  const records = [{ key: 'OPEN-1', kind: 'ticket', outcome: null }, { key: 'DONE-1', kind: 'ticket', outcome: 'merged' }];
  const continued = { 'OPEN-1': { hardUsd: 9, at: now - 90 * DAY }, 'DONE-1': { hardUsd: 9, at: now }, 'GONE-1': { hardUsd: 9, at: now - 40 * DAY }, 'GONE-2': { hardUsd: 9, at: now - DAY } };
  const spent = computeSpend({ records, org: { departments: [], roles: [], budgets: {} }, prev: { at: now, base: {}, continued }, rules: {}, now });
  expect('spend: continues kept for open tickets and recently gone records only', Object.keys(spent.continued).sort().join(','), 'GONE-2,OPEN-1');
  // A continue waits for a spend check in progress (its lock held) instead of writing between the check's read and write.
  const { continueSpend } = await import('../core/spend.mjs');
  const spendLock = join(home, 'locks', 'spend');
  mkdirSync(spendLock, { recursive: true });
  writeFileSync(join(spendLock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'check', at: now }));
  writeFileSync(join(home, 'spend.json'), JSON.stringify({ at: now, continued: {} }));
  let waited = false;
  try {
    continueSpend('OPEN-1', { now });
  } catch (e) {
    waited = e instanceof fsx.LockTimeoutError;
  }
  ok('spend: a continue waits on the spend lock', waited && JSON.parse(readFileSync(join(home, 'spend.json'), 'utf8')).continued['OPEN-1'] === undefined);
  rmSync(spendLock, { recursive: true });
  rmSync(join(home, 'spend.json'));

  // Activity: a step that finished writing after the turn's Stop (stored lastAt is later) leaves the session idle.
  const ah = tmp('activity');
  const wt = tmp('activity-wt');
  writeFileSync(join(ah, 'crew.json'), JSON.stringify({ schemaVersion: 2, dirs: { [wt]: { role: 'engineer', key: 'APP-1', at: now } }, sessions: {} }));
  const sid = hash16(wt);
  mkdirSync(join(ah, 'state'), { recursive: true });
  writeFileSync(join(ah, 'state', `${sid}.json`), JSON.stringify({ busy: false, activity: 'idle', lastAt: now + 60_000 }));
  const actEnv = { ...process.env, KEELCREW_HOME: ah };
  spawnSync('node', [join(root, 'hooks', 'activity.mjs')], { input: JSON.stringify({ cwd: wt, session_id: 's-1', transcript_path: '/tmp/t.jsonl', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), env: actEnv, encoding: 'utf8' });
  const st = JSON.parse(readFileSync(join(ah, 'state', `${sid}.json`), 'utf8'));
  ok('activity: a step older than the stored state never turns the session busy again', st.busy === false && st.activity === 'idle' && st.lastAt === now + 60_000 && st.transcripts?.[0] === '/tmp/t.jsonl');
  expect('activity: the late step is still logged', readFileSync(join(ah, 'events', `${sid}.jsonl`), 'utf8').trim().split('\n').length, 1);
  ok('activity: its state lock is released', !existsSync(join(ah, 'locks', `state-${sid}`)));

  // Another hook holds the state lock past the wait: the state update is skipped, but the event is still logged.
  const stateLock = join(ah, 'locks', `state-${sid}`);
  mkdirSync(stateLock, { recursive: true });
  writeFileSync(join(stateLock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'busy-hook', at: Date.now() }));
  spawnSync('node', [join(root, 'hooks', 'activity.mjs')], { input: JSON.stringify({ cwd: wt, session_id: 's-1', transcript_path: '/tmp/t.jsonl', hook_event_name: 'Stop' }), env: actEnv, encoding: 'utf8' });
  const events = readFileSync(join(ah, 'events', `${sid}.jsonl`), 'utf8').trim().split('\n');
  ok('activity: a timed-out state lock still logs the event', events.length === 2 && JSON.parse(events[1]).kind === 'turn_end' && /APP-1 turn_end/.test(readFileSync(join(ah, 'logs', 'activity.log'), 'utf8')));
  ok('activity: and leaves the other hook\'s lock alone', JSON.parse(readFileSync(join(stateLock, 'owner.json'), 'utf8')).token === 'busy-hook');
  rmSync(stateLock, { recursive: true });
}

console.log(`${n - bad}/${n} core checks pass`);
process.exit(bad ? 1 : 0);
