/**
 * A realistic crew for checking the board by eye: a high-risk launch card waiting on the captain, a QA failure, an engineer
 * paused by crew policy, drafts to post, batch questions, learner cards, watches (one blocked), costs near and
 * over budget, and a Mate that just asked something. Every name, number and ticket here is an example.
 */
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const now = Date.now();
const ago = (ms: number) => now - ms;
/** Earlier today (never before local midnight), for a ticket shipped today. */
const today = (ms: number) => Math.max(new Date(now).setHours(0, 0, 0, 0) + MIN, now - ms);

type Data = Record<string, unknown>;

const contract2401 = [
  { id: 'VAL-BRIN-2401-01', text: 'GET /api/orders/{id}/receipt for a known order returns 200 with the line totals', kind: 'positive' },
  { id: 'VAL-BRIN-2401-02', text: 'An unknown order id returns 404 with "Order not found"', kind: 'negative' },
  { id: 'VAL-BRIN-2401-03', text: 'A non-numeric order id returns 400, not 500', kind: 'negative' },
  { id: 'VAL-BRIN-2401-04', text: 'The PDF receipt download is unchanged for known orders', kind: 'negative' },
  { id: 'VAL-BRIN-2401-05', text: 'An order with no lines returns 200 with empty totals', kind: 'positive' },
  { id: 'VAL-BRIN-2401-06', text: 'Nothing is written to the database', kind: 'negative' },
];
const validation2401 = {
  'VAL-BRIN-2401-01': { status: 'pass', by: 'engineer', evidence: 'cmd-1712: 200 with 4 lines, totals match the order page', at: ago(2 * H) },
  'VAL-BRIN-2401-02': { status: 'pass', by: 'reviewer', evidence: 'cmd-1714: 404 {"detail": "Order not found"}', at: ago(90 * MIN) },
  'VAL-BRIN-2401-03': { status: 'pass', by: 'engineer', evidence: 'cmd-1715: 400 "order_id must be a number"', at: ago(2 * H) },
  'VAL-BRIN-2401-04': { status: 'pass', by: 'engineer', evidence: 'response-1716: PDF bytes identical for 3 orders', at: ago(2 * H) },
  'VAL-BRIN-2401-05': { status: 'untested', by: 'engineer', evidence: 'No dev order has zero lines; needs a seeded fixture', at: ago(2 * H) },
  'VAL-BRIN-2401-06': { status: 'pass', by: 'reviewer', evidence: 'review-1720: only SELECTs in the diff; read-only session', at: ago(90 * MIN) },
};

const diff2401 = `diff --git a/app/orders/routes.py b/app/orders/routes.py
index 3f2a1c0..9b7e2d4 100644
--- a/app/orders/routes.py
+++ b/app/orders/routes.py
@@ -112,4 +112,8 @@ router = APIRouter(prefix="/api/orders", tags=["orders"])
 @router.get("/{order_id}/receipt", dependencies=[Depends(require_scope("orders:read"))])
 async def order_receipt(order_id: str, db: AsyncSession = Depends(get_db)):
     """Receipt with line totals for one order."""
+    if not order_id.isdigit():
+        raise HTTPException(status_code=400, detail="order_id must be a number")
+    if not await order_exists(db, int(order_id)):
+        raise HTTPException(status_code=404, detail="Order not found")
     receipt = await build_receipt(db, int(order_id))
diff --git a/app/sql/order_exists.sql b/app/sql/order_exists.sql
new file mode 100644
index 0000000..77ad1f2
--- /dev/null
+++ b/app/sql/order_exists.sql
@@ -0,0 +1 @@
+SELECT 1 FROM orders WHERE id = :order_id LIMIT 1
`;

