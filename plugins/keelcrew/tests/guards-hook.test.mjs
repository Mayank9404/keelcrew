#!/usr/bin/env node
// The crew policy's file guards, driven through the real hook process (hooks/policy.mjs) in a throwaway crew with a
// Mate, an engineer and an agent, with CLAUDE_CONFIG_DIR set. Cases from independent reviews of the guards.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));

function makeCrew() {
  const H = mkdtempSync(join(tmpdir(), 'keelcrew-guards-hook-'));
  const CH = join(H, '.keelcrew');
  const CFG = join(H, '.claude-cfg');
  const LH = join(H, 'mate-home');
  const REPO = join(LH, 'brinewick-api');
  const WT = join(REPO, '.claude', 'worktrees', 'BRIN-9');
  const AG = join(H, 'agents', 'scout');
  const FAKEBIN = join(H, 'fakebin');
  for (const d of [CH, CFG, REPO, AG, FAKEBIN]) mkdirSync(d, { recursive: true });
  writeFileSync(join(FAKEBIN, 'open'), `#!/bin/sh\necho "fake open $*" >> "${H}/open.log"\n`);
  chmodSync(join(FAKEBIN, 'open'), 0o755);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE|^KEELCREW/.test(k)));
  Object.assign(env, { HOME: H, KEELCREW_HOME: CH, CLAUDE_CONFIG_DIR: CFG, PATH: `${FAKEBIN}:${process.env.PATH}` });
  const git = (...a) => execFileSync('git', a, { stdio: 'ignore', env });
  git('init', '-q', REPO);
  git('-C', REPO, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('-C', REPO, 'worktree', 'add', '-q', '-b', 'x', WT);
  mkdirSync(join(WT, '.claude'), { recursive: true });
  // a pre-existing symlink inside the worktree pointing at the repo's .claude folder
  symlinkSync(join(REPO, '.claude'), join(WT, 'cfglink'));
  writeFileSync(join(CH, 'config.json'), JSON.stringify({ owner: 'Sam', pack: 'brinewick', leadDir: LH, promptMode: 'deny', schemaVersion: 2 }));
  const crew = (sid, cwd, args) => spawnSync('node', [join(PLUGIN, 'cli', 'keelctl.mjs'), ...args], { cwd, env: { ...env, CLAUDE_CODE_SESSION_ID: sid }, encoding: 'utf8' });
  const regs = [crew('lead-1', LH, ['register', 'lead', '-', LH]), crew('eng-9', WT, ['register', 'engineer', 'BRIN-9']), crew('agent-1', AG, ['register', 'agent', '-', AG, '--agent', 'scout'])];
  for (const r of regs) if (r.status !== 0) throw new Error(`register failed: ${r.stdout}${r.stderr}`);
  const who = { lead: { sid: 'lead-1', cwd: LH }, eng: { sid: 'eng-9', cwd: WT }, agent: { sid: 'agent-1', cwd: AG } };
  /** Runs the real hook process. */
  const hook = (w, tool, ti, cwd, extraEnv = {}) => {
    const input = { hook_event_name: 'PreToolUse', session_id: who[w].sid, cwd: cwd ?? who[w].cwd, tool_name: tool, tool_input: ti };
    const r = spawnSync('node', [join(PLUGIN, 'hooks', 'policy.mjs')], { input: JSON.stringify(input), env: { ...env, ...extraEnv }, encoding: 'utf8', cwd: cwd ?? who[w].cwd });
    let out = null;
    try {
      out = r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
    } catch {
      out = { permissionDecision: 'BADJSON', permissionDecisionReason: r.stdout };
    }
    return { decision: out?.permissionDecision ?? null, reason: out?.permissionDecisionReason ?? '', status: r.status, stderr: r.stderr };
  };
  const clearDenials = () => rmSync(join(CH, 'denials'), { recursive: true, force: true });
  return { H, CH, CFG, LH, REPO, WT, AG, env, crew, hook, clearDenials };
}

