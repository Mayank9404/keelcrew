// Runs the crew hooks the way Claude Code does (JSON on stdin) against a throwaway crew home.
// node plugins/keelcrew/tests/hooks.test.mjs
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Built from pieces so no shell guard mistakes this file's text for the command itself.
const PR_CREATE = ['gh', 'pr', 'create'].join(' ');
const home = mkdtempSync(join(tmpdir(), 'keelcrew-test-'));
const wt = join(home, 'wt', 'brin-1');
const other = join(home, 'elsewhere');
mkdirSync(wt, { recursive: true });
mkdirSync(other, { recursive: true });
const env = { ...process.env, KEELCREW_HOME: home };
// These checks are about what asks; promptMode "deny" (the default) is tested in safety.test.mjs.
writeFileSync(join(home, 'config.json'), JSON.stringify({ owner: 'Sam', shipMode: 'card', trust: [], pack: 'brinewick', promptMode: 'ask' }));
writeFileSync(join(home, 'crew.json'), JSON.stringify({ dirs: { [wt]: { role: 'engineer', key: 'BRIN-1' } } }));

const run = (hook, input) => {
  const r = spawnSync('node', [join(root, 'hooks', hook)], { input: JSON.stringify(input), env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${hook} exited ${r.status}: ${r.stderr}`);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'none';
};
const pre = (tool, tool_input, cwd = wt, session_id) => run('policy.mjs', { hook_event_name: 'PreToolUse', cwd, session_id, tool_name: tool, tool_input });
const ship = (answer, form = 'map') => {
  const q = 'Ship BRIN-1: how should it go out?';
  const tool_response = form === 'map' ? { questions: [{ question: q }], answers: { [q]: answer } } : `User has answered your questions: "${q}"="${answer}". You can now continue.`;
  run('grant.mjs', { hook_event_name: 'PostToolUse', cwd: wt, tool_name: 'AskUserQuestion', tool_input: { questions: [{ header: 'Ship', question: q, options: [] }] }, tool_response });
};
const askQ = (header) => ({ questions: [{ header, question: 'Which way?', options: [{ label: 'A' }, { label: 'B' }] }] });

let bad = 0, n = 0;
const expect = (label, got, want) => {
  n++;
  if (got !== want) { bad++; console.log(`FAIL ${label}: ${got}, want ${want}`); }
};

// Other sessions are never touched.
expect('other session push', pre('Bash', { command: 'git push origin HEAD' }, other), 'none');
expect('other session send mail', pre('mcp__x__outlook_send_mail', {}, other), 'none');
expect('other session asks the captain freely', pre('AskUserQuestion', askQ('Design'), other), 'none');

// Never allowed.
for (const c of ['git push --force origin x', 'git push origin develop', 'gh pr merge 12', '.venv/bin/alembic upgrade head', 'cat .env', 'psql -c "delete from x"', 'claude mcp add x']) {
  expect(`deny: ${c}`, pre('Bash', { command: c }), 'deny');
}
for (const c of ['git rebase origin/develop', 'git branch -d T-5-x', 'sudo ls']) expect(`left to auto mode: ${c}`, pre('Bash', { command: c }), 'none');
for (const c of ['helm upgrade x charts/x', 'cd charts && helm install x .', 'kubectl apply -f x.yaml', 'terraform apply', 'helm\tupgrade x charts/x', 'helm \\\n  upgrade x charts/x', 'S=/tmp/helm && /opt/homebrew/bin/helm upgrade x charts/x', 'helm &>/dev/null upgrade x ./c', 'helm &>>/tmp/l upgrade x ./c']) expect(`deny: ${c}`, pre('Bash', { command: c }), 'deny');
// kubectl reads are fine; anything that changes a cluster, runs in it, or reads its secrets is not, wrapped or not.
for (const c of ['kubectl get pods -n prod', 'kubectl -n prod logs deploy/api --tail=50', 'kubectl --context=qa describe pod x', 'kubectl --namespace qa top pods', 'kubectl get pods | grep api', 'watch kubectl get pods', 'kubectl version', 'grep -rn kubectl docs']) expect(`ok: ${c}`, pre('Bash', { command: c }), 'none');
for (const c of ['kubectl delete pod x', 'kubectl -n get delete pod x', 'kubectl exec -it x -- sh', 'kubectl rollout restart deploy/x', 'kubectl port-forward svc/x 8080', 'kubectl config view --raw', 'kubectl get secret db -o yaml', 'kubectl describe secrets', 'kubectl get pods -o name | xargs kubectl delete', 'xargs -I{} kubectl delete pod {}', "bash -c 'kubectl delete pod x'", 'env KUBECONFIG=x kubectl apply -f y', 'kubectl -A get pods', 'kubectl get pods; t(){ kubectl exec -n x p -- ls; }; t', 'T="kubectl exec -n x p"; kubectl get pods; $T -- ls', 'kubectl get pods\nkubectl delete pod x', 'if true; then kubectl delete pod x; fi', 'kubectl get pods `kubectl delete pod x`']) expect(`deny: ${c}`, pre('Bash', { command: c }), 'deny');
expect('ok: kubectl config current-context', pre('Bash', { command: 'kubectl config current-context; kubectl get pods -n x' }), 'none');
for (const c of ['kubectl rollout status deploy/web', 'kubectl auth can-i list pods', 'kubectl events -n prod', 'kubectl config view', 'kubectl get pods -l app=secret-store', 'kubectl --insecure-skip-tls-verify get pods', 'kubectl -v=6 get pods', 'kubectl get --raw /metrics']) expect(`ok: ${c}`, pre('Bash', { command: c }), 'none');
for (const c of ['kubectl --cache-dir="/tmp/ get" delete ns prod', 'kubectl get-x', 'kubectl get --raw /api/v1/namespaces/p/services/web:80/proxy/reset', 'Kubectl delete ns prod', ' kubectl delete ns prod', '/usr/local/bin/kubectl delete ns prod', 'KUBECONFIG=~/.kube/prod kubectl delete ns prod', 'if kubectl delete ns prod; then true; fi', "bash -lc 'kubectl delete ns prod'", 'find . -exec kubectl delete ns prod +', "bash <<< 'kubectl delete ns prod'", "kube''ctl delete ns prod", 'kubectl get SECRETS -o yaml', 'kubectl get "secret"s -o yaml', 'kubectl config view --raw']) expect(`deny: ${c}`, pre('Bash', { command: c }), 'deny');
for (const c of ['cat deploy/helm-charts/values.yaml', 'grep -rn image helm-charts/', 'helm lint charts/x', 'helm template x charts/x', 'S=/tmp/s/helm && mkdir -p $S && git archive origin/develop charts/x | tar -x -C $S', 'S=/tmp/s/helm\nH=/opt/homebrew/bin/helm\n$H lint charts/x', 'S=/tmp/s/helm; ls $S', 'W=/tmp/g/wt; ln -s /Users/x/repo/.venv $W/.venv && ls $W/.venv; rm $W/.venv']) expect(`ok: ${c}`, pre('Bash', { command: c }), 'none');
// Outside the worktree and temp (where crew members may write, as from the shell).
const away = join(homedir(), 'keelcrew-test-elsewhere');
expect('deny: edit outside worktree', pre('Edit', { file_path: join(away, 'a.py') }), 'deny');
expect('deny: read a secret', pre('Read', { file_path: join(wt, '.env') }), 'deny');
expect('deny: forge an approval', pre('Bash', { command: `echo '{}' > ~/.keelcrew/grants/x.json` }), 'deny');
expect('ok: edit inside worktree', pre('Edit', { file_path: join(wt, 'a.py') }), 'none');
expect('ok: lint', pre('Bash', { command: 'ruff check --no-fix .' }), 'none');
expect('ok: register', pre('Bash', { command: '~/.keelcrew/bin/keelctl register engineer BRIN-1' }), 'none');
// Protected branches come from the rules plus the pack, and must be the whole branch name.
expect('deny: checkout a protected branch', pre('Bash', { command: 'git checkout develop' }), 'deny');
expect('deny: switch to a protected branch', pre('Bash', { command: 'git switch main' }), 'deny');
expect('ok: checkout a branch named after one', pre('Bash', { command: 'git checkout develop-fix-1' }), 'none');
expect('ok: restore a file named like one', pre('Bash', { command: 'git checkout main.py' }), 'none');
expect('deny: push to refs/heads/develop', pre('Bash', { command: 'git push origin HEAD:refs/heads/develop' }), 'deny');
expect('deny: edit the crew settings', pre('Write', { file_path: '~/.keelcrew/config.json', content: '{}' }), 'deny');
expect('deny: edit crew memory by hand', pre('Bash', { command: 'echo x >> ~/.keelcrew/memory/lessons.jsonl' }), 'deny');
expect('deny: edit crew files through the real home path', pre('Bash', { command: `echo {} > ${join(home, 'crew.json')}` }), 'deny');
expect('ok: read the crew list', pre('Read', { file_path: join(home, 'crew.json') }), 'none');
expect('engineer: cannot change setup', pre('Bash', { command: '~/.keelcrew/bin/keelctl setup --pack none' }), 'deny');
expect('engineer: cannot forget lessons', pre('Bash', { command: '~/.keelcrew/bin/keelctl memory forget pr-body' }), 'deny');
expect('engineer: cannot rescope lessons', pre('Bash', { command: '~/.keelcrew/bin/keelctl memory scope pr-body --repo nope' }), 'deny');
expect('engineer: may add lessons', pre('Bash', { command: '~/.keelcrew/bin/keelctl memory add --type style --key k --text t' }), 'none');

// Shipping without a card asks; each card answer allows exactly its commands.
expect('no card: own branch push runs', pre('Bash', { command: 'git push -u origin HEAD' }), 'allow');
expect('no card: a PR asks', pre('Bash', { command: `${PR_CREATE} --base develop --title x` }), 'ask');
expect('no card: a draft PR whose risk cannot be read asks', pre('Bash', { command: `${PR_CREATE} --draft --title x` }), 'ask');
writeFileSync(join(home, 'summary.json'), JSON.stringify({ at: 1, tickets: { 'BRIN-1': { prUrl: 'https://github.com/o/r/pull/1' } } }));
expect('no card: a push to a branch with a PR runs', pre('Bash', { command: 'git push -u origin HEAD' }), 'allow');
rmSync(join(home, 'summary.json'));
ship('Push only');
expect('push only: push', pre('Bash', { command: 'git push -u origin HEAD' }), 'allow');
expect('push only: pr asks', pre('Bash', { command: `${PR_CREATE} --base develop --title x` }), 'ask');
expect('push only: chained pr asks', pre('Bash', { command: `git push -u origin HEAD && ${PR_CREATE} --base develop --title x` }), 'ask');
ship('Draft PR', 'text');
expect('draft (text answer): push', pre('Bash', { command: 'git push -u origin HEAD' }), 'allow');
expect('draft: draft pr', pre('Bash', { command: `${PR_CREATE} --draft --base develop --title x --body-file pr_body.md` }), 'allow');
expect('draft: normal pr asks', pre('Bash', { command: `${PR_CREATE} --base develop --title x` }), 'ask');
expect('draft: mark ready asks', pre('Bash', { command: 'gh pr ready 12' }), 'ask');
ship('Open PR');
expect('open: push + pr', pre('Bash', { command: `git push -u origin HEAD && ${PR_CREATE} --base develop --title x` }), 'allow');
expect('open: pr ready on its own branch', pre('Bash', { command: 'gh pr ready' }), 'allow');
// The approval covers this ticket's PR only: another number is refused until the panel knows the PR is its own.
expect("open: pr ready on a PR it can't tell is its own asks", pre('Bash', { command: 'gh pr ready 12' }), 'ask');
writeFileSync(join(home, 'summary.json'), JSON.stringify({ at: 1, tickets: { 'BRIN-1': { prUrl: 'https://github.com/o/r/pull/12' } } }));
expect('open: pr ready on its own PR', pre('Bash', { command: 'gh pr ready 12' }), 'allow');
rmSync(join(home, 'summary.json'));
expect('open: a GitHub write rides along and still asks', pre('Bash', { command: 'git push -u origin HEAD && gh issue create --title x' }), 'ask');
ship('Not yet');
expect('not yet clears the approval', existsSync(join(home, 'grants')) && pre('Bash', { command: `${PR_CREATE} --base develop --title x` }), 'ask');

// Connector tools: an engineer's reads and writes run; Claude Code's own permissions judge them.
expect('mail search runs', pre('mcp__0a1b2c3d__outlook_email_search', {}), 'none');
expect('send mail runs', pre('mcp__0a1b2c3d__outlook_send_mail', {}), 'none');
expect('teams message runs', pre('mcp__0a1b2c3d__teams_send_chat_message', {}), 'none');
expect('notion create runs', pre('mcp__7a8b__notion-create-pages', {}), 'none');
expect('notion fetch runs', pre('mcp__7a8b__notion-fetch', {}), 'none');
expect('jira transition runs', pre('mcp__1a2b__transitionJiraIssue', {}), 'none');
expect('jira executeRead runs', pre('mcp__1a2b__executeRead', {}), 'none');
expect('prod db query runs', pre('mcp__brinewick-db-prod__query', {}), 'none');
expect('unknown connector verb runs', pre('mcp__abc__frobnicate', {}), 'none');
expect('a Jenkins build asks', pre('mcp__3c4d__triggerBuild', { jobName: 'x' }), 'ask');
expect('a Jenkins rebuild asks', pre('mcp__3c4d__rebuildBuild', { jobName: 'x' }), 'ask');
expect('a Jenkins log read runs', pre('mcp__3c4d__getBuildLog', { jobName: 'x' }), 'none');

// Board-only helper tools are blocked for every session, crew or not.
for (const t of ['approve', 'prompt_save', 'config_set']) {
  expect(`crew agent: ${t} denied`, pre(`mcp__keelcrew-local__${t}`, {}), 'deny');
  expect(`other session: ${t} denied`, pre(`mcp__keelcrew-local__${t}`, {}, other), 'deny');
}
expect('helper reads run', pre('mcp__keelcrew-local__crew_state', {}), 'none');

// Tools that act only on this Mac.
expect('turn wrap-up runs', pre('mcp__ccd_turn__wrap_up', { recap: 'r' }), 'none');
expect('turn plan runs', pre('mcp__ccd_turn__update_plan', { advance: true }), 'none');
expect('ReportFindings runs', pre('ReportFindings', { findings: [] }), 'none');
expect('engineer: reveal_path asks', pre('mcp__ccd_host__reveal_path', { path: '/x' }), 'ask');
const scratch = (sid) => `/private/tmp/claude-${process.getuid()}/-proj/${sid}/scratchpad/n.md`;
expect('own scratch folder writes', pre('Write', { file_path: scratch('s-eng'), content: 'x' }, wt, 's-eng'), 'none');
expect("another session's scratch folder denied", pre('Write', { file_path: scratch('s-other'), content: 'x' }, wt, 's-eng'), 'deny');

// The rules read a command without the text it only carries: heredoc bodies and the prose of programs that never run it.
const commitOf = (msg) => `git commit -m "$(cat <<'EOF'\n${msg}\n\nCo-authored: x\nEOF\n)"`;
for (const c of [
  commitOf('fix: refuse git push --force-with-lease in hook\n\nkubectl delete and gh pr merge are for people'),
  'git commit -m "docs: never git push --force to develop; claude plugin install is the captain\'s"',
  'git commit -m "fix(terraform): bump provider" && git log --grep=terraform --oneline',
  'grep -rn "git push --force" docs/ && rg -n "kubectl apply|helm upgrade" docs',
  "cat > notes/runbook.md <<'EOF'\n# Runbook\nkubectl rollout restart deploy/api\nterraform apply\nEOF",
  "echo 'cat .env, then psql -c \"delete from x\"' >> notes.md",
  '~/.keelcrew/bin/keelctl memory add --type pref --key k --text "Owner: never git push --force; never alembic upgrade" --source chat --ref c1',
  'git config core.hooksPath; git grep -n core.hooksPath',
]) expect(`text only: ${JSON.stringify(c)}`, pre('Bash', { command: c }), 'none');
expect('text only: a PR body naming helm upgrade waits for the card, not a rule', pre('Bash', { command: `${PR_CREATE} --draft --title x --body "$(cat <<'EOF'\n| deploy | helm upgrade api ./chart |\nEOF\n)"` }), 'ask');
// Text that a shell, an interpreter, a substitution or arithmetic could run is read whole.
for (const c of [
  'bash <<EOF\ngit push --force origin x\nEOF',
  'sh -c "git push --force origin x"',
  'eval "$(echo git push --force origin x)"',
  "$(cat <<'EOF'\ngit push --force origin x\nEOF\n)",
  'git commit -m "$(gh pr merge 12)"',
  "cat <<'EOF' | bash\ngit push --force origin x\nEOF",
  "echo 'git push --force origin x' | sh",
  "cat <<'EOF' > >(bash)\ngit push --force origin x\nEOF",
  "node <<'EOF'\nrequire('child_process').execSync('git push --force origin x')\nEOF",
  "ssh host <<'EOF'\ngit push --force origin x\nEOF",
  "printf -v x '%s' 'git push --force origin x'; $x",
  "x='a[$(git push --force origin x)]'; echo $[x]",
  "x='a[$(git push --force origin x)]'; echo $((x))",
  "${x:=$'a[\\x24\\x28 git push --force origin x\\x29]'} $[x]",
  "git -c alias.p='!git push --force origin x' p",
  '((x=1<<b))\ngit push --force origin x\nb',
  'cat > /tmp/x <<EOF\n$(git push --force origin x)\nEOF',
  "cat > /tmp/x <<'EOF'\ngit push --force origin x\nEOF\ngit push --force origin x",
  "cat <<'EOF'\nx\\\nEOF\ngit push --force origin x\nEOF",
  'cat <<EOF\r\nEOF\r\ngit push --force origin x\nEOF',
  'cat <<EOF \nEOF \ngit push --force origin x\nEOF',
  'git commit -m x \\\n; git push --force origin x',
  'gh pr edit 12 --add-label "ship-it" --body "release"',
  'echo "$(git push --force origin x)"',
  "git commit -m \"$(cat <<'EOF'\n)\" ; git push --force origin x ; : \"\nEOF\n)\"",
  "cat <<'EOF' | keelctl $(cat)\nmemory forget k\nEOF",
  "echo 'git push --force origin x' | awk '{system($0)}'",
  // Brace expansion turns one word into several crew arguments; prose flags are walked as the CLI parses them.
  'keelctl {memory,forget} K',
  'keelctl {register,lead}',
  'keelctl memory --key --text forget K',
  'keelctl memory add --type preference --key K --text t --x --text --source owner --ref c',
  'keelctl memory --x --text pin K',
  'keelctl alerts --x --text seen',
  'keelctl doctor --x --text --fix',
  'cat .env.example .env',
  // …and as the shell expands them: a secret through braces, a program or git subcommand that is a brace expansion.
  'cat {.env,x}',
  'cat .{e,x}nv',
  'head -5 deploy/{.env,x}',
  'source {.env,x}',
  'git {push,--force,origin,x}',
  '{helm,upgrade,x}',
  'x | {bash,-c,"helm upgrade x"}',
  'echo $({helm,upgrade,x})',
  'env {git,push} origin x',
  'gh {pr,merge,12}',
  'git push origin {HEAD,develop}',
]) expect(`read whole: ${JSON.stringify(c)}`, pre('Bash', { command: c }), 'deny');

// Reads aren't writes: -o is a format to ps, ssh, grep and kubectl, and these programs only read.
for (const c of ['ps -o pid,etime,command -p 123', 'ssh -o ConnectTimeout=5 -o UserKnownHostsFile=/dev/null dev-db true', `grep -o "def [a-z_]*" ${join(other, 'x.py')}`, 'kubectl get pods -o custom-columns=NAME:.metadata.name', 'pytest -o cache_dir=/tmp/pc -q', 'curl -s -o "docs/cc_$(echo $p | tr / _).md" https://x', 'lsof -i :8000 && pgrep -f uvicorn']) {
  expect(`reads: ${c}`, pre('Bash', { command: c }), 'none');
}
for (const c of [`/usr/bin/time touch ${join(away, 'x.txt')}`, `curl -o ${join(away, 'x')} https://x`, `sort -o ${join(away, 's.txt')} a.txt`, `find . -fprint ${join(away, 'list')}`]) {
  expect(`writes away: ${c}`, pre('Bash', { command: c }), 'deny');
}
// Rules that read narrowly: example env files, reading Claude's settings, a migration plan, looking helm up.
for (const c of ['cat .env.example && head -20 deploy/.env.sample', 'cat src/config.env.ts', 'claude plugin list && claude plugin validate . && claude config get model && claude mcp list', 'alembic history', 'alembic current', 'command -v helm && which kubectl && type helm', "psql -h localhost -c \"select query from pg_stat_activity where query ilike '%insert%'\"", "psql -c \"select count(*) from audit_log where action = 'delete'\"", 'git push -u origin HEAD && ls -f', 'ls | head -20\necho "is .env a file?"', 'cat {a,b}.txt', 'git diff -- core/{a,b}.mjs', 'ls {src,tests}', 'cat "{.env,x}" 2>/dev/null || true', "T=$(echo x | tr -d '\"'\\''' )\ncat <<'EOF'\n{a,b}\nEOF", "wc -l skills/keel-{a,b}/SKILL.md; grep -n 'keelctl register' skills/"]) {
  expect(`narrow: ${c}`, pre('Bash', { command: c }) === 'deny' ? 'deny' : 'not denied', 'not denied');
}
for (const c of ['cat ./.env.local', 'cat .env.dev', '. .env', 'source "$W/.env"', 'claude plugin install x', 'claude mcp add x -- y', 'claude config set model x', 'claude auth logout', 'claude plugin marketplace add o/r', 'command helm upgrade x ./c', 'psql -c "select 1; delete from x"', "psql -c \"select 'a;b'; drop table x\"", "psql -c 'DELETE FROM x'", "psql <<'EOF'\nupdate x set a = 1;\nEOF", 'psql -c "with d as (delete from x returning 1) select 1"', 'git config core.hooksPath /tmp/h', 'git config --unset core.hooksPath', 'git push origin x --force']) {
  expect(`narrow still denies: ${c}`, pre('Bash', { command: c }), 'deny');
}
expect('narrow: an example env file reads and edits', [pre('Read', { file_path: join(wt, '.env.example') }), pre('Edit', { file_path: join(wt, '.env.example'), old_string: 'A', new_string: 'B' })].join(), 'none,none');
writeFileSync(join(wt, '.env'), 'X=1\n');
symlinkSync(join(wt, '.env'), join(wt, 'settings.txt'));
expect('narrow: a link to .env is the secret', pre('Read', { file_path: join(wt, 'settings.txt') }), 'deny');
// Brace expansions are counted as they are made: past 256 words the command can't be read (refused at once, never a
// timeout that lets it run); at 256 it is still checked normally. A policy too slow to answer is refused by the watchdog.
{
  const g = (n) => `helm upgrade x ./c; exit; echo ${'{a,b}'.repeat(n)}`;
  const started = Date.now();
  expect('braces: 23 groups are refused', pre('Bash', { command: g(23) }), 'deny');
  expect('braces: and answered quickly', Date.now() - started < 3000, true);
  const reason = (command, extra = {}, cwd = wt) => {
    const r = spawnSync('node', [join(root, 'hooks', 'policy.mjs')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_input: { command } }), env: { ...env, ...extra }, encoding: 'utf8' });
    const o = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : {};
    return `${o.permissionDecision ?? 'none'}: ${o.permissionDecisionReason ?? ''}`;
  };
  expect('braces: 9 groups can not be read', reason(`echo ${'{a,b}'.repeat(9)}`), "deny: Crew policy: this command can't be read plainly, so it can't be checked.");
  expect('braces: 8 groups are checked as expanded', [reason(g(8)), pre('Bash', { command: `echo ${'{a,b}'.repeat(8)}` }), pre('Bash', { command: `cat ${'{a,b}'.repeat(7)}/{.env,x}` })].join(), 'deny: Crew policy: changes to environments are never allowed.,none,deny');
  expect('watchdog: a slow policy is refused', reason('git status', { KEELCREW_POLICY_WATCHDOG_MS: '1' }), 'deny: Crew policy: the policy check took too long, so this is refused; split the command up.');
  expect('watchdog: other sessions are never touched', reason('git status', { KEELCREW_POLICY_WATCHDOG_MS: '1' }, other), 'none: ');
}
expect('narrow: a mutation spelled with quotes or a backslash writes', [pre('Bash', { command: 'gh api graphql -f query=mut"ation{x}"' }), pre('Bash', { command: 'gh api graphql -f query=mut\\ation{x}' })].join(), 'ask,ask');
expect('narrow: a graphql query reads, a mutation writes', [pre('Bash', { command: "gh api graphql -f query='query { viewer { login } }'" }), pre('Bash', { command: "gh api graphql -f query='mutation { x }'" })].join(), 'none,ask');
for (const [label, command] of [
  ['piped into a shell', "python3 - <<'EOF' | bash\nprint('helm upgrade x ./c')\nEOF"],
  ['followed by a script it wrote', "python3 - <<'EOF' && bash /tmp/x.sh\nopen('/tmp/x.sh', 'w').write('helm upgrade x ./c')\nEOF"],
  ['after a bash heredoc', "bash <<'B'; python3 - <<'A'\nhelm upgrade x ./c\nB\nprint(1)\nA"],
  ['its tag inside the body', "python3 - <<'EOF'\nEOF\nhelm upgrade x ./c\nEOF"],
  ['importing os', "python3 - <<'EOF'\nfrom os import system as s\ns('helm upgrade x ./c')\nEOF"],
  ['reaching os through a module', "python3 - <<'EOF'\nimport dataclasses\ndataclasses.sys.modules['os'].system('helm upgrade x ./c')\nEOF"],
  ['running code in an f-string', "python3 - <<'EOF'\nprint(f\"{__import__('os').system('helm upgrade x ./c')}\")\nEOF"],
  ['node', "node - <<'EOF'\nrequire('child'+'_process')['ex'+'ecSync']('helm upgrade x ./c')\nEOF"],
]) expect(`env: a heredoc ${label} is still judged`, pre('Bash', { command }), 'deny');
const reasonOf = (/** @type {string} */ command) => JSON.parse(spawnSync('node', [join(root, 'hooks', 'policy.mjs')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: wt, tool_name: 'Bash', tool_input: { command } }), env, encoding: 'utf8' }).stdout || '{}').hookSpecificOutput?.permissionDecisionReason ?? '';
expect('env: a refusal only heredoc text caused points at the Write tool', [reasonOf("python3 - <<'EOF'\nprint('x; helm qa/prod values')\nEOF").includes('Write tool'), reasonOf('helm upgrade x ./c').includes('Write tool'), reasonOf("helm upgrade x <<'EOF'\nx\nEOF").includes('Write tool')].join(), 'true,false,false');
expect('crew files: card text naming Mate-only commands in a heredoc is refused, pointing at the Write tool', [pre('Bash', { command: "python3 - <<'E'\nimport json\nprint(json.dumps({'commands': {'Approve': ['keelctl memory promote x', 'keelctl memory approve']}}))\nE" }), reasonOf("python3 - <<'E'\nprint('keelctl memory promote x')\nE").includes('Write tool')].join(), 'deny,true');
expect('git: overriding hooks for a read runs, for anything else is refused', ['git -c core.hooksPath=/dev/null diff --stat', 'git -c core.hooksPath=/dev/null log -1', 'git -c core.hooksPath=/dev/null commit -m x', 'git -c core.hooksPath=/dev/null push origin x', 'git -c "core.hooksPath=/tmp/h diff " commit -m x'].map((c) => pre('Bash', { command: c })).join(), 'none,none,deny,deny,deny');
expect('keelctl org: a literal read with variable arguments runs', pre('Bash', { command: 'R=/tmp/r; keelctl org owner f --dir $R' }), 'none');
expect('keelctl org: a computed subcommand is still refused', ['keelctl org $(echo hab)it set a b', "X='habit set a b'; keelctl org $X"].map((c) => pre('Bash', { command: c })).join(), 'deny,deny');
expect('a shell-run heredoc refusal is counted, without the text-only hint', [reasonOf("bash <<'EOF'\nhelm upgrade x ./c\nEOF").includes('only from text'), reasonOf("python3 - <<EOF\nprint('x; helm qa/prod values')\nEOF").includes('only from text')].join(), 'false,false');
expect('env: ruby backticks run a command', pre('Bash', { command: "ruby - <<'EOF'\nputs `helm upgrade x ./c`\nEOF" }), 'deny');
expect('env: a python heredoc that can start a process is still judged', [pre('Bash', { command: "python3 - <<'EOF'\nimport subprocess\nsubprocess.run('helm upgrade x ./c', shell=True)\nEOF" }), pre('Bash', { command: "python3 - <<EOF\nprint('$(helm upgrade x ./c)')\nEOF" }), pre('Bash', { command: "bash <<'EOF'\nhelm upgrade x ./c\nEOF" })].join(), 'deny,deny,deny');
expect('env: helm reads run', ['helm lint ./chart', 'helm template x ./chart', 'helm list -A', 'helm status x', 'helm history x'].map((c) => pre('Bash', { command: c })).join(), 'none,none,none,none,none');
expect('env: helm changes are still denied', ['helm upgrade --install x ./chart', 'helm --kube-context prod uninstall x', 'helm rollback x 2', 'helm "upgrade" x ./c', 'helm -n "my ns" upgrade x ./c', 'helm mapkubeapis x', 'helm get values x'].map((c) => pre('Bash', { command: c })).join(), 'deny,deny,deny,deny,deny,deny,deny');
expect('crew files: a plain cat with output dropped reads', pre('Bash', { command: 'cat ~/.keelcrew/memory/../config.json >/dev/null 2>&1; echo' }), 'none');
expect('crew files: python opening them is still denied', pre('Bash', { command: "python3 -c \"open('/'.join([__import__('os').path.expanduser('~'), '.keelcrew/config.json'])).read()\" ~/.keelcrew/config.json" }), 'deny');
// Scratch and temp: a resumed session's own project scratch and plain temp files are its to write; another project's
// scratch, from a file tool or the shell, is not.
const projectScratch = (slug, sid) => `/private/tmp/claude-${process.getuid()}/${slug}/${sid}/scratchpad/n.md`;
const wtSlug = wt.replace(/[^A-Za-z0-9]/g, '-');
expect('scratch: an earlier session of this project', pre('Write', { file_path: projectScratch(wtSlug, 'old-session'), content: 'x' }, wt, 's-eng'), 'none');
expect("scratch: another project's", [pre('Write', { file_path: projectScratch('-other-proj', 'x'), content: 'x' }, wt, 's-eng'), pre('Bash', { command: `echo x > ${projectScratch('-other-proj', 'x')}` }, wt, 's-eng')].join(), 'deny,deny');
expect('temp: a file tool writes temp like the shell', [pre('Write', { file_path: '/tmp/keelcrew-test-x.txt', content: 'x' }), pre('Bash', { command: 'echo x > /tmp/keelcrew-test-x.txt' })].join(), 'none,none');