function tasks(): Record<string, Data> {
  return {
    'tasks/BRIN-2401': {
      title: 'Order receipts: 404 for unknown order ids', kind: 'ticket', source: 'jira', repo: 'brinewick-api', status: 'active', phase: 'approval', activity: 'waiting', waiting: 'you', difficulty: 'moderate',
      branch: 'BRIN-2401-receipt-404', cabin: 0, sessionId: 'eng-2401', jiraStatus: 'In Progress', goal: 'g-latency', startedAt: ago(5 * H), updatedAt: ago(20 * MIN), costUsd: 35.2,
      summary: 'Launch card up: 404 and 400 for bad order ids on the receipt endpoint, PDF download untouched.',
      spec: '**Goal.** The order receipt endpoint answers 500 for unknown or malformed order ids. Return 404 and 400 instead.\n\n**Acceptance.** Known ids unchanged; unknown ids 404; malformed ids 400; PDF download unchanged.\n\n**Code.** `app/orders/routes.py:order_receipt`, `app/sql/`.',
      contract: contract2401, validation: validation2401,
      receipts: { head: 'a3f9c2e17b4d8e6f0a1b2c3d4e5f60718293a4b5', tests: { status: 'pass', at: ago(2 * H) }, review: { status: 'concerns', at: ago(90 * MIN), head: 'a3f9c2e17b4d8e6f0a1b2c3d4e5f60718293a4b5', round: 2, findings: [{ id: 'F1', severity: 'minor', confidence: 5, title: 'order_exists runs a second query', state: 'open' }] } },
      agents: {
        scout: { status: 'done', result: 'KEEL_RESULT agent=scout key=BRIN-2401 status=DONE summary="2 related tickets, owner: orders team"', at: ago(5 * H) },
        engineer: { status: 'waiting', sessionId: 'eng-2401', sessionLink: 'https://claude.ai/code/session-2401', result: 'KEEL_RESULT agent=engineer key=BRIN-2401 status=DONE summary="launch card posted, 5/6 assertions pass, 1 untested with reason"' },
        reviewer: { status: 'done', round: 2, at: ago(90 * MIN), result: 'KEEL_RESULT agent=reviewer key=BRIN-2401 status=DONE_WITH_CONCERNS summary="1 minor open: extra existence query"' },
      },
    },
    'tasks/BRIN-2388': {
      title: 'Catalog: warm the product cache after deploy', kind: 'ticket', source: 'jira', repo: 'brinewick-api', status: 'active', phase: 'build', activity: 'working', difficulty: 'complex',
      branch: 'BRIN-2388-product-cache-warmup', cabin: 1, sessionId: 'eng-2388', startedAt: ago(3 * H), updatedAt: ago(4 * MIN), costUsd: 18.4,
      summary: 'Building the warmup job; plan approved by the Mate.',
      contract: [
        { id: 'VAL-BRIN-2388-01', text: 'The warmup job fills the product cache for the top 200 products', kind: 'positive' },
        { id: 'VAL-BRIN-2388-02', text: 'A cold product page after warmup is served from cache', kind: 'positive' },
        { id: 'VAL-BRIN-2388-03', text: 'The warmup never runs on the request path', kind: 'negative' },
        { id: 'VAL-BRIN-2388-04', text: 'A failing product does not stop the rest', kind: 'negative' },
      ],
      validation: { 'VAL-BRIN-2388-03': { status: 'pass', by: 'engineer', evidence: 'plan-1801: the job runs in the worker only', at: ago(H) } },
      agents: { scout: { status: 'done', result: 'DONE: cache keys owned by app/catalog/cache.py' }, engineer: { status: 'running', sessionId: 'eng-2388', result: '' } },
    },
    'tasks/BRIN-2405': {
      title: 'Shipping rates: retry the carrier API on 503', kind: 'ticket', source: 'jira', repo: 'brinewick-api', status: 'active', phase: 'review', activity: 'thinking', difficulty: 'simple',
      branch: 'BRIN-2405-carrier-retry-503', cabin: 2, sessionId: 'eng-2405', role: 'contractor', startedAt: ago(2 * H), updatedAt: ago(2 * MIN), costUsd: 9.1,
      summary: 'Reviewer round 1 running on the retry wrapper.',
      contract: [
        { id: 'VAL-BRIN-2405-01', text: 'A 503 is retried up to 3 times with backoff', kind: 'positive' },
        { id: 'VAL-BRIN-2405-02', text: 'A 400 is not retried', kind: 'negative' },
        { id: 'VAL-BRIN-2405-03', text: 'A label purchase is never sent twice after a timeout', kind: 'negative' },
      ],
      validation: {
        'VAL-BRIN-2405-01': { status: 'pass', by: 'engineer', evidence: 'cmd-2201: 3 retries logged, then success', at: ago(40 * MIN) },
        'VAL-BRIN-2405-02': { status: 'pass', by: 'engineer', evidence: 'cmd-2202: single call, error surfaced', at: ago(40 * MIN) },
        'VAL-BRIN-2405-03': { status: 'fail', by: 'engineer', evidence: 'cmd-2203: a timed-out label purchase was sent again', at: ago(30 * MIN) },
      },
      agents: { engineer: { status: 'running', sessionId: 'eng-2405', result: '' }, reviewer: { status: 'running', round: 1, result: '' } },
    },
    'tasks/BRIN-2350': {
      title: 'Cart: apply several coupon codes to one order', kind: 'ticket', source: 'jira', repo: 'brinewick-api', status: 'active', phase: 'build', activity: 'waiting', difficulty: 'complex',
      branch: 'BRIN-2350-cart-coupons', cabin: 3, sessionId: 'eng-2350', startedAt: ago(DAY), updatedAt: ago(35 * MIN), costUsd: 41.3,
      summary: 'Paused by crew policy after three denials in a row.',
      contract: [
        { id: 'VAL-BRIN-2350-01', text: 'Two coupons on one cart are applied in order, each to its own lines', kind: 'positive' },
        { id: 'VAL-BRIN-2350-02', text: 'An unknown coupon code returns 400', kind: 'negative' },
      ],
      validation: { 'VAL-BRIN-2350-01': { status: 'pass', by: 'engineer', evidence: 'cmd-1502: 6 mixed carts priced', at: ago(2 * H) } },
      agents: {
        engineer: {
          status: 'paused', paused: true, sessionId: 'eng-2350',
          denials: { consecutive: 3, total: 7, paused: true, reasons: ['git push origin HEAD:develop (protected branch)', 'psql -c "UPDATE coupons ..." (database write)', 'git push --force-with-lease (force-push)'] },
          result: 'KEEL_RESULT agent=engineer key=BRIN-2350 status=BLOCKED summary="paused by crew policy while trying to refresh test data"',
        },
      },
    },
    'tasks/BRIN-2374': {
      title: 'Orders export: CSV totals disagree with the table', kind: 'ticket', source: 'jira', repo: 'brinewick-api', status: 'qa', phase: 'qa', difficulty: 'moderate', jiraStatus: 'In QA',
      branch: 'BRIN-2374-orders-csv-totals', sessionId: 'eng-2374', prUrl: 'https://github.com/brinewick/brinewick-api/pull/103', startedAt: ago(3 * DAY), updatedAt: ago(50 * MIN), costUsd: 27.9,
      contract: [
        { id: 'VAL-BRIN-2374-01', text: 'CSV totals match the table for a filtered view', kind: 'positive' },
        { id: 'VAL-BRIN-2374-02', text: 'Currency columns keep two decimals', kind: 'positive' },
        { id: 'VAL-BRIN-2374-03', text: 'An empty filter exports headers only', kind: 'negative' },
        { id: 'VAL-BRIN-2374-04', text: 'Exports over 50k rows stream without a timeout', kind: 'positive' },
        { id: 'VAL-BRIN-2374-05', text: 'A user without orders access gets 403', kind: 'negative' },
      ],
      validation: {
        'VAL-BRIN-2374-01': { status: 'fail', by: 'qa', evidence: 'qa-3301-VAL-BRIN-2374-01: CSV 1,204 vs table 1,198', at: ago(55 * MIN) },
        'VAL-BRIN-2374-02': { status: 'pass', by: 'qa', evidence: 'qa-3302-VAL-BRIN-2374-02: 2 decimals', at: ago(55 * MIN) },
        'VAL-BRIN-2374-03': { status: 'pass', by: 'qa', evidence: 'qa-3303-VAL-BRIN-2374-03: headers only', at: ago(55 * MIN) },
        'VAL-BRIN-2374-04': { status: 'untested', by: 'qa', evidence: 'env: dev has 8k rows at most', at: ago(55 * MIN) },
        'VAL-BRIN-2374-05': { status: 'pass', by: 'qa', evidence: 'qa-3305-VAL-BRIN-2374-05: 403', at: ago(55 * MIN) },
      },
      agents: { engineer: { status: 'done', result: 'DONE: PR merged' }, qa: { status: 'waiting', verdict: 'FAIL', round: 2, at: ago(50 * MIN), result: 'KEEL_RESULT agent=qa key=BRIN-2374 status=DONE summary="FAIL 3/5: totals off by 6 on filtered views"' } },
    },
    'tasks/BRIN-2360': {
      title: 'Product search: pass the store locale through every handler', kind: 'ticket', source: 'jira', repo: 'brinewick-api', status: 'pr', phase: 'pr', difficulty: 'simple',
      branch: 'BRIN-2360-search-locale', sessionId: 'eng-2360', prUrl: 'https://github.com/brinewick/brinewick-api/pull/104', startedAt: ago(DAY + 4 * H), updatedAt: ago(70 * MIN), costUsd: 12.6,
      shepherd: { ci: 'failing: ruff B006', reviews: 'waiting on 1 reviewer', checkedAt: '10:15' },
      contract: [{ id: 'VAL-BRIN-2360-01', text: 'Every handler passes the store locale to ProductSearchIndex', kind: 'positive' }],
      validation: { 'VAL-BRIN-2360-01': { status: 'pass', by: 'reviewer', evidence: 'review-1610: grep shows 9 of 9 call sites', at: ago(DAY) } },
      agents: { engineer: { status: 'done', result: 'DONE: draft PR #104 open' }, reviewer: { status: 'done', result: 'DONE: no findings' } },
    },
    'tasks/T-14': {
      title: 'Release notes for 2026.10.16', kind: 'adhoc', source: 'board', status: 'active', phase: 'review', difficulty: 'simple', description: 'Write the release notes for Thursday from the merged PRs.', startedAt: ago(2 * H), updatedAt: ago(25 * MIN), costUsd: 3.4,
      agents: { writer: { status: 'waiting', result: 'KEEL_RESULT agent=writer key=T-14 status=DONE summary="draft card up for the Confluence page"' } },
    },
    'tasks/T-15': {
      title: 'Why did checkout p95 jump on Oct 13?', kind: 'adhoc', source: 'board', status: 'active', phase: 'build', difficulty: 'moderate', description: 'p95 went from 1.8 s to 4.1 s around 14:00.', startedAt: ago(70 * MIN), updatedAt: ago(3 * MIN), costUsd: 6.2,
      agents: { analyst: { status: 'running', result: '' } },
    },
    'tasks/BRIN-2399': { title: 'Reports API: paginate saved searches', kind: 'ticket', source: 'jira', status: 'proposed', difficulty: 'complex', createdAt: ago(5 * H), updatedAt: ago(5 * H) },
    'tasks/BRIN-2410': { title: 'Catalog: dedupe products by SKU', kind: 'ticket', source: 'jira', status: 'queued', difficulty: 'simple', createdAt: ago(3 * H), updatedAt: ago(3 * H) },
    'tasks/BRIN-2320': { title: 'Invoices: due date off by one month', kind: 'ticket', source: 'jira', status: 'done', difficulty: 'simple', startedAt: ago(2 * DAY), closedAt: ago(20 * H), updatedAt: ago(20 * H), costUsd: 8.8, prUrl: 'https://github.com/brinewick/brinewick-api/pull/102' },
    'tasks/BRIN-2333': { title: 'Reports: monthly sales sort by name', kind: 'ticket', source: 'jira', status: 'done', difficulty: 'moderate', startedAt: ago(4 * DAY), closedAt: ago(2 * DAY), updatedAt: ago(2 * DAY), costUsd: 21.0, reopened: true },
    'tasks/BRIN-2343': { title: 'Alerts: digest uses the captain’s timezone', kind: 'ticket', source: 'jira', status: 'done', difficulty: 'simple', startedAt: ago(DAY), closedAt: today(2 * H), updatedAt: today(2 * H), costUsd: 6.4, prUrl: 'https://github.com/brinewick/brinewick-api/pull/106' },
    'tasks/T-12': { title: 'Draft the Q4 crew retro deck outline', kind: 'adhoc', source: 'board', status: 'done', startedAt: ago(3 * DAY), closedAt: ago(3 * DAY - 2 * H), updatedAt: ago(3 * DAY), costUsd: 2.1 },
  };
}

