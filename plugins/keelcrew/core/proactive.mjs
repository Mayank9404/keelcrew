// @ts-check
// Proactive work: the suggest agent's proposals, and whether the Mate may start one by itself now. Code decides the
// budget (the captain's daily cap and share of the weekly usage bar) and which sources and roles are paused for a low hit
// rate; the Mate picks the card. The launch card still waits for the captain.
import { agentById } from './agents.mjs';
import { isObject } from './fsx.mjs';
import { listRecords } from './ledger.mjs';
import { orgRules, readOrg, readOrgFile } from './org.mjs';
import { readSpend } from './spend.mjs';

const DAY = 86_400_000;
const AUTO_START_SETTINGS = ['autoStart', 'autoStartPerDay', 'autoStartUsagePct'];

/**
 * A proposer's hit rate over its last proposals, and the pause it earns when that rate is low.
 * @param {import('./ledger.mjs').LedgerRecord[]} records @param {string} role the ledger role (`suggest:<source>`, `cto`, `pm`)
 * @param {number} now @param {Record<string, any>} rules
 */
export function hitRateOf(records, role, now, rules) {
  const window = Number(rules.proactiveHitWindow ?? 10);
  const recent = records.filter((r) => r.kind === 'output' && r.role === role && r.verdict).sort((a, b) => a.updatedAt - b.updatedAt).slice(-window);
  if (!recent.length) return { hitRate: null, proposals: 0, pausedUntil: null };
  const hitRate = Math.round((recent.filter((r) => r.verdict !== 'rejected').length / recent.length) * 1000) / 1000;
  const enough = recent.length >= Math.ceil(window / 2);
  const until = recent[recent.length - 1].updatedAt + Number(rules.proactivePauseDays ?? 14) * DAY;
  return { hitRate, proposals: recent.length, pausedUntil: enough && hitRate < Number(rules.proactiveMinHitRate ?? 0.3) && until > now ? until : null };
}

/**
 * Whether the Mate may start a suggestion by itself now (and why not), and the hit rate and pause of each suggest source
 * and of the CTO and PM. Pure.
 * @param {{ records: import('./ledger.mjs').LedgerRecord[], settings?: Record<string, any>, spend?: Record<string, any> | null, now?: number, rules?: Record<string, any> }} input
 */
export function proactiveState({ records, settings = {}, spend = null, now = Date.now(), rules = orgRules() }) {
  // A cap that isn't a number allows nothing, as does a weekly usage the panel hasn't read yet.
  const cap = Number.isFinite(Number(settings.autoStartPerDay)) ? Number(settings.autoStartPerDay) : 0;
  const capPct = Number.isFinite(Number(settings.autoStartUsagePct)) ? Number(settings.autoStartUsagePct) : 0;
  const auto = records.filter((r) => r.kind === 'ticket' && r.autoStarted === true);
  // Today is the Mac's own day, from local midnight.
  const startedToday = auto.filter((r) => (r.startedAt ?? r.createdAt) >= new Date(now).setHours(0, 0, 0, 0)).length;
  // Their share of the weekly bar: their spend this week over the crew's, times the share of the bar used.
  const base = isObject(spend?.base) ? spend.base : {};
  const usd = auto.reduce((n, r) => n + Math.max(0, (r.spendUsd ?? 0) - (base[r.key] ?? 0)), 0);
  const usedPct = !spend || !Number.isFinite(spend.utilization) ? null : spend.crewUsd > 0 ? Math.round((usd / spend.crewUsd) * spend.utilization * 1000) / 10 : 0;
  const why =
    settings.enabled === false
      ? 'the suggest agent is off'
      : settings.autoStart !== true
        ? 'auto-start is off'
        : startedToday >= cap
          ? `${startedToday} started today, the daily cap`
          : usedPct === null
            ? "this week's usage isn't read yet"
            : usedPct >= capPct
              ? `auto-started fixes used ${usedPct}% of the weekly bar, the cap is ${capPct}%`
              : null;
  const sources = [...new Set(records.filter((r) => r.kind === 'output' && String(r.role).startsWith('suggest:')).map((r) => String(r.role)))];
  return {
    at: now,
    autoStart: { may: why === null, why, startedToday, cap, usedPct, capPct },
    sources: Object.fromEntries(sources.map((role) => [role.slice('suggest:'.length), hitRateOf(records, role, now, rules)])),
    roles: Object.fromEntries(['cto', 'pm'].map((id) => [id, hitRateOf(records, id, now, rules)])),
  };
}

/** The state from the files on this Mac: the suggest agent's settings are the captain's, else its manifest's defaults. @param {{ now?: number }} [opts] */
export function readProactive({ now = Date.now() } = {}) {
  const own = readOrgFile().agents?.suggest;
  const settings = Object.fromEntries(AUTO_START_SETTINGS.map((k) => [k, own?.[k] ?? agentById('suggest')?.settings?.[k]?.default]));
  const enabled = readOrg().roles.find((r) => r.id === 'suggest')?.enabled === true;
  return proactiveState({ records: listRecords().records, settings: { ...settings, enabled }, spend: readSpend(), now });
}
