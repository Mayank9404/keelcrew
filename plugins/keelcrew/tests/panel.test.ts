import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { cronTimes, otherLook, pieces, plainText, scene, stopTimes, watchesToday } from '../hooks/harbour.ts'

/** The test runner's own timer: the kit's types leave it out, since a hooks module has none. */
declare function setTimeout(fn: (...args: never[]) => void, ms: number): unknown

const HOME = '/home/sam'
const BOARD = 'https://claude.ai/artifact/board'
const WT = '/code/repo/.claude/worktrees/BRIN-1'
const CREW = `${HOME}/.keelcrew/crew.json`
const SUMMARY = `${HOME}/.keelcrew/summary.json`
const USAGE = `${HOME}/.keelcrew/usage.json`
const SCAN = `${HOME}/.keelcrew/scan.json`
const HEALTH = `${HOME}/.keelcrew/health.json`
const CREW_BIN = `${HOME}/.keelcrew/bin/keelctl`
const JIRA = 'mcp__atlassian__searchJiraIssuesUsingJql'
/** Monday 19 October 2026, 10:00 on this machine's clock: working hours for the scan and the health checks. */
const WORK = new Date(2026, 9, 19, 10, 0).getTime()

type Run = { exitCode: number; stdout: string; stderr?: string }
/** What `keelctl` and `df` answer on a healthy Mac whose team pack has a Jira query. */
function healthyRun(argv: readonly string[]): Run {
  if (argv[0] === 'df') return { exitCode: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 971350180 500000000 400000000 56% /System/Volumes/Data\n' }
  if (argv[0] !== CREW_BIN) return { exitCode: 0, stdout: '' }
  const answers: Record<string, string> = { pack: '{"name":"brinewick","pack":{"jira":{"jql":"assignee = currentUser()"}}}', doctor: '{"checks":[]}', costs: '{"tickets":{}}', alerts: 'Raised alert x.', memory: '[]' }
  return { exitCode: 0, stdout: answers[argv[1] ?? ''] ?? '' }
}

async function hash16(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}

const line = (id: string, data: Record<string, unknown>, version = 1) => JSON.stringify({ id, data, version })
const crew = (role: string) =>
  JSON.stringify({
    dirs: { [WT]: { role: 'engineer', key: 'BRIN-1' } },
    sessions: {
      'sess-1': role === 'engineer' ? { role, key: 'BRIN-1', dir: WT } : role === 'agent' ? { role, key: 'BRIN-1', dir: '/code/qa', agent: 'qa' } : { role, key: null, dir: '/code' },
    },
  })

/** A Mac whose crew has this session ('sess-1') in `role`, and a board holding `docs`; records what the mod does. `tools`
 * are the session's tools by name (the Jira search by default), `jira` answers the search (no issues by default), `run`
 * answers host commands (healthy by default), and `store` is what the mod's store holds at the start. */
function world(
  on: On,
  role: string,
  docs: Record<string, string[]>,
  options: {
    failUpdate?: boolean
    /** A crew policy denial for every board update (a crew session answering a card). */
    denyUpdate?: string
    secondPage?: Record<string, string[]>
    refuseSubmits?: number
    usage?: string
    refuseCompact?: boolean
    tools?: string[]
    jira?: (input: Record<string, unknown>) => string | Promise<string>
    run?: (argv: readonly string[]) => Run | undefined | Promise<Run | undefined>
    store?: Record<string, unknown>
    /** Files whose writes the mod reads back, as a real disk would. */
    persist?: string[]
    /** Characters of documents a board answer shows at most, as the board tool's size cap does. */
    cap?: number
    /** The board refuses the update that opens a card again. */
    failReopen?: boolean
    /** The plugin's agents/*.json manifests, by file name. */
    agents?: Record<string, string>
    /** Collections whose reads the board answers with this text instead (an answer the panel can't parse). */
    odd?: Record<string, string>
  } = {},
) {
  const writes: { path: string; text: string }[] = []
  const prompts: string[] = []
  const updates: Record<string, unknown>[] = []
  const sets: Record<string, unknown>[] = []
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const notifies: { text: string; title?: string }[] = []
  const usage = { calls: 0 }
  const compacts = { runs: 0, args: '' }
  const runs: string[][] = []
  /** The working folder of each host command, as `runs` lists them. */
  const cwds: (string | undefined)[] = []
  /** This session's id (a /clear gives it a new one); `fail` makes asking for it throw. */
  const session = { id: 'sess-1', fail: false }
  const jiraCalls: Record<string, unknown>[] = []
  const reads: { collection: string; where?: unknown[] }[] = []
  mock.env(on, { HOME })
  mock.store(on, options.store)
  const files: Record<string, string> = { [`${HOME}/.keelcrew/config.json`]: JSON.stringify({ board: BOARD, owner: 'Sam', jiraCloudId: 'cloud-0' }), [CREW]: crew(role) }
  /** Symbolic links: path → where it leads. */
  const links: Record<string, string> = {}
  on('fs.read', async (_$, e) => {
    // The plugin's own manifest, wherever its folder is, as files['plugin.json'].
    const text = files[links[e.path] ?? e.path] ?? (e.path.endsWith('/.claude-plugin/plugin.json') ? files['plugin.json'] : options.agents?.[e.path.match(/\/agents\/([^/]+)$/)?.[1] ?? ''])
    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.stat', async (_$, e) => {
    const real = links[e.path] ?? e.path
    const text = files[real]
    if (text === undefined) return { deny: `ENOENT ${e.path}` }
    return { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: real !== e.path, ...(e.resolve ? { realPath: real } : {}) } }
  })
  on('fs.exists', async (_$, e) => ({ value: Object.keys(files).some(k => k === e.path || k.startsWith(`${e.path}/`)) }))
  on('fs.list', async (_$, e) => ({
    value: (options.agents && e.path.endsWith('/agents') ? Object.keys(options.agents).map(k => `${e.path}/${k}`) : Object.keys(files))
      .filter(k => k.startsWith(`${e.path}/`) && !k.slice(e.path.length + 1).includes('/'))
      .map(k => ({ name: k.slice(e.path.length + 1), kind: 'file', size: 0, mtimeMs: 0, isLink: false })),
  }) as never)
  on('fs.write', async (_$, e) => {
    writes.push({ path: e.path, text: e.text })
    if (options.persist?.includes(e.path)) files[e.path] = e.text
    return { value: undefined }
  })
  on('tool.call', { tool: 'ArtifactData' } as never, async (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    if (input.action === 'update') {
      updates.push(input)
      if (options.denyUpdate) return { deny: options.denyUpdate } as never
      // Like the board tool: an update to an existing document must pin the version it replaces.
      if (input.if_version === undefined) return { result: {}, isError: true as const, text: 'A write to an existing document needs if_version.' }
      if (options.failUpdate || (options.failReopen && (input.data as { status?: string }).status === 'open')) return { result: {}, isError: true as const, text: 'version mismatch' }
      return { result: {}, text: `Database update committed: "${String(input.collection)}"/"${String(input.doc_id)}". The document is now at version ${Number(input.if_version) + 1}.` }
    }
    if (input.action === 'set' || input.action === 'batch') {
      sets.push(input)
      return { result: {}, text: 'Database write committed.' }
    }
    const collection = String(input.collection)
    if (options.odd?.[collection] !== undefined) return { result: {}, text: options.odd[collection]! }
    if (input.action === 'get') {
      const doc = (docs[collection] ?? []).find(l => (JSON.parse(l) as { id: string }).id === input.doc_id)
      return doc ? { result: {}, text: `1 document\n=== BEGIN ARTIFACT DB x ===\n${doc}\n=== END ARTIFACT DB x ===` } : { result: {}, isError: true as const, text: 'not found' }
    }
    const query = (input.query ?? {}) as { where?: [string, string, unknown][]; order_by?: { field: string; direction: string }; limit?: number; cursor?: string }
    const later = options.secondPage?.[collection]
    const onSecond = query.cursor === 'c1'
    // Like the board: where clauses filter (a missing field matches only `not-in`), order_by sorts, limit and an `off:`
    // cursor page, and past `cap` characters the answer leaves whole documents out but still counts them.
    const fields = (l: string) => (JSON.parse(l) as { data: Record<string, unknown> }).data
    const matches = (l: string) =>
      (query.where ?? []).every(([f, op, v]) => {
        const x = fields(l)[f]
        if (op === 'not-in') return !(v as unknown[]).includes(x)
        if (x === undefined) return false
        return op === '==' ? x === v : op === 'in' ? (v as unknown[]).includes(x) : op === '>=' ? (x as number) >= (v as number) : op === '<=' ? (x as number) <= (v as number) : false
      })
    let all = (onSecond ? (later ?? []) : (docs[collection] ?? [])).filter(matches)
    if (query.order_by) {
      const { field, direction } = query.order_by
      all = [...all].sort((a, b) => ((fields(a)[field] as number) - (fields(b)[field] as number)) * (direction === 'desc' ? -1 : 1))
    }
    const off = query.cursor?.startsWith('off:') ? Number(query.cursor.slice(4)) : 0
    const limit = query.limit ?? 1000
    const rows = all.slice(off, off + limit)
    const shown: string[] = []
    for (const r of rows) {
      if (options.cap !== undefined && [...shown, r].join('\n').length > options.cap) break
      shown.push(r)
    }
    const cut = rows.length - shown.length
    const elided = cut ? `\n[${cut} documents elided — size cap; a smaller read is the only way to see them.]` : ''
    const more =
      later && !onSecond
        ? '\nnext_cursor: "c1" — more documents exist; pass this as `query.cursor` to read the next page.'
        : !query.order_by && off + limit < all.length
          ? `\nnext_cursor: "off:${off + limit}" — more documents exist; pass this as \`query.cursor\` to read the next page.`
          : ''
    reads.push({ collection, where: query.where })
    if (!rows.length && !more) return { result: {}, text: `No documents matched in collection "${collection}".` }
    const head = `${rows.length} document${rows.length === 1 ? '' : 's'} from collection "${collection}":`
    return { result: {}, text: `${head}\n=== BEGIN ARTIFACT DB x ===\n${shown.join('\n')}\n=== END ARTIFACT DB x ===${elided}${more}` }
  })
  on('tool.call', { tool: 'mcp__ccd_session_mgmt__get_usage' } as never, async () => {
    usage.calls++
    return { result: {}, text: options.usage ?? JSON.stringify({ plan: { status: 'not_applicable' } }) }
  })
  on('tool.list', async () => ({ value: (options.tools ?? [JIRA]).map(name => ({ name, description: '', mcp: true })) }) as never)
  // The panel searches Jira on the MCP server directly (raw content blocks, whatever their size).
  on('mcp.call', async (_$, e, next) => {
    const call = e as unknown as { server: string; tool: string; args: Record<string, unknown> }
    if (`mcp__${call.server}__${call.tool}` !== JIRA) return next(e)
    const input = { tool: JIRA, ...call.args }
    jiraCalls.push(input)
    const text = options.jira ? await options.jira(input) : '{"data":{"issues":[],"isLast":true}}'
    return { value: { content: [{ type: 'text', text }], isError: false } } as never
  })
  on('process.run', async (_$, e) => {
    const argv = (e as unknown as { argv: readonly string[] }).argv
    runs.push([...argv])
    cwds.push((e as unknown as { init?: { cwd?: string } }).init?.cwd)
    if (argv[0] === 'rm') delete files[argv[2]!]
    const r = (await options.run?.(argv)) ?? healthyRun(argv)
    return { value: { stderr: '', ...r, isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('command.run', { command: 'compact' } as never, async (_$, e) => {
    compacts.runs++
    compacts.args = (e as unknown as { args: string }).args
    if (options.refuseCompact) throw new Error('refused')
    return {} as never
  })
  on('turn.start', async (_$, e) => ({ turnId: (e as unknown as { turnId: string }).turnId }) as never)
  on('turn.complete', async () => ({ text: 'ok' }) as never)
  let refusals = options.refuseSubmits ?? 0
  on('prompt.submit', async (_$, e) => {
    if (refusals > 0) {
      refusals--
      return { drop: 'busy' } as never
    }
    prompts.push(e.text)
    return { text: e.text }
  })
  on('session.id', async () => {
    if (session.fail) throw new Error('no session id')
    return { value: session.id }
  })
  on('session.start', async () => ({ cwd: '/code' }) as never)
  on('session.end', async (_$, e) => ({ sessionId: (e as unknown as { sessionId: string }).sessionId }) as never)
  on('command.register', async () => ({ value: { name: 'keel-panel' } }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async (_$, e) => {
    statuses.push((e as unknown as { text?: string }).text)
    return { value: undefined }
  })
  on('ui.toast', async (_$, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined }
  })
  on('ui.notify', async (_$, e) => {
    const n = e as unknown as { text: string; title?: string }
    notifies.push({ text: n.text, title: n.title })
    return { value: { isSent: false, reason: 'no-surface' } } as never
  })
  return { writes, prompts, updates, sets, files, links, toasts, statuses, notifies, usage, compacts, runs, cwds, session, jiraCalls, reads }
}

const PLUGIN = '/opt/keelcrew/plugins/keelcrew'
const LEAD_SKILL = `${PLUGIN}/skills/keel-lead/SKILL.md`
const SKILL_LINE = 'Your keel-lead skill changed since you read it: run the keelcrew:keel-lead skill again first, then handle this.'
/** The crew command as `keelctl setup` leaves it, HOME/bin/keelctl linked to the plugin's cli/keelctl.mjs; and the plugin's keel-lead
 * skill holding `skill`, or no skill file when it is left out. */
function installCrew(w: { files: Record<string, string>; links: Record<string, string> }, skill?: string) {
  w.links[CREW_BIN] = `${PLUGIN}/cli/keelctl.mjs`
  w.files[`${PLUGIN}/cli/keelctl.mjs`] = '#!/usr/bin/env node'
  if (skill === undefined) delete w.files[LEAD_SKILL]
  else w.files[LEAD_SKILL] = skill
}

type Ui = { press: (t: { key: string }) => Promise<unknown>; find: (t: { type?: string; text?: RegExp }) => Promise<{ text?: string } | undefined>; unmount: () => Promise<void> }
const mountPane = async ($: { ui: { mount: (t: never) => Promise<unknown> } }, surface: 'terminal' | 'desktop', component: string, requestId?: string) =>
  (await $.ui.mount({ plugin: 'keelcrew', surface, component, ...(requestId ? { requestId } : {}), props: {} } as never)) as Ui

/** The ship rules this mod copies; scripts/check-consistency.mjs checks them against plugins/keelcrew/rules/rules.json. */
const rules = { ship: { choices: ['Open PR', 'Draft PR', 'Push only', 'Not yet'] } }
const SHA_A = 'a'.repeat(40)
/** `keelctl grant` as the helper answers it: the approval it wrote, or why it refused. */
const granted = (risk = 'low', expires = 2_000_000 + 20160 * 60_000) => (argv: readonly string[]): Run | undefined =>
  argv[1] !== 'grant' ? undefined : { exitCode: 0, stdout: JSON.stringify({ ok: true, key: argv[3], choice: argv[5], head: argv[6] === '--head' ? argv[7] : 'd'.repeat(40), expires: argv[5] === 'Not yet' ? null : expires, risk }) }
const grantRuns = (runs: string[][]) => runs.filter(r => r[0] === CREW_BIN && r[1] === 'grant')

const OPEN_REQUEST = { requests: [line('r1', { kind: 'start', key: 'BRIN-2', status: 'open' })] }
const SHIP_CARD = line('ship-1', { kind: 'ship', status: 'open', taskKey: 'BRIN-1', title: 'Push & PR', body: 'Adds the thing.', risk: 'low', receipts: { head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }, 7)
const SHIP = { inbox: [SHIP_CARD] }

test('the Mate is woken once for a new board request, and again only after 15 minutes', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = world(on, 'lead', OPEN_REQUEST)
  await $.session.start({ cwd: '/code' } as never)
  await $.command.run({ command: 'keel-panel' } as never)
  expect(prompts.length).toBe(0)
  await clock.advance(60_000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('request start BRIN-2')
  expect(prompts[0]).toMatch(/Changed: requests\/\S+/)
  await clock.advance(60_000)
  expect(prompts.length).toBe(1)
  await clock.advance(15 * 60_000)
  expect(prompts.length).toBe(2)
})

test('a session that is not the Mate is never woken', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = world(on, 'engineer', OPEN_REQUEST)
  await $.session.start({ cwd: '/code' } as never)
  await $.command.run({ command: 'keel-panel' } as never)
  await clock.advance(5 * 60_000)
  expect(prompts.length).toBe(0)
})

test('a Mate that is replaced stops being woken', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts, files } = world(on, 'lead', OPEN_REQUEST)
  await $.session.start({ cwd: '/code' } as never)
  await $.command.run({ command: 'keel-panel' } as never)
  await clock.advance(60_000)
  expect(prompts.length).toBe(1)
  files[CREW] = crew('engineer')
  await clock.advance(20 * 60_000)
  expect(prompts.length).toBe(1)
})

test('the Mate writes the ticket summary engineers read, and no session gets a status line', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const task = line('BRIN-1', { title: 'Fix alert date', phase: 'approval', status: 'active', summary: 'Ready to ship.', waiting: 'you' })
  const { writes, statuses } = world(on, 'lead', { ...OPEN_REQUEST, ...SHIP, tasks: [task] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  const summary = writes.filter(w => w.path === SUMMARY).at(-1)
  expect(summary).toBeDefined()
  expect(JSON.parse(summary!.text)).toMatchObject({
    tickets: { 'BRIN-1': { title: 'Fix alert date', phase: 'approval', summary: 'Ready to ship.', waiting: 'you', cards: ['launch card'] } },
  })
  expect(statuses.length).toBe(0)
})

test('the Mate toasts a new card for the captain, but not what was already there', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const docs: Record<string, string[]> = { inbox: [line('q-0', { kind: 'question', status: 'open', taskKey: 'BRIN-9' })] }
  const { toasts } = world(on, 'lead', docs)
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(toasts.length).toBe(0)
  docs.inbox = [...docs.inbox!, SHIP_CARD]
  await clock.advance(60_000)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toContain('launch card for BRIN-1')
})

test("an engineer's band shows its ticket, where it stands, what waits for the captain, its approval and its PR", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { files, statuses } = world(on, 'engineer', {})
  const ticket = { title: 'Fix alert date', phase: 'pr', status: 'qa', summary: 'QA found a timezone bug.', waiting: '', prUrl: 'https://github.com/o/r/pull/42', cards: ['question'] }
  files[SUMMARY] = JSON.stringify({ at: 1_000_000, tickets: { 'BRIN-1': ticket } })
  files[`${HOME}/.keelcrew/grants/${await hash16(WT)}.json`] = JSON.stringify({ choice: 'Push only', expires: 1_000_000 + 60_000 + 90 * 60_000 })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(statuses.length).toBe(0)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($ as never, surface, 'AbovePrompt')
    expect(await ui.find({ type: 'Text', text: /BRIN-1 · Fix alert date/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /pr \(qa\) · QA found a timezone bug\./ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /question waiting for you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /approved: Push only\s*$/ })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: /PR #42/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /No board update/ })).toBeUndefined()
    await ui.unmount()
  }
})

test("without a fresh summary from the Mate, an engineer's band says so and still shows its approval", async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const { files } = world(on, 'engineer', {})
  files[SUMMARY] = JSON.stringify({ at: WORK - 11 * 60_000, tickets: { 'BRIN-1': { title: 'Old', phase: 'build' } } })
  files[`${HOME}/.keelcrew/grants/${await hash16(WT)}.json`] = JSON.stringify({ choice: 'Draft PR', expires: WORK + 60_000 + 30 * 60_000 })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  const ui = await mountPane($ as never, 'desktop', 'AbovePrompt')
  expect(await ui.find({ type: 'Text', text: /No board update from the Mate's session/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /approved: Draft PR\s*$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Old/ })).toBeUndefined()
  await ui.unmount()
})

test("out of working hours an old summary is expected, so an engineer's band doesn't warn", async ($, on) => {
  const night = new Date(2026, 9, 19, 21, 30).getTime()
  const clock = mock.clock(on, { now: night })
  const { files } = world(on, 'engineer', {})
  files[SUMMARY] = JSON.stringify({ at: night - 60 * 60_000, tickets: {} })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  const ui = await mountPane($ as never, 'desktop', 'AbovePrompt')
  expect(await ui.find({ type: 'Text', text: /No board update from the Mate's session/ })).toBeUndefined()
  await ui.unmount()
})

test("Push only on a launch card marks the card, then approves that ticket's commit with keelctl grant ship, in the Mate's session too", async ($, on) => {
  mock.clock(on, { now: 2_000_000 })
  const { writes, updates, runs, toasts } = world(on, 'lead', SHIP, { run: granted() })
  for (const surface of ['terminal', 'desktop'] as const) {
    runs.length = 0
    await $.command.run({ command: 'keel-panel' } as never)
    const ui = await mountPane($ as never, surface, 'Pane', 'crew')
    await ui.press({ key: 'ship-1-Push only' })
    expect(updates.at(-1)).toMatchObject({ collection: 'inbox', doc_id: 'ship-1', if_version: 7, data: { status: 'approved', answer: 'Push only', answeredAt: 2_000_000 } })
    expect(grantRuns(runs)).toEqual([[CREW_BIN, 'grant', 'ship', 'BRIN-1', '--choice', 'Push only', '--head', SHA_A, '--json']])
    expect(toasts.at(-1)).toBe('BRIN-1: Push only approved for this commit (low risk).')
    await ui.unmount()
  }
  // The approval itself is the helper's to write, with its checks; the panel writes none of its own.
  expect(writes.filter(w => w.path.includes('/grants/'))).toEqual([])
})

test('a click on a card that changed on the board approves nothing', async ($, on) => {
  mock.clock(on, { now: 2_000_000 })
  const { writes, updates, runs } = world(on, 'lead', SHIP, { failUpdate: true, run: granted() })
  await $.command.run({ command: 'keel-panel' } as never)
  const ui = await mountPane($ as never, 'desktop', 'Pane', 'crew')
  await ui.press({ key: 'ship-1-Push only' })
  expect(updates.length).toBe(1)
  expect(grantRuns(runs)).toEqual([])
  expect(writes.filter(w => w.path.includes('/grants/')).length).toBe(0)
})

test('a click approves only a card that names a full commit id, so it is never bound to whatever the worktree holds; Not yet still goes', async ($, on) => {
  mock.clock(on, { now: 2_000_000 })
  const noHead = line('ship-2', { kind: 'ship', status: 'open', taskKey: 'BRIN-1', title: 'Push', body: 'x', risk: 'low' }, 3)
  const shortHead = line('ship-3', { kind: 'ship', status: 'open', taskKey: 'BRIN-1', title: 'Push', body: 'x', risk: 'low', receipts: { head: 'abc1234' } }, 4)
  const { updates, runs, toasts } = world(on, 'lead', { inbox: [noHead, shortHead] }, { run: granted() })
  await $.command.run({ command: 'keel-panel' } as never)
  const ui = await mountPane($ as never, 'desktop', 'Pane', 'crew')
  for (const key of ['ship-2-Open PR', 'ship-2-Push only', 'ship-3-Draft PR']) {
    await ui.press({ key })
    expect(updates).toEqual([])
    expect(grantRuns(runs)).toEqual([])
    expect(toasts.at(-1)).toBe("BRIN-1: the card doesn't name a full commit id, so nothing was approved (an approval is pinned to the commit it ships). Ask for a new launch card.")
  }
  await ui.press({ key: 'ship-2-Not yet' })
  expect(updates.map(u => u.data)).toEqual([{ status: 'rejected', answer: 'Not yet', answeredAt: 2_000_000 }])
  expect(grantRuns(runs)).toEqual([[CREW_BIN, 'grant', 'ship', 'BRIN-1', '--choice', 'Not yet', '--json']])
  await ui.unmount()
})

test('a click whose approval the helper refuses opens the card again and says why', async ($, on) => {
  mock.clock(on, { now: 2_000_000 })
  const refuse = (argv: readonly string[]): Run | undefined =>
    argv[1] === 'grant' ? { exitCode: 1, stdout: '', stderr: "The card's commit aaaaaaa isn't in BRIN-1's history (HEAD is bbbbbbb), so nothing was approved. Ask for a new launch card." } : undefined
  const { updates, toasts } = world(on, 'lead', SHIP, { run: refuse })
  await $.command.run({ command: 'keel-panel' } as never)
  const ui = await mountPane($ as never, 'desktop', 'Pane', 'crew')
  await ui.press({ key: 'ship-1-Open PR' })
  expect(updates.map(u => u.data)).toEqual([{ status: 'approved', answer: 'Open PR', answeredAt: 2_000_000 }, { status: 'open', answer: null, answeredAt: null }])
  // The reopen pins the version the answer made, or the board refuses it.
  expect(updates[1]).toMatchObject({ if_version: 8 })
  expect(updates[1]).toMatchObject({ collection: 'inbox', doc_id: 'ship-1' })
  expect(toasts.at(-1)).toContain("BRIN-1: nothing was approved, and the card is open again: The card's commit aaaaaaa isn't in BRIN-1's history")
  await ui.unmount()
})

test("the panel offers every ship choice", async ($, on) => {
  mock.clock(on, { now: 2_000_000 })
  world(on, 'lead', SHIP)
  await $.command.run({ command: 'keel-panel' } as never)
  const ui = await mountPane($ as never, 'desktop', 'Pane', 'crew')
  for (const choice of rules.ship.choices) expect(await ui.find({ type: 'Button', text: new RegExp(`^${choice}$`) })).toBeDefined()
  await ui.unmount()
})

test('a request past the first page of results still wakes the Mate', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = world(on, 'lead', { requests: [] }, { secondPage: { requests: [line('r9', { kind: 'stop', key: 'BRIN-9', status: 'open' })] } })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('request stop BRIN-9')
})

test('the Mate is nudged about one item at most three times, then the captain is told', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts, toasts } = world(on, 'lead', OPEN_REQUEST)
  await $.session.start({ cwd: '/code' } as never)
  for (let i = 0; i < 6; i++) await clock.advance(16 * 60_000)
  expect(prompts.length).toBe(3)
  expect(toasts.some(t => t.includes("hasn't handled request start BRIN-2"))).toBe(true)
})

test("a chat line from the Mate counts as its answer", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const chat = [line('m1', { who: 'me', text: 'hi', ts: 10 }), line('l1', { who: 'lead', text: 'hello', ts: 20 })]
  const { prompts } = world(on, 'lead', { chat })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(prompts.length).toBe(0)
})

test('a new captain line waits for its handledAt, whatever the Mate says meanwhile', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const chat: string[] = []
  const { prompts } = world(on, 'lead', { chat })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  chat.unshift(line('m2', { who: 'me', text: 're review the PR', ts: 1_100_000 }), line('l2', { who: 'lead', text: '#105 is updated', ts: 1_100_007 }))
  await clock.advance(60_000)
  expect(prompts.at(-1)).toContain('Changed: chat/m2')
})

test('a wake shows a small changed document whole, with its version, and leaves a large one to be read', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const chat: string[] = []
  const { prompts } = world(on, 'lead', { chat })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  chat.unshift(line('m4', { who: 'me', text: 'ship it', ts: 1_100_000 }, 3), line('m5', { who: 'me', text: 'x'.repeat(700), ts: 1_100_001 }))
  await clock.advance(60_000)
  expect(prompts.at(-1)).toContain('Changed: chat/m5, chat/m4')
  expect(prompts.at(-1)).toContain('Shown whole')
  expect(prompts.at(-1)).toContain('chat/m4 v3 {"who":"me","text":"ship it"')
  expect(prompts.at(-1)).not.toContain('chat/m5 v')
})