function evidence(): Record<string, Data> {
  const k = 'tasks/BRIN-2401/evidence';
  return {
    [`${k}/scout-1`]: { kind: 'context', agent: 'scout', title: 'Context · BRIN-2401', createdAt: ago(5 * H), content: '**Related.** BRIN-2142 added the receipt route; BRIN-2211 fixed the same 500 on the PDF download.\n\n**Owners.** Orders team; last touched by Jordan two weeks ago.\n\n**Open question.** Should orders with no lines 404 or return empty totals? The PDF download returns empty totals.' },
    [`${k}/plan-1`]: { kind: 'plan', agent: 'engineer', title: 'Plan · root cause', createdAt: ago(4 * H), content: '**Root cause.** `order_receipt` passes `int(order_id)` straight to `build_receipt` (`app/orders/routes.py:115`), so a non-numeric id raises ValueError (500) and an unknown id yields no rows, which `build_receipt` indexes (`app/orders/receipts.py:64`, IndexError, 500).\n\n**Change.** Validate the id, check existence with one indexed SELECT, raise HTTPException 400/404.' },
    [`${k}/cmd-1712`]: { kind: 'command', agent: 'engineer', title: 'curl known id', createdAt: ago(2 * H), content: 'curl -s localhost:4101/api/orders/1182/receipt\n200 {"data": {"lines": 4, "subtotal": 312.00, "total": 337.96}}' },
    [`${k}/cmd-1714`]: { kind: 'command', agent: 'reviewer', title: 'curl unknown id', createdAt: ago(90 * MIN), content: 'curl -s localhost:4101/api/orders/99999999/receipt\n404 {"detail": "Order not found"}' },
    [`${k}/walkthrough-1`]: {
      kind: 'walkthrough', agent: 'reviewer', title: 'Walkthrough · a3f9c2e', createdAt: ago(90 * MIN),
      content: { groups: [
        { intent: 'Existence check before building the receipt', files: ['app/orders/routes.py:117-118', 'app/sql/order_exists.sql:1'], notes: 'One extra indexed SELECT per request. Open minor finding: it could fold into the receipt query.', severity: 'minor' },
        { intent: '400 for non-numeric ids', files: ['app/orders/routes.py:115-116'], notes: 'str.isdigit() rejects negatives too, which is what the contract wants.', severity: 'none' },
      ] },
    },
    [`${k}/review-1`]: { kind: 'review', agent: 'reviewer', title: 'Review round 2 · a3f9c2e', createdAt: ago(90 * MIN), content: '**F1 · minor · confidence 5.** `order_exists` adds a second query. Fold it into the receipt query if p95 matters here.' },
    [`${k}/handoff-1`]: { kind: 'handoff', agent: 'engineer', title: 'Handoff · approval', createdAt: ago(25 * MIN), content: { state: 'Branch BRIN-2401-receipt-404 at a3f9c2e, lint and 5 of 6 assertions pass; launch card posted.', decisions: ['Left the PDF download untouched (VAL-04).', 'Used HTTPException for both errors, as the repo does.'], deadEnds: ['Catching ValueError in build_receipt hid other bugs; reverted.'], next: 'Wait for the captain’s ship choice, then run pre-pr-checks and open the PR.', questions: ['Orders with no lines: 404 or empty totals? (asked the Mate)'] } },
    [`${k}/eval-1`]: { kind: 'note', agent: 'learner', title: 'Eval case · reviewer missed a 500 on malformed ids', tags: ['eval-case'], createdAt: ago(3 * H), content: 'Round 1 review passed VAL-03 without a negative check; QA would have caught it.' },
  };
}

