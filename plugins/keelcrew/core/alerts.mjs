// @ts-check
// Crew alerts: something the Mate must look at now (a paused session, a budget, a lost session). Each is one file in
// HOME/alerts named by its id, `<ts>-<kind>-<random>.json`; the panel mod wakes the Mate for every file still there, and
// `keelctl alerts seen` moves handled ones to alerts/seen/.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonLoose, writeJsonAtomic } from './fsx.mjs';
import { paths } from './paths.mjs';

/**
 * @typedef {{ id: string, kind: string, key: string | null, sessionId: string | null, summary: string, at: number }} Alert
 */

const KIND = /^[a-z][a-z0-9-]{0,39}$/;
const ID = /^[\w-]{1,120}$/;
const MAX_SUMMARY = 500;

/**
 * Writes an alert. Throws on a kind that isn't lowercase letters, digits and dashes, or an empty summary.
 * @param {{ kind: string, summary: string, key?: string | null, sessionId?: string | null, now?: number }} a
 * @returns {Alert}
 */
export function writeAlert({ kind, summary, key = null, sessionId = null, now = Date.now() }) {
  if (!KIND.test(String(kind))) throw new Error('An alert kind is lowercase letters, digits and dashes (for example "budget").');
  const text = String(summary ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY);
  if (!text) throw new Error('An alert needs a summary.');
  const id = `${now}-${kind}-${randomBytes(3).toString('hex')}`;
  /** @type {Alert} */
  const alert = { id, kind, key: key ? String(key) : null, sessionId: sessionId ? String(sessionId) : null, summary: text, at: now };
  writeJsonAtomic(join(paths.alerts(), `${id}.json`), alert);
  return alert;
}

/** @param {string} dir */
function ids(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

/**
 * The alerts not yet handled (or, with `seen`, the handled ones), oldest first. A damaged file still lists, by its id.
 * @param {{ seen?: boolean }} [options]
 * @returns {Alert[]}
 */
export function listAlerts({ seen = false } = {}) {
  const dir = seen ? paths.alertsSeen() : paths.alerts();
  return ids(dir)
    .map((id) => {
      const a = readJsonLoose(join(dir, `${id}.json`), null);
      const at = Number(a?.at) || Number(id.split('-')[0]) || 0;
      return { id, kind: String(a?.kind ?? id.split('-')[1] ?? 'unknown'), key: a?.key ?? null, sessionId: a?.sessionId ?? null, summary: String(a?.summary ?? '(unreadable alert)'), at };
    })
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/**
 * Moves one alert, or every one with "all", to alerts/seen/.
 * @param {string} id
 * @returns {string[]} the ids moved (empty when there was no such alert)
 */
export function markAlertSeen(id) {
  const want = id === 'all' ? ids(paths.alerts()) : ID.test(id) ? [id] : [];
  mkdirSync(paths.alertsSeen(), { recursive: true });
  /** @type {string[]} */
  const moved = [];
  for (const a of want) {
    try {
      renameSync(join(paths.alerts(), `${a}.json`), join(paths.alertsSeen(), `${a}.json`));
      // The doctor ages seen alerts by mtime, from when they were seen.
      const now = new Date();
      utimesSync(join(paths.alertsSeen(), `${a}.json`), now, now);
      moved.push(a);
    } catch {
      /* already moved, or no such alert */
    }
  }
  return moved;
}