test('a captain line the Mate marked handled wakes nobody', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const chat: string[] = []
  const { prompts } = world(on, 'lead', { chat })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  chat.unshift(line('m3', { who: 'me', text: 'thanks', ts: 1_100_000, handledAt: 1_100_500 }))
  await clock.advance(60_000)
  expect(prompts.length).toBe(0)
})

test('Not yet clears an earlier approval: keelctl grant runs without a commit', async ($, on) => {
  mock.clock(on, { now: 2_000_000 })
  const { runs, toasts } = world(on, 'lead', SHIP, { run: granted('high') })
  await $.command.run({ command: 'keel-panel' } as never)
  const ui = await mountPane($ as never, 'desktop', 'Pane', 'crew')
  await ui.press({ key: 'ship-1-Not yet' })
  expect(grantRuns(runs).at(-1)).toEqual([CREW_BIN, 'grant', 'ship', 'BRIN-1', '--choice', 'Not yet', '--json'])
  expect(toasts.at(-1)).toBe('BRIN-1: not yet. Nothing will be pushed.')
  await ui.unmount()
})

test('a crew alert wakes the Mate until it is cleared', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts, files } = world(on, 'lead', {})
  files[`${HOME}/.keelcrew/alerts/1-denials-x.json`] = JSON.stringify({ kind: 'denials', summary: 'BRIN-1 paused after 3 denials' })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('alert: BRIN-1 paused after 3 denials')
})

test('a high-risk launch card says so, and how many checks are not passing', async ($, on) => {
  mock.clock(on, { now: 2_000_000 })
  const card = line('ship-3', { kind: 'ship', status: 'open', taskKey: 'BRIN-1', title: 'Push & PR', body: '', risk: { tier: 'high' }, validation: { 'VAL-1': { status: 'pass' }, 'VAL-2': { status: 'untested' } } }, 2)
  world(on, 'lead', { inbox: [card] })
  await $.command.run({ command: 'keel-panel' } as never)
  const ui = await mountPane($ as never, 'desktop', 'Pane', 'crew')
  expect(await ui.find({ type: 'Text', text: /risk: high · 1 check not passing/ })).toBeDefined()
  await ui.unmount()
})

test('a nudge the session refuses is not counted, so the Mate still gets three real ones', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = world(on, 'lead', OPEN_REQUEST, { refuseSubmits: 2 })
  await $.session.start({ cwd: '/code' } as never)
  for (let i = 0; i < 8; i++) await clock.advance(16 * 60_000)
  expect(prompts.length).toBe(3)
})

test('the first wake takes the skill the Mate just read at its start as the baseline, so neither it nor the next wake asks for it again', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, 'lead', OPEN_REQUEST)
  installCrew(w, 'rules v1')
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).not.toContain(SKILL_LINE)
  expect(w.prompts[0]).toContain('request start BRIN-2')
  await clock.advance(15 * 60_000)
  expect(w.prompts.length).toBe(2)
  expect(w.prompts[1]).not.toContain(SKILL_LINE)
  expect(w.prompts[1]).toContain('request start BRIN-2')
})

test('a keel-lead skill that changed since the last wake is named again on the next one, and no wake starts just for it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, 'lead', OPEN_REQUEST)
  installCrew(w, 'rules v1')
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(w.prompts[0]).not.toContain(SKILL_LINE)
  installCrew(w, 'rules v2: set handledAt')
  await clock.advance(60_000)
  expect(w.prompts.length).toBe(1)
  await clock.advance(15 * 60_000)
  expect(w.prompts.length).toBe(2)
  expect(w.prompts[1]!.startsWith(`${SKILL_LINE}\n`)).toBe(true)
})

test('a dropped first wake still sets the baseline, and a later change is named on the wake that enters', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, 'lead', OPEN_REQUEST, { refuseSubmits: 1 })
  installCrew(w, 'rules v1')
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(2 * 60_000)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]).not.toContain(SKILL_LINE)
  installCrew(w, 'rules v2: set handledAt')
  await clock.advance(16 * 60_000)
  expect(w.prompts.length).toBe(2)
  expect(w.prompts[1]!.startsWith(`${SKILL_LINE}\n`)).toBe(true)
})

test('without a keel-lead skill file the wake goes without it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, 'lead', OPEN_REQUEST)
  installCrew(w)
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]!.startsWith('Keelcrew board: request start BRIN-2')).toBe(true)
  expect(w.toasts).toEqual([])
})

test('alerts still wake the Mate when the board cannot be read', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts, files } = world(on, 'lead', {})
  files[`${HOME}/.keelcrew/config.json`] = JSON.stringify({ owner: 'Sam' })
  files[`${HOME}/.keelcrew/alerts/2-budget-y.json`] = JSON.stringify({ kind: 'budget', summary: 'BRIN-1 is over its budget' })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(prompts.some(p => p.includes('BRIN-1 is over its budget'))).toBe(true)
})

test('a new card raises a notification headed Keelcrew, but only a toast while the captain muted them on the board', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const docs: Record<string, string[]> = { inbox: [], crew: [line('lead', { dndUntil: 1_000_000 + 30 * 60_000 })], settings: [line('main', { pushNotifications: true })] }
  const { toasts, notifies } = world(on, 'lead', docs)
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  docs.inbox = [SHIP_CARD]
  await clock.advance(60_000)
  expect(toasts.length).toBe(1)
  expect(notifies.length).toBe(0)
  docs.crew = [line('lead', { dndUntil: 1_000_000 })]
  docs.inbox = [SHIP_CARD, line('q-1', { kind: 'question', urgent: true, status: 'open', taskKey: 'BRIN-3' })]
  await clock.advance(60_000)
  expect(notifies).toEqual([{ text: 'Urgent: BRIN-3 question: open it on the board', title: 'Keelcrew' }])
})

