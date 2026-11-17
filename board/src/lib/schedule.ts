/** Watches as the board lists them: the Mate's `crew/schedules`, or the scheduled agents before it writes one. */
import type { CrewConfig, ScheduleInfo } from '../types';
import { agentConfig, agentOn, type AgentManifest } from './agents';

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isTime = (s: string): boolean => TIME_RE.test(s.trim());

/**
 * The jobs to show: the Mate's list when it has written one, else one row per schedule of each scheduled agent (from
 * the manifests and the captain's settings), not yet run.
 */
export function schedulesToShow(items: ScheduleInfo[], manifests: AgentManifest[], c: Pick<CrewConfig, 'org' | 'agents'>): ScheduleInfo[] {
  if (items.length) return items;
  const out: ScheduleInfo[] = [];
  for (const m of manifests) {
    if (!m.schedules.length) continue;
    const cfg = agentConfig(m, c.agents[m.id], c.org);
    m.schedules.forEach((s, i) =>
      out.push({
        id: m.schedules.length > 1 ? `${m.id}-${i + 1}` : m.id,
        agent: m.id,
        label: m.schedules.length > 1 ? `${m.name} · ${s.label}` : m.name,
        cadence: i === 0 && cfg.schedule ? cronWords(cfg.schedule) : s.label,
        enabled: cfg.enabled,
        lastRun: null,
        nextRun: null,
        lastResult: '',
        openIssues: null,
        openIssueKeys: [],
        handoff: null,
      }),
    );
  }
  return out;
}

/** When the Mate's panel scans Jira (hooks/register.tsx: SCAN_MS in WORK_START_HOUR to WORK_END_HOUR). */
const SCAN_CADENCE = 'In the Mate’s panel, every 30 min, Mon–Fri 9:00–20:00';

/**
 * The Mate's jobs as Settings has them: a job is on only while its agent is on (agentOn; the Mate's copy can
 * lag), and the Jira scan, which the Mate's panel runs, shows the panel's last scan on this Mac (`crew_state.scan`).
 */
export function schedulesNow(items: ScheduleInfo[], manifests: AgentManifest[], c: Pick<CrewConfig, 'org' | 'agents'>, scan: Record<string, unknown> | null): ScheduleInfo[] {
  const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  return items.map((i) => {
    const m = manifests.find((x) => x.id === i.agent);
    const on = m ? agentOn(c, m) : true;
    if (i.agent !== 'scan') return { ...i, enabled: on && i.enabled };
    const at = typeof scan?.at === 'number' ? scan.at : null;
    const result = !scan || at === null ? i.lastResult : scan.ok === true ? `DONE: ${count(scan.new)} new, ${count(scan.changed)} changed, ${count(scan.updated)} updated.` : `BLOCKED: Jira scan failed: ${typeof scan.error === 'string' && scan.error ? scan.error : 'unknown error'}`;
    return { ...i, enabled: on, cadence: SCAN_CADENCE, lastRun: at ?? i.lastRun, nextRun: null, lastResult: result, handoff: at === null ? i.handoff : null };
  });
}

/** The days a schedule can run on, as cron's day-of-week field. */
export const SCHEDULE_DAYS: [string, string][] = [
  ['1-5', 'Weekdays'],
  ['*', 'Every day'],
  ['1', 'Mondays'],
  ['2', 'Tuesdays'],
  ['3', 'Wednesdays'],
  ['4', 'Thursdays'],
  ['5', 'Fridays'],
  ['6', 'Saturdays'],
  ['0', 'Sundays'],
];

const pad = (n: number): string => String(n).padStart(2, '0');

/** A cron the day and time picker can show (one time, on one of SCHEDULE_DAYS); null for any other cron. */
export function simpleCron(cron: string): { days: string; time: string } | null {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\S+)$/.exec(cron.trim());
  if (!m || !SCHEDULE_DAYS.some(([d]) => d === m[3])) return null;
  const [min, hour] = [Number(m[1]), Number(m[2])];
  return min < 60 && hour < 24 ? { days: m[3], time: `${pad(hour)}:${pad(min)}` } : null;
}

/** The cron for a day choice and an HH:MM time. */
export function cronAt(days: string, time: string): string {
  const [h, m] = time.split(':').map(Number);
  return `${m} ${h} * * ${days}`;
}

/** A simple cron in words ("Weekdays 09:30"); any other as "cron …". */
export function cronWords(cron: string): string {
  const s = simpleCron(cron);
  return s ? `${SCHEDULE_DAYS.find(([d]) => d === s.days)?.[1]} ${s.time}` : `cron ${cron}`;
}
