// @ts-check
// The company: switches, staffing and approved models. Runs against a throwaway KEELCREW_HOME.
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'keelcrew-org-'));
process.env.KEELCREW_HOME = home;
const env = { ...process.env, KEELCREW_HOME: home };
const { ENGINEER_LADDER, aliasOf, approvedModel, mainAuthor, modelFor, readOrg, staff } = await import('../core/org.mjs');
const { paths } = await import('../core/paths.mjs');

let pass = 0;
let fail = 0;
/** @param {string} label @param {unknown} got @param {unknown} want */
const expect = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else {
    fail++;
    console.log(`FAIL ${label}: ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};

/* ---------- switches ---------- */
const base = readOrg({ file: {} });
expect('org: CEO seat off by default', base.ceo, false);
expect('org: on at launch', base.departments.filter((d) => d.enabled).map((d) => d.id), ['engineering', 'product', 'operations']);
expect('org: a role in a department that is off is off', base.roles.find((r) => r.id === 'marketing')?.enabled, false);
expect('org: seats from the rules', base.seats, 4);
const custom = readOrg({ file: { departments: { ceo: { enabled: true }, operations: { enabled: false } }, agents: { reviewer: { enabled: false } }, roles: { cto: { enabled: false } }, maxWorkers: 2 } });
expect('org: the captain turns the CEO seat on', custom.ceo, true);
expect('org: Operations is always on', custom.departments.find((d) => d.id === 'operations')?.enabled, true);
expect("org: the agent switch still counts", custom.roles.find((r) => r.id === 'reviewer')?.enabled, false);
expect('org: a role switch', custom.roles.find((r) => r.id === 'cto')?.enabled, false);
expect("org: seats are the board's Engineers at once", custom.seats, 2);
expect('seats: a seats setting is ignored', [readOrg({ file: { maxWorkers: 6 } }).seats, readOrg({ file: { seats: 2, maxWorkers: 6 } }).seats, readOrg({ file: { seats: 2 } }).seats], [6, 6, 4]);
expect('seats: a bad maxWorkers falls back to the rules', [0, -1, 2.5, '6', null].map((m) => readOrg({ file: { maxWorkers: m } }).seats), [4, 4, 4, 4, 4]);
writeFileSync(join(home, 'org.json'), JSON.stringify({ maxWorkers: 6 }));
const fromFile = readOrg().seats;
writeFileSync(join(home, 'org.json'), '{"maxWorkers": 6');
expect('seats: maxWorkers from org.json; a damaged file is the rules default', [fromFile, readOrg().seats], [6, 4]);
writeFileSync(join(home, 'org.json'), '{}');

/* ---------- staffing ---------- */
expect('owner: the most commits wins, bots aside', mainAuthor([{ login: 'b' }, { login: 'dependabot[bot]' }, { login: 'a' }, { login: 'dependabot[bot]' }, { login: 'a' }, { login: null }]), 'a');
expect('owner: a tie goes to the newest commit', mainAuthor([{ login: 'b' }, { login: 'a' }, { login: 'a' }, { login: 'b' }]), 'b');
expect('owner: nobody', mainAuthor([{ login: null }, { login: 'x[bot]' }]), null);
expect('staff: a fresh engineer', staff({}, base, { seatsUsed: 0 }), { role: 'engineer', wait: false, reason: 'a fresh engineer' });
expect('staff: the contractor is off by default, so an engineer', staff({ mechanical: true }, base, { seatsUsed: 0 }).role, 'engineer');
expect('staff: mechanical goes to a contractor once it is on', staff({ mechanical: true }, readOrg({ file: { agents: { contractor: { enabled: true } } } }), { seatsUsed: 0 }).role, 'contractor');
const noContractor = { ...base, roles: base.roles.map((r) => (r.id === 'contractor' ? { ...r, enabled: false } : r)) };
expect('staff: with the contractor off, an engineer', staff({ mechanical: true }, noContractor, { seatsUsed: 0 }).role, 'engineer');
expect('staff: every seat taken, it waits', [staff({}, base, { seatsUsed: 4 }).wait, staff({}, base, { seatsUsed: 4 }).reason], [true, 'every seat is taken']);
{
  const two = readOrg({ file: { maxWorkers: 2 } });
  const now = Date.now();
  const at = now - 2 * 86_400_000;
  /** @param {Record<string, { busy?: boolean, lastAt: number }>} engineers */
  const seated = (engineers) => {
    writeFileSync(join(home, 'crew.json'), JSON.stringify({ dirs: Object.fromEntries(Object.keys(engineers).map((k) => [join(home, k), { role: 'engineer', key: k, at }])), sessions: {} }));
    for (const [k, st] of Object.entries(engineers)) {
      mkdirSync(dirname(paths.state(join(home, k))), { recursive: true });
      writeFileSync(paths.state(join(home, k)), JSON.stringify(st));
    }
    return staff({}, two).wait;
  };
  expect('seats: busy and recently active engineers hold seats', seated({ 'D-1': { busy: true, lastAt: now - 20 * 60_000 }, 'D-2': { lastAt: now - 5 * 60_000 }, 'D-3': { lastAt: now - 3_600_000 } }), true);
  expect('seats: an engineer idle 15 minutes frees its seat, whatever its ticket', seated({ 'D-1': { busy: true, lastAt: now - 20 * 60_000 }, 'D-2': { lastAt: now - 16 * 60_000 } }), false);
  expect('seats: a busy flag with no step for 30 minutes is stale', seated({ 'D-1': { busy: true, lastAt: now - 31 * 60_000 }, 'D-2': { lastAt: now - 60_000 } }), false);
  writeFileSync(join(home, 'crew.json'), '{}');
}

const goal = { id: 'g1', title: 'Saved carts adoption', metric: 'weekly users', target: '50', weight: 2 };
expect('goals: ignored with the CEO seat off', readOrg({ file: { goals: [goal] } }).goals, []);
expect('goals: kept with it on', readOrg({ file: { goals: [goal], departments: { ceo: { enabled: true } } } }).goals.map((g) => g.id), ['g1']);

/* ---------- approved models ---------- */
const S = 'claude-sonnet-5-5';
const O = 'claude-opus-5-5';
const approved = readOrg({ file: { models: { approved: { engineer: { byDifficulty: { simple: { model: S, effort: 'xhigh' }, moderate: { model: O, effort: 'high' } } }, qa: { model: S, effort: 'high' } } } } });
expect('model: approved per difficulty', approvedModel(approved, 'engineer', 'simple'), { model: S, effort: 'xhigh' });
expect('model: a difficulty not approved keeps today', approvedModel(approved, 'engineer', 'critical'), null);
expect('model: a plain approval', approvedModel(approved, 'qa'), { model: S, effort: 'high' });
expect('model: a proposed model is never used', approvedModel(base, 'qa'), null);

/* ---------- the one resolver: approved, else the manifest, else the engineer ladder's default ---------- */
const withSub = readOrg({ file: { models: { approved: { ...approved.approved, subagents: { model: S, effort: 'xhigh' }, lead: { model: S, effort: 'max' } } } } });
expect('modelFor: approved per difficulty', modelFor(approved, 'engineer', 'simple'), { model: S, effort: 'xhigh', source: 'approved', alias: 'sonnet' });
expect("modelFor: a difficulty not approved takes the manifest's model and the ladder's effort", modelFor(approved, 'engineer', 'critical'), { model: S, effort: 'xhigh', source: 'manifest', alias: 'sonnet' });
expect('modelFor: the engineer ladder by difficulty, nothing approved', ['simple', 'moderate', 'complex', 'critical'].map((d) => modelFor(base, 'engineer', d).effort), ['high', 'xhigh', 'xhigh', 'xhigh']);
expect('modelFor: no difficulty reads as moderate', modelFor(base, 'engineer'), { model: S, effort: 'xhigh', source: 'manifest', alias: 'sonnet' });
expect('modelFor: a plain approval', modelFor(approved, 'qa'), { model: S, effort: 'high', source: 'approved', alias: 'sonnet' });
expect("modelFor: else the manifest's model and effort, never the proposed one", [modelFor(base, 'qa'), modelFor(base, 'learner')], [{ model: S, effort: 'high', source: 'manifest', alias: 'sonnet' }, { model: S, effort: 'high', source: 'manifest', alias: 'sonnet' }]);
expect('modelFor: a role whose manifest names none takes the ladder default', [modelFor(base, 'cto'), modelFor(base, 'contractor', 'simple')], [{ model: S, effort: 'xhigh', source: 'default', alias: 'sonnet' }, { model: S, effort: 'high', source: 'default', alias: 'sonnet' }]);
expect('modelFor: the Mate and subagents', [modelFor(base, 'lead'), modelFor(withSub, 'lead'), modelFor(withSub, 'subagents'), modelFor(base, 'subagents').source], [{ model: S, effort: 'xhigh', source: 'default', alias: 'sonnet' }, { model: S, effort: 'max', source: 'approved', alias: 'sonnet' }, { model: S, effort: 'xhigh', source: 'approved', alias: 'sonnet' }, 'default']);
expect('aliasOf: the family the Agent tool takes', ['claude-opus-5-5', 'claude-fable-5-2', 'sonnet', 'claude-haiku-5-5[1m]', 'my-model'].map(aliasOf), ['opus', 'fable', 'sonnet', 'haiku', null]);
expect('modelFor: a damaged approval is ignored', modelFor(readOrg({ file: { models: { approved: { qa: { model: S }, engineer: null } } } }), 'qa').source, 'manifest');
expect('ladder: the default every resolver falls back to', ENGINEER_LADDER, { model: S, effort: { simple: 'high', moderate: 'xhigh', complex: 'xhigh', critical: 'xhigh' } });

/* ---------- joining in a repo ---------- */
const leadDir = join(home, 'lead');
const wt = join(home, 'wt', 'D-1');
mkdirSync(leadDir, { recursive: true });
mkdirSync(wt, { recursive: true });
execFileSync('git', ['init', '-q', wt]);
writeFileSync(join(home, 'config.json'), JSON.stringify({ owner: 'Sam', trust: [], leadDir, pack: 'brinewick', promptMode: 'deny' }));
const crew = (sid, args, cwd = wt) => spawnSync('node', [join(root, 'cli', 'keelctl.mjs'), ...args], { cwd, env: { ...env, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_CODE_HOST_SESSION_ID: `local_${sid}` }, encoding: 'utf8' });
const joined = crew('eng-1', ['register', 'engineer', 'D-1', wt, '--repo', 'brinewick-api']);
expect('register: joins in its repo', joined.status, 0);
const staffed = JSON.parse(crew('lead-x', ['org', 'staff', 'D-2', '--difficulty', 'moderate'], leadDir).stdout);
const full2 = (/** @type {string} */ k, /** @type {string} */ d) => JSON.parse(crew('lead-x', ['org', 'staff', k, '--difficulty', d], leadDir).stdout);
expect('keelctl org staff: an engineer, on the model the resolver picks', [staffed.role, staffed.approved, staffed.model, staffed.effort, staffed.source], ['engineer', false, S, 'xhigh', 'manifest']);
{
  const model = (/** @type {string[]} */ args) => crew('lead-x', ['org', 'model', ...args], leadDir);
  writeFileSync(join(home, 'org.json'), JSON.stringify({ models: { approved: { engineer: { byDifficulty: { simple: { model: S, effort: 'xhigh' } } }, subagents: { model: S, effort: 'xhigh' } } } }));
  expect('keelctl org model: approved for a difficulty', JSON.parse(model(['engineer', '--difficulty', 'simple', '--json']).stdout), { role: 'engineer', difficulty: 'simple', model: S, effort: 'xhigh', source: 'approved', alias: 'sonnet' });
  expect('keelctl org model: else the manifest', JSON.parse(model(['qa', '--json']).stdout), { role: 'qa', difficulty: null, model: S, effort: 'high', source: 'manifest', alias: 'sonnet' });
  expect('keelctl org model: the Mate and subagents', [JSON.parse(model(['lead', '--json']).stdout).source, JSON.parse(model(['subagents', '--json']).stdout).model], ['default', S]);
  expect('keelctl org model: in words', model(['engineer', '--difficulty', 'simple']).stdout.trim(), `${S} · xhigh (approved)`);
  expect('keelctl org staff: the same resolver', [full2('D-6', 'simple').model, full2('D-6', 'simple').approved, full2('D-6', 'simple').source], [S, true, 'approved']);
  expect('keelctl org model: an unknown role or difficulty fails', [model(['nobody']).status, model(['engineer', '--difficulty', 'hard']).status, model([]).status], [1, 1, 1]);
  writeFileSync(join(home, 'org.json'), '{}');
}
{
  const { applyEvent } = await import('../core/ledger.mjs');
  const full = (/** @type {string} */ k) => JSON.parse(crew('lead-x', ['org', 'staff', k, '--difficulty', 'moderate'], leadDir).stdout);
  writeFileSync(join(home, 'org.json'), JSON.stringify({ maxWorkers: 1 }));
  expect('seats: a new engineer the ledger has not seen holds a seat', full('D-3').wait, true);
  applyEvent('task', 'D-1', { status: 'done' });
  expect('seats: a finished ticket still registered holds none', full('D-4').wait, false);
  applyEvent('task', 'D-1', { status: 'active', rowVersion: 2 });
  expect('seats: an active one does', full('D-5').wait, true);
  writeFileSync(join(home, 'org.json'), '{}');
}
const pre = (command, sid) => {
  const r = spawnSync('node', [join(root, 'hooks', 'policy.mjs')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sid, cwd: wt, tool_name: 'Bash', tool_input: { command } }), env, encoding: 'utf8' });
  return (r.stdout ? JSON.parse(r.stdout) : {}).hookSpecificOutput?.permissionDecision ?? 'none';
};
expect('policy: an engineer may ask who staffs a ticket', pre('~/.keelcrew/bin/keelctl org staff D-9 --difficulty simple', 'eng-1'), 'none');
expect('policy: an engineer may ask which model a role runs on', pre('~/.keelcrew/bin/keelctl org model reviewer --json', 'eng-1'), 'none');

console.log(fail ? `${fail} org checks fail, ${pass} pass` : `${pass}/${pass} org checks pass`);
process.exitCode = fail ? 1 : 0;