test('a new card goes to the Claude app as a push, with no banner; quiet while the captain is in the app', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const docs: Record<string, string[]> = { inbox: [], settings: [line('main', { pushNotifications: true })] }
  const { notifies } = world(on, 'lead', docs)
  const pushes: Record<string, unknown>[] = []
  let out: Record<string, unknown> = { pushSent: true }
  on('tool.call', { tool: 'PushNotification' } as never, async (_$, e) => {
    pushes.push(e as unknown as Record<string, unknown>)
    return { result: { message: '', ...out }, text: 'ok' } as never
  })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  docs.inbox = [line('q-1', { kind: 'question', urgent: true, status: 'open', taskKey: 'BRIN-3' })]
  await clock.advance(60_000)
  expect(pushes).toMatchObject([{ tool: 'PushNotification', message: 'Urgent: BRIN-3 question: open it on the board', status: 'proactive' }])
  out = { disabledReason: 'user_present' }
  docs.inbox = [...docs.inbox, line('q-2', { kind: 'question', urgent: true, status: 'open', taskKey: 'BRIN-4' })]
  await clock.advance(60_000)
  expect(pushes.length).toBe(2)
  expect(notifies.length).toBe(0)
})

test('a push the app has turned off, refused or failed falls back to the banner', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const docs: Record<string, string[]> = { inbox: [], settings: [line('main', { pushNotifications: true })] }
  const { notifies } = world(on, 'lead', docs)
  const answers: unknown[] = [
    { result: { message: '', disabledReason: 'config_off' }, text: 'off' },
    { deny: 'no' },
    { result: {}, isError: true, text: 'failed' },
  ]
  on('tool.call', { tool: 'PushNotification' } as never, async () => answers.shift() as never)
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  for (const n of [3, 4, 5]) {
    docs.inbox = [...(docs.inbox ?? []), line(`q-${n}`, { kind: 'question', urgent: true, status: 'open', taskKey: `BRIN-${n}` })]
    await clock.advance(60_000)
  }
  expect(notifies.map(n => n.text)).toEqual(['Urgent: BRIN-3 question: open it on the board', 'Urgent: BRIN-4 question: open it on the board', 'Urgent: BRIN-5 question: open it on the board'])
})

test('a routine card or passed QA is only a toast: no push and no banner; launch cards and failed QA are pushed with their title', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const docs: Record<string, string[]> = { inbox: [], settings: [line('main', { pushNotifications: true })] }
  const { toasts, notifies } = world(on, 'lead', docs)
  const pushes: string[] = []
  on('tool.call', { tool: 'PushNotification' } as never, async (_$, e) => {
    pushes.push((e as unknown as { message: string }).message)
    return { result: { message: '', pushSent: true }, text: 'ok' } as never
  })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  docs.inbox = [line('q-1', { kind: 'question', status: 'open', taskKey: 'BRIN-3' })]
  await clock.advance(60_000)
  expect(toasts).toEqual(['New on the Keelcrew board: question for BRIN-3'])
  expect(pushes.length + notifies.length).toBe(0)
  docs.inbox = [...docs.inbox, line('q-2', { kind: 'question', status: 'open', taskKey: 'BRIN-4' }), SHIP_CARD]
  await clock.advance(60_000)
  expect(pushes).toEqual(['BRIN-1 launch card: Push & PR, low risk'])
  docs.inbox = [
    ...docs.inbox,
    line('qa-1', { kind: 'qa', status: 'open', taskKey: 'BRIN-5', verdict: 'PASS', title: 'QA · BRIN-5: PASS 3/3' }),
    line('qa-2', { kind: 'qa', status: 'open', taskKey: 'BRIN-6', verdict: 'FAIL', title: 'QA · BRIN-6: FAIL 1/3' }),
  ]
  await clock.advance(60_000)
  expect(pushes[1]).toBe('BRIN-6 qa: QA · BRIN-6: FAIL 1/3')
  expect(notifies.length).toBe(0)
})

test('push notifications are off until the captain turns them on: a new card is only a toast', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const docs: Record<string, string[]> = { inbox: [] }
  const { toasts, notifies } = world(on, 'lead', docs)
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  docs.inbox!.push(line('q-9', { kind: 'question', urgent: true, status: 'open', taskKey: 'BRIN-9', title: 'Which env?' }))
  await clock.advance(60_000)
  expect(toasts.some(t => t.includes('New on the Keelcrew board'))).toBe(true)
  expect(notifies).toEqual([])
})

test('a notification is one line of at most 200 characters', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const docs: Record<string, string[]> = { inbox: [], settings: [line('main', { pushNotifications: true })] }
  const { notifies } = world(on, 'lead', docs)
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  docs.inbox = Array.from({ length: 20 }, (_, i) => line(`q-${i}`, { kind: 'question', urgent: true, status: 'open', taskKey: `BRIN-${i}\nX` }))
  await clock.advance(60_000)
  expect(notifies.length).toBe(1)
  expect(notifies[0]!.text.length).toBeLessThanOrEqual(200)
  expect(notifies[0]!.text).not.toContain('\n')
})

test("the Mate's session saves the plan's 5-hour and weekly use for the board, at most every 5 minutes", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const plan = {
    status: 'ok',
    windows: [
      { label: '5-hour limit', percentUsed: 41, resetsAt: '2026-10-17T00:00:00.220Z', resetsIn: '2h 29m' },
      { label: 'Weekly · all models', percentUsed: 34, resetsAt: '2026-10-22T22:59:59.685Z', resetsIn: '6d 1h' },
      { label: 'Weekly · Fable', percentUsed: 90, resetsAt: '2026-10-22T23:00:00.000Z', resetsIn: '6d 1h' },
    ],
  }
  const { writes, usage, updates } = world(on, 'lead', {}, { usage: JSON.stringify({ plan, context: { status: 'ok' } }) })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  const saved = writes.filter(w => w.path === USAGE)
  expect(saved.length).toBe(1)
  const u = JSON.parse(saved[0]!.text)
  expect(u).toMatchObject({
    fiveHour: { utilization: 0.41, resetsAt: Date.parse('2026-10-17T00:00:00.220Z') },
    sevenDay: { utilization: 0.34, resetsAt: Date.parse('2026-10-22T22:59:59.685Z') },
  })
  expect(u.updatedAt).toBeGreaterThan(1_000_000)
  await clock.advance(3 * 60_000)
  expect(usage.calls).toBe(1)
  await clock.advance(3 * 60_000)
  expect(usage.calls).toBe(2)
  expect(updates.length).toBe(0)
})

test("no usage is saved when the plan's limits can't be read", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { writes, usage } = world(on, 'lead', {}, { usage: JSON.stringify({ plan: { status: 'unavailable', windows: [] } }) })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(usage.calls).toBe(1)
  expect(writes.filter(w => w.path === USAGE).length).toBe(0)
})

test("an engineer's session never reads the plan's usage", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { usage } = world(on, 'engineer', {})
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(10 * 60_000)
  expect(usage.calls).toBe(0)
})

const COMPACT_READY = line('c1', { kind: 'compact', key: 'BRIN-1', status: 'open', ready: true })
const COMPACTED = `${HOME}/.keelcrew/compacted/c1.json`
const turn = { start: { text: 'go', turnId: 't1' }, complete: { answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } }
const settle = () => new Promise(resolve => setTimeout(resolve, 50))

test("the Mate's summary lists a ready compact request instead of waking the Mate about it again", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const waiting = line('c2', { kind: 'compact', key: 'BRIN-2', status: 'open' })
  const { writes, prompts } = world(on, 'lead', { requests: [COMPACT_READY, waiting] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(JSON.parse(writes.filter(w => w.path === SUMMARY).at(-1)!.text).compact).toEqual([{ id: 'c1', key: 'BRIN-1', agent: null }])
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('request compact BRIN-2')
  expect(prompts[0]).not.toContain('BRIN-1')
})

test("a compaction's record wakes nobody, and the Mate's panel removes it once the board closed the request", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const docs: Record<string, string[]> = { requests: [COMPACT_READY] }
  const { prompts, files, runs } = world(on, 'lead', docs)
  files[COMPACTED] = JSON.stringify({ key: 'BRIN-1', at: 990_000 })
  files[`${HOME}/.keelcrew/compacted/c3.json`] = JSON.stringify({ key: 'BRIN-3', at: 990_000, error: 'refused' })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(prompts.length).toBe(0)
  expect(runs).toContainEqual(['rm', '-f', `${HOME}/.keelcrew/compacted/c3.json`])
  expect(runs.some(r => r[0] === 'rm' && r[2] === COMPACTED)).toBe(false)
  docs.requests = []
  await clock.advance(60_000)
  expect(runs).toContainEqual(['rm', '-f', COMPACTED])
  expect(prompts.length).toBe(0)
})

test('an engineer compacts its own session once, between turns, and leaves the record for the board', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { files, writes, compacts } = world(on, 'engineer', {})
  files[SUMMARY] = JSON.stringify({ at: 1_000_000, tickets: {}, compact: [{ id: 'c1', key: 'BRIN-1', agent: null }] })
  await $.session.start({ cwd: '/code' } as never)
  await $.turn.start(turn.start as never)
  await clock.advance(3 * 60_000)
  expect(compacts.runs).toBe(0)
  await $.turn.complete(turn.complete as never)
  await settle()
  expect(compacts.runs).toBe(1)
  expect(compacts.args).toContain('next steps')
  const record = writes.filter(w => w.path === COMPACTED)
  expect(record.length).toBe(1)
  expect(JSON.parse(record[0]!.text)).toEqual({ key: 'BRIN-1', at: expect.any(Number) })
  await clock.advance(5 * 60_000)
  await $.turn.start(turn.start as never)
  await $.turn.complete(turn.complete as never)
  await settle()
  expect(compacts.runs).toBe(1)
})

