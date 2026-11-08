#!/usr/bin/env node
// @ts-check
// The crew policy's file guards against the ways a shell can reach a file: Claude Code settings files (anyone) and the
// briefs and Mate notes (anyone but the Mate). Every case runs in a throwaway crew with its own HOME.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const H = mkdtempSync(join(tmpdir(), 'keelcrew-guards-'));
const CH = join(H, '.keelcrew');
// Core modules read KEELCREW_HOME when first imported, and `~` is HOME: set both before importing them.
process.env.HOME = H;
process.env.KEELCREW_HOME = CH;
const LH = join(H, 'mate-home');
const REPO = join(LH, 'brinewick-api');
const WT = join(REPO, '.claude', 'worktrees', 'BRIN-2');
mkdirSync(CH, { recursive: true });
mkdirSync(REPO, { recursive: true });
const git = (/** @type {string[]} */ ...args) => execFileSync('git', args, { stdio: 'ignore' });
git('init', '-q', REPO);
git('-C', REPO, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
git('-C', REPO, 'worktree', 'add', '-q', '-b', 'x', WT);
writeFileSync(join(CH, 'config.json'), JSON.stringify({ owner: 'Sam', pack: 'brinewick', leadDir: LH, promptMode: 'deny', schemaVersion: 2 }));
const crew = (/** @type {string} */ sid, /** @type {string} */ cwd, /** @type {string[]} */ args) =>
  spawnSync('node', [join(root, 'cli', 'keelctl.mjs'), ...args], { cwd, env: { ...process.env, CLAUDE_CODE_SESSION_ID: sid }, encoding: 'utf8' });
crew('lead-1', LH, ['register', 'lead', '-', LH]);
crew('eng-2', WT, ['register', 'engineer', 'BRIN-2']);

const { policyDecision } = await import('../core/policy.mjs');
/** @param {string} who @param {string} tool @param {Record<string, unknown>} ti @param {string} [cwd] */
const decide = (who, tool, ti, cwd) => {
  rmSync(join(CH, 'denials'), { recursive: true, force: true });
  return policyDecision({ hook_event_name: 'PreToolUse', cwd: cwd ?? (who === 'lead' ? LH : WT), session_id: who === 'lead' ? 'lead-1' : 'eng-2', tool_name: tool, tool_input: ti });
};
const B = (/** @type {string} */ command) => /** @type {[string, Record<string, unknown>]} */ (['Bash', { command }]);

const mustDeny = [
  // bypasses found in review
  ['eng', ...B('git checkout develop --')],
  ['eng', ...B('rm -rf .claude')],
  ['eng', ...B('git checkout HEAD~1 -- .claude')],
  ['eng', ...B('git restore --source=HEAD~3 -- .claude/')],
  ['eng', ...B('git -C .claude checkout HEAD~1 -- settings.json')],
  ['eng', ...B('ln ~/.claude/settings.json hl && echo {} > hl')],
  ['eng', ...B("python3 -c \"p='.claude/settings.json'; open(p,'w').write('{}')\"")],
  // more bypasses found in review
  ['eng', ...B("# it's fine\necho {} > .claude/settings.json")],
  ['eng', ...B('export F=.claude/settings.json; echo {} > $F')],
  ['eng', ...B('cp x $(echo .claude/settings.json)')],
  ['eng', ...B("timeout 5 python3 -c \"open('.claude/settings.json','w').write('{}')\"")],
  ['eng', ...B("uv run python -c \"open('.claude/settings.json','w')\"")],
  ['eng', ...B("node --eval \"require('fs').writeFileSync('.claude/settings.json','{}')\"")],
  ['eng', ...B("php -r \"file_put_contents('.claude/settings.json','{}');\"")],
  ['eng', ...B("python3 <<< \"open('.claude/settings.json','w')\"")],
  ['eng', ...B('echo {} >! .claude/settings.json')],
  ['eng', ...B('yq -i ".a=1" .claude/settings.json')],
  ['eng', ...B('git config --file .claude/settings.json a.b c')],
  ['eng', ...B('tar -xf evil.tar -C ~/.claude')],
  ['eng', ...B('unzip -o evil.zip -d .claude')],
  ['eng', ...B('curl -so .claude/settings.json http://x')],
  ['eng', ...B('curl --output-dir ~/.keelcrew/briefs -O http://x/keel-x.md')],
  ['eng', ...B('find ~ -name settings.local.json -delete')],
  ['eng', ...B('ln -s ~/.claude cl && echo {} > cl/settings.json')],
  ['eng', ...B('ln -s ~/.claude/settings.json cl && rm cl/')],
  ['eng', ...B('ln -s ~/.claude/settings.json cl && rm cl > cl')],
  ['eng', ...B(`echo x >> ~${H.split('/').pop()}/.keelcrew/lead.md`)],
  ['eng', ...B('echo {} > "$(echo ~)/.claude/settings.json"')],
  // engineer, settings, file tools
  ['eng', 'Write', { file_path: join(REPO, '.claude', 'settings.json'), content: '{}' }],
  ['eng', 'Write', { file_path: '../../settings.local.json', content: '{}' }],
  ['eng', 'Write', { file_path: '~/.claude/settings.json', content: '{}' }],
  ['eng', 'Edit', { file_path: join(WT, '.claude', 'settings.json'), old_string: 'a', new_string: 'b' }],
  ['eng', 'MultiEdit', { file_path: '../../SETTINGS.LOCAL.JSON', edits: [] }],
  ['eng', 'NotebookEdit', { notebook_path: '~/.Claude/Settings.Json', new_source: 'x' }],
  ['eng', 'Write', { file_path: '~/.claude//./settings.json', content: '{}' }],
  // engineer, settings, Bash
  ['eng', ...B('echo {} > ../../settings.local.json')],
  ['eng', ...B('cd ..; cd ..; echo {} > settings.json')],
  ['eng', ...B('cd .. && cd .. && echo {} > settings.json')],
  ['eng', ...B('cd -- ../.. && echo {} > settings.local.json')],
  ['eng', ...B('cd -P ../.. && echo {} > settings.local.json')],
  ['eng', ...B('pushd ../.. && echo {} > settings.local.json')],
  ['eng', ...B('builtin cd ../.. && echo {} > settings.local.json')],
  ['eng', ...B('cd ../..\necho {} > settings.local.json')],
  ['eng', ...B('cd $HOME/.claude && echo {} > settings.json')],
  ['eng', ...B('cd ~/.claude && echo {} > settings.json')],
  ['eng', ...B('cd . > .claude/settings.json')],
  ['eng', ...B('cd . & echo {} > .claude/settings.json')],
  ['eng', ...B('{ cd ../..; echo {} > settings.local.json; }')],
  ['eng', ...B('(cd ../.. && echo {} > settings.local.json)')],
  ['eng', ...B('(echo {} > .claude/settings.json)')],
  ['eng', ...B('echo {} >| .claude/settings.json')],
  ['eng', ...B('echo {}>.claude/settings.json')],
  ['eng', ...B("echo '{}'>../../settings.json")],
  ['eng', ...B('echo {} &>.claude/settings.json')],
  ['eng', ...B('echo {} 2>.claude/settings.json')],
  ['eng', ...B('tee -a .claude/settings.json < x')],
  ['eng', ...B('printf x | tee -a ~/.claude/settings.local.json')],
  ['eng', ...B("sed -i '' 's/a/b/' .claude/settings.json")],
  ['eng', ...B("sed -i.bak -e 's/a/b/' ~/.claude/settings.json")],
  ['eng', ...B("perl -pi -e 's/a/b/' .claude/settings.json")],
  ['eng', ...B('cp x.json .claude/settings.json')],
  ['eng', ...B('cp settings.json .claude/')],
  ['eng', ...B('cp settings.json ../..')],
  ['eng', ...B('cp -t .claude settings.json')],
  ['eng', ...B('mv /tmp/s.json ~/.claude/settings.json')],
  ['eng', ...B('ln -sf /tmp/evil.json .claude/settings.local.json')],
  ['eng', ...B('install -m 644 x.json .claude/settings.json')],
  ['eng', ...B('rsync -a x.json .claude/settings.json')],
  ['eng', ...B('rsync -a settings.json ~/.claude/')],
  ['eng', ...B('dd if=x of=.claude/settings.json')],
  ['eng', ...B('curl -so .claude/settings.json http://x')],
  ['eng', ...B('curl -s --output=.claude/settings.json http://x')],
  ['eng', ...B('git checkout -- .claude/settings.json')],
  ['eng', ...B(`python3 -c "open('.claude/settings.json','w').write('{}')"`)],
  ['eng', ...B(`node -e "require('fs').writeFileSync('.claude/settings.json','{}')"`)],
  ['eng', ...B('bash -c "echo {} > .claude/settings.json"')],
  ['eng', ...B('F=.claude/settings.json; echo {} > $F')],
  ['eng', ...B('F=./.claude/settings.json; echo {} > "$F"')],
  ['eng', ...B('echo {} > $(echo .claude/settings.json)')],
  ['eng', ...B('echo {} > `echo .claude/settings.json`')],
  ['eng', ...B('echo {} > "$(printf .claude/settings.json)"')],
  ['eng', ...B('cp x .claude/settings.*')],
  ['eng', ...B('cp x .claude/s*')],
  ['eng', ...B('cp x .claude/settings{,.local}.json')],
  ['eng', ...B('cp x .claude/settings.local.jso?')],
  ['eng', ...B('cp x .claude/[s]ettings.json')],
  ['eng', ...B('cp x .cl*/settings.json')],
  ['eng', ...B('cp x .clau[d]e/settings.json')],
  ['eng', ...B('cp x ".claude"/settings.json')],
  ['eng', ...B("cp x .claude/'settings.json'")],
  ['eng', ...B('cp x .claude/**/settings.json')],
  ['eng', ...B('echo {} > .CLAUDE/SETTINGS.LOCAL.JSON')],
  // engineer, from inside .claude
  ['eng', ...B('echo {} > settings.local.json'), join(WT, '.claude')],
  ['eng', ...B('echo {} > *.json'), join(WT, '.claude')],
  // engineer, briefs / lead.md
  ['eng', 'Write', { file_path: '~/.keelcrew/briefs/keel-x.md', content: 'x' }],
  ['eng', 'Write', { file_path: join(CH, 'briefs', 'keel-x.md'), content: 'x' }],
  ['eng', 'Edit', { file_path: '~/.keelcrew/lead.md', old_string: 'a', new_string: 'b' }],
  ['eng', 'Write', { file_path: '~/.keelcrew/briefs/../lead.md', content: 'x' }],
  ['eng', 'Write', { file_path: '~/.KEELCREW/lead.md', content: 'x' }],
  ['eng', 'Write', { file_path: '~/.keelcrew/Lead.md', content: 'x' }],
  ['eng', 'Write', { file_path: '~/.keelcrew/Briefs/keel-x.md', content: 'x' }],
  ['eng', ...B('echo x >> ~/.keelcrew/lead.md')],
  ['eng', ...B('echo x>>~/.keelcrew/lead.md')],
  ['eng', ...B('cd ~/.keelcrew && echo x >> lead.md')],
  ['eng', ...B('cd ~/.keelcrew/briefs && echo x > keel-x.md')],
  ['eng', ...B('tee -a ~/.keelcrew/lead.md < x')],
  ['eng', ...B("sed -i '' 's/a/b/' ~/.keelcrew/lead.md")],
  ['eng', ...B('cp x.md ~/.keelcrew/briefs/')],
  ['eng', ...B('cp lead.md ~/.keelcrew/')],
  ['eng', ...B('mv x ~/.keelcrew/lead.md')],
  ['eng', ...B('F=~/.keelcrew/lead.md; echo x >> $F')],
  ['eng', ...B('echo x >> $HOME/.keelcrew/lead.md')],
  ['eng', ...B('echo x > ~/.keelcrew/lead.m?')],
  ['eng', ...B('echo x > ~/.keelcrew/brief*/keel-x.md')],
  ['eng', ...B('echo x >> ~/.KEELCREW/lead.md')],
  ['eng', ...B(`python3 -c "open('${CH}/lead.md','a').write('x')"`)],
  ['eng', ...B('(echo x >> ~/.keelcrew/lead.md)')],
  // Mate, settings
  ['lead', 'Write', { file_path: join(REPO, '.claude', 'settings.json'), content: '{}' }],
  ['lead', 'Write', { file_path: '~/.claude/settings.json', content: '{}' }],
  ['lead', ...B('echo {} > brinewick-api/.claude/settings.local.json')],
  ['lead', ...B('cd brinewick-api/.claude && echo {} > settings.json')],
  ['lead', ...B('cd brinewick-api && cp x .claude/')],
  ['eng', ...B('cp /tmp/x .claude/{settings,other}.json')],
  ['eng', ...B('cp /tmp/x .claude/{set*,other}.json')],
];

const mustNotDeny = [
  // Python literals in -c code are not path globs (the policy check threw on them and failed closed)
  ['eng', ...B(`cd ${WT} && .venv/bin/python -c "import json; print(json.dumps({'results': [{'system_prompt': 'x', 'ids': [1, 2]}]}))"`)],
  ['eng', ...B(`python3 -c "d = {'a': [1, {'b': [2]}]}; print(d['a'][1])"`)],
  ['eng', ...B('echo x > out/[z-a].txt')],
  ['eng', ...B('echo x > out/{*.txt,[b}/y')],
  // bypasses found in review
  ['eng', ...B(`python3 - <<'EOF'\nimport os,sys\nsys.path.insert(0,'${WT}')\nos.environ.setdefault('APP_CONFIG','settings.local.toml')\nprint(1 > 0)\nEOF`)],
  ['eng', ...B(`python3 -c "p='${WT}/app/settings/base.py'; s=open(p).read(); open(p,'w').write(s)"`)],
  ['eng', ...B(`python3 -c "import shutil; shutil.copy('${WT}/app/settings/local.py','/tmp/local.py')"`)],
  ['eng', ...B("python3 -c \"import json,pathlib; d=json.load(open('.claude/settings.json')); pathlib.Path('/tmp/p.json').write_text(json.dumps(d))\"")],
  ['eng', ...B("node -e \"const s=require('./.claude/settings.json'); console.log(Object.keys(s).filter(k => k.length))\"")],
  ['eng', ...B(`python3 -c "print(open('${CH}/briefs/keel-d-1.md').read()[:200])"`)],
  ['eng', ...B('for d in dev qa; do jq . deploy/base.json > "deploy/$d/settings.json"; done')],
  ['eng', ...B('T=$(mktemp -d) && echo "{}" > "$T/settings.json"')],
  ['eng', 'Write', { file_path: join(H, '.claude', 'projects', 'p', 'memory', 'notes.md'), content: 'x' }],
  // everyday work that must keep running
  ['eng', ...B('if [ -f ~/.claude/settings.json ]; then echo yes; fi')],
  ['eng', ...B('[[ -f .claude/settings.json ]] && jq . .claude/settings.json')],
  ['eng', ...B('for f in .claude/settings.json .vscode/settings.json; do jq . "$f"; done')],
  ['eng', ...B('# rewrite .claude/settings.json later\ngit status')],
  ['eng', ...B('npx prettier --write "**/*.{js,json,md}"')],
  ['eng', ...B('git add src/**/*.json')],
  ['eng', ...B('git add .claude')],
  ['eng', ...B('tar -czf /tmp/x.tgz .claude')],
  ['eng', ...B('mkdir -p .claude')],
  ['eng', ...B('rsync -a ./ /tmp/b/ --exclude .claude')],
  ['eng', ...B('S=~/.claude/settings.json; jq . "$S"')],
  ['eng', ...B(`python3 -c "import json; print(json.load(open('.claude/settings.json')))"`)],
  ['eng', ...B('gh api repos/o/r/contents/.claude/settings.json')],
  ['eng', ...B("cat <<\\EOF\nsee .claude/settings.json\nEOF")],
  ['eng', ...B('git checkout develop -- app/settings.py')],
  ['eng', ...B('cd $(git rev-parse --show-toplevel) && sed -i "" s/80/120/ .vscode/settings.json')],
  ['eng', ...B('docker run --rm -v "$PWD":/app -w /app python:3.11 python -c "import fastapi"')],
  ['eng', ...B('curl -so /tmp/x.json https://example.com')],
  ['eng', ...B('python -m app.check --config=settings.local.toml')],
  ['eng', ...B('APP_CONFIG=settings.local.toml python -m app.check')],
  ['eng', ...B('pytest --config-file=settings.test.ini tests/')],
  ['eng', ...B('pytest --config-file settings.test.ini tests/')],
  ['eng', ...B('ruff check --no-fix app/settings*.py')],
  ['eng', ...B('ruff check --no-fix app/settings/')],
  ['eng', ...B('ruff check --fix app/settings/base.py')],
  ['eng', ...B(`cd ${WT} && ruff check --no-fix app/settings/*.py`)],
  ['eng', ...B('cd app/settings && ruff check --no-fix *.py')],
  ['eng', ...B('git add app/settings/base.py && git commit -m "fix .claude/settings.json handling"')],
  ['eng', ...B("git commit -m 'edit .claude/settings.local.json docs'")],
  ['eng', ...B('git commit -m "update settings.json docs for .claude"')],
  ['eng', ...B('git diff -- app/settings.py')],
  ['eng', ...B('git status')],
  ['eng', ...B('ls .claude/worktrees')],
  ['eng', ...B('ls ../../worktrees')],
  ['eng', ...B('ls -la .claude/')],
  ['eng', ...B('cat .vscode/settings.json')],
  ['eng', ...B('echo {} > .vscode/settings.json')],
  ['eng', ...B('find . -name "settings*.py"')],
  ['eng', ...B('grep -rn settings .claude/')],
  ['eng', ...B('echo {} > deploy/settings.json')],
  ['eng', ...B('cat .claude/settings.json')],
  ['eng', ...B('ls .claude/*')],
  ['eng', 'Read', { file_path: join(REPO, '.claude', 'settings.json') }],
  ['eng', 'Read', { file_path: '~/.claude/settings.local.json' }],
  ['eng', 'Read', { file_path: '~/.keelcrew/briefs/keel-d-1.md' }],
  ['eng', 'Read', { file_path: '~/.keelcrew/lead.md' }],
  ['eng', 'Edit', { file_path: join(WT, 'app', 'settings', 'base.py'), old_string: 'a', new_string: 'b' }],
  ['eng', 'Write', { file_path: join(WT, '.vscode', 'settings.json'), content: '{}' }],
  ['lead', 'Write', { file_path: '~/.keelcrew/briefs/keel-d-1.md', content: 'x' }],
  ['lead', 'Write', { file_path: join(CH, 'briefs', 'keel-d-1.md'), content: 'x' }],
  ['lead', 'Edit', { file_path: '~/.keelcrew/lead.md', old_string: 'a', new_string: 'b' }],
  ['lead', ...B('rm ~/.keelcrew/briefs/keel-d-1.md')],
  ['lead', ...B('echo x >> ~/.keelcrew/lead.md')],
  ['lead', ...B('~/.keelcrew/bin/keelctl doctor --fix')],
  ['lead', 'Read', { file_path: join(REPO, '.claude', 'settings.json') }],
  ['lead', ...B('ls brinewick-api/.claude/worktrees')],
  ['lead', ...B('git -C brinewick-api worktree list')],
];

let n = 0;
let bad = 0;
for (const [who, tool, ti, cwd] of /** @type {[string, string, Record<string, unknown>, string?][]} */ (/** @type {unknown} */ (mustDeny))) {
  n++;
  const r = decide(who, tool, ti, cwd);
  if (r?.decision !== 'deny') {
    bad++;
    console.log(`FAIL must deny: ${who} ${tool} ${JSON.stringify(ti.command ?? ti.file_path ?? ti.notebook_path)}${cwd ? ` (in ${cwd})` : ''} -> ${r?.decision ?? 'none'}`);
  }
}
for (const [who, tool, ti, cwd] of /** @type {[string, string, Record<string, unknown>, string?][]} */ (/** @type {unknown} */ (mustNotDeny))) {
  n++;
  const r = decide(who, tool, ti, cwd);
  if (r?.decision === 'deny') {
    bad++;
    console.log(`FAIL must not deny: ${who} ${tool} ${JSON.stringify(ti.command ?? ti.file_path)} -> ${r.reason}`);
  }
}
rmSync(H, { recursive: true, force: true });
console.log(`${n - bad}/${n} guard checks pass`);
process.exit(bad ? 1 : 0);
