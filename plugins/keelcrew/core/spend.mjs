// @ts-check
// Spend controls, computed by code from the ledger. Weekly allowances: each department's share of the plan's weekly usage
// bar (the captain's weekly shares in Settings → Limits, else the department's default share), shown against what it used. The
// per-ticket spend alarm: once there are enough closed tickets of a difficulty, a soft line (a flag on the board) and a
// hard line that pauses the ticket's sessions and alerts the Mate, who asks the captain: continue once, re-scope or park.
// Written to ~/.keelcrew/spend.json; nothing here writes the board.
import { writeAlert } from './alerts.mjs';
import { crewDirs, readRegistry } from './crew.mjs';
import { pauseSession, unpause } from './denials.mjs';
import { join } from 'node:path';
import { isObject, readJsonLoose, withLock, writeJsonAtomic } from './fsx.mjs';
import { listRecords, readRecord } from './ledger.mjs';
import { orgRules, readOrg } from './org.mjs';
import { HOME, paths } from './paths.mjs';

const DAY = 86_400_000;
const OPEN_OUTCOMES = new Set([null, undefined]);
/** A continue-once line is kept while its ticket is open; one whose ticket has no record is dropped after this long. */
const CONTINUED_KEEP_MS = 30 * DAY;
/** Held around every read-modify-write of spend.json, so a continue never lands between a check's read and its write. */
const spendLock = () => join(HOME, 'locks', 'spend');

/**
 * @typedef {import('./ledger.mjs').LedgerRecord} LedgerRecord
 * @typedef {{ soft: number, hard: number, tickets: number }} SpendLine
 * @typedef {{ level: 'soft' | 'hard', spendUsd: number, softUsd: number, hardUsd: number, at: number }} SpendFlag
 */

/** @param {number} x */
const cents = (x) => Math.round(x * 100) / 100;

/** The value below which a share q of the sorted list falls. @param {number[]} xs @param {number} q */
function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
}

/**
 * The spend alarm's lines per difficulty, from closed tickets' spend; none for a difficulty with too few tickets yet
 * (the alarm is off for it until then).
 * @param {LedgerRecord[]} records @param {Record<string, any>} [rules]
 * @returns {Record<string, SpendLine>}
 */
export function spendLines(records, rules = orgRules()) {
  const min = Number(rules.spendAlarmMinTickets ?? 10);
  /** @type {Record<string, number[]>} */
  const by = {};
  for (const r of records) {
    if (r.kind !== 'ticket' || OPEN_OUTCOMES.has(r.outcome) || !r.difficulty || typeof r.spendUsd !== 'number') continue;
    (by[r.difficulty] ??= []).push(r.spendUsd);
  }
  /** @type {Record<string, SpendLine>} */
  const out = {};
  for (const [d, xs] of Object.entries(by)) {
    if (xs.length < min) continue;
    const soft = cents(quantile(xs, Number(rules.spendSoftQuantile ?? 0.75)));
    out[d] = { soft, hard: Math.max(soft, cents(quantile(xs, Number(rules.spendHardQuantile ?? 0.95)))), tickets: xs.length };
  }
  return out;
}

/** The plan's weekly window: from its reset a week back, else from Monday 00:00 UTC. @param {any} usage @param {number} now */
function windowOf(usage, now) {
  const resetsAt = Number(usage?.sevenDay?.resetsAt);
  if (Number.isFinite(resetsAt) && resetsAt > now) return { start: resetsAt - 7 * DAY, end: resetsAt, fromPlan: true };
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - (((d.getUTCDay() || 7) - 1) * DAY);
  return { start, end: start + 7 * DAY, fromPlan: false };
}

/**
 * Allowances and the spend alarm. Pure: the caller reads and writes the files and pauses sessions.
 * @param {{ records: LedgerRecord[], org: ReturnType<typeof readOrg>, usage?: any, prev?: Record<string, any> | null, rules?: Record<string, any>, now?: number }} input
 */