test('an idle engineer compacts on the timer', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { files, compacts } = world(on, 'engineer', {})
  files[SUMMARY] = JSON.stringify({ at: 1_000_000, tickets: {}, compact: [{ id: 'c1', key: 'BRIN-1', agent: null }] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(compacts.runs).toBe(1)
})

test("a session never compacts for another ticket's or another agent's request", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { files, compacts } = world(on, 'engineer', {})
  files[SUMMARY] = JSON.stringify({ at: 1_000_000, tickets: {}, compact: [{ id: 'c2', key: 'BRIN-2', agent: null }, { id: 'c3', key: 'BRIN-1', agent: 'qa' }] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(3 * 60_000)
  expect(compacts.runs).toBe(0)
})

test("an agent's session compacts for a request naming its agent", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { files, compacts, writes } = world(on, 'agent', {})
  files[SUMMARY] = JSON.stringify({ at: 1_000_000, tickets: {}, compact: [{ id: 'c1', key: 'BRIN-1', agent: null }, { id: 'c3', key: 'BRIN-1', agent: 'qa' }] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(3 * 60_000)
  expect(compacts.runs).toBe(1)
  expect(writes.some(w => w.path === `${HOME}/.keelcrew/compacted/c3.json`)).toBe(true)
  expect(writes.some(w => w.path === COMPACTED)).toBe(false)
})

test('when /compact is refused, the record carries the error so the board can tell the captain to type it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { files, writes, compacts } = world(on, 'engineer', {}, { refuseCompact: true })
  files[SUMMARY] = JSON.stringify({ at: 1_000_000, tickets: {}, compact: [{ id: 'c1', key: 'BRIN-1', agent: null }] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(3 * 60_000)
  expect(compacts.runs).toBe(1)
  expect(JSON.parse(writes.find(w => w.path === COMPACTED)!.text)).toMatchObject({ key: 'BRIN-1', error: expect.any(String) })
})

const SETTINGS = line('main', { intake: { jql: 'assignee = currentUser()', jiraCloudId: 'cloud-1', skipKeys: ['D-9'] } })
const issue = (key: string, status: string, updated: string) => ({ key, fields: { summary: `Ticket ${key}`, status: { name: status }, updated } })
const jiraAnswer = (issues: unknown[]) => JSON.stringify({ data: { issues, isLast: true } })
const lastJson = (writes: { path: string; text: string }[], path: string) => JSON.parse(writes.filter(w => w.path === path).at(-1)!.text)

test('a Jira scan with new and changed tickets wakes the Mate once, after the wake of its own minute, and a scan with nothing new wakes nobody', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const docs: Record<string, string[]> = {
    settings: [SETTINGS],
    tasks: [
      line('D-2', { status: 'active', jiraStatus: 'To Do', jiraUpdated: '2026-10-19T09:00:00.000+0000' }),
      line('D-3', { status: 'done', jiraStatus: 'QA', jiraUpdated: '2026-10-18T09:00:00.000+0000' }),
    ],
  }
  const issues = [issue('D-1', 'To Do', '2026-10-19T09:30:00.000+0000'), issue('D-2', 'In Progress', '2026-10-19T09:00:00.000+0000'), issue('D-3', 'QA', '2026-10-18T09:00:00.000+0000'), issue('D-9', 'To Do', '2026-10-19T09:30:00.000+0000')]
  const { prompts, writes, jiraCalls } = world(on, 'lead', docs, { jira: () => jiraAnswer(issues) })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  expect(jiraCalls.length).toBe(1)
  expect(jiraCalls[0]).toMatchObject({ cloudId: 'cloud-1', jql: 'assignee = currentUser()', fields: ['summary', 'status', 'updated'] })
  expect(prompts.length).toBe(0)
  await clock.advance(55_000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Jira: 1 new (D-1), 1 changed (D-2)')
  expect(prompts[0]).toContain('Changed: jira D-1 D-2')
  expect(lastJson(writes, SCAN)).toMatchObject({
    ok: true,
    new: [{ key: 'D-1', title: 'Ticket D-1', status: 'To Do' }],
    changed: [{ key: 'D-2', status: 'In Progress', from: 'To Do' }],
    updated: [],
  })
  expect(lastJson(writes, SCAN).truncated).toBeUndefined()
  // The Mate writes the rows; the next scan finds nothing new and wakes nobody.
  docs.tasks = [
    line('D-1', { status: 'proposed', jiraStatus: 'To Do', jiraUpdated: '2026-10-19T09:30:00.000+0000' }),
    line('D-2', { status: 'active', jiraStatus: 'In Progress', jiraUpdated: '2026-10-19T09:00:00.000+0000' }),
    docs.tasks![1]!,
  ]
  await clock.advance(31 * 60_000)
  expect(jiraCalls.length).toBe(2)
  expect(prompts.length).toBe(1)
  expect(lastJson(writes, SCAN)).toMatchObject({ ok: true, new: [], changed: [], updated: [] })
})

test('a new ticket the Mate closed right away (taken by the captain) wakes the Mate no more', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const docs: Record<string, string[]> = { settings: [SETTINGS], tasks: [] }
  const { prompts } = world(on, 'lead', docs, { jira: () => jiraAnswer([issue('D-1', 'To Do', '2026-10-19T09:30:00.000+0000')]) })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Jira: 1 new (D-1)')
  // The Mate writes the row and closes it at once; the open-tasks read no longer shows it.
  docs.tasks = [line('D-1', { status: 'done', jiraStatus: 'To Do', jiraUpdated: '2026-10-19T09:30:00.000+0000' })]
  await clock.advance(20 * 60_000)
  expect(prompts.length).toBe(1)
})

test('a ticket only updated in Jira wakes nobody, and rides along when a new one wakes the Mate', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const docs = { settings: [SETTINGS], tasks: [line('D-4', { status: 'active', jiraStatus: 'To Do', jiraUpdated: '2026-10-19T08:00:00.000+0000' }), line('D-5', { status: 'active', jiraStatus: 'To Do' })] }
  let issues = [issue('D-4', 'To Do', '2026-10-19T09:45:00.000+0000'), issue('D-5', 'To Do', '2026-10-19T09:45:00.000+0000')]
  const { prompts, writes } = world(on, 'lead', docs, { jira: () => jiraAnswer(issues) })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(2 * 60_000)
  expect(prompts.length).toBe(0)
  expect(lastJson(writes, SCAN)).toMatchObject({ ok: true, new: [], changed: [], updated: [{ key: 'D-4' }] })
  issues = [...issues, issue('D-1', 'To Do', '2026-10-19T10:10:00.000+0000')]
  await clock.advance(31 * 60_000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Jira: 1 new (D-1), 1 updated (D-4)')
  expect(prompts[0]).toContain('Changed: jira D-1 D-4')
  expect(prompts[0]).not.toContain('D-5')
})

test("a new or edited comment by someone else wakes the Mate until its row's jiraUpdated catches up; the captain's own don't", async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const INFO = 'mcp__atlassian__atlassianUserInfo'
  const row = (key: string, jiraUpdated: string) => line(key, { status: 'pr', jiraStatus: 'In Progress', jiraUpdated })
  const docs = { settings: [SETTINGS], tasks: [row('D-4', '2026-10-19T08:00:00.000+0000'), row('D-5', '2026-10-19T08:00:00.000+0000'), row('D-6', '2026-10-19T08:00:00.000+0000')] }
  const comment = (who: string, created: string, updated = created, editor = who) => ({ author: { accountId: who, displayName: who }, updateAuthor: { accountId: editor, displayName: editor }, created, updated })
  const comments: Record<string, unknown[]> = {
    'D-4': [comment('qa-1', '2026-10-19T09:40:00.000+0000')],
    'D-5': [comment('me', '2026-10-19T09:40:00.000+0000')],
    'D-6': [comment('me', '2026-10-18T09:00:00.000+0000', '2026-10-19T09:41:00.000+0000', 'qa-2')],
  }
  const issues = ['D-4', 'D-5', 'D-6'].map(k => issue(k, 'In Progress', '2026-10-19T09:45:00.000+0000'))
  const jira = (input: Record<string, unknown>) =>
    String(input.jql).startsWith('key in') ? jiraAnswer(issues.map(i => ({ key: i.key, fields: { comment: { comments: comments[i.key] } } }))) : jiraAnswer(issues)
  const { prompts, writes, jiraCalls } = world(on, 'lead', docs, { tools: [JIRA, INFO], jira })
  on('tool.call', { tool: INFO } as never, async () => ({ result: {}, text: '{"data":{"accountId":"me"}}' }) as never)
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(2 * 60_000)
  expect(jiraCalls.find(c => String(c.jql).startsWith('key in'))).toMatchObject({ jql: 'key in (D-4, D-5, D-6)', fields: ['comment'] })
  expect(lastJson(writes, SCAN).commented).toMatchObject([{ key: 'D-4', by: 'qa-1' }, { key: 'D-6', by: 'qa-2' }])
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Jira: 2 with new comments (D-4, D-6), 1 updated (D-5)')
  // The Mate writes jiraUpdated on the rows: the wake is handled and the next scan finds nothing.
  docs.tasks = ['D-4', 'D-5', 'D-6'].map(k => row(k, '2026-10-19T09:45:00.000+0000'))
  await clock.advance(31 * 60_000)
  expect(prompts.length).toBe(1)
})

test("comments are sorted when the user-info call is refused (the captain's id comes from a search), and a ticket whose newest comments the search leaves out counts", async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const INFO = 'mcp__atlassian__atlassianUserInfo'
  const row = (key: string) => line(key, { status: 'pr', jiraStatus: 'In Progress', jiraUpdated: '2026-10-19T08:00:00.000+0000' })
  const docs = { settings: [SETTINGS], tasks: [row('D-4'), row('D-5'), row('D-7')] }
  const comment = (who: string) => ({ author: { accountId: who, displayName: who }, created: '2026-10-19T09:40:00.000+0000', updated: '2026-10-19T09:40:00.000+0000' })
  const fields: Record<string, unknown> = {
    'D-4': { comment: { comments: [comment('qa-1')], total: 1 } },
    'D-5': { comment: { comments: [comment('me')], total: 1 } },
    'D-7': { comment: { comments: [comment('me')], total: 25 } },
  }
  const issues = ['D-4', 'D-5', 'D-7'].map(k => issue(k, 'In Progress', '2026-10-19T09:45:00.000+0000'))
  const jira = (input: Record<string, unknown>) => {
    const jql = String(input.jql)
    if (jql === 'assignee = currentUser() ORDER BY updated DESC') return jiraAnswer([{ key: 'D-4', fields: { assignee: { accountId: 'me' } } }])
    return jql.startsWith('key in') ? jiraAnswer(issues.map(i => ({ key: i.key, fields: fields[i.key] }))) : jiraAnswer(issues)
  }
  const { prompts, writes, jiraCalls } = world(on, 'lead', docs, { tools: [JIRA, INFO], jira })
  let infoCalls = 0
  on('tool.call', { tool: INFO } as never, async () => (infoCalls++, { deny: 'refused' }) as never)
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(2 * 60_000)
  expect(infoCalls).toBe(0)
  // The compact view leaves the assignee's accountId out.
  expect(jiraCalls.find(c => String(c.jql).endsWith('ORDER BY updated DESC'))).toMatchObject({ fields: ['assignee'], view: 'full' })
  const scan = lastJson(writes, SCAN)
  expect(scan.commented.map((c: { key: string }) => c.key)).toEqual(['D-4', 'D-7'])
  expect(scan.commentsError).toBeUndefined()
  expect(prompts[0]).toContain('Jira: 2 with new comments (D-4, D-7), 1 updated (D-5)')
})

test('a comment search whose answer is too large for the model is still read whole, from the MCP server itself', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const INFO = 'mcp__atlassian__atlassianUserInfo'
  const row = (key: string) => line(key, { status: 'pr', jiraStatus: 'In Progress', jiraUpdated: '2026-10-19T08:00:00.000+0000' })
  const docs = { settings: [SETTINGS], tasks: [row('D-4'), row('D-5')] }
  const body = '<p>' + 'x'.repeat(30_000) + '</p>'
  const comment = (who: string) => ({ author: { accountId: who, displayName: who }, body, created: '2026-10-19T09:40:00.000+0000', updated: '2026-10-19T09:40:00.000+0000' })
  const fields: Record<string, unknown> = { 'D-4': { comment: { comments: [comment('me'), comment('qa-1')], total: 2 } }, 'D-5': { comment: { comments: [comment('me')], total: 1 } } }
  const issues = ['D-4', 'D-5'].map(k => issue(k, 'In Progress', '2026-10-19T09:45:00.000+0000'))
  const jira = (input: Record<string, unknown>) => (String(input.jql).startsWith('key in') ? jiraAnswer(issues.map(i => ({ key: i.key, fields: fields[i.key] }))) : jiraAnswer(issues))
  const { prompts, writes } = world(on, 'lead', docs, { tools: [JIRA, INFO], jira })
  on('tool.call', { tool: INFO } as never, async () => ({ result: {}, text: '{"data":{"accountId":"me"}}' }) as never)
  // What the model would read of the same search: a note that the answer was saved to a file.
  on('tool.call', { tool: JIRA } as never, async () => ({ result: {}, text: 'Output too large (92.1KB). Full output saved to: /tmp/x.json' }) as never)
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(2 * 60_000)
  const scan = lastJson(writes, SCAN)
  expect(scan.commented).toMatchObject([{ key: 'D-4', by: 'qa-1' }])
  expect(scan.commentsError).toBeUndefined()
  expect(prompts[0]).toContain('Jira: 1 with new comments (D-4), 1 updated (D-5)')
})

test('a comment search that fails counts every updated ticket and says why; with no account id every new comment counts', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const row = (key: string) => line(key, { status: 'pr', jiraStatus: 'In Progress', jiraUpdated: '2026-10-19T08:00:00.000+0000' })
  const docs = { settings: [SETTINGS], tasks: [row('D-4'), row('D-5')] }
  const issues = ['D-4', 'D-5'].map(k => issue(k, 'In Progress', '2026-10-19T09:45:00.000+0000'))
  let failComments = true
  const jira = (input: Record<string, unknown>) => {
    const jql = String(input.jql)
    if (jql === 'assignee = currentUser() ORDER BY updated DESC') return jiraAnswer([])
    if (!jql.startsWith('key in')) return jiraAnswer(issues)
    if (failComments) return 'not json'
    return jiraAnswer([{ key: 'D-4', fields: { comment: { comments: [{ author: { accountId: 'me', displayName: 'Me' }, created: '2026-10-19T09:40:00.000+0000' }] } } }, { key: 'D-5', fields: { comment: { comments: [] } } }])
  }
  const { prompts, writes } = world(on, 'lead', docs, { jira })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(2 * 60_000)
  expect(lastJson(writes, SCAN)).toMatchObject({ commented: [{ key: 'D-4' }, { key: 'D-5' }], commentsError: expect.stringContaining('comments not checked') })
  expect(prompts[0]).toContain('Jira: 2 with new comments (D-4, D-5) (comments not checked')
  failComments = false
  await clock.advance(31 * 60_000)
  expect(lastJson(writes, SCAN)).toMatchObject({ commented: [{ key: 'D-4', by: 'Me' }], commentsError: expect.stringContaining("account id couldn't be read") })
})

test('a scan that stops at its page limit says so in scan.json and in the wake', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const settings = line('main', { intake: { jql: 'project = D', jiraCloudId: 'cloud-1' }, agents: { scan: { maxPages: 2 } } })
  const { prompts, writes, jiraCalls } = world(on, 'lead', { settings: [settings] }, {
    jira: () => JSON.stringify({ data: { issues: [issue(`D-${jiraCalls.length}`, 'To Do', '2026-10-19T09:00:00.000+0000')], isLast: false, nextPageToken: `p${jiraCalls.length}` } }),
  })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(jiraCalls.map(c => c.nextPageToken)).toEqual([undefined, 'p1'])
  expect(lastJson(writes, SCAN)).toMatchObject({ ok: true, truncated: true, new: [{ key: 'D-1' }, { key: 'D-2' }] })
  expect(prompts[0]).toContain('Jira: 2 new (D-1, D-2) (the scan stopped at its page limit)')
})

test('without the Atlassian tool, the second failed scan in a row tells the Mate, once that day', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const { prompts, writes } = world(on, 'lead', { settings: [SETTINGS] }, { tools: [] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(prompts.length).toBe(0)
  expect(lastJson(writes, SCAN)).toMatchObject({ ok: false, error: expect.stringContaining('searchJiraIssuesUsingJql') })
  await clock.advance(32 * 60_000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Jira scan in the panel failed: ')
  expect(prompts[0]).toContain('Changed: scan.json')
  await clock.advance(3 * 60 * 60_000)
  expect(prompts.length).toBe(1)
})

test('with no Jira cloud id the scan never runs, says how to set one, and wakes nobody, even after earlier failures', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const settings = line('main', { intake: { jql: 'project = D' } })
  // A stored count of missing-cloud-id scans wakes nobody, now or the next day.
  const w = world(on, 'lead', { settings: [settings] }, { store: { scanFails: 2, scanError: 'no Jira cloud id: set jiraCloudId in config.json' } })
  w.files[`${HOME}/.keelcrew/config.json`] = JSON.stringify({ board: BOARD, owner: 'Sam' })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(w.jiraCalls.length).toBe(0)
  expect(lastJson(w.writes, SCAN)).toMatchObject({ ok: false, error: 'no Jira cloud id: run `keelctl setup --cloud-id <id>` (or switch Scan off on the board)' })
  await clock.advance(24 * 60 * 60_000)
  expect(w.writes.filter(x => x.path === SCAN).length).toBeGreaterThan(2)
  expect(w.jiraCalls.length).toBe(0)
  expect(w.prompts).toEqual([])
})

test('with no Jira query anywhere the scan fails, and the Mate hears of it once', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const { prompts, writes } = world(on, 'lead', {}, { run: argv => (argv[0] === CREW_BIN && argv[1] === 'pack' ? { exitCode: 0, stdout: '{"name":null,"pack":{}}' } : undefined) })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(lastJson(writes, SCAN)).toMatchObject({ ok: false, error: 'no Jira query set' })
  await clock.advance(32 * 60_000)
  expect(prompts).toEqual([expect.stringContaining('Jira scan in the panel failed: no Jira query set')])
})

test('a Jira search that never answers fails the scan after 90 seconds, and the next scan still runs', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const { prompts, writes, jiraCalls } = world(on, 'lead', { settings: [SETTINGS] }, { jira: () => new Promise<string>(() => undefined) })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(2 * 60_000)
  expect(lastJson(writes, SCAN)).toMatchObject({ ok: false, error: expect.stringContaining('took over 90 s') })
  await clock.advance(31 * 60_000)
  expect(jiraCalls.length).toBe(2)
  await clock.advance(3 * 60_000)
  expect(prompts).toEqual([expect.stringContaining('Jira scan in the panel failed: the Jira search took over 90 s')])
})

test("a broken Jira item in the store doesn't stop the Mate's wake", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = world(on, 'lead', OPEN_REQUEST, { store: { jira: { id: 'jira:x', label: 'Jira: bad', keys: [], changes: 'oops', told: false } } })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('request start BRIN-2')
})

test('a scan request scans at once, even out of hours, and needs nothing from the Mate', async ($, on) => {
  const night = new Date(2026, 9, 18, 22, 0).getTime()
  const clock = mock.clock(on, { now: night })
  const docs = { settings: [SETTINGS], requests: [line('s1', { kind: 'scan', key: null, status: 'open', at: night - 1000 })] }
  const { prompts, writes, jiraCalls } = world(on, 'lead', docs)
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(jiraCalls.length).toBe(1)
  expect(lastJson(writes, SCAN).at).toBeGreaterThan(night - 1000)
  await clock.advance(5 * 60_000)
  expect(jiraCalls.length).toBe(1)
  expect(prompts.length).toBe(0)
})

test('a health issue raises one alert when it first appears, and none while it lasts or when one clears', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const guard = { id: 'claudeguard', label: 'Claude settings', status: 'fail', detail: 'disableAllHooks is on.' }
  const locks = { id: 'locks', label: 'Locks', status: 'warn', detail: 'A stale lock.' }
  let checks: Record<string, string>[] = [{ ...locks, status: 'ok', detail: 'No locks held.' }, guard]
  const { writes, runs, prompts } = world(on, 'lead', {}, { run: argv => (argv[0] === CREW_BIN && argv[1] === 'doctor' ? { exitCode: 1, stdout: JSON.stringify({ checks }) } : undefined) })
  const adds = () => runs.filter(r => r[0] === CREW_BIN && r[1] === 'alerts')
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  const health = lastJson(writes, HEALTH)
  expect(health.issues).toEqual([{ id: 'doctor:claudeguard', severity: 'now', text: expect.stringContaining('disableAllHooks is on.') }])
  expect(health.ok).toEqual(['housekeeping', 'playbook', 'alerts', 'budgets', 'usage', 'disk', 'waiting', 'notes'])
  expect(adds()).toEqual([[CREW_BIN, 'alerts', 'add', '--kind', 'health', '--summary', expect.stringContaining('Claude settings')]])
  expect(runs).toContainEqual([CREW_BIN, 'doctor', '--fix', '--safe', '--json'])
  await clock.advance(2 * 60 * 60_000 + 60_000)
  expect(writes.filter(w => w.path === HEALTH).length).toBe(2)
  expect(adds().length).toBe(1)
  checks = [locks, guard]
  await clock.advance(2 * 60 * 60_000 + 60_000)
  expect(adds().length).toBe(2)
  expect(adds()[1]![6]).toContain('A stale lock.')
  checks = [locks]
  await clock.advance(2 * 60 * 60_000 + 60_000)
  expect(lastJson(writes, HEALTH).issues.map((i: { id: string }) => i.id)).toEqual(['doctor:locks'])
  expect(adds().length).toBe(2)
  expect(prompts.length).toBe(0)
})

test('an engineer waiting on the Mate for an hour and an alert unhandled for 2 hours are health issues; a held question and a newer alert are not', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const ago = (min: number) => WORK - min * 60_000
  const docs = {
    tasks: [line('D-6', { status: 'active', activity: 'waiting', waiting: 'lead', updatedAt: ago(90) }), line('D-7', { status: 'active', activity: 'waiting', waiting: 'lead', updatedAt: ago(90) })],
    crew: [line('lead', { heldQuestions: [{ taskKey: 'D-6', title: 'Which env?' }] })],
  }
  const { writes, files } = world(on, 'lead', docs)
  files[`${HOME}/.keelcrew/alerts/1-budget-a.json`] = JSON.stringify({ kind: 'budget', key: 'D-8', summary: 'D-8 over budget', at: ago(150) })
  files[`${HOME}/.keelcrew/alerts/2-denials-b.json`] = JSON.stringify({ kind: 'denials', key: 'D-9', summary: 'D-9 paused', at: ago(30) })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(lastJson(writes, HEALTH).issues.map((i: { id: string }) => i.id)).toEqual(['alert:1-budget-a', 'waiting:D-7'])
})

const FACTS = `${HOME}/.keelcrew/ledger-facts.json`
const MERGES = `${HOME}/.keelcrew/merges.json`
const crewRuns = (runs: string[][], cmd: string, sub: string) => runs.filter(r => r[0] === CREW_BIN && r[1] === cmd && r[2] === sub)
const ledgerRuns = (runs: string[][], sub: string) => crewRuns(runs, 'ledger', sub)
/** The panel's tick isn't awaited by the mock clock: under load its last steps land a moment later, so wait for them. */
const settleUntil = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i++) await new Promise(r => setTimeout(r, 10))
}

