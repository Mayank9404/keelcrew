/**
 * The crew's watches (the Mate's `crew/schedules`, keyed by agent): each job's light, last run and result, open
 * issues, and the handoff a blocked run left. On or off is Settings → Crew (Edit); Run now and Pause all are requests the
 * Mate applies.
 */
import { useState } from 'react';
import { LEAD, fromLabel } from '../../labels';
import { AGENTS } from '../../lib/agentCatalog';
import { api } from '../../lib/api';
import { ago, dayTime } from '../../lib/format';
import { schedulesToShow } from '../../lib/schedule';
import { toast } from '../../lib/toast';
import { jobLight, type JobLight } from '../../lib/triage';
import { ui } from '../../lib/ui';
import type { CrewState, ScheduleInfo } from '../../types';
import { Details, Dot, Empty, Switch, cls, type Tone } from '../common';
import { HandoffView } from '../parts/EvidenceViews';
import { scanJira, setSchedulesPaused } from '../shell/Controls';

const LIGHT: Record<JobLight, { tone: Tone; label: string }> = {
  ok: { tone: 'ok', label: 'Last run fine' },
  warn: { tone: 'warn', label: 'Has open issues' },
  fail: { tone: 'block', label: 'Ended blocked' },
  off: { tone: 'muted', label: 'Off' },
  idle: { tone: 'muted', label: 'Not run yet' },
};

function JobRow({ info, paused, now, canWrite }: { info: ScheduleInfo; paused: boolean; now: number; canWrite: boolean }) {
  const [running, setRunning] = useState(false);
  const light = jobLight(info, paused);
  const run = async () => {
    setRunning(true);
    try {
      if (info.agent === 'scan') await scanJira();
      else {
        await api.runSchedule(info.id);
        toast(`Asked the ${LEAD} to run ${info.label} now.`);
      }
    } catch {
      /* toasted */
    } finally {
      setRunning(false);
    }
  };
  const next = paused ? 'paused' : !info.enabled ? 'off' : info.nextRun ? dayTime(info.nextRun, now) : '—';
  return (
    <li className={cls('job', `l-${light}`)}>
      <Dot tone={LIGHT[light].tone} label={LIGHT[light].label} />
      <div className="job-main">
        <div className="job-h">
          <b>{info.label}</b>
          {info.agent && fromLabel(info.agent) !== info.label ? <span className="faint">{fromLabel(info.agent)}</span> : null}
          {info.openIssues ? <span className="tag warn">{info.openIssues} open issue{info.openIssues === 1 ? '' : 's'}</span> : null}
        </div>
        <div className="faint small">
          {info.cadence || '—'} · last {info.lastRun ? ago(info.lastRun, now) : 'never'} · next {next}
        </div>
        {info.lastResult ? <p className={light === 'fail' ? 'job-result block-text' : 'job-result'}>{info.lastResult}</p> : null}
        {info.openIssueKeys.length ? <p className="faint small mono">{info.openIssueKeys.join(' · ')}</p> : null}
        {info.handoff ? (
          <Details label="Handoff for the next run" openLabel="Hide the handoff" defaultOpen={light === 'fail'}>
            <HandoffView h={info.handoff} />
          </Details>
        ) : null}
      </div>
      <div className="job-acts">
        {canWrite ? (
          <button type="button" className="btn xs" onClick={() => void run()} disabled={running}>
            {running ? 'Asking…' : 'Run now'}
          </button>
        ) : null}
        {info.agent ? (
          <button type="button" className="btn xs ghost" onClick={() => ui.openSettings(info.agent === 'scan' ? 'tasks' : 'crew')}>
            Edit
          </button>
        ) : null}
      </div>
    </li>
  );
}

export function Jobs({ crew, now }: { crew: CrewState; now: number }) {
  const [busy, setBusy] = useState(false);
  const canWrite = crew.access.canWrite;
  const paused = crew.schedulesPaused;
  const items = schedulesToShow(crew.schedules, AGENTS, crew.config);
  const asked = crew.requests.filter((r) => r.kind === 'schedules' || r.kind === 'run');
  const setPaused = async (p: boolean) => {
    setBusy(true);
    await setSchedulesPaused(p);
    setBusy(false);
  };
  return (
    <div className="jobs">
      <div className="jobs-top">
        <p className="note">{paused ? 'No watch runs. Sessions already running keep going.' : `The recurring watches the ${LEAD} keeps in step with Settings → Crew.`}{asked.length ? ` ${asked.length} change${asked.length === 1 ? '' : 's'} waiting for the ${LEAD}.` : ''}</p>
        <Switch checked={paused} disabled={busy || !canWrite} onChange={(v) => void setPaused(v)} label="Pause all" />
      </div>
      {items.length ? (
        <ul className="job-list">
          {items.map((info) => (
            <JobRow key={info.id} info={info} paused={paused} now={now} canWrite={canWrite} />
          ))}
        </ul>
      ) : (
        <Empty title="No watches set.">Switch on a scheduled agent (briefs, learner, health…) in Settings → Crew, or Jira under Settings → Tasks; the {LEAD} sets its watch.</Empty>
      )}
    </div>
  );
}