// Activity: prompt, tool and turn end land in the member's state and event log.
const act = (input) => spawnSync('node', [join(root, 'hooks', 'activity.mjs')], { input: JSON.stringify({ cwd: wt, session_id: 'sess-1', transcript_path: '/tmp/t.jsonl', ...input }), env, encoding: 'utf8' });
act({ hook_event_name: 'UserPromptSubmit', prompt: 'Mate: start on the spec' });
act({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ruff check --no-fix .' }, tool_response: { stdout: 'ok' } });
const { createHash } = await import('node:crypto');
const { readFileSync } = await import('node:fs');
const id = createHash('sha1').update(wt).digest('hex').slice(0, 16);
const st = JSON.parse(readFileSync(join(home, 'state', `${id}.json`), 'utf8'));
expect('activity: session id', st.sessionId, 'sess-1');
expect('activity: terminal while running a command', st.activity, 'terminal');
expect('activity: last step', st.lastText, 'Bash: ruff check --no-fix .');
act({ hook_event_name: 'Stop' });
expect('activity: idle after the turn', JSON.parse(readFileSync(join(home, 'state', `${id}.json`), 'utf8')).activity, 'idle');
expect('activity: three events logged', readFileSync(join(home, 'events', `${id}.jsonl`), 'utf8').trim().split('\n').length, 3);
act({ hook_event_name: 'PostToolUse', tool_name: 'ArtifactData', tool_use_id: 'toolu_plugin_abc', tool_input: { action: 'list' } });
const afterMod = JSON.parse(readFileSync(join(home, 'state', `${id}.json`), 'utf8'));
expect("activity: a mod's tool call leaves the session idle", afterMod.activity, 'idle');
expect("activity: a mod's tool call doesn't mark it busy", afterMod.busy, false);
expect("activity: a mod's tool call notes the session is open", typeof JSON.parse(readFileSync(join(home, 'state', `${id}.alive.json`), 'utf8')), 'number');
expect("activity: a mod's tool call isn't logged", readFileSync(join(home, 'events', `${id}.jsonl`), 'utf8').trim().split('\n').length, 3);
act({ hook_event_name: 'PostToolUse', tool_name: 'SendMessage', tool_use_id: 'toolu_01x', tool_input: { message: 'hi' } });
expect('activity: messaging is not writing code', JSON.parse(readFileSync(join(home, 'state', `${id}.json`), 'utf8')).activity, 'thinking');
act({ hook_event_name: 'Stop' });
const other2 = spawnSync('node', [join(root, 'hooks', 'activity.mjs')], { input: JSON.stringify({ cwd: other, hook_event_name: 'Stop' }), env, encoding: 'utf8' });
expect('activity: other sessions untouched', other2.stdout, '');

// The policy log keeps crew members' calls and every denial, but not the passing calls of sessions outside the crew.
const mark = `log-mark-${process.pid}`;
pre('Bash', { command: `echo ${mark}-other` }, other);
pre('Bash', { command: `echo ${mark}-member` });
const boardOnly = pre('mcp__keelcrew-local__approve', { note: `${mark}-denied` }, other);
const policyLog = readFileSync(join(home, 'logs', 'policy.log'), 'utf8');
expect('policy log: outside pass skipped, member and denial kept', [policyLog.includes(`${mark}-other`), policyLog.includes(`${mark}-member`), boardOnly, policyLog.includes(`${mark}-denied`)].join(), 'false,true,deny,true');

// Membership by session: `keelctl register` ties the session that runs it to the crew, so its rules hold in any folder,
// and the Mate's folder (which holds every repo) catches no other session.
const leadHome = join(home, 'mate-home');
const repo = join(leadHome, 'brinewick-api');
const wt2 = join(repo, '.claude', 'worktrees', 'BRIN-2');
mkdirSync(wt2, { recursive: true });
writeFileSync(join(wt2, '.git'), 'gitdir: x\n');
writeFileSync(join(home, 'config.json'), JSON.stringify({ owner: 'Sam', shipMode: 'card', trust: [], leadDir: leadHome, pack: 'brinewick', promptMode: 'ask' }));
const crew = (sid, args) => spawnSync('node', [join(root, 'cli', 'keelctl.mjs'), ...args], { env: { ...env, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_CODE_HOST_SESSION_ID: `local_${sid}` }, encoding: 'utf8' });
const sessions = () => JSON.parse(readFileSync(join(home, 'crew.json'), 'utf8')).sessions ?? {};

expect('register needs a session', spawnSync('node', [join(root, 'cli', 'keelctl.mjs'), 'register', 'lead', '-', leadHome], { env: { ...env, CLAUDE_CODE_SESSION_ID: '' }, encoding: 'utf8' }).status, 1);
crew('lead-1', ['register', 'lead', '-', leadHome]);
expect('lead: force push denied', pre('Bash', { command: 'git push --force origin x' }, leadHome, 'lead-1'), 'deny');
expect('lead: jira write runs', pre('mcp__1a2b__transitionJiraIssue', {}, leadHome, 'lead-1'), 'none');
expect('lead: starting an engineer runs', pre('mcp__scheduled-tasks__run_scheduled_task', {}, leadHome, 'lead-1'), 'none');
expect('lead: starting a session runs', pre('mcp__ccd_session__start_session', { initiation: 'user_asked', title: 't', prompt: 'p' }, leadHome, 'lead-1'), 'none');
expect('lead: proposing an engineer is denied', pre('mcp__ccd_session__start_session', { initiation: 'own_initiative', name: 'keel-brin-2535', title: 't', prompt: 'p' }, leadHome, 'lead-1'), 'deny');
expect('lead: proposing a re-staffed engineer is denied', pre('mcp__ccd_session__start_session', { initiation: 'own_initiative', name: 'keel-t-4-5', title: 't', prompt: 'p' }, leadHome, 'lead-1'), 'deny');
expect('lead: proposing an agent runs', pre('mcp__ccd_session__start_session', { initiation: 'own_initiative', name: 'keel-qa-brin-2413', title: 't', prompt: 'p' }, leadHome, 'lead-1'), 'none');
expect('lead: starting an engineer as asked runs', pre('mcp__ccd_session__start_session', { initiation: 'user_asked', name: 'keel-brin-2535', title: 't', prompt: 'p' }, leadHome, 'lead-1'), 'none');
expect('lead: listing where sessions can start runs', pre('mcp__ccd_session__list_start_targets', {}, leadHome, 'lead-1'), 'none');
expect('lead: opening a session in a window runs', pre('mcp__ccd_window__open_session_in', { session_id: 'local_eng-2' }, leadHome, 'lead-1'), 'none');
expect('lead: setting its effort runs', pre('mcp__ccd_session_mgmt__set_session_effort', {}, leadHome, 'lead-1'), 'none');
expect('lead: auto-merge still asks', pre('mcp__ccd_pr__set_auto_merge', {}, leadHome, 'lead-1'), 'ask');
expect('lead: asking in its session denied (board instead)', pre('AskUserQuestion', askQ('Scope'), leadHome, 'lead-1'), 'deny');
expect('lead: may remove a compaction record', pre('Bash', { command: 'rm ~/.keelcrew/compacted/req-1.json' }, leadHome, 'lead-1'), 'none');
expect('lead: may read a compaction record', pre('Read', { file_path: join(home, 'compacted', 'req-1.json') }, leadHome, 'lead-1'), 'none');
{
  const cli = (command, sid, cwd = leadHome) => pre('Bash', { command }, cwd, sid);
  // A plain read of the crew's files from the shell is as harmless as the Read tool; anything that could write is not.
  const cj = join(home, 'crew.json');
  for (const c of [`cat ${cj}`, `jq .sessions ${cj} | head -5`, `grep -c role ${cj}; wc -l ${cj}`]) expect(`engineer: ${c} runs`, cli(c, undefined, wt), 'none');
  for (const c of [
    `cat /tmp/x > ${cj}`,
    `jq . ${cj} > /tmp/x`,
    `tee ${cj} < /tmp/x`,
    `cat $(echo ${cj})`,
    `grep x ${cj}; rm ${cj}`,
    `cat ${cj} | sh`,
    `python3 -c "print(open('${cj}').read())"`,
    `cat <<EOF > ${cj}\n{}\nEOF`,
    `cat \\\n> ${cj}`,
    `cat ${cj} ${'${x:=$'}'a[\\x24\\x28touch /tmp/p\\x29]'} $[x]`,
  ]) expect(`engineer: ${JSON.stringify(c)} denied`, cli(c, undefined, wt), 'deny');
  // A crew command is judged per part: the words as text are fine, the command hidden in a heredoc or an escape is not.
  expect('engineer: keel-scan in a heredoc is not crew', cli("python3 - <<'EOF'\nprint({\"taskId\": \"keel-scan\", \"note\": \"spend continue\"})\nEOF", undefined, wt), 'none');
  expect('engineer: a name that only starts with the command is not the command', cli("python3 - <<'EOF'\nprint({\"taskId\": \"keelctl-scan\", \"note\": \"spend continue\"})\nEOF", undefined, wt), 'none');
  expect('engineer: rg names it as text', cli('rg -n "keelctl spend continue" skills/', undefined, wt), 'none');
  for (const c of ['rg -n keelctl skills/ && $EDITOR skills/spend-continue.md', 'grep -rn keelctl docs; $PAGER docs/memory-forget.md', 'rg keelctl . ; $(npm bin)/vitest run tests/doctor --fix', 'C=keelctl; $C org show']) {
    expect(`engineer: ${c} runs`, cli(c, undefined, wt), 'none');
  }
  expect('engineer: crew text in a heredoc is fine', cli("cat > /tmp/s.json <<'EOF'\n{\"lastResult\": \"keelctl spend: continue D-1, cost $3\"}\nEOF", undefined, wt), 'none');
  for (const c of [
    'keelctl spend continue D-1',
    'keelctl sp""end continue D-1',
    'keelctl $(echo spend) continue D-1',
    'C=keelctl; $C spend continue D-1',
    'C=keelctl; "$C" spend continue D-1',
    'C=keelctl; ${C} spend continue D-1 --json',
    'if true; then $C spend continue D-1; fi',
    '{ $C memory forget k; }',
    'time $C doctor --fix',
    'command $C spend continue D-1',
    'C=keelctl; $C org add x',
    'C=ctl; keel$C spend continue D-1',
    '$(which keelctl) unpause D-2',
    'CLAUDE_CODE_SESSION_ID= ~/.keelcrew/bin/keelctl spend continue D-1',
    'node ~/.keelcrew/bin/keelctl.mjs spend continue D-1',
    'bash <<EOF\nkeelctl spend continue D-1\nEOF',
    'keelctl spend continue D-1 <<EOF\nspend\nEOF',
    '$(cat <<EOF\nkeelctl spend continue D-1\nEOF\n)',
    '`cat <<EOF\nkeelctl spend continue D-1\nEOF\n`',
    'cat <<EOF > >(bash)\nkeelctl spend continue D-1\nEOF',
    "node <<EOF\nrequire('child_process').execSync('keelctl spend continue D-1')\nEOF",
    'ssh localhost <<EOF\nkeelctl spend continue D-1\nEOF',
    '((x=1<<b))\nkeelctl spend continue D-1\nb',
    'cat > /tmp/x <<EOF\nhi\nEOF\nkeelctl spend continue D-1',
    'cat > /tmp/x <<EOF\nEOF\nkeelctl spend continue D-1\nEOF',
    "cat <<'EOF'\nx\\\nEOF\nkeelctl spend continue D-1\nEOF",
    'cat <<EOF\r\nEOF\r\nkeelctl spend continue D-1\nEOF',
    'cat <<EOF\x0b\nEOF\x0b\nkeelctl spend continue D-1\nEOF',
    'cat <<EOF\f\nEOF\f\nkeelctl spend continue D-1\nEOF',
    'cat <<EOF \nEOF \nkeelctl spend continue D-1\nEOF',
  ]) expect(`engineer: ${JSON.stringify(c)} denied`, cli(c, undefined, wt), 'deny');
}
expect("captain's own session inside the Mate folder untouched", pre('Bash', { command: 'git push origin HEAD' }, repo, 'mine'), 'none');

expect('engineer in the Mate folder: not crew before registering', pre('Bash', { command: 'git push origin HEAD' }, leadHome, 'eng-2'), 'none');
expect('engineer cannot register the Mate folder', crew('eng-2', ['register', 'engineer', 'brin-2', leadHome]).status, 1);
expect('engineer cannot register a plain folder', crew('eng-2', ['register', 'engineer', 'brin-2', other]).status, 1);
expect('engineer registers its worktree', crew('eng-2', ['register', 'engineer', 'brin-2', wt2]).status, 0);
expect('engineer: push asks from any folder', pre('Bash', { command: 'git push -u origin HEAD' }, leadHome, 'eng-2'), 'ask');
expect('engineer: edit outside its worktree denied', pre('Edit', { file_path: join(away, 'a.py') }, leadHome, 'eng-2'), 'deny');
expect('engineer: edit inside its worktree ok', pre('Edit', { file_path: join(wt2, 'a.py') }, leadHome, 'eng-2'), 'none');
expect('engineer: binding its PR runs', pre('mcp__ccd_pr__bind_pr', {}, wt2, 'eng-2'), 'none');
expect('engineer: asking the captain in its session denied (Mate instead)', pre('AskUserQuestion', askQ('PR monitor'), wt2, 'eng-2'), 'deny');
expect('engineer: a ship question mixed with another denied', pre('AskUserQuestion', { questions: [...askQ('Ship').questions, ...askQ('Other').questions] }, wt2, 'eng-2'), 'deny');
expect('engineer: its launch card question still runs', pre('AskUserQuestion', askQ('Ship'), wt2, 'eng-2'), 'none');
expect('engineer: starting sessions asks', pre('mcp__scheduled-tasks__run_scheduled_task', {}, wt2, 'eng-2'), 'ask');
expect('engineer: proposing a session runs', pre('mcp__ccd_session__start_session', { initiation: 'own_initiative', title: 't', prompt: 'p' }, wt2, 'eng-2'), 'none');
expect('engineer: starting a session denied', pre('mcp__ccd_session__start_session', { initiation: 'user_asked', title: 't', prompt: 'p' }, wt2, 'eng-2'), 'deny');
expect('engineer: starting a session with no input denied', pre('mcp__ccd_session__start_session', undefined, wt2, 'eng-2'), 'deny');
expect('engineer: opening a session in a window asks', pre('mcp__ccd_window__open_session_in', { session_id: 'local_lead-1' }, wt2, 'eng-2'), 'ask');
expect('engineer: writing text that names a crew file is fine', pre('Edit', { file_path: join(wt2, 'notes.md'), old_string: 'a', new_string: 'read ~/.keelcrew/config.json with Read' }, wt2, 'eng-2'), 'none');
expect('engineer: writing a crew file is denied', pre('Write', { file_path: join(home, 'crew.json'), content: '{}' }, wt2, 'eng-2'), 'deny');
expect('engineer: a message naming a crew file is fine', pre('mcp__ccd_session_mgmt__send_message', { session_id: 'local_lead-1', message: 'crew.json looks stale' }, wt2, 'eng-2'), 'allow');
expect('engineer: messaging the Mate with to is fine', pre('mcp__ccd_session_mgmt__send_message', { to: 'local_lead-1', message: 'launch card is up' }, wt2, 'eng-2'), 'allow');
expect('engineer: SendMessage to the Mate is fine', pre('SendMessage', { to: 'local_lead-1', message: 'launch card is up' }, wt2, 'eng-2'), 'allow');
expect('engineer: SendMessage to another session asks, like send_message', pre('SendMessage', { to: 'local_someone-else', message: 'x' }, wt2, 'eng-2'), 'ask');
expect('engineer: SendMessage to a subagent is just text', pre('SendMessage', { to: 'a1b2c3d4e5f6a7b8c', message: 'x' }, wt2, 'eng-2'), 'none');
expect('engineer: a board read saved into crew memory is denied', pre('ArtifactData', { action: 'list', url: 'u', collection: 'tasks', out_dir: join(home, 'memory') }, wt2, 'eng-2'), 'deny');
expect('engineer: editing Claude settings is denied', pre('Bash', { command: 'echo {} > .claude/settings.local.json' }, wt2, 'eng-2'), 'deny');
expect('lead: writing Claude settings is denied', pre('Write', { file_path: join(leadHome, '.claude', 'settings.local.json'), content: '{}' }, leadHome, 'lead-1'), 'deny');
expect('lead: reading Claude settings runs', pre('Read', { file_path: join(leadHome, '.claude', 'settings.local.json') }, leadHome, 'lead-1'), 'none');
expect('engineer: cd into .claude then writing settings is denied', pre('Bash', { command: 'cd .claude && echo {} > settings.local.json' }, wt2, 'eng-2'), 'deny');
expect('engineer: a glob at Claude settings is denied', pre('Bash', { command: 'cp x ~/.claude/settings.loc*.json' }, wt2, 'eng-2'), 'deny');
expect('engineer: app settings in a .claude worktree run', pre('Bash', { command: `cd ${join(repo, '.claude', 'worktrees', 'X')} && APP_CONFIG=settings.local.toml python -m app.check` }, wt2, 'eng-2'), 'none');
expect('engineer: linting app/settings in a .claude worktree runs', pre('Bash', { command: `ruff check --no-fix ${join(repo, '.claude', 'worktrees', 'X', 'app', 'settings', 'base.py')}` }, wt2, 'eng-2'), 'none');
expect('engineer: writing settings.local.json from inside .claude is denied', pre('Bash', { command: 'echo {} > settings.local.json' }, join(wt2, '.claude'), 'eng-2'), 'deny');
expect('engineer: an ordinary commit runs', pre('Bash', { command: 'git commit -m "tidy settings docs"' }, wt2, 'eng-2'), 'none');
expect('engineer: a todo naming Claude settings runs', pre('TodoWrite', { todos: [{ content: 'check .claude/settings.json', status: 'pending' }] }, wt2, 'eng-2'), 'none');
expect('engineer: ../../ out of a worktree into .claude settings is denied', pre('Bash', { command: 'echo {} > ../../settings.local.json' }, wt2, 'eng-2'), 'deny');
expect('engineer: cd ../.. out of a worktree then writing settings is denied', pre('Bash', { command: 'cd ../.. && echo {} > settings.local.json' }, wt2, 'eng-2'), 'deny');
expect('engineer: a different case is the same file on macOS', pre('Bash', { command: 'echo {} > .Claude/Settings.json' }, wt2, 'eng-2'), 'deny');
expect('lead: upper-case settings file name is denied', pre('Write', { file_path: join(leadHome, '.claude', 'SETTINGS.local.json'), content: '{}' }, leadHome, 'lead-1'), 'deny');
expect('engineer: a ? glob at .claude settings is denied', pre('Bash', { command: 'cp x .claude/settings.local.jso?' }, wt2, 'eng-2'), 'deny');
expect('engineer: a brace glob at .claude settings is denied', pre('Bash', { command: "cp x '.claude/settings{,.local}.json'" }, wt2, 'eng-2'), 'deny');
expect('engineer: a settings*.py glob in a worktree runs', pre('Bash', { command: `ruff check --no-fix ${join(wt2, 'app')}/settings*.py` }, wt2, 'eng-2'), 'none');
expect('engineer: .vscode/settings.json is not Claude settings', pre('Bash', { command: `cat ${join(wt2, '.vscode', 'settings.json')}` }, wt2, 'eng-2'), 'none');
expect('engineer: a commit message naming both runs', pre('Bash', { command: 'git commit -m "update settings.json docs for .claude"' }, wt2, 'eng-2'), 'none');
expect('engineer: writing a brief is denied', pre('Bash', { command: `echo x > ${join(home, 'briefs', 'keel-d-1.md')}` }, wt2, 'eng-2'), 'deny');
expect("engineer: appending to the Mate's notes is denied", pre('Bash', { command: `echo x >> ${join(home, 'lead.md')}` }, wt2, 'eng-2'), 'deny');
expect('engineer: reading a brief runs', pre('Read', { file_path: join(home, 'briefs', 'keel-d-1.md') }, wt2, 'eng-2'), 'none');
expect('lead: writing a brief runs', pre('Write', { file_path: join(home, 'briefs', 'keel-d-1.md'), content: 'x' }, leadHome, 'lead-1'), 'none');
expect('lead: keelctl doctor --fix runs', pre('Bash', { command: '~/.keelcrew/bin/keelctl doctor --fix' }, leadHome, 'lead-1'), 'none');
expect('engineer: cannot re-register as Mate', pre('Bash', { command: '~/.keelcrew/bin/keelctl register lead' }, wt2, 'eng-2'), 'deny');
expect('engineer: cannot unregister', pre('Bash', { command: '~/.keelcrew/bin/keelctl unregister' }, wt2, 'eng-2'), 'deny');
expect('engineer: cannot unpause', pre('Bash', { command: '~/.keelcrew/bin/keelctl unpause eng-2' }, wt2, 'eng-2'), 'deny');
expect('engineer: cannot edit the crew list', pre('Bash', { command: 'echo {} > ~/.keelcrew/crew.json' }, wt2, 'eng-2'), 'deny');
expect('a registered session keeps its role', crew('eng-2', ['register', 'lead', '-', leadHome]).status, 1);
expect('lead: may remove a member', pre('Bash', { command: `~/.keelcrew/bin/keelctl unregister ${wt2}` }, leadHome, 'lead-1'), 'none');

crew('job-1', ['register', 'job', '-', leadHome]);
expect('watch: messaging the Mate runs', pre('mcp__ccd_session_mgmt__send_message', { session_id: 'local_lead-1' }, leadHome, 'job-1'), 'allow');
expect('watch: messaging another session asks', pre('mcp__ccd_session_mgmt__send_message', { session_id: 'local_someone-else' }, leadHome, 'job-1'), 'ask');
expect('watch: SendMessage to another session asks', pre('SendMessage', { to: 'local_someone-else', message: 'x' }, leadHome, 'job-1'), 'ask');
expect('watch: force push denied', pre('Bash', { command: 'git push --force origin x' }, leadHome, 'job-1'), 'deny');
expect('watch: starting sessions asks', pre('mcp__scheduled-tasks__run_scheduled_task', {}, leadHome, 'job-1'), 'ask');
expect('watch: asking in its session denied', pre('AskUserQuestion', askQ('Ship'), leadHome, 'job-1'), 'deny');
{
  const r = spawnSync('node', [join(root, 'hooks', 'policy.mjs')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: wt2, session_id: 'eng-2', tool_name: 'AskUserQuestion', tool_input: askQ('X') }), env, encoding: 'utf8' });
  expect('engineer: the denial names the Mate to message', /send_message to local_lead-1\b/.test(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason), true);
}
crew('lead-2', ['register', 'lead', '-', leadHome]);
expect('a new Mate replaces the old one', sessions()['lead-1'], undefined);
crew('lead-2', ['unregister', wt2]);
expect('unregister drops the session too', pre('Bash', { command: 'git push -u origin HEAD' }, leadHome, 'eng-2'), 'none');

