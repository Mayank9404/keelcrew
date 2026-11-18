/**
 * A task's detail panel: who, where it stands and what it costs on top; the story first; then the evidence, the diff,
 * the transcript, the activity, and the controls. A side panel on wide screens, the whole screen on a phone.
 */
import { useEffect, useRef, useState } from 'react';
import { ROLE_LABEL, sessionRole } from '../../labels';
import { api, errorText } from '../../lib/api';
import { ACTIVITY, isJiraKey, openInbox, taskView } from '../../lib/derive';
import { ago, modelName } from '../../lib/format';
import { useCrewStore } from '../../lib/store';
import { ui, type TaskTab } from '../../lib/ui';
import type { CrewState, Session, Task, TaskDetail as Detail } from '../../types';
import { Dot, Icon, Pill, useNow } from '../common';
import { RiskPill } from '../parts/RiskBlock';
import { Spend, SpendFlag, StaffBits, StatePill } from '../parts/TaskBits';
import { ContextMeter, SessionActions } from '../SessionBits';
import { TranscriptView } from '../Transcript';
import { ActivityTab } from './ActivityTab';
import { DiffTab } from './DiffTab';
import { EvidenceTab } from './EvidenceTab';
import { ManageTab } from './ManageTab';
import { Story } from './Story';

const TABS: { id: TaskTab; label: string }[] = [
  { id: 'story', label: 'Story' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'diff', label: 'Diff' },
  { id: 'transcript', label: 'Transcript' },
  { id: 'activity', label: 'Activity' },
  { id: 'manage', label: 'Manage' },
];

/** Task detail: fetched on open and refreshed (debounced) whenever the task changes. */
function useDetail(key: string, version: number | undefined) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const first = useRef(true);
  useEffect(() => {
    let live = true;
    const delay = first.current ? 0 : 900;
    first.current = false;
    const t = window.setTimeout(() => {
      api.taskDetail(key).then(
        (d) => {
          if (!live) return;
          setDetail(d);
          setError(null);
        },
        (e) => live && setError(errorText(e)),
      );
    }, delay);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [key, version]);
  return { detail, error };
}

/** The engineer at a glance: model, what it's doing, how full its context is, and its controls. */
function EngineerStrip({ session }: { session: Session | undefined }) {
  if (!session) return null;
  const doing = session.lastTool ?? session.lastText ?? ACTIVITY[session.activity]?.label ?? '';
  const live = session.status === 'running' && session.activity !== 'idle';
  return (
    <div className="eng-strip">
      <Dot tone={session.paused ? 'block' : live ? 'work' : 'muted'} pulse={live} />
      <b>{ROLE_LABEL.engineer}</b>
      <span className="faint">
        {modelName(session.model)} · {session.effort}
      </span>
      <ContextMeter s={session} />
      <span className="eng-doing" title={doing}>
        {doing}
      </span>
      <SessionActions s={session} labels="short" />
    </div>
  );
}

function TranscriptTab({ task, sessions }: { task: Task; sessions: Session[] }) {
  const list = [...sessions].sort((a, b) => (a.id === task.sessionId ? -1 : b.id === task.sessionId ? 1 : b.lastEventAt - a.lastEventAt));
  const [id, setId] = useState<string | null>(null);
  const s = list.find((x) => x.id === id) ?? list[0];
  if (!s) return <p className="note">No session yet.</p>;
  return (
    <>
      {list.length > 1 ? (
        <div className="seg" role="group" aria-label="Session">
          {list.map((x) => (
            <button key={x.id} type="button" aria-pressed={x.id === s.id} onClick={() => setId(x.id)}>
              {x.id === task.sessionId ? ROLE_LABEL.engineer : sessionRole(x)}
            </button>
          ))}
        </div>
      ) : null}
      <TranscriptView key={s.id} session={s} />
    </>
  );
}