function inbox(): Record<string, Data> {
  return {
    'inbox/q-crew-paused-2350': {
      kind: 'question', from: 'lead', taskKey: 'BRIN-2350', urgent: true, status: 'open', createdAt: ago(30 * MIN), sessionId: 'lead-1',
      title: 'The engineer on BRIN-2350 was paused after 5 denials',
      summary: 'Crew policy paused it while it tried to push to `develop`, run a database UPDATE and force-push. It looks like it wanted fresh test data for the coupon fixtures.',
      recommendation: 'Unpause it, and I’ll tell it to load fixtures from the read-only dev copy instead.',
      options: ['Unpause it', 'Stop it', 'I’ll look'],
    },
    'inbox/ship-BRIN-2401-1': {
      kind: 'ship', from: 'engineer', taskKey: 'BRIN-2401', sessionId: 'eng-2401', title: 'Push & PR · BRIN-2401', status: 'open', createdAt: ago(22 * MIN),
      body: 'High risk: expand the diff before approving. The order receipt endpoint now returns 400 for malformed and 404 for unknown order ids instead of 500. PDF download untouched.',
      diffstat: ' app/orders/routes.py     | 4 ++++\n app/sql/order_exists.sql | 1 +\n 2 files changed, 5 insertions(+)',
      checks: [{ name: 'ruff (CI set)', status: 'pass' }, { name: 'pre-pr-checks', status: 'pass', detail: '12 of 12, 2 with notes' }, { name: 'endpoint calls on dev', status: 'pass', detail: '5 calls' }],
      receipts: { head: 'a3f9c2e17b4d8e6f0a1b2c3d4e5f60718293a4b5', tests: { status: 'pass', at: ago(2 * H) }, review: { status: 'concerns', at: ago(90 * MIN), head: 'a3f9c2e17b4d8e6f0a1b2c3d4e5f60718293a4b5', round: 2, findings: [{ id: 'F1', state: 'open' }] } },
      risk: { tier: 'high', reasons: ['raw SQL files', 'auth-adjacent route'], files: 2, added: 5, deleted: 0 },
      riskNotes: { 'raw SQL files': 'one SELECT on an indexed primary key, with a bound parameter; the id is validated as digits first', 'auth-adjacent route': 'the route keeps its require_scope("orders:read") dependency, which still runs first' },
      validation: validation2401, walkthroughId: 'walkthrough-1', notes: 'Run nothing by hand: no migrations, no settings.',
    },
    'inbox/qa-BRIN-2374-2': {
      kind: 'qa', from: 'qa', taskKey: 'BRIN-2374', sessionId: 'qa-2374', title: 'QA · BRIN-2374: FAIL 3/5', verdict: 'FAIL', url: 'https://qa.brinewick.test/orders/export', head: '7c21de4a90b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5', round: 2, status: 'open', createdAt: ago(50 * MIN),
      summary: 'Filtered exports still disagree with the table by 6 rows (deduplication runs after the totals). Empty filters and access checks pass.',
      cases: [
        { id: 'VAL-BRIN-2374-01', ac: 'CSV totals match the table for a filtered view', verdict: 'fail', expected: '1,198 rows', actual: '1,204 rows', note: 'Duplicate order ids counted twice', evidenceId: 'qa-3301-VAL-BRIN-2374-01', screenshot: '~/.keelcrew/work/qa-brin-2374/01-fail.png' },
        { id: 'VAL-BRIN-2374-02', ac: 'Currency columns keep two decimals', verdict: 'pass', evidenceId: 'qa-3302-VAL-BRIN-2374-02' },
        { id: 'VAL-BRIN-2374-03', ac: 'An empty filter exports headers only', verdict: 'flaky', note: 'First load timed out at 30 s; passed on retry' },
        { id: 'VAL-BRIN-2374-04', ac: 'Exports over 50k rows stream', verdict: 'env', note: 'Dev has 8k rows at most' },
        { id: 'VAL-BRIN-2374-05', ac: 'No orders access gets 403', verdict: 'pass', evidenceId: 'qa-3305-VAL-BRIN-2374-05' },
      ],
      flakeRate: 0.08, recommendation: 'Keep fixing: the engineer has the exact repro.',
      draft: { channel: 'jira-comment', destination: 'BRIN-2374', body: 'QA round 2 on 7c21de4: FAIL 3/5.\n- VAL-01 fails: filtered CSV 1,204 rows vs table 1,198 (duplicate order ids).\n- VAL-04 untested: dev has 8k rows.\nBack with the engineer.' },
      post: { tool: 'mcp__atlassian__addCommentToJiraIssue', match: 'BRIN-2374' },
      options: ['Keep fixing', 'Accept anyway', 'Stop QA'],
    },
    'inbox/draft-T-14-1': {
      kind: 'question', from: 'writer', taskKey: 'T-14', sessionId: 'writer-14', title: 'Draft · Release notes 2026.10.16 → Confluence', status: 'open', createdAt: ago(25 * MIN),
      summary: 'Seven merged PRs grouped by product area, with the two API changes called out for the frontend team.',
      recommendation: 'Post it: it only updates the existing release page.',
      draft: { channel: 'confluence', destination: 'Releases / 2026.10.16', mode: 'update', subject: 'Release 2026.10.16', body: '## Orders\n- Order receipts return 404 for unknown order ids (BRIN-2401)\n- The product cache warms after deploy (BRIN-2388)\n\n## Invoices\n- Due dates no longer shift by a month (BRIN-2320)\n\n## Platform\n- Shipping rates retry the carrier API on 503 (BRIN-2405)\n- Product search uses the store locale everywhere (BRIN-2360)\n\n## For the frontend team\n- Receipt errors now carry `detail`\n- Product search takes a `locale` parameter\n\n## Known issues\n- Orders CSV totals on filtered views (BRIN-2374, in QA)' },
      post: { tool: 'mcp__atlassian__updateConfluenceContent', match: '1000001' },
      options: ['Post it', 'Change it', 'Drop it'],
    },
    'inbox/q-batch-20261015-1130': {
      kind: 'question', from: 'lead', batch: true, title: '3 questions', status: 'open', createdAt: ago(2 * H + 10 * MIN),
      items: [
        { id: 'q1', title: 'Orders with no lines on receipts: 404 or empty totals?', taskKey: 'BRIN-2401', summary: 'The PDF download returns empty totals. The ticket says “404 for missing orders”.', recommendation: 'Empty totals, to match the PDF.', options: ['Empty totals', '404'], answer: 'Empty totals', answeredAt: ago(H) },
        { id: 'q2', title: 'Split BRIN-2399 into API and UI tasks?', taskKey: 'BRIN-2399', summary: 'The plan touches 19 files across two areas; the scope limit is 15.', recommendation: 'Split: API first.', options: ['Split it', 'Keep it whole'] },
        { id: 'q3', title: 'Turn on the PR monitor for new crew PRs?', summary: 'It auto-fixes CI failures, conflicts and review comments.', options: ['Turn it on', 'Leave it off'] },
      ],
    },
    'inbox/proposal-suggest-a1-1': {
      kind: 'proposal', from: 'suggest', source: 'errors', impact: 'medium', title: 'Fix KeyError in the catalog export', status: 'open', createdAt: ago(14 * H),
      summary: '37 production 500s in 7 days, all `KeyError: "billing_address"` from one code path.',
      rationale: 'One missing dict key on customers without a billing address; a one-line default fixes it and nothing else touches that path.', confidence: 0.82, fingerprint: 'suggest:errors:/api/catalog/export:KeyError',
      recommendation: 'Start it: simple, one file.', options: ['Start it', 'File a ticket', 'Not now', 'Skip it'], neverAskKey: 'suggest:errors:/api/catalog/export:KeyError',
      proposal: { title: 'catalog export: default billing_address', repo: 'brinewick-api', difficulty: 'simple', description: '`app/catalog/export.py:212` reads `row["billing_address"]`; customers without a billing address omit the key. Use `.get("billing_address")` and render it empty.' },
    },
    'inbox/proposal-suggest-b2-1': {
      kind: 'proposal', from: 'suggest', source: 'perf', impact: 'high', title: '500s · /api/orders/search (12 in 24 h)', status: 'open', createdAt: ago(9 * H),
      summary: 'Timeouts at 30 s on the read-only connection for broad product filters; the plan shows a sequential scan on order_items.',
      recommendation: 'Start it as complex: needs an index proposal reviewed.', options: ['Start it', 'File a ticket', 'Not now', 'Skip it'], fingerprint: 'suggest:perf:orders.search:QueryCanceled',
      proposal: { title: 'orders search: avoid seq scan on order_items', repo: 'brinewick-api', difficulty: 'complex', description: 'Group: QueryCanceled after 30 s. Plan: Seq Scan on order_items (cost 1.2M). Fix: push the product filter into the CTE and use the existing (product_id, created_at) index.' },
    },
    'inbox/start-catalog-export': {
      kind: 'start', from: 'lead', title: 'Start a session: catalog export KeyError', status: 'open', createdAt: ago(3 * MIN),
      summary: 'An engineer to default `billing_address` in the catalog export.',
      options: ['Not now'], start: { proposal: 'task_catalog_export_keyerror', model: 'claude-opus-5-5', effort: 'xhigh' },
    },
    'inbox/start-BRIN-2410': {
      kind: 'start', from: 'lead', taskKey: 'BRIN-2410', title: 'Start BRIN-2410 dedupe products', status: 'open', createdAt: ago(2 * MIN),
      body: 'The engineer dedupes catalog products by SKU.', options: ['Not now'], start: { proposal: 'task_crew_brin_2410', model: 'claude-opus-5-5', effort: 'high' },
    },
    'inbox/playbook-2026-10-14': {
      kind: 'playbook', from: 'learner', title: 'Standing order changes · 3', status: 'open', createdAt: ago(13 * H),
      summary: 'Three candidates from yesterday: commit message length, HTTPException for 4xx, and asking before touching migrations.',
      lessons: [
        { key: 'commit-msg-short', text: 'Keep commit messages to 3-4 words.', status: 'candidate', scope: { repo: 'brinewick-api' }, evidence: [{ source: 'pr-review', ref: 'https://github.com/brinewick/brinewick-api/pull/102#r1' }, { source: 'edit', ref: 'c7d1e02' }] },
        { key: 'http-exception-4xx', text: 'Raise HTTPException with a user-facing detail for every 4xx.', status: 'candidate', scope: { repo: 'brinewick-api', agent: 'engineer' }, evidence: [{ source: 'card', ref: 'ship-BRIN-2320-1' }] },
        { key: 'ask-before-migrations', text: 'Ask the Mate before generating a migration.', status: 'candidate', scope: { agent: 'engineer' }, evidence: [{ source: 'chat', ref: 'c-881', quote: 'never generate migrations without asking' }] },
      ],
      diff: '@@ Style @@\n+ Keep commit messages to 3-4 words.\n@@ Repo facts: brinewick-api @@\n+ Raise HTTPException with a user-facing detail for every 4xx.\n- Return a bare JSONResponse(status_code=400) for bad input.\n@@ Process @@\n+ Ask the Mate before generating a migration.',
      recommendation: 'Approve all three.', options: ['Approve', 'Not now'],
      commands: { Approve: ['keelctl memory promote commit-msg-short', 'keelctl memory promote http-exception-4xx', 'keelctl memory promote ask-before-migrations', 'keelctl memory approve'] },
    },
    'inbox/conflict-tests-1': {
      kind: 'conflict', from: 'learner', title: 'Which rule holds: running the e2e suite before the launch card?', status: 'open', createdAt: ago(12 * H),
      summary: 'An active lesson says skip the e2e suite (it’s flaky); a new review comment asks for an e2e run on every PR.',
      lessons: [
        { key: 'skip-e2e', text: 'Don’t run the e2e suite in brinewick-web; run the unit tests and check the page in the browser.', type: 'repo-fact', confidence: 0.9, evidence: [{ source: 'owner', ref: 'c-412', quote: 'e2e is flaky, check the page yourself' }] },
        { key: 'e2e-every-pr', text: 'Run the e2e suite before every PR.', type: 'process', confidence: 0.75, evidence: [{ source: 'pr-review', ref: 'https://github.com/brinewick/brinewick-web/pull/58#r9' }] },
      ],
      recommendation: 'Keep the old one: the e2e suite still needs a seeded staging account.', options: ['Keep the old one', 'Keep the new one', 'Keep both, scoped', 'Neither'],
      commands: { 'Keep the old one': ['keelctl memory forget e2e-every-pr'], 'Keep the new one': ['keelctl memory forget skip-e2e', 'keelctl memory promote e2e-every-pr'] },
    },
    'inbox/comms-1': {
      kind: 'question', from: 'comms', title: 'Inbox · 3 need you (1 due today)', status: 'open', createdAt: ago(4 * H),
      summary: 'Mia asks for the QA env date; Lee wants a review on PR #105; the release sync moved to 16:00.',
      items: [
        { id: 'm1', channel: 'teams-chat', from: 'Mia Example', subject: 'QA env for the orders fix', ask: 'When will qa.brinewick.test have the orders fix?', due: 'today', draft: 'Hi Mia, the fix is on qa.brinewick.test now; QA found one more filtered-view mismatch, so expect a new build tomorrow morning.', link: 'https://teams.microsoft.com/l/message/1' },
        { id: 'm2', channel: 'email', from: 'Lee Example', subject: 'Review request: PR #105', ask: 'Can you review the reports pagination PR?', due: 'Fri', draft: 'Sure, I’ll look at it this afternoon.', post: { tool: 'Bash', match: 'pulls/105/reviews' }, options: ['Post it', 'Skip'] },
        { id: 'm3', channel: 'teams-channel', from: 'Release', subject: 'Release sync moved to 16:00', ask: 'FYI', due: '' },
      ],
      notes: '1. **Mia Example** (Teams): QA env date, due today.\n2. **Lee Example** (email): review PR #105 by Friday.\n3. **Release** (channel): sync at 16:00.',
      recommendation: 'Got it: the two replies are drafted.', options: ['Got it', 'Track the asks as tasks', 'Redraft'],
    },
    'inbox/q-BRIN-2388-eng': {
      kind: 'question', from: 'engineer', taskKey: 'BRIN-2388', title: 'Warm 200 or 500 products?', status: 'open', createdAt: ago(40 * MIN),
      summary: 'The spec says top 200; the cache has room for 500 at the same cost.', options: ['200', '500'], recommendation: '200, as specified.',
    },
    'inbox/proposal-BRIN-2399': {
      kind: 'proposal', from: 'lead', taskKey: 'BRIN-2399', title: 'Start BRIN-2399: paginate saved searches?', status: 'open', createdAt: ago(5 * H),
      summary: 'Complex: 19 files across the reports API and its response models. I’d split it (see the batch question).', options: ['Start it', 'Not now', 'Skip it'],
    },
    'inbox/ship-BRIN-2360-1': {
      kind: 'ship', from: 'engineer', taskKey: 'BRIN-2360', title: 'Push & PR · BRIN-2360', status: 'approved', answer: 'Draft PR', createdAt: ago(DAY), resolvedAt: ago(DAY - 20 * MIN),
      risk: { tier: 'low', reasons: [] }, receipts: { head: '1e2d3c4b5a6978f0e1d2c3b4a5968778695a4b3c' },
    },
    'inbox/ship-BRIN-2401-0': {
      kind: 'ship', from: 'engineer', taskKey: 'BRIN-2401', title: 'Push & PR · BRIN-2401', status: 'dismissed', withdrawn: 'review receipt was for an older head', createdAt: ago(3 * H), resolvedAt: ago(170 * MIN), handledAt: ago(170 * MIN),
    },
    'inbox/q-crew-models': {
      kind: 'question', from: 'lead', title: 'Use Sonnet for the Jira scan?', status: 'answered', answer: 'Keep Opus', createdAt: ago(6 * H), resolvedAt: ago(5 * H),
    },
  };
}