export function computeSpend({ records, org, usage = null, prev = null, rules = orgRules(), now = Date.now() }) {
  const current = windowOf(usage, now);
  // The plan's reset time wobbles by milliseconds between reads. The Monday fallback (usage.json stale) keeps the stored
  // week, dates included, until it ends; the plan's week takes over a fallback week if it began before that one did.
  const slack = Number(rules.spendWindowSlackMinutes ?? 60) * 60_000;
  const prevStart = Number(prev?.windowStart);
  const prevEnd = Number(prev?.windowEnd);
  const prevFromPlan = prev?.windowFromPlan !== false;
  const sameWindow =
    isObject(prev?.base) &&
    (!current.fromPlan ? now < prevEnd : prevFromPlan ? Math.abs(current.start - prevStart) < slack : current.start <= prevStart + slack);
  const keepStored = sameWindow && !current.fromPlan;
  const { start, end } = keepStored ? { start: prevStart, end: prevEnd } : current;
  const windowFromPlan = keepStored ? prevFromPlan : current.fromPlan;
  // Spend is a running total per ticket, so a week's spend is the total less what it was when the week began.
  /** @type {Record<string, number>} */
  const base = sameWindow ? { ...prev.base } : Object.fromEntries(records.filter((r) => typeof r.spendUsd === 'number').map((r) => [r.key, /** @type {number} */ (r.spendUsd)]));
  /** @param {LedgerRecord} r */
  const weekSpend = (r) => Math.max(0, (r.spendUsd ?? 0) - (base[r.key] ?? 0));
  const tickets = records.filter((r) => r.kind === 'ticket');
  const crewUsd = tickets.reduce((n, r) => n + weekSpend(r), 0);
  const utilization = Number(usage?.sevenDay?.utilization);
  /** The bar's percent a spend stands for: its share of the crew's spend this week, times the bar used. */
  const pctOf = (/** @type {number} */ usd) => (Number.isFinite(utilization) && crewUsd > 0 ? Math.round((usd / crewUsd) * utilization * 1000) / 10 : null);
  const own = isObject(org.budgets) ? org.budgets : {};

  /** @type {Record<string, { allowancePct: number | null, usedPct: number | null, spentUsd: number }>} */
  const departments = {};
  for (const d of org.departments.filter((x) => x.enabled)) {
    // A budget the captain cleared on the board is null (the board can't delete a field): that means the default share.
    const raw = own.departments?.[d.id];
    const pct = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
    const spentUsd = cents(tickets.filter((r) => (d.id === 'engineering' && r.role === 'engineer') || (r.role && org.roles.some((x) => x.id === r.role && x.department === d.id))).reduce((n, r) => n + weekSpend(r), 0));
    departments[d.id] = { allowancePct: Number.isFinite(pct) ? pct : Math.round(d.budgetShare * 100), usedPct: pctOf(spentUsd), spentUsd };
  }

  const alarmOn = own.spendAlarm !== false;
  const lines = alarmOn ? spendLines(records, rules) : {};
  // A continue-once line goes with its ticket: dropped once the ticket closed, or long after its record went.
  const byKey = new Map(records.map((r) => [r.key, r]));
  const continued = Object.fromEntries(
    Object.entries(isObject(prev?.continued) ? prev.continued : {}).filter(([k, c]) => {
      const r = byKey.get(k);
      return r ? OPEN_OUTCOMES.has(r.outcome) : now - (Number(c?.at) || 0) < CONTINUED_KEEP_MS;
    }),
  );
  /** @type {Record<string, SpendFlag>} */
  const flags = {};
  for (const r of tickets) {
    if (!OPEN_OUTCOMES.has(r.outcome) || typeof r.spendUsd !== 'number' || !r.difficulty) continue;
    const line = lines[r.difficulty];
    if (!line) continue;
    const hardUsd = Number(continued[r.key]?.hardUsd) || line.hard;
    const level = r.spendUsd >= hardUsd ? 'hard' : r.spendUsd >= line.soft ? 'soft' : null;
    if (level) flags[r.key] = { level, spendUsd: r.spendUsd, softUsd: line.soft, hardUsd, at: prev?.flags?.[r.key]?.level === level ? prev.flags[r.key].at : now };
  }
  const newlyHard = Object.keys(flags).filter((k) => flags[k].level === 'hard' && prev?.flags?.[k]?.level !== 'hard');
  return {
    at: now, windowStart: start, windowEnd: end, windowFromPlan, base, crewUsd: cents(crewUsd), utilization: Number.isFinite(utilization) ? utilization : null,
    departments,
    lines, flags, continued, newlyHard,
  };
}

/** The last spend state written, or null. */
export const readSpend = () => {
  const s = readJsonLoose(paths.spend(), null);
  return isObject(s) && typeof s.at === 'number' ? s : null;
};

/** The crew sessions working on a ticket (never the Mate), with the role each runs as. @param {string} key */
const sessionsOf = (key) =>
  crewDirs(readRegistry())
    .filter((m) => m.role !== 'lead' && String(m.key ?? '').toUpperCase() === key.toUpperCase())
    .flatMap((m) => m.sessions.map((sessionId) => ({ sessionId, role: m.agent ?? m.role })));

/**
 * Recomputes allowances and the alarm, writes spend.json, and pauses the sessions of each ticket that just crossed its
 * hard line (with an alert that wakes the Mate). Returns the state.
 * @param {{ now?: number }} [opts]
 */
export function checkSpend({ now = Date.now() } = {}) {
  const records = listRecords().records;
  return withLock(spendLock(), () => {
    const out = computeSpend({ records, org: readOrg(), usage: readJsonLoose(paths.usage(), null), prev: readSpend(), now });
    // Every session of a ticket past its hard line stays paused, a newly started one too; the alert goes out once.
    for (const [key, f] of Object.entries(out.flags)) {
      if (f.level !== 'hard') continue;
      for (const m of sessionsOf(key)) pauseSession(m.sessionId, { key, role: m.role, reason: `spend $${f.spendUsd} reached the hard line $${f.hardUsd}`, now });
      if (out.newlyHard.includes(key)) writeAlert({ kind: 'spend', key, summary: `${key} spent $${f.spendUsd}, past its hard line of $${f.hardUsd}; its sessions are paused. Ask the captain: continue once, re-scope, or park.`, now });
    }
    writeJsonAtomic(paths.spend(), out);
    return out;
  });
}

/**
 * The captain chose to continue a ticket past its hard line once: the line moves to its spend times the rules' factor and
 * its sessions are unpaused. Returns the new line, or null when the ticket has no flag.
 * @param {string} key @param {{ now?: number }} [opts]
 */
export function continueSpend(key, { now = Date.now() } = {}) {
  return withLock(spendLock(), () => {
    const s = readSpend();
    const r = readRecord(key);
    if (!s || !r || typeof r.spendUsd !== 'number') return null;
    const hardUsd = cents(r.spendUsd * Number(orgRules().spendAlarmContinueFactor ?? 1.5));
    // The record's own key: one typed in another case still finds the record on a case-insensitive disk.
    s.continued = { ...(isObject(s.continued) ? s.continued : {}), [r.key]: { hardUsd, at: now } };
    if (s.flags?.[r.key]) delete s.flags[r.key];
    writeJsonAtomic(paths.spend(), s);
    unpause(r.key, readRegistry(), { spend: true });
    return hardUsd;
  });
}