test("the Mate's panel feeds the ledger: every row first, then only when the facts change; spend and its checks every 5 minutes, reverts daily, a commit every 30", async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const docs: Record<string, string[]> = {
    tasks: [line('D-1', { status: 'active', title: 'One' })],
    inbox: [line('q-1', { kind: 'question', status: 'open', taskKey: 'D-1', createdAt: 1 }), line('info-1', { kind: 'info', status: 'open' })],
  }
  const { writes, runs } = world(on, 'lead', docs)
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => ledgerRuns(runs, 'commit').length > 0)
  expect(ledgerRuns(runs, 'feed')).toEqual([[CREW_BIN, 'ledger', 'feed', FACTS]])
  const facts = lastJson(writes, FACTS)
  expect(facts.tasks.map((t: { id: string }) => t.id)).toEqual(['D-1'])
  expect(facts.inbox.map((c: { id: string }) => c.id)).toEqual(['q-1'])
  expect(ledgerRuns(runs, 'spend').length).toBe(1)
  expect(crewRuns(runs, 'spend', 'check').length).toBe(1)
  expect(ledgerRuns(runs, 'reverts').length).toBe(1)
  expect(ledgerRuns(runs, 'commit').length).toBe(1)
  await clock.advance(60_000)
  expect(ledgerRuns(runs, 'feed').length).toBe(1)
  docs.tasks = [line('D-1', { status: 'pr', title: 'One', prUrl: 'https://github.com/o/r/pull/1' })]
  await clock.advance(60_000)
  await settleUntil(() => ledgerRuns(runs, 'feed').length > 1)
  expect(ledgerRuns(runs, 'feed').length).toBe(2)
  await clock.advance(4 * 60_000)
  await settleUntil(() => ledgerRuns(runs, 'spend').length > 1)
  expect(ledgerRuns(runs, 'spend').length).toBe(2)
  await settleUntil(() => crewRuns(runs, 'spend', 'check').length > 1)
  expect(crewRuns(runs, 'spend', 'check').length).toBe(2)
  expect(ledgerRuns(runs, 'reverts').length).toBe(1)
  await clock.advance(25 * 60_000)
  await settleUntil(() => ledgerRuns(runs, 'commit').length > 1)
  expect(ledgerRuns(runs, 'commit').length).toBe(2)
})

test('with the ledger switched off in Settings, the panel feeds nothing', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const { runs } = world(on, 'lead', { settings: [line('main', { ledger: { enabled: false } })], tasks: [line('D-1', { status: 'active' })] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  expect(runs.filter(r => r[0] === CREW_BIN && r[1] === 'ledger')).toEqual([])
})

test('a ledger feed slower than a minute is not started again while it runs', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  let release = () => {}
  const held = new Promise<void>(resolve => (release = resolve))
  const slowFeed = async (argv: readonly string[]) => (argv[1] === 'ledger' && argv[2] === 'feed' ? (await held, { exitCode: 0, stdout: '' }) : undefined)
  const { runs } = world(on, 'lead', { tasks: [line('D-1', { status: 'active' })] }, { run: slowFeed })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => ledgerRuns(runs, 'feed').length > 0)
  await clock.advance(3 * 60_000)
  await settle()
  expect(ledgerRuns(runs, 'feed').length).toBe(1)
  release()
  await settle()
})

test('after an update the Mate is asked to republish the board until crew/lead has the version; a newer download asks for /reload-plugins', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const { prompts, files, toasts, statuses } = world(on, 'lead', { settings: [line('main', { ledger: { enabled: false } })], crew: [line('lead', { pluginVersion: '9.9.0' }, 7)] })
  files['plugin.json'] = JSON.stringify({ version: '9.9.1' })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => prompts.length > 0)
  // The wake names crew/lead's version, so the Mate's heartbeat rides on its next write without a read.
  expect(prompts.at(-1)).toContain('crew/lead: version 7.')
  expect(prompts.at(-1)).toMatch(/Keelcrew updated to 9\.9\.1: republish the board from \S+\/board and reload keelcrew:keel-lead/)
  files['plugin.json'] = JSON.stringify({ version: '9.9.2' })
  await clock.advance(60_000)
  await settleUntil(() => toasts.some(t => t.includes('9.9.2')))
  expect(statuses.at(-1)).toBe('Keelcrew 9.9.2 is installed, but this session still runs 9.9.1: type /reload-plugins here to switch.')
})

test('after /reload-plugins runs the newer version, the update note leaves the status line', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const { files, statuses } = world(on, 'lead', { settings: [line('main', { ledger: { enabled: false } })], crew: [line('lead', { pluginVersion: '9.9.2' })] })
  files['plugin.json'] = JSON.stringify({ version: '9.9.2' })
  // What the module stored before the reload stays.
  on('state.get', ($, e, next) => (e.key === 'updateNote' ? { value: '9.9.2', version: 1 } : next(e)))
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(65_000)
  await settleUntil(() => statuses.length > 0)
  expect(statuses.at(-1)).toBeUndefined()
})

test('once crew/lead has the running version, no update item and no restart notice', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const { prompts, files, toasts } = world(on, 'lead', { ...OPEN_REQUEST, settings: [line('main', { ledger: { enabled: false } })], crew: [line('lead', { pluginVersion: '9.9.1' })] })
  files['plugin.json'] = JSON.stringify({ version: '9.9.1' })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => prompts.length > 0)
  expect(prompts.join('\n')).not.toContain('Keelcrew updated')
  expect(toasts.some(t => t.includes('/reload-plugins'))).toBe(false)
})

test('merged crew PRs are recorded with their target status when the switch is on, and the Mate is woken if the board page did not apply it', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const docs: Record<string, string[]> = {
    settings: [line('main', { merges: { autoStatus: true }, ledger: { enabled: false } })],
    tasks: [line('D-1', { status: 'pr', prUrl: 'https://github.com/o/r/pull/1', risk: 'low' }), line('D-2', { status: 'pr', prUrl: 'https://github.com/o/r/pull/2' }), line('D-3', { status: 'pr', prUrl: 'https://github.com/o/r/pull/3' })],
  }
  const merged = (n: string) => JSON.stringify({ state: n === '3' ? 'OPEN' : 'MERGED', mergedAt: '2026-10-19T09:00:00Z', number: Number(n), mergeCommit: { oid: `sha${n}` } })
  const { writes, runs, prompts, files } = world(on, 'lead', docs, { run: argv => (argv[0] === 'gh' ? { exitCode: 0, stdout: merged(String(argv.find(a => a.startsWith('https://'))).split('/').pop()!) } : undefined) })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => writes.some(w => w.path === MERGES))
  expect(runs.filter(r => r[0] === 'gh').length).toBe(3)
  const m = lastJson(writes, MERGES).merges
  expect(m.map((x: { key: string; target: string }) => `${x.key}:${x.target}`)).toEqual(['D-1:done', 'D-2:qa'])
  expect(m[0]).toMatchObject({ prNumber: 1, mergeSha: 'sha1', risk: 'low' })
  // The board page wasn't open: two minutes on, the rows are still at pr, so the Mate is woken to set them.
  files[MERGES] = writes.filter(w => w.path === MERGES).at(-1)!.text
  await clock.advance(3 * 60_000)
  await settleUntil(() => prompts.length > 0)
  expect(prompts.at(-1)).toContain('Merged: D-1 → done')
  expect(prompts.at(-1)).toContain('Merged: D-2 → qa')
})

test('the merge watcher is off by default: no gh call', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const { runs } = world(on, 'lead', { tasks: [line('D-1', { status: 'pr', prUrl: 'https://github.com/o/r/pull/1' })] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  expect(runs.filter(r => r[0] === 'gh')).toEqual([])
})

const PR = (n: number) => `https://github.com/o/r/pull/${n}`
/** `gh pr view` saying the PR named last in its argv merged. */
const ghMerged = (argv: readonly string[]) =>
  argv[0] === 'gh' ? { exitCode: 0, stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-19T09:00:00Z', number: Number(String(argv.at(-1)).split('/').pop()), mergeCommit: { oid: 'sha' } }) } : undefined
const mergeRecord = (key: string, prUrl: string, target: string) => ({ key, prUrl, prNumber: 1, mergedAt: 1, mergeSha: 'sha', risk: 'low', target, recordedAt: WORK - 60 * 60_000 })
const AUTO_STATUS = line('main', { merges: { autoStatus: true }, ledger: { enabled: false } })

test("a row QA sent back to pr with a new PR: the old PR's merge wakes nobody, and the new PR is checked and recorded", async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const { writes, runs, prompts, files } = world(on, 'lead', { settings: [AUTO_STATUS], tasks: [line('D-1', { status: 'pr', prUrl: PR(2) })] }, { run: ghMerged })
  files[MERGES] = JSON.stringify({ at: 1, merges: [mergeRecord('D-1', PR(1), 'done')] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => writes.some(w => w.path === MERGES))
  expect(prompts.filter(p => p.includes('Merged:'))).toEqual([])
  expect(runs.filter(r => r[0] === 'gh').map(r => r.at(-1))).toEqual([PR(2)])
  expect(lastJson(writes, MERGES).merges.map((m: { key: string; prUrl: string; target: string }) => `${m.key} ${m.prUrl} ${m.target}`)).toEqual([`D-1 ${PR(1)} done`, `D-1 ${PR(2)} qa`])
  files[MERGES] = writes.filter(w => w.path === MERGES).at(-1)!.text
  await clock.advance(3 * 60_000)
  await settleUntil(() => prompts.length > 0)
  expect(prompts.at(-1)).toContain('Merged: D-1 → qa')
  expect(prompts.at(-1)).not.toContain('→ done')
})

test('with the merge switch off, a recorded merge whose row is still at pr wakes nobody', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const { prompts, files } = world(on, 'lead', { tasks: [line('D-1', { status: 'pr', prUrl: PR(1) })] })
  files[MERGES] = JSON.stringify({ at: 1, merges: [mergeRecord('D-1', PR(1), 'done')] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await clock.advance(60_000)
  await settle()
  expect(prompts.filter(p => p.includes('Merged:'))).toEqual([])
})

test("a merge wake points the Mate at the ticket's row, not at an alert", async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const { prompts, files } = world(on, 'lead', { settings: [AUTO_STATUS], tasks: [line('D-1', { status: 'pr', prUrl: PR(1) })] })
  files[MERGES] = JSON.stringify({ at: 1, merges: [mergeRecord('D-1', PR(1), 'done')] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => prompts.length > 0)
  expect(prompts[0]).toContain('Merged: D-1 → done')
  expect(prompts[0]).toContain('Changed: tasks/D-1.')
})

test('the merge watcher hands gh only a GitHub PR link, after --', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const tasks = [line('D-1', { status: 'pr', prUrl: '--repo=x/y' }), line('D-2', { status: 'pr', prUrl: `${PR(2)} --web` }), line('D-3', { status: 'pr', prUrl: PR(3) })]
  const { runs, writes } = world(on, 'lead', { settings: [AUTO_STATUS], tasks }, { run: ghMerged })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => writes.some(w => w.path === MERGES))
  expect(runs.filter(r => r[0] === 'gh')).toEqual([['gh', 'pr', 'view', '--json', 'state,mergedAt,number,mergeCommit', '--', PR(3)]])
})

const ORG = `${HOME}/.keelcrew/org.json`
/** An engineer's world whose context holds `tokens`, with auto-compaction on or off in the mirrored org settings. */
function compactWorld(on: Parameters<typeof world>[0], tokens: number, enabled: boolean, ticket: Record<string, unknown> = { status: 'active', waiting: '' }, store?: Record<string, unknown>) {
  const w = world(on, 'engineer', {}, { store })
  w.files[ORG] = JSON.stringify({ compaction: { enabled } })
  w.files[SUMMARY] = JSON.stringify({ at: 1_000_000, tickets: { 'BRIN-1': { title: 't', phase: 'build', summary: '', prUrl: '', cards: [], ...ticket } } })
  on('session.usage', async () => ({ value: { startedAt: 0, context: { tokens, window: 1_000_000 }, rateLimits: [] } }) as never)
  return w
}

test('an engineer past 200k compacts right after its turn, once per hour; under it, nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { compacts } = compactWorld(on, 210_000, true)
  await $.session.start({ cwd: '/code' } as never)
  await $.turn.start(turn.start as never)
  await $.turn.complete(turn.complete as never)
  await settle()
  expect(compacts.runs).toBe(1)
  expect(compacts.args).toContain('next steps')
  await clock.advance(10 * 60_000)
  await $.turn.start(turn.start as never)
  await $.turn.complete(turn.complete as never)
  await settle()
  expect(compacts.runs).toBe(1)
})

test('a waiting ticket compacts past 100k; an active one under 200k does not', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const { compacts } = compactWorld(on, 150_000, true, { status: 'pr', waiting: '' })
  await $.session.start({ cwd: '/code' } as never)
  await $.turn.start(turn.start as never)
  await $.turn.complete(turn.complete as never)
  await settle()
  expect(compacts.runs).toBe(1)
})

test('an active ticket under 200k is left alone', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const { compacts } = compactWorld(on, 150_000, true)
  await $.session.start({ cwd: '/code' } as never)
  await $.turn.start(turn.start as never)
  await $.turn.complete(turn.complete as never)
  await settle()
  expect(compacts.runs).toBe(0)
})

test('auto-compaction is off unless the captain switched it on', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const { compacts } = compactWorld(on, 400_000, false)
  await $.session.start({ cwd: '/code' } as never)
  await $.turn.start(turn.start as never)
  await $.turn.complete(turn.complete as never)
  await settle()
  expect(compacts.runs).toBe(0)
})

test("another session's auto-compaction doesn't hold this engineer's back", async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  // The store is shared by every session: another engineer compacted a minute ago.
  const { compacts } = compactWorld(on, 210_000, true, undefined, { autoCompactAt: 940_000, 'autoCompactAt:sess-2': 940_000 })
  await $.session.start({ cwd: '/code' } as never)
  await $.turn.start(turn.start as never)
  await $.turn.complete(turn.complete as never)
  await settle()
  expect(compacts.runs).toBe(1)
})

test("the Mate's panel mirrors Settings → Crew to org.json, only when it changes", async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const docs: Record<string, string[]> = { settings: [line('main', { org: { seats: 3, departments: { ceo: { enabled: true } } }, agents: { reviewer: { enabled: false } }, ledger: { enabled: false } })] }
  const { writes, files } = world(on, 'lead', docs)
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => writes.some(w => w.path === ORG))
  expect(lastJson(writes, ORG)).toEqual({ seats: 3, departments: { ceo: { enabled: true } }, agents: { reviewer: { enabled: false } } })
  files[ORG] = writes.filter(w => w.path === ORG).at(-1)!.text
  await clock.advance(60_000)
  await settle()
  expect(writes.filter(w => w.path === ORG).length).toBe(1)
})

test('a deleted org.json is written again on the next minute', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const { writes, files } = world(on, 'lead', { settings: [line('main', { org: { seats: 3 }, ledger: { enabled: false } })] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => writes.some(w => w.path === ORG))
  files[ORG] = writes.filter(w => w.path === ORG).at(-1)!.text
  await clock.advance(60_000)
  await settle()
  expect(writes.filter(w => w.path === ORG).length).toBe(1)
  delete files[ORG]
  await clock.advance(60_000)
  await settleUntil(() => writes.filter(w => w.path === ORG).length > 1)
  expect(writes.filter(w => w.path === ORG).length).toBe(2)
  expect(lastJson(writes, ORG)).toEqual({ seats: 3, agents: {} })
})

test("org.json carries the board's Engineers at once (maxWorkers), and nothing else changes", async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const { writes } = world(on, 'lead', { settings: [line('main', { org: { seats: 3 }, agents: { scan: { enabled: true } }, maxWorkers: 4, ledger: { enabled: false } })] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => writes.some(w => w.path === ORG))
  expect(lastJson(writes, ORG)).toEqual({ seats: 3, agents: { scan: { enabled: true } }, maxWorkers: 4 })
})

test('org.json carries the models set in Settings → Crew, so the crew command resolves them', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const approved = { lead: { model: 'claude-sonnet-5-5', effort: 'max' }, engineer: { byDifficulty: { simple: { model: 'claude-sonnet-5-5', effort: 'high' } } } }
  const { writes } = world(on, 'lead', { settings: [line('main', { org: { models: { approved, foldedAt: 7 } }, ledger: { enabled: false } })] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => writes.some(w => w.path === ORG))
  expect(lastJson(writes, ORG).models).toEqual({ approved, foldedAt: 7 })
})

