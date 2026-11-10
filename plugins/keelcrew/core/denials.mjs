// @ts-check
// Denial escalation: the policy counts the calls it denies per crew session in HOME/denials/<sessionId>.json. Too many in a
// row, or in total, and the session is paused (it may only read and message the Mate) until the Mate runs `keelctl unpause`.
// The Mate itself is never paused, since it is the one who unpauses; it gets an alert instead.
// A soft denial (one that stands in for a prompt nobody would answer) counts only when the same call is refused
// rules.denials.softRetries times in a row, and then counts for all of them: the agent gets room to switch to the card.
import { existsSync, rmSync } from 'node:fs';
import { writeAlert } from './alerts.mjs';
import { isObject, readJsonLoose, readJsonStrict, withLock, writeJsonAtomic } from './fsx.mjs';
import { paths } from './paths.mjs';

/**
 * @typedef {{ consecutive: number, total: number, reasons: string[], paused: boolean, key: string | null, role: string | null, at: number, pausedAt?: number, cause?: 'spend', soft?: { what: string, n: number } | null }} Denials
 */

const MAX_REASONS = 20;
/** Hooks run under a 10 s timeout, so a busy denials file is waited on briefly. */
const LOCK = { timeoutMs: 1500, staleMs: 10_000 };

/** @returns {Denials} */
const fresh = () => ({ consecutive: 0, total: 0, reasons: [], paused: false, key: null, role: null, at: 0, soft: null });

/**
 * A session's denial count, or null when it has none. A damaged file reads as none.
 * @param {string} sessionId
 * @returns {Denials | null}
 */
export function readDenials(sessionId) {
  const d = readJsonLoose(paths.denials(sessionId), null);
  return d && typeof d === 'object' ? { ...fresh(), ...d } : null;
}

/**
 * Whether a session is paused. A denials file that can't be read counts as paused: a damaged file must not lift a pause
 * (the Mate's `keelctl unpause` clears it).
 * @param {string | undefined} sessionId
 */
export function isPaused(sessionId) {
  if (!sessionId) return false;
  try {
    const d = readJsonStrict(paths.denials(sessionId), null);
    if (d === null) return false;
    return !isObject(d) || d.paused !== false;
  } catch {
    return true;
  }
}

/**
 * Counts one denied call. Pauses the session (and writes an alert) when it reaches the rules' limit. A soft denial counts
 * only from the softRetries-th refusal of the same call in a row (then for the whole run); a hard one, or a different
 * call, ends the run.
 * @param {string} sessionId
 * @param {{ key?: string | null, role?: string | null, label?: string, what: string, why: string, rules: import('./rules.mjs').Rules, now?: number, soft?: boolean }} d
 * @returns {{ denials: Denials, pausedNow: boolean, counted: number }}
 */
export function noteDenial(sessionId, { key = null, role = null, label, what, why, rules, now = Date.now(), soft = false }) {
  return withLock(
    paths.denialsLock(),
    () => {
      const d = readDenials(sessionId) ?? fresh();
      // A paused session's denials are the pause itself; they don't add up any further.
      if (d.paused) return { denials: d, pausedNow: false, counted: 0 };
      let add = 1;
      if (soft) {
        const n = d.soft?.what === what ? d.soft.n + 1 : 1;
        d.soft = { what, n };
        const limit = Math.max(1, rules.denials.softRetries);
        add = n < limit ? 0 : n === limit ? limit : 1;
      } else d.soft = null;
      if (!add) {
        Object.assign(d, { key, role, at: now });
        writeJsonAtomic(paths.denials(sessionId), d);
        return { denials: d, pausedNow: false, counted: 0 };
      }
      d.consecutive += add;
      d.total += add;
      d.reasons = [...d.reasons, `${what}: ${why}`.slice(0, 300)].slice(-MAX_REASONS);
      Object.assign(d, { key, role, at: now });
      const { consecutive: inRow, total: inAll } = rules.denials;
      const why2 = d.consecutive >= inRow ? `${d.consecutive} denials in a row` : `${d.total} denials in total`;
      const who = label ?? key ?? role ?? sessionId;
      let pausedNow = false;
      const crossed = (/** @type {number} */ n, /** @type {number} */ limit) => n >= limit && n - add < limit;
      if (role === 'lead') {
        if (crossed(d.consecutive, inRow) || crossed(d.total, inAll)) {
          writeAlert({ kind: 'denials', key, sessionId, summary: `The Mate had ${why2}. Last: ${why}`, now });
        }
      } else if (!d.paused && (d.consecutive >= inRow || d.total >= inAll)) {
        d.paused = true;
        d.pausedAt = now;
        pausedNow = true;
        writeAlert({ kind: 'denials', key, sessionId, summary: `${who} is paused after ${why2}. Last: ${why}`, now });
      }
      writeJsonAtomic(paths.denials(sessionId), d);
      return { denials: d, pausedNow, counted: add };
    },
    LOCK,
  );
}