// The Notification hook: the panel mod's "Keelcrew" notifications become a macOS banner through osascript, the text passed
// as arguments; anything else (the app's own notifications, other plugins') runs nothing. A fake osascript records its args.
{
  const bin = join(home, 'fakebin');
  const out = join(home, 'osascript.args');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'osascript'), '#!/bin/sh\nfor a in "$@"; do printf \'%s\\0\' "$a"; done > "$OSA_OUT"\n');
  chmodSync(join(bin, 'osascript'), 0o755);
  const notify = (input) => {
    rmSync(out, { force: true });
    const r = spawnSync('node', [join(root, 'hooks', 'notify.mjs')], { input: JSON.stringify({ session_id: 's', transcript_path: '/t', cwd: other, hook_event_name: 'Notification', ...input }), env: { ...env, PATH: `${bin}:${process.env.PATH}`, OSA_OUT: out }, encoding: 'utf8', timeout: 10_000 });
    expect('notify: exits 0', r.status, 0);
    expect('notify: prints nothing', r.stdout, '');
    return existsSync(out) ? readFileSync(out, 'utf8').split('\0').slice(0, -1) : null;
  };
  const mac = process.platform === 'darwin';
  const message = 'New on the Keelcrew board: launch card for BRIN-1 "A" \\ end run\nsecond line';
  const args = notify({ notification_type: 'plugin_notification', title: 'Keelcrew', message });
  expect('notify: osascript runs on a Mac', args !== null, mac);
  if (mac && args) {
    expect('notify: the script reads its text from argv', args[0] === '-e' && /^on run argv\b/.test(args[1]) && !args[1].includes('BRIN'), true);
    expect('notify: title', args[2], 'Keelcrew');
    expect('notify: message, one line', args[3], 'New on the Keelcrew board: launch card for BRIN-1 "A" \\ end run second line');
    expect('notify: plays a sound', /sound name "\w+"/.test(args[1]), true);
    expect('notify: at most 200 characters', notify({ notification_type: 'plugin_notification', title: 'Keelcrew', message: 'x'.repeat(500) })?.[3].length, 200);
  }
  expect("notify: another plugin's notification", notify({ notification_type: 'plugin_notification', title: 'Other', message: 'hi' }), null);
  expect("notify: the app's own permission prompt", notify({ notification_type: 'permission_prompt', title: 'Keelcrew', message: 'Claude needs your permission' }), null);
  expect("notify: the app's idle prompt", notify({ notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }), null);
  expect('notify: an empty message', notify({ notification_type: 'plugin_notification', title: 'Keelcrew', message: ' ' }), null);
  expect('notify: unreadable input', (rmSync(out, { force: true }), spawnSync('node', [join(root, 'hooks', 'notify.mjs')], { input: 'not json', env: { ...env, PATH: `${bin}:${process.env.PATH}`, OSA_OUT: out } }).status), 0);
  expect('notify: unreadable input runs nothing', existsSync(out), false);
}

console.log(`${n - bad}/${n} hook checks pass`);
process.exit(bad ? 1 : 0);