test('a new Subagents model in org.json is applied to the Mate folder at once, and only when it changes', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const settings = (subagents: unknown, seats = 3) => line('main', { org: { seats, models: { approved: { subagents } } }, ledger: { enabled: false } })
  const docs: Record<string, string[]> = { settings: [settings({ model: 'claude-sonnet-5-5', effort: 'xhigh' })] }
  const { writes, runs } = world(on, 'lead', docs, { persist: [ORG] })
  const applies = () => crewRuns(runs, 'doctor', 'leadsettings')
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => applies().length > 0)
  expect(applies()).toEqual([[CREW_BIN, 'doctor', 'leadsettings', '--fix', '--json']])
  docs.settings = [settings({ model: 'claude-sonnet-5-5', effort: 'xhigh' }, 4)]
  await clock.advance(60_000)
  await settleUntil(() => lastJson(writes, ORG).seats === 4)
  expect(applies().length).toBe(1)
  docs.settings = [settings({ model: 'claude-haiku-5-5', effort: 'xhigh' }, 4)]
  await clock.advance(60_000)
  await settleUntil(() => applies().length > 1)
  expect(applies().length).toBe(2)
})

const PHONE = `${HOME}/.keelcrew/phone-grants.json`
const SHA = 'a'.repeat(40)
/** A launch card the captain answered on their phone: answered on the board, and the board's snapshot of what the card showed
 * (`grantPending`) left for the Mac to carry out. */
const phoneShip = (id: string, data: Record<string, unknown> = {}, snap: Record<string, unknown> = {}) =>
  line(id, { kind: 'ship', taskKey: 'BRIN-1', status: 'approved', answer: 'Push only', answeredAt: WORK - 60_000, resolvedAt: WORK - 60_000, grantPending: { choice: 'Push only', at: WORK - 60_000, key: 'BRIN-1', head: SHA, ...snap }, receipts: { head: SHA }, risk: 'low', ...data })
const NO_LEDGER = line('main', { ledger: { enabled: false } })

test('a phone answer is carried out once with keelctl grant, remembered before it runs, and the Mate hears how it went', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const disk: { files?: Record<string, string> } = {}
  let before = ''
  const w = world(on, 'lead', { settings: [NO_LEDGER], inbox: [phoneShip('ship-9')] }, {
    persist: [PHONE],
    run: argv => {
      if (argv[1] !== 'grant') return undefined
      before = disk.files?.[PHONE] ?? ''
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, key: 'BRIN-1', choice: 'Push only', head: SHA, expires: new Date(2026, 10, 2, 10, 0).getTime(), risk: 'low' }) }
    },
  })
  disk.files = w.files
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => w.prompts.length > 0)
  expect(grantRuns(w.runs)).toEqual([[CREW_BIN, 'grant', 'ship', 'BRIN-1', '--choice', 'Push only', '--head', SHA, '--answered-at', String(WORK - 60_000), '--json']])
  expect(JSON.parse(before)[`ship-9 ${WORK - 60_000}`]).toMatchObject({ ok: false, text: expect.stringContaining('stopped before it finished') })
  expect(JSON.parse(w.files[PHONE]!)[`ship-9 ${WORK - 60_000}`]).toMatchObject({ key: 'BRIN-1', choice: 'Push only', ok: true })
  expect(w.prompts[0]).toContain('Phone answer: ship-9 BRIN-1 Push only → done (low risk, until 2026-11-02 10:00)')
  expect(w.prompts[0]).toContain('Changed: inbox/ship-9.')
  expect(w.prompts[0]).not.toContain('your answer on')
  await clock.advance(60_000)
  await clock.advance(60_000)
  await settle()
  expect(grantRuns(w.runs).length).toBe(1)
})

test('a phone answer to post runs keelctl grant post; a failed one tells the Mate why', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const post = line('draft-1', { kind: 'question', taskKey: 'BRIN-2', status: 'answered', answer: 'Post it', answeredAt: WORK - 30_000, grantPending: { choice: 'Post it', at: WORK - 30_000, key: 'BRIN-2', post: { tool: 'mcp__x__send_message', match: 'Release 1.2' } }, post: { tool: 'mcp__x__send_message', match: 'Release 1.2' } })
  const w = world(on, 'lead', { settings: [NO_LEDGER], inbox: [post, phoneShip('ship-8', {}, { choice: 'Open PR' })] }, {
    persist: [PHONE],
    run: argv =>
      argv[1] !== 'grant'
        ? undefined
        : argv[2] === 'post'
          ? { exitCode: 0, stdout: JSON.stringify({ ok: true, key: 'BRIN-2', tool: 'mcp__x__send_message', expires: new Date(2026, 9, 19, 10, 30).getTime() }) }
          : { exitCode: 1, stdout: '', stderr: "The card's commit aaaaaaa isn't in BRIN-1's history (HEAD is bbbbbbb), so nothing was approved. Ask for a new launch card." },
  })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => w.prompts.length > 0)
  expect(grantRuns(w.runs).find(r => r[2] === 'post')).toEqual([CREW_BIN, 'grant', 'post', 'BRIN-2', '--tool', 'mcp__x__send_message', '--match', 'Release 1.2', '--answered-at', String(WORK - 30_000), '--json'])
  expect(w.prompts[0]).toContain('Phone answer: draft-1 BRIN-2 Post it → done (one post, until 2026-10-19 10:30)')
  expect(w.prompts[0]).toContain("Phone answer: ship-8 BRIN-1 Open PR → failed: The card's commit aaaaaaa isn't in BRIN-1's history")
})

test("the panel carries out only the captain's snapshot: a ticket, commit, answer or post target changed on the card since changes nothing", async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const swapped = phoneShip('ship-9', { taskKey: 'BRIN-7', answer: 'Open PR', answeredAt: WORK - 1_000, receipts: { head: 'b'.repeat(40) }, post: { tool: 'mcp__evil__send_message' } })
  const draft = line('draft-1', { kind: 'question', taskKey: 'BRIN-7', status: 'answered', answer: 'Post it', answeredAt: WORK - 1_000, grantPending: { choice: 'Post it', at: WORK - 30_000, key: 'BRIN-2', post: { tool: 'mcp__x__send_message', match: 'Release 1.2' } }, post: { tool: 'mcp__evil__send_message', match: 'anything' } })
  const w = world(on, 'lead', { settings: [NO_LEDGER], inbox: [swapped, draft] }, { persist: [PHONE] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => grantRuns(w.runs).length === 2 && w.prompts.length > 0)
  expect(grantRuns(w.runs)).toEqual([
    [CREW_BIN, 'grant', 'ship', 'BRIN-1', '--choice', 'Push only', '--head', SHA, '--answered-at', String(WORK - 60_000), '--json'],
    [CREW_BIN, 'grant', 'post', 'BRIN-2', '--tool', 'mcp__x__send_message', '--match', 'Release 1.2', '--answered-at', String(WORK - 30_000), '--json'],
  ])
})

test("keelctl grant never runs for a withdrawn card, an answer over 24 hours old, or a snapshot it can't read (the Mate hears why)", async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const bad = (id: string, grantPending: unknown) => line(id, { kind: 'ship', taskKey: 'BRIN-1', status: 'approved', answer: 'Push only', answeredAt: WORK - 60_000, grantPending })
  const inbox = [
    phoneShip('ship-w', { withdrawn: 'new commits' }),
    phoneShip('ship-old', {}, { at: WORK - 25 * 3_600_000 }),
    phoneShip('ship-t', {}, { at: null }),
    bad('ship-true', true),
    phoneShip('ship-choice', {}, { choice: 'Ship it' }),
    phoneShip('ship-head', {}, { head: 'HEAD~1' }),
    phoneShip('ship-nohead', {}, { head: null }),
    phoneShip('ship-key', {}, { key: '--choice' }),
    bad('post-tool', { choice: 'Post it', at: WORK - 60_000, key: 'BRIN-1', post: { tool: '' } }),
  ]
  const w = world(on, 'lead', { settings: [NO_LEDGER], inbox }, { persist: [PHONE] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => w.prompts.length > 0)
  expect(grantRuns(w.runs)).toEqual([])
  expect(w.prompts[0]).toContain('Phone answer: ship-w BRIN-1 Push only → failed: the Mate withdrew this card')
  expect(w.prompts[0]).toContain('Phone answer: ship-old BRIN-1 Push only → failed: the answer is over 24 hours old')
  for (const id of ['ship-t', 'ship-true', 'ship-choice', 'ship-head', 'ship-nohead', 'ship-key', 'post-tool']) expect(w.prompts[0]).toMatch(new RegExp(`Phone answer: ${id} .*→ failed: the answer on the card can't be read \\(`))
})

test('with phone approvals off in Settings, the panel carries out nothing', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const w = world(on, 'lead', { settings: [line('main', { ledger: { enabled: false }, phoneApprovals: false })], inbox: [phoneShip('ship-9')] }, { persist: [PHONE] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await clock.advance(60_000)
  await settle()
  expect(grantRuns(w.runs)).toEqual([])
  expect(w.writes.filter(x => x.path === PHONE)).toEqual([])
  expect(w.prompts.filter(p => p.includes('Phone answer'))).toEqual([])
})

test('once the Mate has recorded the outcome, the card is an ordinary answer again', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const w = world(on, 'lead', { settings: [NO_LEDGER], inbox: [phoneShip('ship-9', { grantPending: false, grantResult: 'done (low risk)' })] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => w.prompts.length > 0)
  expect(grantRuns(w.runs)).toEqual([])
  expect(w.prompts[0]).toContain('your answer on BRIN-1')
})

test('a click the crew policy refuses approves nothing, and the toast says why', async ($, on) => {
  mock.clock(on, { now: 2_000_000 })
  const w = world(on, 'lead', SHIP, { denyUpdate: 'Crew policy: 1700000000000 is ahead of now.', run: granted() })
  await $.command.run({ command: 'keel-panel' } as never)
  const ui = await mountPane($ as never, 'desktop', 'Pane', 'crew')
  await ui.press({ key: 'ship-1-Push only' })
  expect(grantRuns(w.runs)).toEqual([])
  expect(w.toasts.at(-1)).toBe('BRIN-1: the board write was refused, so nothing was approved: Crew policy: 1700000000000 is ahead of now.')
  await ui.unmount()
})

test("an answer the board tool's size cap left out of a read still wakes the Mate", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const handled = Array.from({ length: 30 }, (_, i) => line(`a-${String(i).padStart(2, '0')}`, { kind: 'question', status: 'answered', answer: 'Yes', answeredAt: 900_000, handledAt: 950_000, body: 'x'.repeat(200) }))
  const late = line('ship-T-4', { kind: 'ship', status: 'approved', taskKey: 'T-4', answer: 'Push only', answeredAt: 990_000 })
  const { prompts } = world(on, 'lead', { inbox: [...handled, late] }, { cap: 2_000 })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('inbox/ship-T-4')
})

test('the minute read skips cards answered over a day ago, and an answer given after the Mate handled the card wakes it again', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const old = line('q-old', { kind: 'question', status: 'answered', answer: 'Yes', answeredAt: WORK - 2 * 24 * 60 * 60_000 })
  const again = line('ship-2', { kind: 'ship', status: 'approved', taskKey: 'D-2', answer: 'Push only', answeredAt: WORK - 60_000, handledAt: WORK - 5 * 60_000 })
  const { prompts } = world(on, 'lead', { settings: [NO_LEDGER], inbox: [old, again] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => prompts.length > 0)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Changed: inbox/ship-2.')
})

test('a captain line behind many Mate lines still wakes the Mate', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const chat: Record<string, string[]> = { chat: [] }
  const { prompts } = world(on, 'lead', chat)
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  chat.chat = [line('m1', { who: 'me', text: 'push it', ts: 1_010_000 }), ...Array.from({ length: 60 }, (_, i) => line(`l${i}`, { who: 'lead', text: 'on it', ts: 1_010_010 + i }))]
  await clock.advance(60_000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('Changed: chat/m1.')
})

test('the Mate is not woken during its own turn, and is woken once it ends', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = world(on, 'lead', OPEN_REQUEST)
  await $.turn.start(turn.start as never)
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(20 * 60_000)
  expect(prompts.length).toBe(0)
  await $.turn.complete(turn.complete as never)
  await clock.advance(60_000)
  expect(prompts.length).toBe(1)
})

test('a minute whose board read failed keeps the nudge counts, so the next good read does not nudge again early', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts, files } = world(on, 'lead', OPEN_REQUEST)
  const config = files[`${HOME}/.keelcrew/config.json`]!
  files[`${HOME}/.keelcrew/alerts/1-denials-x.json`] = JSON.stringify({ kind: 'denials', summary: 'BRIN-1 paused' })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  expect(prompts.length).toBe(1)
  files[`${HOME}/.keelcrew/config.json`] = JSON.stringify({ owner: 'Sam' })
  await clock.advance(60_000)
  files[`${HOME}/.keelcrew/config.json`] = config
  await clock.advance(60_000)
  expect(prompts.length).toBe(1)
})

test('a merged PR takes its risk from the ticket launch card even when that card is days old', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const docs: Record<string, string[]> = {
    settings: [line('main', { merges: { autoStatus: true }, ledger: { enabled: false } })],
    tasks: [line('D-2', { status: 'pr', prUrl: 'https://github.com/o/r/pull/2' })],
    inbox: [line('ship-D-2', { kind: 'ship', status: 'approved', taskKey: 'D-2', answer: 'Open PR', answeredAt: WORK - 5 * 24 * 60 * 60_000, handledAt: WORK - 5 * 24 * 60 * 60_000, createdAt: 1, risk: { tier: 'low' } })],
  }
  const merged = JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-19T09:00:00Z', number: 2, mergeCommit: { oid: 'sha2' } })
  const { writes } = world(on, 'lead', docs, { run: argv => (argv[0] === 'gh' ? { exitCode: 0, stdout: merged } : undefined) })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => writes.some(w => w.path === MERGES))
  expect(lastJson(writes, MERGES).merges.map((x: { key: string; target: string }) => `${x.key}:${x.target}`)).toEqual(['D-2:done'])
})

test('a ledger fed before the inbox read was fixed is fed every card once more, then only the recent ones', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const docs: Record<string, string[]> = {
    tasks: [line('D-1', { status: 'active', title: 'One' })],
    inbox: [line('ship-old', { kind: 'ship', status: 'approved', taskKey: 'D-1', answer: 'Push only', answeredAt: WORK - 5 * 24 * 60 * 60_000, handledAt: WORK - 5 * 24 * 60 * 60_000, createdAt: 1 })],
  }
  const { writes, runs, reads } = world(on, 'lead', docs, { store: { ledgerBackfilled: true } })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  await settleUntil(() => ledgerRuns(runs, 'feed').length > 0)
  expect(lastJson(writes, FACTS).inbox.map((c: { id: string }) => c.id)).toEqual(['ship-old'])
  const full = () => reads.filter(r => r.collection === 'inbox' && !r.where).length
  expect(full()).toBe(1)
  docs.inbox = [...docs.inbox!, line('q-new', { kind: 'question', status: 'open', taskKey: 'D-1', createdAt: 2 })]
  await clock.advance(60_000)
  await settleUntil(() => ledgerRuns(runs, 'feed').length > 1)
  expect(lastJson(writes, FACTS).inbox.map((c: { id: string }) => c.id)).toEqual(['q-new'])
  expect(full()).toBe(1)
})

test('a click whose approval the helper refuses, on a card the board will not open again, says the card still shows the answer', async ($, on) => {
  mock.clock(on, { now: 2_000_000 })
  const refuse = (argv: readonly string[]): Run | undefined => (argv[1] === 'grant' ? { exitCode: 1, stdout: '', stderr: 'nothing was approved.' } : undefined)
  const { toasts } = world(on, 'lead', SHIP, { run: refuse, failReopen: true })
  await $.command.run({ command: 'keel-panel' } as never)
  const ui = await mountPane($ as never, 'desktop', 'Pane', 'crew')
  await ui.press({ key: 'ship-1-Open PR' })
  expect(toasts.at(-1)).toContain('BRIN-1: nothing was approved, but the card still says Open PR: tell the Mate nothing was approved')
  await ui.unmount()
})

test('an item the Mate dealt with leaves its nudge count behind, so when it comes back it is woken again', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const docs: Record<string, string[]> = { ...OPEN_REQUEST }
  const { prompts } = world(on, 'lead', docs)
  await $.session.start({ cwd: '/code' } as never)
  for (let i = 0; i < 4; i++) await clock.advance(16 * 60_000)
  expect(prompts.length).toBe(3)
  docs.requests = []
  await clock.advance(60_000)
  docs.requests = OPEN_REQUEST.requests
  await clock.advance(60_000)
  expect(prompts.length).toBe(4)
})

