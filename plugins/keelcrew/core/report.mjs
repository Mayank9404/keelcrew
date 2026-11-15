// @ts-check
// The weekly report from the ledger: per week, the tickets closed, how long they took, what they cost, how often QA
// passed first time, bugs, reverts, the captain's edit share and questions per ticket. With a switch-on date, the same
// numbers for the weeks before it and after it: the baseline the org has to beat.
const CLOSED = new Set(['merged', 'done']);
const DAY = 86_400_000;

/** The ISO week a time falls in, like 2026-W43. @param {number} ms */
function weekOf(ms) {
  const d = new Date(ms);
  const t = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); // the Mac's own day
  const day = new Date(t).getUTCDay() || 7;
  const thursday = new Date(t + (4 - day) * DAY);
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** @param {number[]} xs */
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** @param {number | null} x @param {number} [d] */
const round = (x, d = 2) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);
/** @template T @param {(T | null | undefined)[]} xs @returns {T[]} */
const known = (xs) => /** @type {T[]} */ (xs.filter((x) => x !== null && x !== undefined));

/**
 * The numbers for a set of closed tickets. Unknown values (backfilled records have explicit nulls) are left out of
 * each number, and each number says how many tickets it rests on.
 * @param {import('./ledger.mjs').LedgerRecord[]} rs
 */
export function summarize(rs) {
  const cycles = known(rs.map((r) => (r.startedAt && r.closedAt ? (r.closedAt - r.startedAt) / 3_600_000 : null)));
  const spends = known(rs.map((r) => r.spendUsd));
  const qa = known(rs.map((r) => r.qaFirstPass));
  const edits = known(rs.map((r) => r.ownerEdit?.ratio));
  return {
    tickets: rs.length,
    medianHours: round(median(cycles), 1),
    spendUsd: round(spends.reduce((a, b) => a + b, 0)),
    medianSpendUsd: round(median(spends)),
    qaFirstPass: qa.length ? round(qa.filter(Boolean).length / qa.length) : null,
    qaKnown: qa.length,
    withBugs: rs.filter((r) => r.bugs30d.length).length,
    reverted: rs.filter((r) => r.reverts30d.length).length,
    medianOwnerEdit: round(median(edits)),
    editsKnown: edits.length,
    questionsPerTicket: rs.length ? round(rs.reduce((n, r) => n + Object.values(r.cards).filter((c) => c.kind === 'question').length, 0) / rs.length) : null,
  };
}

/**
 * Per week (the last `weeks`, oldest first), and before and after a switch-on time when given.
 * @param {{ records: import('./ledger.mjs').LedgerRecord[], weeks?: number, switchOnAt?: number | null, now?: number }} a
 */
export function weeklyReport({ records, weeks = 8, switchOnAt = null, now = Date.now() }) {
  const closed = records.filter((r) => r.kind === 'ticket' && CLOSED.has(String(r.outcome)) && (r.closedAt ?? r.mergedAt));
  const when = (/** @type {any} */ r) => r.closedAt ?? r.mergedAt;
  const wanted = new Set(Array.from({ length: weeks }, (_, i) => weekOf(now - i * 7 * DAY)));
  const rows = [...wanted].sort().map((week) => ({ week, ...summarize(closed.filter((r) => weekOf(when(r)) === week)) }));
  const baseline = switchOnAt ? { switchOnAt, before: summarize(closed.filter((r) => when(r) < switchOnAt)), after: summarize(closed.filter((r) => when(r) >= switchOnAt)) } : null;
  return { at: now, weeks: rows, baseline };
}
