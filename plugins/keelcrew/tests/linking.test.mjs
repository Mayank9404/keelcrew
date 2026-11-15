// @ts-check
// Bugs and reverts traced back to crew tickets through git, and the weekly report. Runs against a throwaway
// KEELCREW_HOME and a scratch git repo whose `develop` branch stands in for origin's.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'keelcrew-linking-'));
process.env.KEELCREW_HOME = home;
const env = { ...process.env, KEELCREW_HOME: home };
const { applyEvent, emptyRecord, readRecord } = await import('../core/ledger.mjs');
const { linkBug, scanReverts } = await import('../core/ledgerlink.mjs');
const { weeklyReport } = await import('../core/report.mjs');
const { hasPr } = await import('../core/crew.mjs');

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

const DAY = 86_400_000;
const repo = join(home, 'repo');
mkdirSync(repo, { recursive: true });
const g = (/** @type {string[]} */ ...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@x', '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8' }).trim();
g('init', '-q', '-b', 'develop');
writeFileSync(join(repo, 'a.py'), 'x = 1\n');
g('add', '-A');
g('commit', '-q', '-m', 'start');
// A squash merge: its subject ends with the PR number.
writeFileSync(join(repo, 'a.py'), 'x = 2\n');
g('commit', '-q', '-am', 'Fix the thing (#12)');
const squash = g('rev-parse', 'HEAD');
// A merge commit: the change's own commit has no PR number; the first-parent merge does.
g('checkout', '-q', '-b', 'feature');
writeFileSync(join(repo, 'b.py'), 'y = 1\n');
g('add', '-A');
g('commit', '-q', '-m', 'add b');
g('checkout', '-q', 'develop');
g('merge', '-q', '--no-ff', 'feature', '-m', 'Merge pull request #13 from o/feature');
const sync = () => g('update-ref', 'refs/remotes/origin/develop', 'HEAD');
sync();
writeFileSync(join(home, 'config.json'), JSON.stringify({ owner: 'Sam', trust: [], pack: 'brinewick', promptMode: 'deny', repos: { repo: { path: repo, baseBranch: 'develop' } } }));

const NOW = Date.now();
applyEvent('task', 'T-1', { status: 'done', difficulty: 'simple' }, { now: NOW });
applyEvent('merge', 'T-1', { prNumber: 12, mergedAt: NOW - DAY, mergeSha: squash }, { now: NOW });
applyEvent('task', 'T-2', { status: 'done', difficulty: 'moderate', prUrl: 'https://github.com/o/r/pull/13' }, { now: NOW });
applyEvent('merge', 'T-2', { mergedAt: NOW - 40 * DAY }, { now: NOW });

/* ---------- bugs ---------- */
expect('link-bug: a squash merge by its PR number', linkBug({ bug: 'BUG-1', repo: 'repo', file: 'a.py', line: 1, severity: 'high', now: NOW }), { key: 'T-1', sha: squash, ignored: null });
expect('link-bug: recorded once', [readRecord('T-1')?.bugs30d.map((b) => [b.ticket, b.severity]), linkBug({ bug: 'BUG-1', repo: 'repo', file: 'a.py', line: 1, now: NOW }).key, readRecord('T-1')?.bugs30d.length], [[['BUG-1', 'high']], 'T-1', 1]);
const old = linkBug({ bug: 'BUG-2', repo: 'repo', file: 'b.py', line: 1, now: NOW });
expect('link-bug: through the first-parent merge, but too old to count', [old.key, old.ignored, readRecord('T-2')?.bugs30d.length], ['T-2', 'merged more than 30 days ago', 0]);
applyEvent('merge', 'T-2', { mergedAt: NOW - 2 * DAY }, { now: NOW + 1 });
expect('link-bug: through the first-parent merge', linkBug({ bug: 'BUG-3', repo: 'repo', file: 'b.py', line: 1, now: NOW }).key, 'T-2');
g('commit', '-q', '--allow-empty', '-m', 'unrelated');
writeFileSync(join(repo, 'c.py'), 'z = 1\n');
g('add', '-A');
g('commit', '-q', '-m', 'owner change');
sync();
expect('link-bug: a line no crew ticket wrote', linkBug({ bug: 'BUG-4', repo: 'repo', file: 'c.py', line: 1, now: NOW }).key, null);
let refused = false;
try {
  linkBug({ bug: 'not a key', repo: 'repo', file: 'a.py', line: 1 });
} catch {
  refused = true;
}
expect('link-bug: a bad bug key is refused', refused, true);
// A teammate's squash merge and a direct commit on develop, then a crew merge: neither line is the crew's.
const commitFile = (/** @type {string} */ file, /** @type {string} */ subject) => {
  writeFileSync(join(repo, file), `${file} = 1\n`);
  g('add', '-A');
  g('commit', '-q', '-m', subject);
};
commitFile('t.py', 'Teammate fix (#5)');
commitFile('u.py', 'direct on develop');
g('checkout', '-q', '-b', 'feature3');
commitFile('d.py', 'add d');
g('checkout', '-q', 'develop');
g('merge', '-q', '--no-ff', 'feature3', '-m', 'Merge pull request #14 from o/feature3');
sync();
applyEvent('task', 'T-3', { status: 'done', prUrl: 'https://github.com/o/r/pull/14' }, { now: NOW });
applyEvent('merge', 'T-3', { mergedAt: NOW - DAY }, { now: NOW });
expect("link-bug: a teammate's PR or a direct commit before a crew merge isn't the crew's", [['BUG-5', 't.py'], ['BUG-6', 'u.py'], ['BUG-7', 'd.py']].map(([bug, file]) => linkBug({ bug, repo: 'repo', file, line: 1, now: NOW }).key), [null, null, 'T-3']);

/* ---------- reverts ---------- */
// A ticket that landed 200 days ago, reverted now: past the window.
commitFile('v.py', 'Old change (#15)');
applyEvent('merge', 'T-4', { prNumber: 15, mergedAt: NOW - 200 * DAY, mergeSha: g('rev-parse', 'HEAD') }, { now: NOW });
g('revert', '--no-edit', 'HEAD');
g('revert', '--no-edit', squash);
sync();
expect('reverts: a revert of a crew change counts against its ticket', scanReverts({ now: NOW }), ['T-1']);
expect('reverts: once', [scanReverts({ now: NOW }), readRecord('T-1')?.reverts30d.length], [[], 1]);

/* ---------- the report ---------- */
const rec = (/** @type {string} */ key, /** @type {Record<string, any>} */ over) => ({ ...emptyRecord(key, NOW), outcome: 'merged', startedAt: NOW - 3 * 3_600_000, closedAt: NOW, spendUsd: 10, ...over });
const rows = [rec('R-1', { qaFirstPass: true }), rec('R-2', { spendUsd: 30, qaFirstPass: false, bugs30d: [{ ticket: 'B', severity: null, at: NOW }] }), rec('R-3', { closedAt: NOW - 20 * DAY, startedAt: NOW - 21 * DAY, spendUsd: 50 }), rec('R-4', { outcome: null })];
const r = weeklyReport({ records: /** @type {any} */ (rows), weeks: 4, switchOnAt: NOW - 7 * DAY, now: NOW });
const last = r.weeks[r.weeks.length - 1];
expect('report: this week', [r.weeks.length, last.tickets, last.medianHours, last.spendUsd, last.qaFirstPass, last.withBugs], [4, 2, 3, 40, 0.5, 1]);
expect('report: before and after the switch-on', [r.baseline?.before.tickets, r.baseline?.after.tickets, r.baseline?.before.qaKnown], [1, 2, 0]);
expect('report: no baseline without a switch-on', weeklyReport({ records: [], now: NOW }).baseline, null);
{
  // Weeks are the Mac's own: east of UTC (Tokyo here) a ticket closed Monday 00:30 is in that Monday's week, not the one before.
  const url = (/** @type {string} */ f) => JSON.stringify(pathToFileURL(join(root, 'core', f)).href);
  const script = `const { weeklyReport } = await import(${url('report.mjs')}); const { emptyRecord } = await import(${url('ledger.mjs')});
    const at = Date.parse('2026-11-16T00:30:00+09:00');
    const w = weeklyReport({ records: [{ ...emptyRecord('W-1', at), outcome: 'merged', closedAt: at }], weeks: 1, now: Date.parse('2026-11-18T12:00:00+09:00') }).weeks[0];
    console.log(JSON.stringify([w.week, w.tickets]));`;
  const out = spawnSync('node', ['--input-type=module', '-e', script], { env: { ...env, TZ: 'Asia/Tokyo' }, encoding: 'utf8' });
  expect('report: weeks start at local midnight', out.stdout.trim(), JSON.stringify(['2026-W47', 1]));
}

/* ---------- whether a ticket has a PR, for the free draft PR ---------- */
{
  const summary = join(home, 'summary.json');
  const cases = /** @type {[string, string | null][]} */ ([
    ['no summary yet', null],
    ['a torn summary', '{"at": 1, "tick'],
    ['a summary of the wrong shape', '[]'],
    ['tickets of the wrong shape', '{"at": 1, "tickets": []}'],
    ['an entry of the wrong shape', '{"at": 1, "tickets": {"D-1": "x"}}'],
    ['no entry for the ticket', '{"at": 1, "tickets": {}}'],
    ['an entry without a PR', '{"at": 1, "tickets": {"D-1": {"prUrl": ""}}}'],
    ['an entry with a PR', '{"at": 1, "tickets": {"D-1": {"prUrl": "https://github.com/o/r/pull/1"}}}'],
  ]);
  const got = cases.map(([, text]) => {
    if (text === null) rmSync(summary, { force: true });
    else writeFileSync(summary, text);
    return hasPr('D-1');
  });
  rmSync(summary, { force: true });
  // Only a summary that says so reads as no PR; a missing one (the panel hasn't recorded anything yet) or one that can't
  // be read gates the draft PR instead.
  expect(`has PR: ${cases.map(([c]) => c).join(', ')}`, got, [true, true, true, true, true, false, false, true]);
  expect('has PR: no summary.json counts as a PR', hasPr('D-1'), true);
  expect('has PR: no ticket key is no PR', hasPr(null), false);
}

/* ---------- policy ---------- */
const leadDir = join(home, 'lead');
const wt = join(home, 'wt', 'D-1');
mkdirSync(leadDir, { recursive: true });
mkdirSync(wt, { recursive: true });
execFileSync('git', ['init', '-q', wt]);
writeFileSync(join(home, 'config.json'), JSON.stringify({ owner: 'Sam', trust: [], leadDir, pack: 'brinewick', promptMode: 'deny', repos: { repo: { path: repo, baseBranch: 'develop' } } }));
const crew = (/** @type {string} */ sid, /** @type {string[]} */ args, cwd = leadDir) => spawnSync('node', [join(root, 'cli', 'keelctl.mjs'), ...args], { cwd, env: { ...env, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_CODE_HOST_SESSION_ID: `local_${sid}` }, encoding: 'utf8' });
expect('register: the Mate joins', crew('lead-1', ['register', 'lead']).status, 0);
expect('register: the engineer joins', crew('eng-1', ['register', 'engineer', 'D-1', wt], wt).status, 0);
const pre = (/** @type {string} */ command, /** @type {string} */ sid, cwd = leadDir) => {
  const out = spawnSync('node', [join(root, 'hooks', 'policy.mjs')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sid, cwd, tool_name: 'Bash', tool_input: { command } }), env, encoding: 'utf8' });
  return (out.stdout ? JSON.parse(out.stdout) : {}).hookSpecificOutput?.permissionDecision ?? 'none';
};
expect('policy: anyone reads the report', [pre('~/.keelcrew/bin/keelctl ledger report --weeks 4 --json', 'lead-1'), pre('~/.keelcrew/bin/keelctl ledger report', 'eng-1', wt)], ['none', 'none']);
expect('policy: the Mate links a bug', pre('~/.keelcrew/bin/keelctl ledger link-bug BUG-9 --repo repo --file a.py --line 1', 'lead-1'), 'none');
expect('policy: a link with a substitution is refused', pre('~/.keelcrew/bin/keelctl ledger link-bug BUG-9 --repo repo --file $(id) --line 1', 'lead-1'), 'deny');
expect('policy: an engineer may not link bugs or scan reverts', [pre('~/.keelcrew/bin/keelctl ledger link-bug BUG-9 --repo repo --file a.py --line 1', 'eng-1', wt), pre('~/.keelcrew/bin/keelctl ledger reverts', 'eng-1', wt)], ['deny', 'deny']);
const shown = crew('lead-1', ['ledger', 'report', '--switch-on', '2026-10-01']);
expect('keelctl ledger report: prints weeks and the baseline', [shown.status, /before 2026-10-01:/.test(shown.stdout)], [0, true]);
// With no switch-on there is no baseline; a record missing its lists is skipped.
writeFileSync(join(home, 'ledger', 'BAD-9.json'), JSON.stringify({ key: 'BAD-9', kind: 'ticket', outcome: 'merged', closedAt: NOW }));
const auto = crew('lead-1', ['ledger', 'report', '--json']);
expect('keelctl ledger report: no switch-on, no baseline', [auto.status, auto.status === 0 ? JSON.parse(auto.stdout).baseline : 'failed'], [0, null]);

console.log(fail ? `${fail} linking checks fail, ${pass} pass` : `${pass}/${pass} linking checks pass`);
process.exitCode = fail ? 1 : 0;