export function TaskDetail({ crew, taskKey, tab, evidenceId }: { crew: CrewState; taskKey: string; tab: TaskTab; evidenceId: string | null }) {
  const live = crew.tasks.find((t) => t.key === taskKey);
  const { detail, error } = useDetail(taskKey, live?.updatedAt);
  const events = useCrewStore().events;
  const now = useNow(30_000);
  const task = live ?? detail?.task;
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    ref.current?.focus();
    return () => {
      const el = opener.current as HTMLElement | null;
      if (el && document.contains(el)) el.focus();
    };
  }, [taskKey]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      ui.closeTask();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const close = (
    <button type="button" className="btn icon ghost close" aria-label="Close the task" onClick={() => ui.closeTask()}>
      <Icon name="x" />
    </button>
  );
  if (!task) {
    return (
      <aside className="detail" role="dialog" aria-label={taskKey} tabIndex={-1} ref={ref}>
        <div className="dt-head">
          <div>
            <span className="mono faint">{taskKey}</span>
            <h2>{error ? 'Couldn’t load this task' : 'Loading…'}</h2>
            {error ? <p className="note">{error}</p> : null}
          </div>
          {close}
        </div>
      </aside>
    );
  }
  const v = taskView(crew, task, openInbox(crew));
  const ship = crew.inbox.filter((i) => i.taskKey === task.key && i.kind === 'ship').sort((a, b) => b.createdAt - a.createdAt)[0];
  const jiraUrl = isJiraKey(task.key) && crew.config.intake.jiraSite ? `${crew.config.intake.jiraSite.replace(/\/$/, '')}/browse/${task.key}` : null;
  const evidenceN = detail?.evidence.length ?? 0;
  const wide = tab === 'diff' || tab === 'transcript';
  return (
    <aside className={wide ? 'detail wide' : 'detail'} role="dialog" aria-labelledby="dt-title" tabIndex={-1} ref={ref}>
      <div className="dt-head">
        <div className="dt-id">
          <div className="dt-eyebrow">
            {jiraUrl ? (
              <a className="mono" href={jiraUrl} target="_blank" rel="noopener noreferrer" title="Open in Jira">
                {task.key}
              </a>
            ) : (
              <span className="mono">{task.key}</span>
            )}
            <span>{task.kind === 'adhoc' ? 'Captain’s task' : 'Jira ticket'}</span>
            {task.repo ? <span className="mono">{task.repo}</span> : null}
            {task.jiraStatus ? <span>Jira: {task.jiraStatus}</span> : null}
          </div>
          <h2 id="dt-title">{task.title}</h2>
          <div className="dt-facts">
            <StatePill v={v} />
            {ship?.risk ? <RiskPill risk={ship.risk} /> : null}
            <Pill tone="neutral">{task.difficulty}</Pill>
            <StaffBits crew={crew} task={task} />
            <Spend crew={crew} task={task} />
            <SpendFlag crew={crew} task={task} />
            {task.startedAt ? <span className="faint">started {ago(task.startedAt, now)}</span> : null}
            {task.prUrl ? (
              <a href={task.prUrl} target="_blank" rel="noopener noreferrer">
                PR #{/\/pull\/(\d+)/.exec(task.prUrl)?.[1] ?? ''}
              </a>
            ) : null}
          </div>
        </div>
        {close}
      </div>
      <EngineerStrip session={v.session} />
      <div className="dt-tabs" role="tablist" aria-label="Task sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => ui.setTaskTab(t.id)}>
            {t.label}
            {t.id === 'evidence' && evidenceN ? <span className="num count">{evidenceN}</span> : null}
          </button>
        ))}
      </div>
      <div className="dt-body" role="tabpanel">
        {tab === 'story' ? <Story crew={crew} task={task} detail={detail} now={now} /> : null}
        {tab === 'evidence' ? <EvidenceTab detail={detail} error={error} focus={evidenceId} /> : null}
        {tab === 'diff' ? <DiffTab task={task} /> : null}
        {tab === 'transcript' ? <TranscriptTab task={task} sessions={detail?.sessions ?? crew.sessions.filter((x) => x.taskKey === task.key)} /> : null}
        {tab === 'activity' ? <ActivityTab crew={crew} task={task} detail={detail} live={events} /> : null}
        {tab === 'manage' ? <ManageTab crew={crew} task={task} view={v} /> : null}
      </div>
    </aside>
  );
}