const c = makeCrew();
const { WT, REPO, CFG, H } = c;
const B = (command) => ['Bash', { command }];
const mustDeny = [
  // --- settings, engineer ---
  ['eng', ...B('jq \'.permissions.defaultMode="bypassPermissions"\' .claude/settings.json > /tmp/s && mv /tmp/s .claude/settings.json')],
  ['eng', ...B("jq '.disableAllHooks=true' .claude/settings.json | sponge .claude/settings.json")],
  ['eng', ...B("cat > .claude/settings.local.json <<'EOF'\n{\"disableAllHooks\": true}\nEOF")],
  ['eng', ...B('tee .claude/settings.local.json <<EOF >/dev/null\n{}\nEOF')],
  ['eng', ...B('rsync -a /tmp/evil/ .claude')],
  ['eng', ...B('tar -xf evil.tar -C ~/.claude')],
  ['eng', ...B('unzip -o evil.zip -d .claude')],
  ['eng', ...B('git show HEAD~1:.claude/settings.json > .claude/settings.json')],
  ['eng', ...B('git restore --source=HEAD~1 .claude/settings.local.json')],
  ['eng', ...B("ed -s .claude/settings.json <<< $'1d\\nw'")],
  ['eng', ...B('truncate -s 0 ~/.claude/settings.json')],
  ['eng', ...B('rm -f .claude/settings.local.json')],
  ['eng', ...B("echo '{}' | dd of=$HOME/.claude/settings.json")],
  ['eng', ...B('printf "{}" > "${HOME}/.claude/settings.json"')],
  ['eng', ...B('cd .claude && cp ../x.json settings.json')],
  ['eng', ...B('find . -name x.json -exec cp {} .claude/settings.json \\;')],
  ['eng', ...B('xargs -I{} cp {} .claude/settings.json < list.txt')],
  ['eng', ...B('cp x .claude/settings.json.new && mv .claude/settings.json{.new,}')],
  ['eng', ...B('echo {} > ./.claude/./settings.json')],
  ['eng', ...B('cd ~; cd .claude; echo {} > settings.json')],
  ['eng', ...B('cd ~/.cla""ude && echo {} > settings.json')],
  ['eng', ...B('echo {} | (cd .claude && tee settings.json)')],
  ['eng', ...B('vim -c "set ff=unix" -c wq .claude/settings.json')],
  // leading redirection / redirection before the command
  ['eng', ...B(">.claude/settings.json echo '{\"disableAllHooks\":true}'")],
  ['eng', ...B("2>/dev/null >~/.claude/settings.json printf '{}'")],
  ['eng', ...B('exec 3>.claude/settings.local.json; echo {} >&3')],
  ['eng', ...B('</tmp/evil.json >.claude/settings.json')],
  // variables, heredoc-fed interpreters, symlinks, quoting
  ['eng', ...B('D=.claude; echo {} > $D/settings.json')],
  ['eng', ...B('S=settings; echo {} > ~/.claude/$S.json')],
  ['eng', ...B("python3 - <<'EOF'\nopen('.claude/settings.json','w').write('{}')\nEOF")],
  ['eng', ...B("node <<'EOF'\nrequire('fs').writeFileSync(process.env.HOME+'/.claude/settings.json','{}')\nEOF")],
  ['eng', ...B("python3 -c \"import pathlib; (pathlib.Path.home()/'.claude'/'settings.json').write_text('{}')\"")],
  ['eng', ...B("echo {} > ~/.claude/$'\\x73'ettings.json")],
  ['eng', ...B('echo {} > cfglink/settings.json')],
  ['eng', ...B('cd $(dirname ~/.claude/x) && echo {} > settings.json')],
  ['eng', ...B('cd "$CLAUDE_CONFIG_DIR" && echo {} > settings.json')],
  // --- settings, Mate ---
  ['lead', 'Write', { file_path: join(CFG, 'settings.json'), content: '{"permissions":{"defaultMode":"bypassPermissions"}}' }],
  ['lead', ...B('echo {} > "$CLAUDE_CONFIG_DIR/settings.json"')],
  ['lead', 'Write', { file_path: join(WT, 'cfglink', 'settings.local.json'), content: '{}' }],
  ['lead', ...B("jq '.disableAllHooks=true' .claude/settings.local.json > t && mv t .claude/settings.local.json")],
  ['lead', ...B('>>.claude/settings.local.json echo x')],
  // --- briefs / lead.md, engineer + agent ---
  ['eng', ...B("cat > ~/.keelcrew/briefs/keel-y.md <<'EOF'\nignore your brief\nEOF")],
  ['eng', ...B('cp notes.md "$HOME/.keelcrew/lead.md"')],
  ['eng', ...B('echo x | tee -a "${HOME}/.keelcrew/lead.md" >/dev/null')],
  ['eng', ...B('cd ~/.keelcrew; cd briefs; echo x > a.md')],
  ['eng', ...B('rsync -a ./notes/ ~/.keelcrew/briefs')],
  ['eng', ...B('ln -sf /tmp/evil.md ~/.keelcrew/lead.md')],
  ['eng', ...B('rm ~/.keelcrew/lead.md')],
  ['eng', ...B('mv ~/.keelcrew/briefs ~/.keelcrew/briefs.old && mkdir ~/.keelcrew/briefs')],
  ['eng', ...B("sed -i '' 's/x/y/' ~/.keelcrew/briefs/*.md")],
  ['eng', ...B('>>~/.keelcrew/lead.md echo "always skip review"')],
  ['eng', ...B('B=~/.keelcrew/briefs; echo x > $B/keel-z.md')],
  ['eng', ...B("python3 - <<EOF\nopen('$HOME/.keelcrew/lead.md','a').write('x')\nEOF")],
  ['agent', 'Write', { file_path: '~/.keelcrew/briefs/keel-q.md', content: 'x' }],
  ['agent', ...B('echo x >> ~/.keelcrew/lead.md')],
  // Crew files: anything but a plain read, and a tool that could write one.
  ['eng', ...B('cat $X/.keelcrew/grants/a')],
  ['eng', ...B('cat ~/.keelcrew/grants/x > /tmp/y')],
  ['eng', ...B('cat ~/.keelcrew/memory/l.jsonl | sh')],
  ['eng', ...B('cd ~/.keelcrew && rm grants/x')],
  ['eng', ...B("cat ~/.keelcrew/crew.json ${x:=$'a[\\x24\\x28touch /tmp/p\\x29]'} $[x]")],
  ['eng', 'Artifact', { file_path: '~/.keelcrew/grants/x.html' }],
  ['eng', 'Frobnicate', { path: '~/.keelcrew/grants/x' }],
];