test('a card that came while the app was closed is announced when it opens', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { notifies } = world(on, 'lead', { inbox: [line('q-1', { kind: 'question', urgent: true, status: 'open', taskKey: 'BRIN-3' })], settings: [line('main', { pushNotifications: true })] }, { store: { seenCards: [] } })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(5_000)
  expect(notifies).toEqual([{ text: 'Urgent: BRIN-3 question: open it on the board', title: 'Keelcrew' }])
})

test("the Mate's guessed handledAt and chat ts are written on the real clock, so its answer counts as handled", async ($, on) => {
  mock.clock(on, { now: 2_000_000 })
  const { updates, sets } = world(on, 'lead', {})
  await $.session.start({ cwd: '/code' } as never)
  await $.tool.call({ tool: 'ArtifactData', action: 'update', url: BOARD, collection: 'inbox', doc_id: 'ship-1', if_version: 3, data: { handledAt: 2_000_000 - 6 * 60_000 } } as never)
  expect((updates.at(-1)!.data as { handledAt: number }).handledAt).toBe(2_000_000)
  await $.tool.call({ tool: 'ArtifactData', action: 'set', url: BOARD, collection: 'chat', doc_id: 'lead-2360000', data: { who: 'lead', ts: 2_000_000 + 6 * 60_000, text: 'Done.' } } as never)
  expect((sets.at(-1)!.data as { ts: number }).ts).toBe(2_000_000)
  await $.tool.call({ tool: 'ArtifactData', action: 'batch', url: BOARD, writes: [{ op: 'update', collection: 'inbox', doc_id: 'q-1', if_version: 2, data: { handledAt: 1 } }, { op: 'update', collection: 'tasks', doc_id: 'T-1', if_version: 4, data: { status: 'pr' } }] } as never)
  const writes = sets.at(-1)!.writes as { data: Record<string, unknown> }[]
  expect(writes[0]!.data.handledAt).toBe(2_000_000)
  expect(writes[1]!.data).toEqual({ status: 'pr' })
})

test("the Mate's times within 5 minutes of the clock are left as written, so auto mode doesn't refuse a changed call", async ($, on) => {
  mock.clock(on, { now: 2_000_000 })
  const { updates, sets } = world(on, 'lead', {})
  await $.session.start({ cwd: '/code' } as never)
  await $.tool.call({ tool: 'ArtifactData', action: 'update', url: BOARD, collection: 'inbox', doc_id: 'ship-1', if_version: 3, data: { handledAt: 1_993_000 } } as never)
  expect((updates.at(-1)!.data as { handledAt: number }).handledAt).toBe(1_993_000)
  await $.tool.call({ tool: 'ArtifactData', action: 'set', url: BOARD, collection: 'chat', doc_id: 'lead-2007000', data: { who: 'lead', ts: 2_007_000, text: 'Done.' } } as never)
  expect((sets.at(-1)!.data as { ts: number }).ts).toBe(2_007_000)
  await $.tool.call({ tool: 'ArtifactData', action: 'batch', url: BOARD, writes: [{ op: 'update', collection: 'inbox', doc_id: 'q-1', if_version: 2, data: { handledAt: 2_000_000 - 4 * 60_000 } }] } as never)
  expect((sets.at(-1)!.writes as { data: Record<string, unknown> }[])[0]!.data.handledAt).toBe(2_000_000 - 4 * 60_000)
})

test("an engineer's board writes keep their own times", async ($, on) => {
  mock.clock(on, { now: 2_000_000 })
  const { updates } = world(on, 'engineer', {})
  await $.session.start({ cwd: '/code' } as never)
  await $.tool.call({ tool: 'ArtifactData', action: 'update', url: BOARD, collection: 'inbox', doc_id: 'ship-1', if_version: 3, data: { handledAt: 1 } } as never)
  expect((updates.at(-1)!.data as { handledAt: number }).handledAt).toBe(1)
})

test('lead.md past 200 lines is a health issue that raises an alert', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const { writes, files, runs } = world(on, 'lead', {})
  files[`${HOME}/.keelcrew/lead.md`] = `${Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n')}\n`
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  const health = lastJson(writes, HEALTH)
  expect(health.issues).toEqual([{ id: 'notes:long', severity: 'soon', text: expect.stringContaining('lead.md is 250 lines') }])
  expect(runs.filter(r => r[0] === CREW_BIN && r[1] === 'alerts')).toEqual([[CREW_BIN, 'alerts', 'add', '--kind', 'health', '--summary', expect.stringContaining('lead.md is 250 lines')]])
})

const DAY = 24 * 60 * 60_000
const KEEP = `${HOME}/.keelcrew/housekeeping.json`

test("once a day the board's old documents are listed for the Mate, old chat saved first; the Mate is woken until it marks them cleared", async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const docs: Record<string, string[]> = {
    requests: [line('r-old', { kind: 'memory', status: 'done', at: WORK - 3 * DAY }), line('r-new', { kind: 'memory', status: 'done', at: WORK - DAY }), line('r-open', { kind: 'memory', status: 'open', at: WORK - 9 * DAY })],
    inbox: [
      line('c-old', { kind: 'question', status: 'answered', handledAt: WORK - 15 * DAY }, 4),
      line('c-asked-again', { kind: 'question', status: 'open', handledAt: WORK - 15 * DAY }),
      line('c-new', { kind: 'question', status: 'answered', handledAt: WORK - 2 * DAY }),
      line('pm-started', { kind: 'proposal', from: 'pm', proposal: { metric: 'x' }, answer: 'Start it', status: 'answered', handledAt: WORK - 20 * DAY }),
      line('pm-declined', { kind: 'proposal', from: 'pm', proposal: { metric: 'y' }, answer: 'Not now', status: 'answered', handledAt: WORK - 20 * DAY }),
    ],
    chat: [line('m-old', { who: 'me', text: 'hello from october', ts: WORK - 31 * DAY }), line('m-new', { who: 'me', text: 'recent', ts: WORK - DAY, handledAt: WORK })],
    tasks: [
      line('BRIN-7', { status: 'done', closedAt: WORK - 40 * DAY }),
      line('BRIN-8', { status: 'done', closedAt: WORK - 3 * DAY }),
      line('BRIN-3', { status: 'done', closedAt: WORK - 40 * DAY, reopened: true }),
      line('BRIN-2', { status: 'done', closedAt: WORK - 40 * DAY, reopenedAt: WORK - 2 * DAY }),
    ],
    crew: [line('lead', {})],
  }
  const { writes, prompts } = world(on, 'lead', docs)
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  const list = lastJson(writes, KEEP)
  expect(list.delete).toEqual([
    { collection: 'requests', id: 'r-old', version: 1 },
    { collection: 'inbox', id: 'pm-declined', version: 1 },
    { collection: 'inbox', id: 'c-old', version: 4 },
    { collection: 'chat', id: 'm-old', version: 1 },
  ])
  expect(list.evidenceOf).toEqual(['BRIN-7'])
  const month = new Date(WORK - 31 * DAY)
  const archive = writes.find(w => w.path === `${HOME}/.keelcrew/archive/chat-${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}.jsonl`)
  expect(archive?.text).toContain('hello from october')
  await clock.advance(60_000)
  expect(prompts.some(p => p.includes('board housekeeping: 5 old documents') && p.includes('housekeeping.json'))).toBe(true)
  // The Mate deleted them and stamped crew/lead: no more wakes, and the next day's list leaves BRIN-7's evidence out.
  docs.crew = [line('lead', { housekeptAt: WORK + 5 * 60_000 })]
  const before = prompts.length
  await clock.advance(20 * 60_000)
  expect(prompts.slice(before).some(p => p.includes('board housekeeping'))).toBe(false)
  await clock.advance(DAY)
  expect(lastJson(writes, KEEP).evidenceOf).toEqual([])
})

test('a housekeeping list too large for one board answer is read at a smaller size, oldest first', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const chat = Array.from({ length: 40 }, (_, i) => line(`m-${i}`, { who: 'me', text: `old message ${i} ${'x'.repeat(60)}`, ts: WORK - 40 * DAY + i }))
  const { writes } = world(on, 'lead', { chat }, { cap: 2_000 })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  const list = lastJson(writes, KEEP)
  expect(list.delete.length).toBeGreaterThan(0)
  expect(list.delete[0]).toEqual({ collection: 'chat', id: 'm-0', version: 1 })
})

test("lead.md's bullets about tasks closed a week ago move to the monthly lead archive; open tasks and standing notes stay", async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const docs = {
    tasks: [
      line('BRIN-7', { status: 'done', closedAt: WORK - 9 * DAY }),
      line('BRIN-9', { status: 'active' }),
      line('T-3', { status: 'cancelled', closedAt: WORK - 30 * DAY }),
      line('BRIN-2026', { status: 'done', closedAt: WORK - 9 * DAY }),
      line('BRIN-1234', { status: 'active' }),
    ],
  }
  const { writes, files } = world(on, 'lead', docs)
  const notes = `${HOME}/.keelcrew/lead.md`
  files[notes] = [
    '# Mate notes',
    '- Repos: brinewick-api, base develop.',
    '- **BRIN-7** · PR merged · done',
    '  second line of 7',
    '- 9 and 7 together: BRIN-9 waits on BRIN-7',
    '- Keep the VPN on (learned on BRIN-7)',
    '- T-3 · cancelled',
    '- T-31 · open note',
    '- 2026 · merged',
    '- 2026-11-02 · release cut',
    '- 2026 waits on 1234',
    '',
  ].join('\n')
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  const kept = writes.filter(w => w.path === notes).at(-1)!.text
  expect(kept).toBe(
    ['# Mate notes', '- Repos: brinewick-api, base develop.', '- 9 and 7 together: BRIN-9 waits on BRIN-7', '- Keep the VPN on (learned on BRIN-7)', '- T-31 · open note', '- 2026-11-02 · release cut', '- 2026 waits on 1234', ''].join('\n'),
  )
  const archive = writes.find(w => /lead-archive-\d{4}-\d{2}\.md$/.test(w.path))!.text
  expect(archive).toContain('- **BRIN-7** · PR merged · done\n  second line of 7')
  expect(archive).toContain('- T-3 · cancelled')
  expect(archive).toContain('- 2026 · merged')
})

test("a closed task's clean worktree is saved, removed and unregistered a week on; one with changes or no branch is kept but unregistered", async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const clean = '/code/repo/.claude/worktrees/BRIN-7'
  const dirty = '/code/repo/.claude/worktrees/BRIN-8'
  const busyWt = '/code/repo/.claude/worktrees/BRIN-5'
  const detached = '/code/repo/.claude/worktrees/BRIN-4'
  const docs = {
    tasks: [
      line('BRIN-7', { status: 'done', closedAt: WORK - 8 * DAY, worktree: clean, briefs: ['keel-brin-7'] }),
      line('BRIN-8', { status: 'done', closedAt: WORK - 8 * DAY, worktree: dirty }),
      line('BRIN-6', { status: 'done', closedAt: WORK - DAY, worktree: '/code/repo/.claude/worktrees/BRIN-6', briefs: ['keel-brin-6'] }),
      line('BRIN-5', { status: 'done', closedAt: WORK - 9 * DAY, worktree: busyWt }),
      line('BRIN-4', { status: 'done', closedAt: WORK - 9 * DAY, worktree: detached }),
    ],
  }
  const { runs, files } = world(on, 'lead', docs, {
    run: argv =>
      argv[0] === 'git' && argv[2] === dirty && argv[3] === 'status' ? { exitCode: 0, stdout: ' M a.py\n' } : argv[0] === 'git' && argv[2] === detached && argv[3] === 'symbolic-ref' ? { exitCode: 1, stdout: '' } : undefined,
  })
  for (const wt of [clean, dirty, busyWt, detached, '/code/repo/.claude/worktrees/BRIN-6']) files[`${wt}/README`] = 'x'
  files[`${clean}/.claude/dev-notes/n.md`] = 'notes'
  files[`${HOME}/.keelcrew/state/${await hash16(busyWt)}.json`] = JSON.stringify({ lastAt: WORK - DAY })
  for (const b of ['keel-brin-7', 'keel-brin-6']) files[`${HOME}/.keelcrew/briefs/${b}.md`] = 'brief'
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(runs).toContainEqual(['cp', '-R', `${clean}/.claude/dev-notes`, `${HOME}/.keelcrew/archive/worktrees/BRIN-7/.claude/`])
  const removeAt = runs.findIndex(r => r.join(' ') === `git -C /code/repo worktree remove ${clean}`)
  expect(removeAt).toBeGreaterThan(-1)
  expect(runs.findIndex(r => r[0] === CREW_BIN && r[1] === 'unregister' && r[2] === clean)).toBeGreaterThan(removeAt)
  for (const wt of [dirty, busyWt, detached, '/code/repo/.claude/worktrees/BRIN-6']) expect(runs.some(r => r.includes(wt) && r.includes('remove'))).toBe(false)
  for (const wt of [dirty, detached]) expect(runs).toContainEqual([CREW_BIN, 'unregister', wt])
  for (const wt of [busyWt, '/code/repo/.claude/worktrees/BRIN-6']) expect(runs.some(r => r.includes(wt) && r.includes('unregister'))).toBe(false)
  expect(runs).toContainEqual(['rm', '-f', `${HOME}/.keelcrew/briefs/keel-brin-7.md`])
  expect(runs.some(r => r.includes(`${HOME}/.keelcrew/briefs/keel-brin-6.md`))).toBe(false)
})

test('standing orders that leave lessons out, or more than 80 lessons in force, are a health issue', async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const { writes, files } = world(on, 'lead', {}, { run: argv => (argv[0] === CREW_BIN && argv[1] === 'memory' ? { exitCode: 0, stdout: JSON.stringify([...Array.from({ length: 81 }, (_, i) => ({ key: `k${i}`, status: 'active' })), { key: 'c', status: 'candidate' }]) } : undefined) })
  files[`${HOME}/.keelcrew/memory/playbook.md`] = '# Crew standing orders\n\n_28 lower-confidence lessons left out to keep this short._\n'
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(lastJson(writes, HEALTH).issues.map((i: { id: string }) => i.id)).toEqual(['playbook:dropped', 'playbook:many'])
})

test('the harbour reads cron schedules, times each voyage stop, and turns card blocks into one line for the terminal', async () => {
  const mon = new Date(2026, 9, 19, 10, 0)
  expect(cronTimes('15 10-18/2 * * 1-5', mon)).toEqual([615, 735, 855, 975, 1095])
  expect(cronTimes('0 10 * * 1', new Date(2026, 9, 20, 10, 0))).toEqual([])
  // Days of the month count from 1, and day and month names read as numbers.
  expect(cronTimes('0 9 */2 * *', mon)).toEqual([540])
  expect(cronTimes('0 9 */2 * *', new Date(2026, 9, 20, 10, 0))).toEqual([])
  expect(cronTimes('0 9 * oct mon-fri', mon)).toEqual([540])
  expect(watchesToday([['PR shepherd', '15 10-18/2 * * 1-5'], ['Learner', '0 21 * * 1-5']], mon.getTime() + 20 * 60_000)).toEqual([
    { at: '10:15', name: 'PR shepherd', state: 'done' },
    { at: '12:15', name: 'PR shepherd', state: 'next' },
    { at: '14:15', name: 'PR shepherd', state: 'later' },
    { at: '16:15', name: 'PR shepherd', state: 'later' },
  ])
  const t0 = 1_000_000
  expect(stopTimes([{ phase: 'spec', at: t0 }, { phase: 'build', at: t0 + 20 * 60_000 }, { phase: 'verify', at: t0 + 60 * 60_000 }], t0 + 150 * 60_000)).toEqual(['20m', '2h 10m', '', '', '', ''])
  const parts = pieces('Overnight:\n```keelcrew\n{"kind": "you", "key": "BRIN-1", "title": "Launch it", "risk": {"tier": "Medium", "why": ["deletes a file"]}}\n```\n```keelcrew\nnot json\n```\n')
  expect(parts?.length).toBe(3)
  expect(plainText(parts!)).toContain('**Needs you:** BRIN-1 Launch it (Medium risk: deletes a file)')
  expect(plainText(parts!)).toContain('not json')
  expect(pieces('no cards here')).toBe(null)
  // A block of the wrong shape stays text.
  expect(pieces('```keelcrew\n{"kind": "you", "key": "BRIN-1", "title": "t", "risk": {"tier": "low"}}\n```')).toBe(null)
  expect(pieces('```keelcrew\n{"kind": "crew", "role": "Engineer", "key": "BRIN-1", "title": "t", "status": "s", "facts": "one"}\n```')).toBe(null)
})

