// @ts-check
// The ledger: records, events, the commit hook and the policy around them. Runs against a throwaway KEELCREW_HOME.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'keelcrew-ledger-'));
process.env.KEELCREW_HOME = home;
const env = { ...process.env, KEELCREW_HOME: home };
const { applyEvent, commitLedger, listRecords, readRecord } = await import('../core/ledger.mjs');

let pass = 0;
let fail = 0;
/** @param {string} label @param {unknown} got @param {unknown} want */
const expect = (label, got, want) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) pass++;
  else {
    fail++;
    console.log(`FAIL ${label}: ${a}, want ${b}`);
  }
};
/** @param {string} label @param {() => unknown} fn */
const throws = (label, fn) => {
  try {
    fn();
    expect(label, 'no error', 'an error');
  } catch {
    pass++;
  }
};

/* ---------- events ---------- */
expect('event: creates the record', applyEvent('task', 'BRIN-1', { title: 'Fix it', difficulty: 'simple', risk: 'low', sessions: ['s1'], prUrl: 'https://github.com/o/r/pull/7' }, { now: 1000 }), true);
expect('event: the same event again changes nothing', applyEvent('task', 'BRIN-1', { title: 'Fix it', difficulty: 'simple', risk: 'low', sessions: ['s1'], prUrl: 'https://github.com/o/r/pull/7' }), false);
const r1 = readRecord('BRIN-1');
expect('event: task fields copied', [r1?.title, r1?.difficulty, r1?.risk, r1?.sessions, r1?.prs], ['Fix it', 'simple', 'low', ['s1'], ['https://github.com/o/r/pull/7']]);
applyEvent('task', 'BRIN-1', { status: 'pr', sessions: ['s2'], title: null });
expect('event: a later task event merges, nulls skipped', [readRecord('BRIN-1')?.status, readRecord('BRIN-1')?.sessions, readRecord('BRIN-1')?.title], ['pr', ['s1', 's2'], 'Fix it']);
applyEvent('card', 'BRIN-1', { cardId: 'q-1', kind: 'question', createdAt: 0, answeredAt: 30 * 60_000, answer: 'A' });
applyEvent('card', 'BRIN-1', { cardId: 'q-2', kind: 'question', createdAt: 0, answer: null });
const cards = readRecord('BRIN-1')?.cards ?? {};
expect('card: wait and answer', [cards['q-1']?.waitMinutes, cards['q-1']?.answer], [30, 'A']);
expect('card: unanswered has no wait or answer', [cards['q-2']?.waitMinutes, cards['q-2']?.answer], [null, null]);
applyEvent('edits', 'BRIN-1', { shas: ['m1'], linesChanged: 5, linesInFinalDiff: 50 });
expect('edits: ratio', readRecord('BRIN-1')?.ownerEdit?.ratio, 0.1);
applyEvent('qa', 'BRIN-1', { passed: false });
applyEvent('qa', 'BRIN-1', { passed: true });
expect('qa: only the first verdict counts', readRecord('BRIN-1')?.qaFirstPass, false);
applyEvent('bug', 'BRIN-1', { ticket: 'BRIN-9', severity: 'sev-2', at: 5 });
applyEvent('bug', 'BRIN-1', { ticket: 'BRIN-9', severity: 'sev-2', at: 6 });
expect('bug: one entry per bug ticket', readRecord('BRIN-1')?.bugs30d.length, 1);
throws('outcome: must be known', () => applyEvent('outcome', 'BRIN-1', { outcome: 'shipped-ish' }));
throws('event: unknown type', () => applyEvent('vibes', 'BRIN-1', {}));
throws('event: bad key', () => applyEvent('task', '../etc', {}));
throws('card: needs an id', () => applyEvent('card', 'BRIN-1', {}));
applyEvent('output', 'pm-2026-W43', { verdict: 'edited', role: 'pm' });
applyEvent('edits', 'BRIN-1', { shas: ['m2'], linesChanged: 50, linesInFinalDiff: 5 });
expect('edits: the ratio is at most 1', readRecord('BRIN-1')?.ownerEdit?.ratio, 1);
applyEvent('spend', 'BRIN-1', { usd: 1.2, tokens: 900 });
applyEvent('spend', 'BRIN-1', { usd: 0, tokens: 0 });
expect('spend: a total never goes down (a folder left, or a later session joined)', [readRecord('BRIN-1')?.spendUsd, readRecord('BRIN-1')?.tokens], [1.2, 900]);
expect('output: other roles get records', [readRecord('pm-2026-W43')?.kind, readRecord('pm-2026-W43')?.verdict], ['output', 'edited']);
expect('list: all records', listRecords().records.map((r) => r.key), ['BRIN-1', 'pm-2026-W43']);
expect('commit: first commit', commitLedger('test'), true);
expect('commit: nothing new', commitLedger('test'), false);
expect('commit: the lock file stays out of git', execFileSync('git', ['-C', join(home, 'ledger'), 'ls-files'], { encoding: 'utf8' }).trim().split('\n'), ['BRIN-1.json', 'pm-2026-W43.json']);
{
  // A git that died mid-commit leaves index.lock behind: a fresh one is left alone, a stale one cleared.
  const indexLock = join(home, 'ledger', '.git', 'index.lock');
  const tryCommit = () => {
    try {
      return commitLedger('test');
    } catch {
      return 'refused';
    }
  };
  applyEvent('task', 'BRIN-1', { goal: 'ship it' });
  writeFileSync(indexLock, '');
  expect('commit: a fresh index.lock is left to its git', [tryCommit(), existsSync(indexLock)], ['refused', true]);
  const old = (Date.now() - 11 * 60_000) / 1000;
  utimesSync(indexLock, old, old);
  expect('commit: a stale index.lock is cleared', tryCommit(), true);
}