function chat(): Record<string, Data> {
  const lines: [number, string, string, string?][] = [
    [ago(26 * H), 'lead', 'Morning brief\n- **Done:** BRIN-2320 ($8.80 · 5 captain-min)\n- **In flight:** 2401 review, 2388 build, 2350 build\n- **Waiting on you:** 1 launch card, 1 proposal'],
    [ago(3 * H), 'me', 'Start the release notes for Thursday please'],
    [ago(3 * H - MIN), 'lead', 'Started T-14 with the writer. The draft lands on Sign-offs as a card; nothing posts until you approve it.', 'T-14'],
    [ago(70 * MIN), 'me', 'Can someone look at why checkout p95 jumped on the 13th?'],
    [ago(69 * MIN), 'lead', 'T-15 is with the analyst, read-only on prod. I’ll post the report here.', 'T-15'],
    [ago(30 * MIN), 'lead', 'Heads up: the engineer on BRIN-2350 was paused by crew policy after 5 denials. The card is on Sign-offs (urgent).', 'BRIN-2350'],
    [ago(4 * MIN), 'lead', 'BRIN-2399 touches 19 files. Want me to split it into API and UI tasks?', 'BRIN-2399'],
  ];
  const out: Record<string, Data> = {};
  lines.forEach(([ts, who, text, taskKey], i) => (out[`chat/c${i}`] = { who, text, ts, ...(taskKey ? { taskKey } : {}) }));
  out['chat/brief-retro-2026-10-09'] = {
    who: 'lead', ts: ago(6 * DAY), text: 'Full retro for week 41.',
    retro: { week: '2026-W41', metrics: { 'tasks finished': { thisWeek: 9, lastWeek: 6, change: '+3' }, 'median cycle': { thisWeek: '7.5 h', lastWeek: '9.1 h', change: '−1.6 h' }, 'captain-minutes per task': { thisWeek: 11, lastWeek: 14, change: '−3' } }, recommendations: ['Batch questions into two windows', { text: 'Smaller PRs for schema migrations', status: 'partial' }] },
  };
  return out;
}