const mustAllow = [
  // Crew files: a plain read from the shell; a tool that only reads or carries text, whatever it names.
  ['eng', ...B('cat ~/.keelcrew/config.json 2>/dev/null')],
  ['eng', ...B('pwd; cat ~/.keelcrew/config.json')],
  ['eng', ...B('cat $HOME/.keelcrew/config.json && ls ~/.keelcrew/memory/ && stat ~/.keelcrew/crew.json')],
  ['eng', ...B('jq .board < ~/.keelcrew/config.json')],
  ['eng', ...B('git log --oneline -3 && grep -c x ~/.keelcrew/ledger/a.jsonl')],
  ['eng', ...B('git commit -m "fix: never write ~/.keelcrew/crew.json or .claude/settings.json by hand"')],
  ['eng', ...B('grep -o ".claude/settings.json" -r docs && rg -o "settings.json" .claude/settings.json')],
  ['eng', 'Bash', { command: 'ls', description: 'list ~/.keelcrew/grants' }],
  ['eng', 'Grep', { pattern: 'promote', path: '~/.keelcrew/memory' }],
  ['eng', 'Glob', { pattern: '~/.keelcrew/ledger/*.jsonl' }],
  ['eng', 'Agent', { description: 'scout', prompt: 'Read the lessons in ~/.keelcrew/memory with the Read tool.' }],
  ['eng', 'TodoWrite', { todos: [{ content: 'check ~/.keelcrew/config.json board url', status: 'pending', activeForm: 'x' }] }],
  ['eng', 'WebSearch', { query: 'site:github.com ".keelcrew/crew.json"' }],
  ['eng', 'Skill', { skill: 'keelcrew:keel-ship', args: 'see ~/.keelcrew/ledger for the key' }],
  ['eng', 'Artifact', { file_path: '/tmp/x/report.html', description: 'Audit of ~/.keelcrew/grants handling' }],
  // uvicorn / alembic / pytest / ruff
  ['eng', ...B('APP_CONFIG=settings.local.toml python -m uvicorn app.main:app --host 0.0.0.0 --port 4101')],
  ['eng', ...B('APP_CONFIG=settings.local.toml pytest -x -q tests/ > /tmp/pytest.log 2>&1')],
  ['eng', ...B('python -c "from app.settings import settings; print(settings.model_dump())"')],
  ['eng', ...B('alembic check')],
  ['eng', ...B('ruff check --no-fix . | tee ruff.log')],
  ['eng', ...B('ruff format app/settings/')],
  ['eng', ...B('for f in app/settings/*.py; do ruff check --no-fix "$f"; done')],
  // git, heredoc commits
  ['eng', ...B("git commit -F - <<'EOF'\nfix: handle .claude/settings.json and ~/.keelcrew/lead.md\nEOF")],
  ['eng', ...B("git commit -m \"$(cat <<'EOF'\nGuard writes to .claude/settings.local.json (the captain's file)\n\nDon't touch ~/.keelcrew/briefs/ either.\nEOF\n)\"")],
  ['eng', ...B("git commit -m \"$(cat <<'EOF'\nIt's a fix (see settings) for .claude/settings.json\nEOF\n)\"")],
  ['eng', ...B('git diff develop...HEAD -- app/settings/ | grep -n DEBUG')],
  ['eng', ...B('git log --oneline -5 -- .claude/settings.json')],
  ['eng', ...B('git diff -- .claude/settings.json')],
  ['eng', ...B('git blame .claude/settings.local.json')],
  ['eng', ...B('git status --short .claude/')],
  ['eng', ...B('git add app/settings/base.py && git commit -m "settings: tidy (.claude/settings.json untouched)"')],
  // find / jq / readers
  ['eng', ...B("find . -name 'settings*' -not -path './node_modules/*'")],
  ['eng', ...B("find .claude -name 'settings*.json'")],
  ['eng', ...B('jq . package.json > out.json')],
  ['eng', ...B("jq '.permissions' .claude/settings.json")],
  ['eng', ...B('jq -r .defaultMode ~/.claude/settings.json')],
  ['eng', ...B('python3 -m json.tool .claude/settings.local.json')],
  ['eng', ...B('shasum -a 256 .claude/settings.json')],
  ['eng', ...B('cp ~/.claude/settings.json /tmp/claude-settings-backup.json')],
  ['eng', ...B('while read -r l; do echo "$l"; done < .claude/settings.json')],
  ['eng', ...B('python3 scripts/check.py < .claude/settings.json')],
  ['eng', ...B('diff <(jq -S . .claude/settings.json) <(jq -S . ~/.claude/settings.json)')],
  ['eng', ...B('cat ~/.keelcrew/briefs/keel-BRIN-9.md | head -40')],
  ['eng', ...B('rg -n defaultMode ~/.claude/settings.json .claude/')],
  // npm / make / docker
  ['eng', ...B('npm install --save-dev eslint > npm.log 2>&1 && npm test')],
  ['eng', ...B('npm --prefix ui run lint -- --fix')],
  ['eng', ...B('npx prettier --write "src/**/*.{js,jsx}"')],
  ['eng', ...B('make test SETTINGS=app/settings/test.py')],
  ['eng', ...B('make -C frontend build 2>&1 | tail -20')],
  ['eng', ...B('docker compose -f docker-compose.yml up -d')],
  ['eng', ...B('docker run --rm -v "$PWD":/app -w /app python:3.11 python -c "import fastapi"')],
  // VS Code / app settings files
  ['eng', ...B("sed -i '' 's/80/120/' .vscode/settings.json")],
  ['eng', ...B('cp .vscode/settings.json .vscode/settings.json.bak')],
  ['eng', 'Write', { file_path: join(WT, 'app', 'settings', 'local_override.py'), content: 'x' }],
  ['eng', ...B("cat > app/settings/test.py <<'EOF'\nfrom .base import *  # noqa\nEOF")],
  ['eng', ...B("printf 'DEBUG = True\\n' >> app/settings/local.py")],
  ['eng', ...B('echo {} > .claude-plugin/settings.json')],
  ['eng', ...B('cp docs/x.md .claude/commands/')],
  ['eng', ...B('cd /tmp && echo {} > settings.json')],
  ['eng', ...B('echo x > notes/lead.md && echo y > /tmp/briefs/keel-x.md')],
  // Mate in .claude/worktrees paths
  ['lead', ...B('cd brinewick-api/.claude/worktrees/BRIN-9 && git status && python -m pytest -q')],
  ['lead', ...B('git -C brinewick-api/.claude/worktrees/BRIN-9 diff --stat')],
  ['lead', ...B("cat >> ~/.keelcrew/lead.md <<'EOF'\n- prefers small PRs\nEOF")],
  ['lead', ...B('cp ~/.keelcrew/briefs/keel-a.md ~/.keelcrew/briefs/keel-b.md')],
  ['lead', ...B("jq '.permissions' brinewick-api/.claude/settings.json")],
];