/* ---------- the commit hook ---------- */
const g = (dir, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const repo = join(home, 'repo');
mkdirSync(repo, { recursive: true });
g(repo, 'init', '-q', '-b', 'develop');
writeFileSync(join(repo, 'a.txt'), '1\n');
g(repo, 'add', '.');
g(repo, 'commit', '-q', '-m', 'base');
const wt = join(home, 'wt', 'BRIN-2');
g(repo, 'worktree', 'add', '-q', '-b', 'brin-2', wt);
const leadDir = join(home, 'lead');
mkdirSync(leadDir, { recursive: true });
writeFileSync(join(home, 'config.json'), JSON.stringify({ owner: 'Sam', trust: [], leadDir, pack: 'brinewick', promptMode: 'deny' }));
const crew = (sid, args, cwd = wt) => spawnSync('node', [join(root, 'cli', 'keelctl.mjs'), ...args], { cwd, env: { ...env, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_CODE_HOST_SESSION_ID: `local_${sid}` }, encoding: 'utf8' });
expect('register: engineer joins', crew('eng-2', ['register', 'engineer', 'BRIN-2', wt]).status, 0);
expect('register: lead joins', crew('lead-1', ['register', 'lead', '-', leadDir], leadDir).status, 0);
let n = 0;
/** One run of the ledger hook. @param {string} event @param {string} sid @param {string} id @param {string} [cwd] */
const hook = (event, sid, id, cwd = leadDir) => spawnSync('node', [join(root, 'hooks', 'ledger.mjs')], { input: JSON.stringify({ hook_event_name: event, session_id: sid, tool_use_id: id, tool_name: 'Bash', cwd, tool_input: { command: 'x' } }), env, encoding: 'utf8' });
/** Runs the hook around a git action, as Claude Code would around one Bash call. @param {() => void} action @param {string} [sid] */
const around = (action, sid = 'eng-2', after = 'PostToolUse', cwd = leadDir) => {
  const id = `toolu_${++n}`;
  const pre = hook('PreToolUse', sid, id, cwd);
  action();
  const post = hook(after, sid, id, cwd);
  expect(`hook: silent and clean (${id})`, [pre.status, pre.stdout, post.status, post.stdout], [0, '', 0, '']);
};
/** Commits one new file. @param {string} dir @param {string} file @param {Record<string, string>} [dates] committed then */
const commitFile = (dir, file, dates) => {
  writeFileSync(join(dir, file), `${file}\n`);
  g(dir, 'add', '.');
  if (!dates) return void g(dir, 'commit', '-q', '-m', file);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', file], { env: { ...process.env, ...dates } });
};
const OLD = { GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z' };
const shas = () => readRecord('BRIN-2')?.crewShas ?? [];
around(() => {
  writeFileSync(join(wt, 'b.txt'), 'b\n');
  g(wt, 'add', '.');
  g(wt, 'commit', '-q', '-m', 'crew one');
});
const c1 = g(wt, 'rev-parse', 'HEAD');
expect('hook: a commit is recorded (from the Mate folder, worktree from the registry)', shas(), [c1]);
around(() => g(wt, 'commit', '-q', '--amend', '-m', 'crew one, amended'));
const c1b = g(wt, 'rev-parse', 'HEAD');
expect('hook: an amend records the new commit', shas().includes(c1b), true);
// Someone else's commits land on develop; merging develop in records only the merge commit.
writeFileSync(join(repo, 'c.txt'), 'c\n');
g(repo, 'add', '.');
g(repo, 'commit', '-q', '-m', 'other people on develop');
const baseSha = g(repo, 'rev-parse', 'HEAD');
around(() => g(wt, 'merge', '-q', '--no-edit', 'develop'));
const mergeSha = g(wt, 'rev-parse', 'HEAD');
expect('hook: a merge records the merge commit', shas().includes(mergeSha), true);
expect("hook: never what the merge brought in", shas().includes(baseSha), false);
// The captain commits in the same worktree outside any crew call: not recorded.
writeFileSync(join(wt, 'd.txt'), 'd\n');
g(wt, 'add', '.');
g(wt, 'commit', '-q', '-m', 'owner edit');
const owner = g(wt, 'rev-parse', 'HEAD');
around(() => {});
expect("hook: the captain's commit is not recorded", shas().includes(owner), false);
around(() => {
  writeFileSync(join(wt, 'e.txt'), 'e\n');
  g(wt, 'add', '.');
  g(wt, 'commit', '-q', '-m', 'crew two');
}, 'lead-1');
expect("hook: the Mate's session records nothing", existsSync(join(home, 'ledger', 'lead.json')), false);
around(() => {
  writeFileSync(join(wt, 'f.txt'), 'f\n');
  g(wt, 'add', '.');
  g(wt, 'commit', '-q', '-m', 'crew three, then the tests failed');
}, 'eng-2', 'PostToolUseFailure');
expect('hook: a commit from a call that then failed is recorded', shas().includes(g(wt, 'rev-parse', 'HEAD')), true);
{
  // A new engineer with no commits of its own fast-forwards to teammates' older commits on develop: none of them is the crew's.
  const wt5 = join(home, 'wt', 'BRIN-5');
  g(repo, 'worktree', 'add', '-q', '-b', 'brin-5', wt5, 'develop');
  expect('register: a second engineer joins', crew('eng-5', ['register', 'engineer', 'BRIN-5', wt5], wt5).status, 0);
  writeFileSync(join(repo, 'h.txt'), 'h\n');
  g(repo, 'add', '.');
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'teammate on develop'], { env: { ...process.env, GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z' } });
  around(() => g(wt5, 'merge', '-q', '--ff-only', 'develop'), 'eng-5');
  expect("hook: a fast-forward to teammates' commits records nothing", readRecord('BRIN-5')?.crewShas ?? [], []);
}
{
  // BRIN-7: the captain's own session in the worktree, overlapping calls, and a call that met a held ledger lock.
  const wt7 = join(home, 'wt', 'BRIN-7');
  g(repo, 'worktree', 'add', '-q', '-b', 'brin-7', wt7, 'develop');
  expect('register: engineer 7 joins', crew('eng-7', ['register', 'engineer', 'BRIN-7', wt7], wt7).status, 0);
  const shas7 = () => readRecord('BRIN-7')?.crewShas ?? [];
  const head7 = () => g(wt7, 'rev-parse', 'HEAD');
  around(() => commitFile(wt7, 'own7.txt'), 'owner-s', 'PostToolUse', wt7);
  expect("hook: the captain's own session in an engineer's worktree records nothing", shas7().includes(head7()), false);
  const [a, b] = [`toolu_${++n}`, `toolu_${++n}`];
  hook('PreToolUse', 'eng-7', a);
  commitFile(wt7, 'x7.txt');
  const x7 = head7();
  hook('PreToolUse', 'eng-7', b);
  commitFile(wt7, 'y7.txt');
  const y7 = head7();
  hook('PostToolUse', 'eng-7', b);
  hook('PostToolUse', 'eng-7', a);
  expect('hook: two overlapping calls in one session both count', [shas7().includes(x7), shas7().includes(y7)], [true, true]);
  const z = `toolu_${++n}`;
  hook('PreToolUse', 'eng-7', z);
  commitFile(wt7, 'z7.txt');
  const z7 = head7();
  const lock = join(home, 'ledger', '.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'held', at: Date.now() }));
  hook('PostToolUse', 'eng-7', z);
  rmSync(lock, { recursive: true, force: true });
  expect('hook: a call that met a held lock records nothing yet', shas7().includes(z7), false);
  around(() => {}, 'eng-7');
  expect("hook: the session's next call records it", shas7().includes(z7), true);
}
const wt6 = join(home, 'wt', 'BRIN-6');
const shas6 = () => readRecord('BRIN-6')?.crewShas ?? [];
{
  // BRIN-6: the captain commits, the crew commits, then the crew rebases onto a newer develop.
  g(repo, 'worktree', 'add', '-q', '-b', 'brin-6', wt6, 'develop');
  expect('register: engineer 6 joins', crew('eng-6', ['register', 'engineer', 'BRIN-6', wt6], wt6).status, 0);
  commitFile(wt6, 'o6.txt');
  around(() => commitFile(wt6, 'c6.txt'), 'eng-6');
  commitFile(repo, 'q6.txt', OLD);
  around(() => g(wt6, 'rebase', '-q', 'develop'), 'eng-6');
  const [c6, o6] = g(wt6, 'rev-list', '-2', 'HEAD').split('\n');
  expect("hook: a crew rebase keeps the crew's commit the crew's and the captain's the captain's", [shas6().includes(c6), shas6().includes(o6)], [true, false]);
}
expect('hook: no snapshots left behind', spawnSync('sh', ['-c', `ls ${join(home, 'cache', 'heads')} | wc -l`], { encoding: 'utf8' }).stdout.trim(), '0');

/* ---------- feeding board facts, captain edits and spend ---------- */
{
  const { feed, measureEdits, recordSpend } = await import('../core/ledgerfeed.mjs');
  const facts = {
    tasks: [
      { id: 'BRIN-3', data: { title: 'Three', status: 'active', difficulty: 'moderate', sessionId: 'e3', agents: { qa: { sessionId: 'q3' } }, updatedAt: 1 } },
      { id: 'T-4', data: { title: 'Owner task', status: 'done', updatedAt: 1 } },
      { id: 'not a key', data: { status: 'active' } },
    ],
    inbox: [
      { id: 'qa-2', data: { kind: 'qa', taskKey: 'BRIN-3', createdAt: 20, cases: [{ verdict: 'pass' }, { verdict: 'pass' }] } },
      { id: 'qa-1', data: { kind: 'qa', taskKey: 'BRIN-3', createdAt: 10, cases: [{ verdict: 'pass' }, { verdict: 'fail' }] } },
      { id: 'q-1', data: { kind: 'question', taskKey: 'BRIN-3', createdAt: 0, answeredAt: 600_000, answer: 'Yes' } },
      { id: 'info-1', data: { kind: 'info' } },
    ],
  };
  const first = feed(facts);
  expect('feed: records changed', first.changed > 0, true);
  expect('feed: the same facts again change nothing', feed(facts).changed, 0);
  const r3 = readRecord('BRIN-3');
  expect('feed: sessions from the row and its agents', r3?.sessions, ['e3', 'q3']);
  expect('feed: a card with its wait and answer', [r3?.cards['q-1']?.waitMinutes, r3?.cards['q-1']?.answer], [10, 'Yes']);
  expect('feed: the earliest QA card decides the first pass', r3?.qaFirstPass, false);
  expect('feed: a captain’s task done without a PR is done', readRecord('T-4')?.outcome, 'done');
  expect('feed: rows that are not keys are skipped', readRecord('BRIN-3') !== null && listRecords().records.every((r) => r.key !== 'not a key'), true);
  facts.tasks[0].data = { ...facts.tasks[0].data, status: 'pr', updatedAt: 2 };
  expect('feed: ready work is reported for edit measurement', feed(facts).ready, ['BRIN-3', 'T-4']);
  facts.tasks[0].data = { ...facts.tasks[0].data, status: 'active', updatedAt: 3 };
  feed(facts);
  expect('feed: a row going back is still applied', readRecord('BRIN-3')?.status, 'active');
  feed({ merges: [{ key: 'BRIN-3', prNumber: 12, mergedAt: 99, mergeSha: 'abc' }] });
  expect('feed: a recorded merge', [readRecord('BRIN-3')?.prNumber, readRecord('BRIN-3')?.mergedAt, readRecord('BRIN-3')?.mergeSha], [12, 99, 'abc']);
  feed({ inbox: [
    { id: 'proposal-cto-a1-1', data: { kind: 'proposal', from: 'cto', answer: 'File a ticket' } },
    { id: 'proposal-pm-b2-1', data: { kind: 'proposal', from: 'pm', answer: 'Not now' } },
    { id: 'design-T-4-1', data: { kind: 'question', from: 'designer', taskKey: 'T-4', answer: 'Change it' } },
    { id: 'proposal-cto-c3-1', data: { kind: 'proposal', from: 'cto' } },
    { id: 'q-eng-1', data: { kind: 'question', from: 'engineer', answer: 'Yes' } },
    { id: 'proposal-suggest-d4-1', data: { kind: 'proposal', from: 'suggest', source: 'security', answer: 'Skip it' } },
    { id: 'proposal-suggest-e5-1', data: { kind: 'proposal', from: 'suggest', source: 'health', answer: 'Start it', autoStarted: true } },
  ] });
  expect("feed: a suggestion counts toward its source; one the Mate started by itself doesn't", [readRecord('proposal-suggest-d4-1')?.role, readRecord('proposal-suggest-d4-1')?.verdict, readRecord('proposal-suggest-e5-1')], ['suggest:security', 'rejected', null]);
  expect("feed: roles' outputs judged by the captain's answer", ['proposal-cto-a1-1', 'proposal-pm-b2-1', 'design-T-4-1'].map((k) => [readRecord(k)?.kind, readRecord(k)?.role, readRecord(k)?.verdict]), [['output', 'cto', 'accepted'], ['output', 'pm', 'rejected'], ['output', 'designer', 'edited']]);
  expect('feed: an unanswered card or an engineer question is no output', [readRecord('proposal-cto-c3-1'), readRecord('q-eng-1')], [null, null]);

  // The captain's edits on BRIN-2: everything on the branch since the base that the crew didn't commit.
  writeFileSync(join(home, 'config.json'), JSON.stringify({ owner: 'Sam', trust: [], leadDir, pack: 'brinewick', promptMode: 'deny', repos: { repo: { path: join(home, 'wt'), baseBranch: 'develop' } } }));
  g(repo, 'update-ref', 'refs/remotes/origin/develop', baseSha);
  const e = measureEdits('BRIN-2');
  expect('edits: owner commits and lines (crew commits excluded, merges ignored)', [e?.owner, e?.linesChanged, e?.linesInFinalDiff], [2, 2, 4]);
  expect('edits: ratio on the record', readRecord('BRIN-2')?.ownerEdit?.ratio, 0.5);
  expect('edits: no worktree, no measurement', measureEdits('BRIN-3'), null);

  // BRIN-6: the captain rebases the branch (or GitHub updates it), giving the crew's commit a new sha; then the crew
  // merges a teammate's stacked branch in. Neither is an owner edit: only the captain's own o6.txt is.
  commitFile(repo, 'q6b.txt', OLD);
  g(wt6, 'rebase', '-q', 'develop');
  const stack = join(home, 'stack6');
  g(repo, 'worktree', 'add', '-q', '-b', 'stack6', stack, 'develop');
  commitFile(stack, 's6.txt');
  around(() => g(wt6, 'merge', '-q', '--no-edit', 'stack6'), 'eng-6');
  g(repo, 'update-ref', 'refs/remotes/origin/develop', g(repo, 'rev-parse', 'develop'));
  const e6 = measureEdits('BRIN-6');
  expect('edits: a rebased crew commit and a merged-in branch are not captain edits', [e6?.owner, e6?.linesChanged, e6?.linesInFinalDiff], [1, 1, 3]);

  // Outcomes follow the row: done, parked, then done again.
  for (const [status, updatedAt] of [['done', 1], ['parked', 2], ['done', 3]]) feed({ tasks: [{ id: 'T-6', data: { status, updatedAt } }] });
  expect('feed: a row done again after parking is done', readRecord('T-6')?.outcome, 'done');
  feed({ tasks: [{ id: 'T-9', data: { status: 'parked', updatedAt: 1 } }] });
  feed({ tasks: [{ id: 'T-9', data: { status: 'active', updatedAt: 2 } }] });
  expect('feed: a parked row back at work has no outcome', [readRecord('T-9')?.status, readRecord('T-9')?.outcome ?? null], ['active', null]);
  feed({ tasks: [
    { id: 'T-7', data: { status: 'active', sessionId: 'c7', agents: { contractor: { sessionId: 'c7' } }, updatedAt: 1 } },
    { id: 'T-8', data: { status: 'active', sessionId: 'e8', updatedAt: 1 } },
    { id: 'T-9', data: { status: 'active', agents: { engineer: { sessionId: 'e9' } }, updatedAt: 1 } },
    { id: 'T-10', data: { status: 'active', updatedAt: 1 } },
  ] });
  expect('feed: the role from the row (contractor, engineer session, engineer agent, nobody)', ['T-7', 'T-8', 'T-9', 'T-10'].map((k) => readRecord(k)?.role), ['contractor', 'engineer', 'engineer', null]);

  // A damaged record is skipped and named; the rest is still fed and spend still recorded.
  writeFileSync(join(home, 'ledger', 'BAD-1.json'), '{ not json');
  writeFileSync(join(home, 'ledger', 'BAD-2.json'), JSON.stringify({ key: 'BAD-2', cards: {} }));
  const tasks = ['BAD-1', 'BAD-2', 'OK-1'].map((id) => ({ id, data: { status: 'active', updatedAt: 1 } }));
  let fed = null;
  try {
    fed = feed({ tasks }).damaged;
  } catch {
    fed = 'threw';
  }
  expect('feed: damaged records skipped and named', [fed, readRecord('OK-1')?.status], [['BAD-1', 'BAD-2'], 'active']);
  expect('list: a record missing its lists is damaged, not listed', listRecords().damaged, ['BAD-1.json', 'BAD-2.json']);
  throws('read: a record of the wrong shape is damaged', () => readRecord('BAD-2'));
  writeFileSync(join(home, 'facts.json'), JSON.stringify({ tasks }));
  expect('keelctl ledger feed: still succeeds', crew('lead-1', ['ledger', 'feed', join(home, 'facts.json')], leadDir).status, 0);
  writeFileSync(join(home, 'ledger', 'BRIN-5.json'), '{ not json');
  let spent = null;
  try {
    spent = recordSpend().damaged;
  } catch {
    spent = 'threw';
  }
  expect('spend: a damaged record is skipped and named', spent, ['BRIN-5']);
  for (const f of ['BAD-1.json', 'BAD-2.json', 'BRIN-5.json']) rmSync(join(home, 'ledger', f));
}

/* ---------- policy: crew sessions read records, never write them ---------- */
const pre = (command, sid) => {
  const r = spawnSync('node', [join(root, 'hooks', 'policy.mjs')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sid, cwd: sid === 'lead-1' ? leadDir : wt, tool_name: 'Bash', tool_input: { command } }), env, encoding: 'utf8' });
  const out = r.stdout ? JSON.parse(r.stdout) : {};
  return out.hookSpecificOutput?.permissionDecision ?? 'none';
};
expect('policy: an engineer reads a record', pre('~/.keelcrew/bin/keelctl ledger show BRIN-2', 'eng-2'), 'none');
expect('policy: the Mate lists records', pre('~/.keelcrew/bin/keelctl ledger list --json', 'lead-1'), 'none');
expect('policy: the Mate may not record an event', pre(`~/.keelcrew/bin/keelctl ledger event outcome BRIN-2 '{"outcome":"merged"}'`, 'lead-1'), 'deny');
expect('policy: an engineer may not record an event', pre("~/.keelcrew/bin/keelctl ledger event shas BRIN-2 '{\"shas\":[\"x\"]}'", 'eng-2'), 'deny');
expect('policy: quoting the subcommand changes nothing', pre('~/.keelcrew/bin/keelctl "ledger" "ev"ent outcome BRIN-2 {}', 'eng-2'), 'deny');
expect('policy: the Mate may not feed facts', pre('~/.keelcrew/bin/keelctl ledger feed /tmp/x.json', 'lead-1'), 'deny');
expect('policy: node keelctl.mjs ledger commit denied', pre(`node ${join(root, 'cli', 'keelctl.mjs')} ledger commit`, 'lead-1'), 'deny');
expect('policy: no hand edits to a record', pre(`echo {} > ~/.keelcrew/ledger/BRIN-2.json`, 'eng-2'), 'deny');

console.log(fail ? `${fail} ledger checks fail, ${pass} pass` : `${pass}/${pass} ledger checks pass`);
process.exitCode = fail ? 1 : 0;