function crewDocs(): Record<string, Data> {
  return {
    'settings/main': {
      maxWorkers: 4, workingHours: { start: '09:30' }, intake: { jiraSite: 'https://example.atlassian.net', autoStartMaxDifficulty: 'moderate', skipKeys: ['BRIN-2211'] },
      budgets: { perTicketUsd: 40, perRoleUsd: { engineer: 30, reviewer: 8, qa: 10, analyst: 15, writer: 6 } }, questionWindows: ['11:30', '16:30'],
      agents: { comms: { enabled: true }, suggest: { enabled: true } }, updatedAt: ago(2 * DAY),
      merges: { autoStatus: true },
      org: { goals: [{ id: 'g-latency', title: 'p95 under 2 s on checkout', metric: 'p95 latency', target: '2 s', weight: 2 }], models: { approved: { qa: { model: 'claude-sonnet-5-5', effort: 'high' } } } },
    },
    'crew/lead': { status: 'working', heartbeatAt: ago(MIN), sessionId: 'lead-1', sessionLink: 'https://claude.ai/code/lead', heldQuestions: [{ title: 'Rename the flag?' }, { title: 'Ship before Friday?' }] },
    'crew/usage': { status: 'allowed', fiveHour: { utilization: 0.46, resetsAt: now + 2 * H + 10 * MIN }, sevenDay: { utilization: 0.71, resetsAt: now + 3 * DAY }, updatedAt: ago(MIN) },
    'crew/schedules': {
      items: [
        { id: 'keel-scan', agent: 'scan', label: 'Jira scan', cadence: 'every 30 min, weekdays 9:00-18:30', enabled: true, lastRun: ago(12 * MIN), nextRun: now + 18 * MIN, lastResult: 'KEEL_RESULT agent=scan key=- status=DONE summary="2 new, 1 reopened flag cleared"' },
        { id: 'keel-brief-morning', agent: 'briefs', label: 'Morning brief', cadence: 'weekdays 9:30', enabled: true, lastRun: ago(4 * H), nextRun: now + 20 * H, lastResult: 'DONE: morning brief posted' },
        { id: 'keel-shepherd', agent: 'shepherd', label: 'PR shepherd', cadence: 'every 2 h, weekdays', enabled: true, lastRun: ago(70 * MIN), nextRun: now + 50 * MIN, lastResult: 'DONE_WITH_CONCERNS: PR #104 CI failing (ruff B006); engineer woken', openIssues: { 'ci:1e2d3c4:ruff': ago(70 * MIN) } },
        { id: 'keel-health', agent: 'health', label: 'Health check', cadence: 'hourly at :05', enabled: true, lastRun: ago(40 * MIN), nextRun: now + 20 * MIN, lastResult: 'BLOCKED: crew_state unreachable for 2 runs', openIssues: { 'budget:BRIN-2350': ago(3 * H), 'paused:BRIN-2350': ago(35 * MIN) }, handoff: { state: 'Two runs could not reach the helper.', decisions: [], deadEnds: ['Retried crew_state 3 times'], next: 'Restart the Claude app if the helper stays down', questions: [] } },
        { id: 'keel-learner', agent: 'learner', label: 'Learner', cadence: 'weekdays 21:00', enabled: true, lastRun: ago(13 * H), nextRun: now + 11 * H, lastResult: 'DONE: +3 candidates, 2 evidence, 1 missed signal, 1 conflict, standing-orders card yes' },
        { id: 'keel-comms', agent: 'comms', label: 'Comms digest', cadence: 'weekdays 9:15, 13:15, 17:15', enabled: true, lastRun: ago(4 * H), nextRun: now + H, lastResult: 'DONE: 3 threads, 2 drafts' },
        { id: 'keel-suggest', agent: 'suggest', label: 'Suggested tasks', cadence: 'weekdays 9:00 and 18:00', enabled: true, lastRun: ago(14 * H), nextRun: now + 10 * H, lastResult: 'DONE: 1 proposal (errors); KeyError in catalog export' },
        { id: 'keel-release', agent: 'release', label: 'Release captain', cadence: 'Thursdays 10:00', enabled: false, lastRun: null, nextRun: null, lastResult: '' },
      ],
    },
    'requests/r-task-1': { kind: 'task', text: 'Draft a Teams reply to Mia about the QA env date', status: 'open', at: ago(3 * MIN) },
    'decisions/d1': { topic: 'never-ask:pr-monitor', decision: 'Leave it off', source: 'q-crew-31', createdAt: ago(8 * DAY) },
    'decisions/d2': { topic: 'writer:auto-post:jira-comment', decision: 'Post QA notes to Jira without asking', scope: { agent: 'qa' }, createdAt: ago(5 * DAY) },
  };
}

export function seed(): Record<string, Data> {
  return { ...tasks(), ...evidence(), ...inbox(), ...chat(), ...crewDocs() };
}

/**
 * A busy board for performance checks: the example crew plus `tasks` more tasks (most finished, some open) and
 * `chat` more chat lines, with a handful of open cards on the new tasks.
 */
export function bigSeed(nTasks = 300, nChat = 1000): Record<string, Data> {
  const out = seed();
  const statuses = ['done', 'done', 'done', 'cancelled', 'queued', 'proposed', 'active', 'pr', 'qa', 'parked'];
  for (let i = 0; i < nTasks; i++) {
    const key = `PERF-${1000 + i}`;
    const status = statuses[i % statuses.length];
    const closed = status === 'done' || status === 'cancelled';
    out[`tasks/${key}`] = {
      title: `Perf task ${i}: ${['tune the reports query', 'add order filters', 'fix a flaky export', 'paginate saved searches'][i % 4]}`, kind: 'ticket', source: 'jira', repo: 'brinewick-api', status,
      phase: ['spec', 'plan', 'build', 'verify', 'review'][i % 5], difficulty: ['simple', 'moderate', 'complex'][i % 3], createdAt: ago((i + 1) * H), updatedAt: ago(i * 7 * MIN),
      ...(closed ? { closedAt: ago(i * 37 * MIN), startedAt: ago((i + 3) * H) } : {}), summary: `Step ${i % 9} of the plan.`,
    };
    if (i % 25 === 0 && !closed) out[`inbox/perf-q-${i}`] = { kind: 'question', from: 'lead', taskKey: key, title: `Question about ${key}`, status: 'open', createdAt: ago(i * MIN), summary: 'Pick one.', options: ['A', 'B'] };
  }
  for (let i = 0; i < nChat; i++) out[`chat/perf-${String(i).padStart(4, '0')}`] = { who: i % 3 ? 'lead' : 'me', text: `Line ${i}: ${'status update '.repeat(1 + (i % 5))}`, ts: ago((nChat - i) * 3 * MIN) };
  return out;
}

/**
 * The example crew with `engineers` engineers at work in all (`?crew=24`): extra active tickets, each with an engineer
 * in some state, for checking a full engineering hall.
 */
export function crowdSeed(engineers = 24): Record<string, Data> {
  const out = seed();
  const have = Object.values(out).filter((d) => d.status === 'active' && (d.agents as Data | undefined)?.engineer).length + 1;
  const titles = ['tune the reports query', 'add order filters', 'fix a flaky export', 'paginate saved searches', 'cache the category facet', 'dedupe customers'];
  const acts = ['working', 'working', 'thinking', 'working', 'waiting', 'working'];
  for (let i = 0; i < Math.max(0, engineers - have); i++) {
    const key = `BRIN-${2500 + i}`;
    out[`tasks/${key}`] = {
      title: `Crowd ${i + 1}: ${titles[i % titles.length]}`, kind: 'ticket', source: 'jira', repo: 'brinewick-api', status: 'active', phase: ['plan', 'build', 'verify', 'review'][i % 4], activity: acts[i % acts.length],
      difficulty: 'moderate', createdAt: ago((i + 2) * H), startedAt: ago((i + 1) * H), updatedAt: ago(i * 3 * MIN), costUsd: 2 + i, agents: { engineer: { status: i % 9 === 4 ? 'blocked' : 'running', result: '' } },
    };
  }
  return out;
}

