// @ts-check
// Policy profiles: a role manifest's `policy` decides what its sessions may do; today's roles keep today's rules.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'keelcrew-profiles-'));
process.env.KEELCREW_HOME = home;
const env = { ...process.env, KEELCREW_HOME: home };
const { isContractor, profileOf } = await import('../core/agents.mjs');

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

expect('profile: the Mate', profileOf({ role: 'lead' }), 'lead');
expect('profile: an engineer', profileOf({ role: 'engineer' }), 'code');
expect('profile: a contractor (its manifest)', profileOf({ role: 'engineer', agent: 'contractor' }), 'code');
expect('profile: today\'s agents keep the agent rules', [profileOf({ role: 'agent', agent: 'qa' }), profileOf({ role: 'job', agent: 'learner' })], ['agent', 'agent']);
expect('profile: the CTO only reads', profileOf({ role: 'job', agent: 'cto' }), 'reader');
expect('profile: the designer drafts', profileOf({ role: 'agent', agent: 'designer' }), 'drafts');
expect('profile: comms, writer and release draft', ['comms', 'writer', 'release'].map((a) => profileOf({ role: 'agent', agent: a })), ['drafts', 'drafts', 'drafts']);
expect('profile: an unknown role is the most restricted', profileOf({ role: 'visitor' }), 'reader');
expect('contractor: by its manifest', [isContractor({ role: 'engineer', agent: 'contractor' }), isContractor({ role: 'engineer' }), isContractor({ role: 'agent', agent: 'contractor' })], [true, false, false]);