const cases = [
  ['deny', 'eng', ...B('echo {} > ${HOME}/.claude/settings.json')],
  ['deny', 'eng', ...B('cp x ${HOME}/.claude/settings.local.json')],
  ['deny', 'lead', ...B('echo {} | tee "${HOME}/.claude/settings.json"')],
  ['deny', 'eng', ...B('echo x > "${HOME}/.keelcrew/briefs/keel-x.md"')],
  ['deny', 'eng', ...B("{ echo '{\"disableAllHooks\":true}'; } > .claude/settings.json")],
  ['deny', 'eng', ...B('(echo {}) > .claude/settings.local.json')],
  ['deny', 'lead', ...B("{ echo '{}'; } > ~/.claude/settings.json")],
  ['deny', 'eng', ...B('{ echo "skip review"; } >> ~/.keelcrew/lead.md')],
  ['deny', 'eng', ...B('> .claude/settings.json')],
  ['deny', 'eng', ...B("cat <<'EOF' > .claude/settings.json\n{}\nEOF")],
  ['deny', 'eng', ...B("bash <<'EOF'\necho {} > .claude/settings.json\nEOF")],
  ['deny', 'eng', 'Write', { file_path: 'cfglink/settings.json', content: '{}' }],
  ['allow', 'eng', ...B("git commit -m \"$(cat <<'EOF'\nFix two things:\n1) guard writes\n2) docs for .claude/settings.json\nEOF\n)\"")],
  ['allow', 'eng', ...B('mkdir -p .claude/commands && cp docs/cmd.md .claude/commands/review.md')],
  ['allow', 'lead', ...B('git -C brinewick-api worktree add .claude/worktrees/BRIN-10 -b feat/x')],
  ['allow', 'lead', ...B('cp ~/notes.txt brinewick-api/.claude/worktrees/BRIN-9/')],
  ['allow', 'eng', ...B('tar -czf /tmp/claude-cfg.tgz .claude/commands')],
  ['allow', 'eng', ...B('cp -r .claude/commands /tmp/cmds-backup')],
];
let n = 0;
let bad = 0;
/** @param {'deny' | 'allow'} want @param {any[]} row */
const check = (want, [who, tool, ti, cwd, env]) => {
  n++;
  c.clearDenials();
  const r = c.hook(who, tool, ti, cwd, env);
  const denied = r.decision === 'deny';
  if (denied !== (want === 'deny') || r.status !== 0) {
    bad++;
    console.log(`FAIL must ${want === 'deny' ? 'deny' : 'not deny'}: ${who} ${tool} ${JSON.stringify(ti.command ?? ti.file_path ?? ti.notebook_path)} -> ${r.decision ?? 'none'} ${r.reason.slice(0, 100)}`);
  }
};
for (const row of mustDeny) check('deny', row);
for (const row of mustAllow) check('allow', row);
for (const [want, ...row] of cases) check(want === 'deny' ? 'deny' : 'allow', row);
rmSync(H, { recursive: true, force: true });
console.log(`${n - bad}/${n} hook guard checks pass`);
process.exit(bad ? 1 : 0);