test("the Mate's needs-you card for a launch card shows that card's own risk and answers it as the panel does; a crew message's never does", async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const { updates, runs } = world(on, 'lead', SHIP, { run: granted() })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  const text = 'One waits.\n```keelcrew\n{"kind": "you", "key": "BRIN-1", "title": "Push & PR", "risk": {"tier": "Low", "why": ["small"]}}\n```\n'
  const crewMsg = (await $.ui.mount({ plugin: 'keelcrew', surface: 'desktop', component: 'UserMessage', props: { text } } as never)) as Ui
  expect(await crewMsg.find({ text: /Answer it on the board/ })).toBeDefined()
  await crewMsg.unmount()
  const ui = (await $.ui.mount({ plugin: 'keelcrew', surface: 'desktop', component: 'AssistantMessage', props: { text, isFirstOfReply: true } } as never)) as Ui
  expect(await ui.find({ text: /Needs you/ })).toBeDefined()
  expect(await ui.find({ text: /launch card: low risk, commit aaaaaaa/ })).toBeDefined()
  await ui.press({ key: 'ship-1:Open PR:1' })
  expect((updates[0]?.data as { answer?: string }).answer).toBe('Open PR')
  expect(grantRuns(runs).length).toBe(1)
  await ui.unmount()
})

test('the jetty names each boat by where its task stands: working, PR open, in QA, needs you, failed, paused', () => {
  const states = ['work', 'review', 'qa', 'you', 'bad', 'paused'] as const
  const svg = scene({ at: 0, waiting: 0, paused: 0, alerts: 0, watches: [], week: null, crew: states.map((state, i) => ({ key: `T-${i}`, role: 'Engineer', state })), phases: {} } as never)
  for (const word of ['Working', 'PR open', 'In QA', 'Needs you', 'Failed', 'Paused']) expect(svg).toContain(`>${word}<`)
})

test("the Mate's session wears Harbour light: its row counts what waits and who is aboard, and switching the look off takes the row away", async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const docs: Record<string, string[]> = { ...SHIP, tasks: [line('BRIN-1', { title: 'Push', phase: 'review', status: 'active' })], settings: [] }
  const w = world(on, 'lead', docs)
  w.files[CREW] = JSON.stringify({ dirs: {}, sessions: { 'sess-1': { role: 'lead', key: null, dir: '/code' }, 'eng-1': { role: 'engineer', key: 'BRIN-1', dir: WT } } })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  const row = await mountPane($ as never, 'desktop', 'AbovePrompt')
  expect(await row.find({ text: /1 need you/ })).toBeDefined()
  expect(await row.find({ text: /1 aboard/ })).toBeDefined()
  await row.unmount()
  expect(w.writes.some(x => x.path.endsWith('/phases.json') && x.text.includes('"phase":"review"'))).toBe(true)
  docs.settings!.push(line('main', { harbourLook: false }))
  await clock.advance(60_000)
  // With the look off the panel draws no row of its own: the slot goes to what lies beneath (nothing, in a test).
  // Older test kits throw "no implementation for ui.render" for an empty slot; newer ones mount nothing.
  const off = await mountPane($ as never, 'desktop', 'AbovePrompt').then(
    async r => {
      const left = await r.find({ text: /aboard|need you/ }).catch(() => undefined)
      await r.unmount()
      return left ? 'drawn' : 'empty'
    },
    (err: Error) => (/no implementation for ui\.render/.test(String(err.message)) ? 'empty' : String(err.message)),
  )
  expect(off).toBe('empty')
})

test("the harbour's watches follow the role switch in Settings → Crew", async ($, on) => {
  const clock = mock.clock(on, { now: WORK })
  const docs: Record<string, string[]> = { ...SHIP, tasks: [], settings: [line('main', {})] }
  world(on, 'lead', docs, { agents: { 'shepherd.json': JSON.stringify({ id: 'shepherd', name: 'PR shepherd', defaultEnabled: true, schedule: { cron: '30 * * * *' } }) } })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  const row = await mountPane($ as never, 'desktop', 'AbovePrompt')
  expect(await row.find({ text: /next watch/ })).toBeDefined()
  await row.unmount()
  docs.settings = [line('main', { org: { roles: { shepherd: { enabled: false } } }, agents: { shepherd: { enabled: true } } })]
  await clock.advance(60_000)
  const off = await mountPane($ as never, 'desktop', 'AbovePrompt')
  expect(await off.find({ text: /next watch/ }).catch(() => undefined)).toBeUndefined()
  await off.unmount()
})

test("while Harbour light is on, another plugin's theme is refused; Keelcrew's own and the engine's pass", () => {
  expect(otherLook(true, 'other-look')?.deny).toContain('Harbour light')
  expect(otherLook(true, 'keelcrew')).toBeNull()
  expect(otherLook(true, 'engine')).toBeNull()
  expect(otherLook(false, 'other-look')).toBeNull()
})

/** `keelctl rekey` as the CLI answers it: the old id's entry moves to the new id in crew.json; `refuse` answers exit 1. */
const rekeyed = (w: { files: Record<string, string> }, refuse = false) => (argv: readonly string[]): Run | undefined => {
  if (argv[0] !== CREW_BIN || argv[1] !== 'rekey') return undefined
  if (refuse) return { exitCode: 1, stdout: '', stderr: 'refused' }
  const reg = JSON.parse(w.files[CREW]!) as { sessions: Record<string, unknown> }
  reg.sessions[argv[4]!] = reg.sessions[argv[2]!]
  delete reg.sessions[argv[2]!]
  w.files[CREW] = JSON.stringify(reg)
  return { exitCode: 0, stdout: '' }
}
const CLEAR = { reason: 'clear', sessionId: 'sess-1', resume: { id: 'sess-1' } }
const MATE_CLEARED = "You're the Keelcrew Mate and this conversation was just cleared: run the keelcrew:keel-lead skill first, then handle this."

test("after /clear the Mate's session moves its crew entry to its new id, from its own folder, and is woken again", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const docs: Record<string, string[]> = { ...OPEN_REQUEST }
  const w = world(on, 'lead', docs, { run: argv => rekeyed(w)(argv) })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(w.prompts.length).toBe(1)
  await $.session.end(CLEAR as never)
  w.session.id = 'sess-2'
  docs.requests = [...docs.requests!, line('r2', { kind: 'start', key: 'BRIN-3', status: 'open' })]
  await clock.advance(1_000)
  await settleUntil(() => w.runs.some(r => r[1] === 'rekey'))
  const at = w.runs.findIndex(r => r[1] === 'rekey')
  expect(w.runs[at]).toEqual([CREW_BIN, 'rekey', 'sess-1', '--session', 'sess-2'])
  expect(w.cwds[at]).toBe('/code')
  await clock.advance(60_000)
  expect(w.prompts.at(-1)).toContain('request start BRIN-3')
  // The first wake of the new conversation tells it to load its skill, once.
  expect(w.prompts.at(-1)!.startsWith(`${MATE_CLEARED}\nKeelcrew board:`)).toBe(true)
  expect(w.prompts.filter(p => p.includes(MATE_CLEARED)).length).toBe(1)
  await $.prompt.submit({ text: 'What is open?' } as never)
  expect(w.prompts.at(-1)).toBe('What is open?')
  // Once moved, nothing runs it again.
  await clock.advance(5 * 60_000)
  expect(w.runs.filter(r => r[1] === 'rekey').length).toBe(1)
})

test("after /clear an engineer's band comes back once its entry moves; a refused move is tried again, then given up", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let refuse = true
  const w = world(on, 'engineer', {}, { run: argv => rekeyed(w, refuse)(argv) })
  w.files[SUMMARY] = JSON.stringify({ at: 1_000_000, tickets: { 'BRIN-1': { title: 'Fix alert date', phase: 'build', status: 'active', summary: '', waiting: '', prUrl: '', cards: [] } } })
  await $.session.start({ cwd: '/code' } as never)
  await $.session.end(CLEAR as never)
  w.session.id = 'sess-2'
  await clock.advance(60_000)
  const tries = () => w.runs.filter(r => r[1] === 'rekey')
  expect(tries().length).toBeGreaterThan(0)
  // From the engineer's worktree, whatever folder the session is in.
  expect(w.cwds[w.runs.findIndex(r => r[1] === 'rekey')]).toBe(WT)
  refuse = false
  await clock.advance(60_000)
  w.files[SUMMARY] = JSON.stringify({ at: 1_000_000 + 2 * 60_000, tickets: { 'BRIN-1': { title: 'Fix alert date', phase: 'build', status: 'active', summary: '', waiting: '', prUrl: '', cards: [] } } })
  await clock.advance(60_000)
  const ui = await mountPane($ as never, 'desktop', 'AbovePrompt')
  expect(await ui.find({ type: 'Text', text: /BRIN-1 · Fix alert date/ })).toBeDefined()
  await ui.unmount()
  // A move refused for over 10 minutes is given up.
  await $.session.end({ ...CLEAR, sessionId: 'sess-2' } as never)
  w.session.id = 'sess-3'
  refuse = true
  await clock.advance(12 * 60_000)
  const n = tries().length
  await clock.advance(5 * 60_000)
  expect(tries().length).toBe(n)
})

test('a session outside the crew never runs keelctl rekey after /clear', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, 'lead', {})
  w.files[CREW] = JSON.stringify({ dirs: {}, sessions: { other: { role: 'lead', key: null, dir: '/code' } } })
  await $.session.start({ cwd: '/code' } as never)
  await $.session.end({ ...CLEAR } as never)
  w.session.id = 'sess-2'
  await clock.advance(3 * 60_000)
  expect(w.runs.filter(r => r[1] === 'rekey')).toEqual([])
})

test("a /clear leaves the note keelctl rekey asks for, for the id that ended; any other end forgets the /clear", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, 'engineer', {}, { run: argv => rekeyed(w)(argv) })
  await $.session.start({ cwd: '/code' } as never)
  await $.session.end(CLEAR as never)
  expect(w.writes.filter(x => x.path.includes('/cleared/'))).toEqual([{ path: `${HOME}/.keelcrew/cleared/sess-1.json`, text: `${JSON.stringify({ at: 1_000_000 })}\n` }])
  // A resume before the new id was seen: the process goes on as another session, which never takes this /clear's entry.
  await $.session.end({ ...CLEAR, reason: 'resume' } as never)
  w.session.id = 'sess-9'
  await clock.advance(3 * 60_000)
  expect(w.runs.filter(r => r[1] === 'rekey')).toEqual([])
})

test("the captain's first prompt after the Mate's /clear tells it to load keel-lead, once", async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, 'lead', {}, { run: argv => rekeyed(w)(argv) })
  await $.session.start({ cwd: '/code' } as never)
  await $.session.end(CLEAR as never)
  w.session.id = 'sess-2'
  await $.prompt.submit({ text: 'What is open?' } as never)
  // Back in the crew before the note is decided.
  expect(w.runs.filter(r => r[1] === 'rekey')).toEqual([[CREW_BIN, 'rekey', 'sess-1', '--session', 'sess-2']])
  expect(w.prompts).toEqual([`${MATE_CLEARED}\nWhat is open?`])
  await $.prompt.submit({ text: 'And now?' } as never)
  expect(w.prompts.at(-1)).toBe('And now?')
})

test("the Mate's first wake after /clear with a changed keel-lead skill carries one note, and the skill counts as told", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, 'lead', OPEN_REQUEST, { run: argv => rekeyed(w)(argv) })
  installCrew(w, 'rules v1')
  await $.session.start({ cwd: '/code' } as never)
  await $.session.end(CLEAR as never)
  w.session.id = 'sess-2'
  await clock.advance(60_000)
  expect(w.prompts.length).toBe(1)
  expect(w.prompts[0]!.startsWith(`${MATE_CLEARED}\nKeelcrew board:`)).toBe(true)
  expect(w.prompts[0]).not.toContain(SKILL_LINE)
  await clock.advance(15 * 60_000)
  expect(w.prompts.length).toBe(2)
  expect(w.prompts[1]!.startsWith('Keelcrew board:')).toBe(true)
})

test("an engineer's /clear adds no note to its next prompt", async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, 'engineer', {}, { run: argv => rekeyed(w)(argv) })
  await $.session.start({ cwd: '/code' } as never)
  await $.session.end(CLEAR as never)
  w.session.id = 'sess-2'
  await $.prompt.submit({ text: 'Carry on.' } as never)
  expect(w.prompts).toEqual(['Carry on.'])
})

test("the Mate's prompt without a /clear is left as typed", async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const w = world(on, 'lead', {})
  await $.session.start({ cwd: '/code' } as never)
  await $.prompt.submit({ text: 'What is open?' } as never)
  expect(w.prompts).toEqual(['What is open?'])
})

test('a board answer the panel cannot read is never taken for an empty collection', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { writes } = world(on, 'lead', { ...SHIP }, { odd: { inbox: 'The tool ran.' } })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(writes.filter(w => w.path === SUMMARY)).toEqual([])
  await $.command.run({ command: 'keel-panel' } as never)
  const ui = await mountPane($ as never, 'desktop', 'Pane', 'crew')
  expect(await ui.find({ type: 'Text', text: /Couldn't read the board: reading inbox gave an answer the panel can't read/ })).toBeDefined()
  await ui.unmount()
})

test("a turn the host still has running holds the Mate's wake, though this copy of the panel never saw it start (a reload)", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = world(on, 'lead', OPEN_REQUEST)
  let running: { id: string; at: number } | null = { id: 't0', at: 1_000_000 }
  on('state.get', async (_$, e, next) => ((e as unknown as { key: string }).key === 'turn' ? ({ value: { value: running, version: 1 } } as never) : next(e)))
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(20 * 60_000)
  expect(prompts.length).toBe(0)
  running = null
  await clock.advance(60_000)
  expect(prompts.length).toBe(1)
})

test("a turn that never reported its end holds wakes for two hours at most", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const { prompts } = world(on, 'lead', OPEN_REQUEST)
  await $.turn.start(turn.start as never)
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(110 * 60_000)
  expect(prompts.length).toBe(0)
  await clock.advance(11 * 60_000)
  expect(prompts.length).toBe(1)
})

test("an engineer's compaction isn't run again after /clear, nor when its record is already on disk", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const w = world(on, 'engineer', {}, { run: argv => rekeyed(w)(argv) })
  w.files[SUMMARY] = JSON.stringify({ at: 1_000_000, tickets: {}, compact: [{ id: 'c1', key: 'BRIN-1', agent: null }] })
  await $.session.start({ cwd: '/code' } as never)
  await clock.advance(60_000)
  expect(w.compacts.runs).toBe(1)
  await $.session.end(CLEAR as never)
  w.session.id = 'sess-2'
  await clock.advance(3 * 60_000)
  expect(w.runs.some(r => r[1] === 'rekey')).toBe(true)
  expect(w.compacts.runs).toBe(1)
  // A request whose record is on disk ran already (a store from before a reload, say).
  w.files[`${HOME}/.keelcrew/compacted/c2.json`] = JSON.stringify({ key: 'BRIN-1', at: 990_000 })
  w.files[SUMMARY] = JSON.stringify({ at: 1_000_000, tickets: {}, compact: [{ id: 'c2', key: 'BRIN-1', agent: null }] })
  await clock.advance(3 * 60_000)
  expect(w.compacts.runs).toBe(1)
})

test('the board write that opens a card again after a refused approval carries the press as consent', async ($, on) => {
  mock.clock(on, { now: 2_000_000 })
  const refuse = (argv: readonly string[]): Run | undefined => (argv[1] === 'grant' ? { exitCode: 1, stdout: '', stderr: 'no' } : undefined)
  const { updates } = world(on, 'lead', SHIP, { run: refuse })
  await $.command.run({ command: 'keel-panel' } as never)
  const ui = await mountPane($ as never, 'desktop', 'Pane', 'crew')
  await ui.press({ key: 'ship-1-Open PR' })
  expect(updates.length).toBe(2)
  for (const u of updates) expect(String(u.consent)).toMatch(/^The user pressed "Open PR" on the BRIN-1 launch card in the Keelcrew panel/)
  await ui.unmount()
})

test("a board write goes through as it was when the panel's check of it fails", async ($, on) => {
  mock.clock(on, { now: 2_000_000 })
  const w = world(on, 'lead', {})
  w.session.fail = true
  const r = await $.tool.call({ tool: 'ArtifactData', action: 'update', url: BOARD, collection: 'inbox', doc_id: 'q-1', if_version: 3, data: { handledAt: 5 } } as never)
  expect(String((r as { text?: string }).text)).toContain('now at version 4')
  expect(w.updates.map(u => u.data)).toEqual([{ handledAt: 5 }])
})