/* ---------- the helper ---------- */

const member = (p: Data): Data & { key?: unknown; agent?: unknown; role: unknown; costUsd: unknown; tokens: unknown } => ({ key: null, role: 'engineer', agent: 'engineer', busy: false, activity: 'idle', lastAt: ago(10 * MIN), aliveAt: ago(MIN), repo: 'brinewick-api', contextTokens: 61_000, contextMax: 200_000, costUsd: 5, tokens: 400_000, model: 'claude-opus-5-5', turns: 30, ...p });

const MEMBERS = [
  member({ dir: '/Users/sam/lead', role: 'lead', agent: null, key: null, sessionId: 'lead-1', busy: true, activity: 'thinking', lastAt: ago(20_000), lastText: 'Reading the BRIN-2350 denials', costUsd: 11.4, contextTokens: 128_000 }),
  member({ dir: '/w/2401', key: 'BRIN-2401', sessionId: 'eng-2401', activity: 'waiting', lastAt: ago(20 * MIN), lastText: 'Launch card posted', costUsd: 30.1, contextTokens: 151_000 }),
  member({ dir: '/w/2388', key: 'BRIN-2388', sessionId: 'eng-2388', busy: true, activity: 'typing', lastAt: ago(15_000), lastTool: 'Edit', lastText: 'app/catalog/cache.py: warm_product_cache()', costUsd: 16.9 }),
  member({ dir: '/w/2405', key: 'BRIN-2405', sessionId: 'eng-2405', busy: true, activity: 'thinking', lastAt: ago(30_000), lastText: 'Why is a timed-out label purchase sent again?', costUsd: 7.8 }),
  member({ dir: '/w/2350', key: 'BRIN-2350', sessionId: 'eng-2350', paused: true, activity: 'idle', lastAt: ago(35 * MIN), lastText: 'Denied: git push origin HEAD:develop', costUsd: 41.3, contextTokens: 176_000 }),
  member({ dir: '/c/work/analyst-t-15', role: 'agent', agent: 'analyst', key: 'T-15', sessionId: 'an-15', busy: true, activity: 'reading', lastAt: ago(40_000), lastTool: 'mcp__brinewick-db-prod__query', lastText: 'EXPLAIN ANALYZE on the checkout totals query', costUsd: 6.2 }),
  member({ dir: '/c/work/writer-t-14', role: 'agent', agent: 'writer', key: 'T-14', sessionId: 'wr-14', activity: 'idle', lastAt: ago(25 * MIN), costUsd: 3.4 }),
  member({ dir: '/c/work/qa-2374', role: 'agent', agent: 'qa', key: 'BRIN-2374', sessionId: 'qa-2374', activity: 'idle', lastAt: ago(50 * MIN), costUsd: 9.6 }),
  member({ dir: '/c/jobs/shepherd', role: 'job', agent: 'shepherd', key: null, sessionId: 'job-sh', busy: true, activity: 'terminal', lastAt: ago(25_000), lastTool: 'Bash', lastText: 'gh pr checks 104', costUsd: 0.6 }),
  member({ dir: '/c/jobs/reviewer-2405', role: 'agent', agent: 'reviewer', key: 'BRIN-2405', sessionId: 'rv-2405', busy: true, activity: 'reading', lastAt: ago(50_000), costUsd: 4.1 }),
];

function costs() {
  const tickets: Record<string, { costUsd: number; tokens: number; byRole: Record<string, number> }> = {};
  const roles: Record<string, { costUsd: number; tokens: number }> = {};
  for (const m of MEMBERS) {
    const role = (m.agent as string | null) ?? (m.role as string);
    roles[role] = { costUsd: Math.round(((roles[role]?.costUsd ?? 0) + (m.costUsd as number)) * 100) / 100, tokens: (roles[role]?.tokens ?? 0) + (m.tokens as number) };
    if (!m.key) continue;
    const t = (tickets[m.key as string] ??= { costUsd: 0, tokens: 0, byRole: {} });
    t.costUsd = Math.round((t.costUsd + (m.costUsd as number)) * 100) / 100;
    t.tokens += m.tokens as number;
    t.byRole[role] = (t.byRole[role] ?? 0) + (m.costUsd as number);
  }
  tickets['BRIN-2401'].costUsd = 35.2;
  tickets['BRIN-2401'].byRole.reviewer = 5.1;
  return { now, members: MEMBERS.map((m) => ({ key: m.key, agent: m.agent, role: m.role, costUsd: m.costUsd, tokens: m.tokens, since: ago(6 * H) })), tickets, roles, totalUsd: MEMBERS.reduce((a, m) => a + (m.costUsd as number), 0) };
}

const LESSONS = [
  { key: 'commit-msg-short', type: 'style', text: 'Keep commit messages to 3-4 words.', status: 'candidate', confidence: 0.6, scope: { repo: 'brinewick-api' }, at: ago(13 * H), evidence: [{ source: 'pr-review', ref: 'https://github.com/brinewick/brinewick-api/pull/102#r1' }] },
  { key: 'http-exception-4xx', type: 'repo-fact', text: 'Raise HTTPException with a user-facing detail for every 4xx.', status: 'candidate', confidence: 0.75, scope: { repo: 'brinewick-api', agent: 'engineer' }, at: ago(13 * H), evidence: [{ source: 'card', ref: 'ship-BRIN-2320-1' }] },
  { key: 'ask-before-migrations', type: 'process', text: 'Ask the Mate before generating a migration.', status: 'candidate', confidence: 0.9, scope: { agent: 'engineer' }, at: ago(13 * H), evidence: [{ source: 'chat', ref: 'c-881', quote: 'never generate migrations without asking' }] },
  { key: 'skip-e2e', type: 'repo-fact', text: 'Don’t run the e2e suite in brinewick-web; run the unit tests and check the page in the browser.', status: 'pinned', confidence: 0.9, scope: { repo: 'brinewick-web' }, at: ago(20 * DAY), evidence: [{ source: 'owner', ref: 'c-412', quote: 'e2e is flaky, check the page yourself' }] },
  { key: 'draft-pr-default', type: 'preference', text: 'Open crew PRs as drafts unless the card says otherwise.', status: 'active', confidence: 0.85, scope: {}, at: ago(9 * DAY), evidence: [{ source: 'card', ref: 'ship-BRIN-2360-1' }, { source: 'card', ref: 'ship-BRIN-2320-1' }] },
  { key: 'money-type', type: 'repo-fact', text: 'Use the Money type for every currency field in API responses.', status: 'active', confidence: 0.8, scope: { repo: 'brinewick-api' }, at: ago(12 * DAY), evidence: [{ source: 'pr-review', ref: 'https://github.com/brinewick/brinewick-api/pull/101#r4' }] },
  { key: 'brief-short', type: 'preference', text: 'Keep chat replies to 2-4 lines.', status: 'pinned', confidence: 0.95, scope: { agent: 'lead' }, at: ago(30 * DAY), evidence: [{ source: 'owner', ref: 'c-101', quote: 'terse please' }] },
  { key: 'qa-chrome-login', type: 'process', text: 'Use Chrome for QA on qa.brinewick.test; the built-in browser is signed out.', status: 'active', confidence: 0.7, scope: { agent: 'qa' }, at: ago(6 * DAY), evidence: [{ source: 'card', ref: 'qa-BRIN-2333-1' }] },
];