/** A call went through: the run of denials in a row is over. Writes only when there was one. @param {string} sessionId */
export function noteAllowed(sessionId) {
  if (!readDenials(sessionId)?.consecutive) return;
  withLock(
    paths.denialsLock(),
    () => {
      const d = readDenials(sessionId);
      if (d?.consecutive) writeJsonAtomic(paths.denials(sessionId), { ...d, consecutive: 0 });
    },
    LOCK,
  );
}

/**
 * Pauses a crew session directly, not through its denial count (the spend alarm's hard line); `keelctl unpause` or
 * `keelctl spend continue` lifts it. Returns whether it was running before.
 * @param {string} sessionId @param {{ key?: string | null, role?: string | null, reason: string, now?: number }} p
 */
export function pauseSession(sessionId, { key = null, role = null, reason, now = Date.now() }) {
  return withLock(
    paths.denialsLock(),
    () => {
      const d = readDenials(sessionId) ?? fresh();
      // Already paused (for its denials): it now waits on the spend line too, so a plain `keelctl unpause` doesn't lift it.
      if (d.paused) {
        if (d.cause !== 'spend') writeJsonAtomic(paths.denials(sessionId), { ...d, cause: 'spend', reasons: [...d.reasons, reason].slice(-MAX_REASONS) });
        return false;
      }
      writeJsonAtomic(paths.denials(sessionId), { ...d, paused: true, pausedAt: now, at: now, cause: 'spend', key: key ?? d.key, role: role ?? d.role, reasons: [...d.reasons, reason].slice(-MAX_REASONS) });
      return true;
    },
    LOCK,
  );
}

/**
 * Unpauses crew sessions: one by its session id, or every session the registry lists for a ticket key. Their counts start
 * over.
 * @param {string} target a session id or a ticket key
 * @param {import('./crew.mjs').Registry} reg
 * @param {{ spend?: boolean }} [opts] also lift spend-alarm pauses (only `keelctl spend continue`)
 * @returns {string[]} the session ids that were paused and no longer are
 */
export function unpause(target, reg, { spend = false } = {}) {
  const want = String(target ?? '').trim();
  const sessions = want && existsSync(paths.denials(want))
    ? [want]
    : Object.entries(reg.sessions)
        .filter(([, m]) => m.key && m.key.toUpperCase() === want.toUpperCase())
        .map(([s]) => s);
  return withLock(
    paths.denialsLock(),
    () => {
      /** @type {string[]} */
      const cleared = [];
      for (const s of sessions) {
        if (!existsSync(paths.denials(s))) continue;
        // A spend pause lifts only with the captain's continue (`keelctl spend continue`), never a plain unpause.
        if (!spend && readDenials(s)?.cause === 'spend') continue;
        if (isPaused(s)) cleared.push(s);
        rmSync(paths.denials(s), { force: true });
      }
      return cleared;
    },
    LOCK,
  );
}