const leadDir = join(home, 'lead');
mkdirSync(leadDir, { recursive: true });
writeFileSync(join(home, 'config.json'), JSON.stringify({ owner: 'Sam', leadDir, pack: 'brinewick', promptMode: 'deny' }));
const crew = (sid, args) => spawnSync('node', [join(root, 'cli', 'keelctl.mjs'), ...args], { cwd: leadDir, env: { ...env, CLAUDE_CODE_SESSION_ID: sid, CLAUDE_CODE_HOST_SESSION_ID: `local_${sid}` }, encoding: 'utf8' });
expect('register: the CTO job joins', crew('cto-1', ['register', 'job', '-', leadDir, '--agent', 'cto']).status, 0);
expect('register: the learner job joins', crew('learn-1', ['register', 'job', '-', leadDir, '--agent', 'learner']).status, 0);
expect('register: the support job joins', crew('sup-1', ['register', 'job', '-', leadDir, '--agent', 'support']).status, 0);
/** @param {string} tool @param {Record<string, unknown>} input @param {string} sid */
const why = (tool, input, sid) => {
  const r = spawnSync('node', [join(root, 'hooks', 'policy.mjs')], { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sid, cwd: leadDir, tool_name: tool, tool_input: input }), env, encoding: 'utf8' });
  const out = (r.stdout ? JSON.parse(r.stdout) : {}).hookSpecificOutput ?? {};
  return [out.permissionDecision ?? 'none', String(out.permissionDecisionReason ?? '')];
};
const pre = (tool, input, sid) => why(tool, input, sid)[0];
expect('reader: may not write a file', pre('Write', { file_path: join(leadDir, 'notes.md'), content: 'x' }, 'cto-1'), 'deny');
expect('reader: may read one', pre('Read', { file_path: join(leadDir, 'notes.md') }, 'cto-1'), 'none');
expect('reader: posts nothing to a connector', pre('mcp__1a2b__createJiraIssue', { summary: 'x' }, 'cto-1'), 'deny');
expect('reader: reads a connector', pre('mcp__1a2b__searchJiraIssuesUsingJql', { jql: 'x' }, 'cto-1'), 'none');
expect('reader: filters crew JSON with jq', pre('Bash', { command: `~/.keelcrew/bin/keelctl org show --json | jq '.roles[] | select(.id == "cto")'` }, 'cto-1'), 'none');
const py = why('Bash', { command: `~/.keelcrew/bin/keelctl org show --json | python3 -c "import json,sys; print(json.load(sys.stdin))"` }, 'cto-1');
expect('reader: interpreter code is refused, pointing to jq', [py[0], /filter JSON with jq/.test(py[1])], ['deny', true]);
const misaddressed = why('mcp__ccd_session_mgmt__send_message', { session_id: 'learn-1', message: 'x' }, 'cto-1');
expect("reader: a message to a crew session's Claude Code id names its app id", [misaddressed[0], /Send it to local_learn-1/.test(misaddressed[1])], ['deny', true]);
expect('reader: an object key is no crew id', ['__proto__', 'constructor'].map((s) => /Send it to/.test(why('mcp__ccd_session_mgmt__send_message', { session_id: s, message: 'x' }, 'cto-1')[1])), [false, false]);
expect('reader: messages a crew session by its app id', pre('mcp__ccd_session_mgmt__send_message', { session_id: 'local_learn-1', message: 'x' }, 'cto-1'), 'allow');
expect('reader: writes the board (crew protocol)', pre('ArtifactData', { action: 'set', url: 'u', collection: 'inbox', doc_id: 'p', data: {} }, 'cto-1'), 'none');
expect('agent: a connector write runs for the learner', pre('mcp__1a2b__createJiraIssue', { summary: 'x' }, 'learn-1'), 'none');
expect('drafts: reads a connector', pre('mcp__0a1b__teams_list_channel_messages', { team: 'x' }, 'sup-1'), 'none');
expect('drafts: writes the board', pre('ArtifactData', { action: 'set', url: 'u', collection: 'inbox', doc_id: 'p', data: {} }, 'sup-1'), 'none');
expect('drafts: never sends', [pre('mcp__0a1b__teams_send_message', { text: 'x' }, 'sup-1'), pre('mcp__1a2b__send_email', { to: 'a' }, 'sup-1'), pre('mcp__0a1b__chat_reply', { text: 'x' }, 'sup-1')], ['deny', 'deny', 'deny']);
expect('drafts: its writes need a post', pre('mcp__1a2b__createJiraIssue', { summary: 'x' }, 'sup-1') !== 'none', true);
// Making a draft isn't sending; a channel post or a numbered send is. Neither refusal counts toward a pause.
expect('register: a second support run joins', crew('sup-2', ['register', 'job', '-', leadDir, '--agent', 'support']).status, 0);
const sending = (/** @type {string} */ tool) => why(tool, { text: 'x' }, 'sup-2')[1].includes('prepares drafts; sending');
expect('drafts: a draft is not a send', ['mcp__0a1b__create_reply_draft', 'mcp__0a1b__create_draft_reply', 'mcp__slack__slack_send_message_draft'].map(sending), [false, false, false]);
expect('drafts: sends it catches', ['mcp__slack__post_channel_message', 'mcp__0a1b__send_v2', 'mcp__gmail__send_draft'].map(sending), [true, true, true]);
expect('drafts: those refusals never pause it', [pre('Bash', { command: 'ls' }, 'sup-1'), pre('Bash', { command: 'ls' }, 'sup-2')], ['none', 'none']);
// A reader's refused connector writes don't pause it either: a tool's name is read roughly.
for (const tool of ['mcp__5e6f__ddsql_run_query', 'mcp__5e6f__explore_profiling_flame_graph', 'mcp__4d5e__submit_query']) expect(`reader: no connector write (${tool})`, pre(tool, {}, 'cto-1'), 'deny');
expect('reader: those refusals never pause it', pre('Bash', { command: 'ls' }, 'cto-1'), 'none');
// The designer writes to the kinds its manifest lists in `drafts` (its own Figma file), and still never sends.
const studio = join(home, 'work', 'designer-D-1');
mkdirSync(studio, { recursive: true });
expect('register: the designer joins', crew('des-1', ['register', 'agent', 'D-1', studio, '--agent', 'designer']).status, 0);
const FIGMA = 'mcp__0f3a9c2e-5b71-4d8e-a6c4-2e9b7d1f8a35';
// claude.ai connectors are named by id in the desktop app (mcp__<uuid>__…) and by name in the CLI (mcp__claude_ai_Figma__…).
const newFile = { fileName: 'D-1 · Login (crew draft)', planKey: 'team::1234567890', editorType: 'design' };
expect('drafts: the designer makes its Figma file and frames', [pre(`${FIGMA}__create_new_file`, newFile, 'des-1'), pre(`${FIGMA}__use_figma`, { code: 'x' }, 'des-1'), pre('mcp__claude_ai_Figma__create_new_file', {}, 'des-1'), pre('mcp__figma__use_figma', { code: 'x' }, 'des-1')], ['none', 'none', 'none', 'none']);
// Only Figma's own write tools: no other Figma write, and no other server's new file or Figma-named tool.
for (const [tool, input] of /** @type {[string, Record<string, unknown>][]} */ ([
  ['mcp__figma__delete_file', { fileKey: 'k' }],
  ['mcp__figma__invite_user', { email: 'a@b.c' }],
  ['mcp__figma__post_comment', { message: 'x' }],
  ['mcp__google_drive__create_new_file', { name: 'x' }],
  ['mcp__slack__share_figma_link_to_channel', { channel: 'c' }],
  [`${FIGMA}__create_new_file`, { fileName: 'D-1' }],
  ['mcp__0b6c3a9e-1111-4222-8333-944455556666__create_new_file', { name: 'x', mimeType: 'application/vnd.google-apps.document' }],
])) {
  expect(`drafts: the designer asks first for ${tool.split('__').slice(1).join('__')} (${Object.keys(input).join(', ')})`, pre(tool, input, 'des-1') !== 'none', true);
}
expect('drafts: but sends nothing to Figma, and writes nowhere else freely', [pre(`${FIGMA}__send_code_to_figma`, {}, 'des-1'), pre('mcp__1a2b__createJiraIssue', { summary: 'x' }, 'des-1') !== 'none'], ['deny', true]);
expect('drafts: a role without figma in its drafts asks first', pre(`${FIGMA}__create_new_file`, {}, 'sup-1') !== 'none', true);

console.log(fail ? `${fail} profile checks fail, ${pass} pass` : `${pass}/${pass} profile checks pass`);
process.exitCode = fail ? 1 : 0;