const DEPARTMENTS = [
  { id: 'ceo', name: 'CEO office', summary: 'The Chief of Staff orders the inbox, writes the brief and retro, and keeps the goals.', head: 'chief-of-staff', order: 0, colour: '#b08d57', budgetShare: 0.05, defaultEnabled: false, switchable: true },
  { id: 'engineering', name: 'Engineering', summary: 'The Mate, engineers, contractors, QA, scout and release.', head: 'cto', order: 1, colour: '#4a7bd0', budgetShare: 0.6, defaultEnabled: true, switchable: true },
  { id: 'product', name: 'Product & Design', summary: 'PM, designer and analyst.', head: 'pm', order: 2, colour: '#8a5cc7', budgetShare: 0.15, defaultEnabled: true, switchable: true },
  { id: 'marketing', name: 'Marketing', summary: 'Release notes, changelog and post drafts. Drafts only.', head: 'marketing', order: 3, colour: '#d0784a', budgetShare: 0.05, defaultEnabled: false, switchable: true },
  { id: 'support', name: 'Support', summary: 'Triages customer issues into ticket drafts and drafts replies. Drafts only.', head: 'support', order: 4, colour: '#3f9e7a', budgetShare: 0.05, defaultEnabled: false, switchable: true },
  { id: 'operations', name: 'Operations', summary: 'Jira scan, health, learner, briefs and comms. Always on.', head: 'briefs', order: 5, colour: '#7a8494', budgetShare: 0.1, defaultEnabled: true, switchable: false },
];
const ORG = {
  departments: DEPARTMENTS,
  org: {
    ceo: false,
    departments: DEPARTMENTS.map((d) => ({ ...d, enabled: d.defaultEnabled || !d.switchable })),
    roles: [],
    seats: 4,
    approved: {},
    budgets: {},
    goals: [],
  },
};
const ORG_STATE = {
  merges: { at: ago(5 * MIN), merges: [{ key: 'BRIN-2360', prUrl: 'https://github.com/brinewick/brinewick-api/pull/104', prNumber: 104, mergedAt: ago(8 * MIN), mergeSha: 'f00d', target: 'done' }] },
  spend: {
    at: ago(20 * MIN),
    departments: { engineering: { allowancePct: 60, usedPct: 38.2, spentUsd: 162 } },
    flags: { 'BRIN-2401': { level: 'soft', spendUsd: 35.2, softUsd: 30, hardUsd: 48, at: ago(30 * MIN) }, 'BRIN-2350': { level: 'hard', spendUsd: 41.3, softUsd: 28, hardUsd: 40, at: ago(35 * MIN) } },
  },
  health: { at: ago(40 * MIN), issues: [{ id: 'disk:near', severity: 'soon', text: '8.0 GB free on disk, under 10 GB' }], ok: ['doctor'] },
};

export function tools(): Record<string, (input: Record<string, unknown>) => unknown> {
  const local: Record<string, unknown> = { owner: 'Sam', ide: { editor: 'pycharm', terminal: 'desktop' }, repos: { 'brinewick-api': { path: '/Users/sam/code/brinewick-api', baseBranch: 'develop', prGate: 'pre-pr-checks' } }, trust: ['jira'], compactWindow: 'auto' };
  return {
    ping: () => ({ ok: true, version: '1.0.0', schema: 2, home: '/Users/sam/.keelcrew' }),
    crew_state: () => ({ now: Date.now(), members: MEMBERS, ...ORG_STATE }),
    org: () => ORG,
    costs,
    risk: ({ key }) => ({ key, tier: key === 'BRIN-2401' ? 'high' : 'low', reasons: key === 'BRIN-2401' ? ['raw SQL files', 'auth-adjacent route'] : [], files: 2, added: 5, deleted: 0 }),
    diff: ({ key }) => ({ base: 'develop', branch: `${key}-branch`, diff: diff2401, status: '' }),
    branch_url: ({ key }) => ({ branchUrl: `https://github.com/brinewick/brinewick-api/compare/develop...${key}` }),
    changed_files: () => ({ files: { 'BRIN-2388': ['app/catalog/cache.py', 'app/workers/jobs.py'], 'BRIN-2405': ['app/shipping/carrier.py', 'app/workers/jobs.py'] } }),
    config_get: () => ({ config: structuredClone(local) }),
    config_set: ({ patch }) => ({ config: structuredClone(Object.assign(local, patch)) }),
    memory_list: () => ({ lessons: LESSONS, playbook: '# Crew standing orders\n\n## Preferences\n- Open crew PRs as drafts unless the card says otherwise.\n- Keep chat replies to 2-4 lines. *(pinned)*\n\n## Repo facts · brinewick-api\n- Use the Money type for every currency field in API responses.\n\n## Repo facts · brinewick-web\n- Don’t run the e2e suite; run the unit tests and check the page in the browser. *(pinned)*\n\n## Process\n- Use Chrome for QA on qa.brinewick.test.' }),
    agents_list: () => ({ agents: [{ id: 'reviewer', teamSkills: ['code-review'], teamNotes: 'Use the team’s code-review checklist.' }, { id: 'qa', teamSkills: ['smoke-test'], teamNotes: null }], pack: 'brinewick' }),
    doctor: () => ({ checks: [{ id: 'plugin', label: 'Keelcrew plugin', status: 'ok', detail: '1.0.0' }, { id: 'lead', label: 'Mate registered', status: 'ok', detail: '/Users/sam/lead' }, { id: 'board', label: 'Board link', status: 'ok', detail: 'claude.ai/artifact/…' }] }),
    session_events: ({ key }) => ({ events: Array.from({ length: 12 }, (_, i) => ({ id: i, ts: ago((12 - i) * 4 * MIN), key, kind: i % 4 === 3 ? 'turn_end' : 'tool', tool: ['Read', 'Grep', 'Bash', 'Edit'][i % 4], summary: ['app/orders/routes.py', 'order_exists', 'ruff check --no-fix app/orders', 'routes.py +4'][i % 4] })) }),
    transcript: () => ({ source: 'session', total: 4, entries: [{ i: 0, role: 'user', kind: 'text', text: 'Go: start by using the keelcrew:keel-engineer skill.' }, { i: 1, role: 'assistant', kind: 'thinking', text: 'Read the contract first.' }, { i: 2, role: 'assistant', kind: 'tool', tool: 'Read', text: '', input: '{"file_path": "app/orders/routes.py"}' }, { i: 3, role: 'user', kind: 'result', tool: 'Read', text: 'async def order_receipt(order_id: str, …' }] }),
    prompts: () => ({ prompts: [{ file: 'lead.md', about: 'The Mate’s own notes', text: '# Mate notes\n- The captain prefers drafts.' }] }),
    logs: () => ({ logs: [{ file: 'helper.log', label: 'Helper', sessionId: null, size: 2048, mtime: ago(MIN) }] }),
    log_tail: () => ({ file: 'helper.log', lines: ['10:01:02 info crew_state ok', '10:02:11 info approve BRIN-2360 Draft PR'], total: 2, size: 2048, mtime: ago(MIN), path: '/Users/sam/.keelcrew/logs/helper.log' }),
    approve: ({ key, choice, head }) => ({ ok: true, key, choice, head }),
    open_session: ({ key }) => ({ command: `claude --desktop --resume ${key === 'lead' ? 'lead-1' : `eng-${String(key).slice(-4)}`}` }),
    approve_post: ({ key, tool, match }) => ({ ok: true, post: { id: `p-${Date.now().toString(36)}`, key, tool, match, uses: 1, expires: Date.now() + 30 * MIN, via: 'board' } }),
  };
}
