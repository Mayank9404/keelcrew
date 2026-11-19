/**
 * Underway: every task in one list, most recently touched first, each row saying in words where it stands. Anything
 * stuck sits at the top. A filter narrows the list; the search also covers chat and decisions.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { LEAD, fromLabel } from '../../labels';
import { api } from '../../lib/api';
import { groupTasks, type Group, type TaskView } from '../../lib/derive';
import { ago, clock, shortDay, toMs } from '../../lib/format';
import { toast } from '../../lib/toast';
import { stuckItems, type StuckItem } from '../../lib/triage';
import { ui, useUi, type UnderwayFilter } from '../../lib/ui';
import { gridSummary, validationGrid } from '../../lib/validation';
import type { CrewState, SearchHit } from '../../types';
import { Empty, FeedNote, Icon, KeyLink, PageHeader, Section, cls, useNow, type IconName } from '../common';
import { ValidationStrip } from '../parts/ValidationGrid';
import { PhaseSteps, Spend, SpendFlag, StaffBits, StatePill, viewTone } from '../parts/TaskBits';

const FILTERS: { id: UnderwayFilter; label: string; groups: Group[] }[] = [
  { id: 'flight', label: 'In flight', groups: ['need', 'work', 'review', 'qa'] },
  { id: 'waiting', label: 'Not started', groups: ['proposed', 'queued'] },
  { id: 'done', label: 'Finished', groups: ['done'] },
  { id: 'all', label: 'All', groups: ['need', 'work', 'review', 'qa', 'proposed', 'queued', 'done'] },
];
const DONE_SHOWN = 20;

const STUCK_ICON: Record<StuckItem['kind'], IconName> = { paused: 'pause', blocked: 'alert', failing: 'x', stale: 'refresh', budget: 'coin', job: 'clock', lead: 'chat', silent: 'minus' };

function StuckRow({ s, crew }: { s: StuckItem; crew: CrewState }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const canWrite = crew.access.canWrite;
  const unpause = async () => {
    setBusy(true);
    try {
      await api.unpause({ key: s.taskKey, agent: s.agent, sessionId: s.sessionId });
      toast(`Asked the ${LEAD} to unpause ${s.agent ? fromLabel(s.agent) : 'it'}${s.taskKey ? ` on ${s.taskKey}` : ''}.`);
      setConfirm(false);
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  };
  const asked = crew.requests.some((r) => r.kind === 'unpause' && r.key === s.taskKey);
  return (
    <li className={`stuck k-${s.kind}`}>
      <Icon name={STUCK_ICON[s.kind]} />
      <div className="st-main">
        <b>
          {s.taskKey ? <KeyLink k={s.taskKey} /> : null} {s.title.replace(`${s.taskKey} · `, '')}
        </b>
        {s.reasons.length ? (
          <ul className="reasons">
            {s.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : (
          <span className="faint">{s.detail}</span>
        )}
        {confirm ? (
          <div className="confirm">
            <span>Unpause it? It can take actions again; the denials above are what it tried.</span>
            <button type="button" className="btn sm primary" disabled={busy} onClick={() => void unpause()}>
              {busy ? 'Asking…' : 'Unpause'}
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setConfirm(false)}>
              Keep paused
            </button>
          </div>
        ) : null}
      </div>
      <span className="st-acts">
        {s.kind === 'paused' && canWrite && !confirm ? (
          asked ? (
            <span className="faint small">Unpause asked</span>
          ) : (
            <button type="button" className="btn xs" onClick={() => setConfirm(true)}>
              Unpause…
            </button>
          )
        ) : null}
        {s.kind === 'job' ? (
          <button type="button" className="btn xs ghost" onClick={() => ui.setView('crew')}>
            Jobs
          </button>
        ) : null}
        {s.taskKey ? (
          <button type="button" className="btn xs ghost" onClick={() => ui.openTask(s.taskKey!)}>
            Open
          </button>
        ) : null}
      </span>
    </li>
  );
}

function TaskRow({ v, crew, now }: { v: TaskView; crew: CrewState; now: number }) {
  const t = v.task;
  const rows = validationGrid(t.contract, t.validation);
  const s = gridSummary(rows);
  const done = t.status === 'done' || t.status === 'cancelled';
  const last = done ? '' : t.agents.find((a) => a.id === 'engineer')?.result || t.lastSummary;
  return (
    <li>
      <button type="button" className={cls('trow', `t-${viewTone(v)}`)} onClick={() => ui.openTask(t.key)}>
        <span className="tr-key mono">{t.key}</span>
        <span className="tr-main">
          <span className="tr-title">
            {t.title}
            {t.kind === 'adhoc' ? <span className="tag">captain’s task</span> : null}
            {v.skipped ? <span className="tag">skipped</span> : null}
            {t.overlaps.length ? <span className="tag warn" title={t.overlaps.map((o) => `Also edited by ${o.key}: ${o.files.join(', ')}`).join('\n')}>overlap</span> : null}
          </span>
          <span className="tr-meta">
            <StatePill v={v} />
            {done ? null : <PhaseSteps task={t} />}
            {rows.length ? (
              <span className={s.fail || (!done && s.untested) ? 'vsum block-text' : 'vsum'}>
                <ValidationStrip rows={rows} />
                <span className="num">
                  {s.pass}/{s.total}
                </span>
              </span>
            ) : null}
            <StaffBits crew={crew} task={t} />
            <Spend crew={crew} task={t} />
            <SpendFlag crew={crew} task={t} />
            <span className="faint num tr-when">{done && t.closedAt ? shortDay(t.closedAt, now) : ago(t.updatedAt, now)}</span>
          </span>
          {last ? <span className="tr-last">{last}</span> : null}
        </span>
      </button>
    </li>
  );
}

export function UnderwayView({ crew }: { crew: CrewState }) {
  const now = useNow(30_000);
  const { underwayFilter, search } = useUi();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const g = useMemo(() => groupTasks(crew), [crew]);
  useEffect(() => {
    if (!search) return;
    setQ(search.q);
    inputRef.current?.focus();
  }, [search]);
  const needle = q.trim().toLowerCase();
  useEffect(() => {
    if (needle.length < 2) {
      setHits(null);
      return;
    }
    let live = true;
    const t = window.setTimeout(() => {
      api.search(needle).then(
        (r) => live && setHits(r.filter((h) => h.kind !== 'task')),
        () => live && setHits([]),
      );
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [needle]);
  const match = (v: TaskView) => !needle || `${v.task.key} ${v.task.title} ${v.task.lastSummary} ${v.task.repo}`.toLowerCase().includes(needle);
  const filter = FILTERS.find((f) => f.id === underwayFilter) ?? FILTERS[0];
  const listOf = (f: (typeof FILTERS)[number]) => f.groups.flatMap((gr) => g[gr]).filter(match);
  const when = (v: TaskView): number => toMs(v.task.closedAt ?? v.task.updatedAt);
  const isDone = (v: TaskView): boolean => v.task.status === 'done' || v.task.status === 'cancelled';
  const all = listOf(filter).sort((a, b) => when(b) - when(a));
  // Finished tasks are capped wherever they show; the rest stay in the board's database.
  let doneSeen = 0;
  const shown = all.filter((v) => !isDone(v) || ++doneSeen <= DONE_SHOWN);
  const withFinished = filter.groups.includes('done');
  const stuck = stuckItems(crew, now);
  const asked = crew.requests.filter((r) => r.kind === 'task' || r.kind === 'start');
  const inFlight = g.need.length + g.work.length + g.review.length + g.qa.length;
  return (
    <div className="view underway">
      <PageHeader
        title="Underway"
        status={
          <>
            <span>
              <b className="num">{inFlight}</b> in flight
            </span>
            <span className={stuck.length ? 'block-text' : ''}>
              <b className="num">{stuck.length}</b> stuck
            </span>
            <span>
              <b className="num">{g.proposed.length + g.queued.length}</b> not started
            </span>
            <span>
              <b className="num">{g.done.filter((v) => v.task.closedAt && now - v.task.closedAt < 7 * 86_400_000).length}</b> finished this week
            </span>
          </>
        }
      />
      {stuck.length ? (
        <Section title="Stuck" count={stuck.length} tone="block" meta={<FeedNote feed={crew.feeds.crew} now={now} />}>
          <ul className="stuck-list">
            {stuck.map((s) => (
              <StuckRow key={s.id} s={s} crew={crew} />
            ))}
          </ul>
        </Section>
      ) : null}
      <div className="toolbar">
        <label className="search">
          <Icon name="search" />
          <input ref={inputRef} id="underway-search" type="search" value={q} placeholder="Find a task, or search chat and decisions" aria-label="Search" onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="seg" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" aria-pressed={underwayFilter === f.id} onClick={() => ui.setUnderwayFilter(f.id)}>
              {f.label}
              <span className="num">{listOf(f).length}</span>
            </button>
          ))}
        </div>
      </div>
      {asked.length ? (
        <Section title={`Sent to the ${LEAD}`} count={asked.length} tone="muted">
          <ul className="pending">
            {asked.map((r) => (
              <li key={r.id}>
                <Icon name="clock" />
                <span>
                  <b>{r.kind === 'start' ? `Start ${r.key}` : `New task${r.agent ? ` for the ${fromLabel(r.agent)}` : ''}`}</b>
                  {r.text ? `: ${r.text}` : ''}
                </span>
                <span className="faint num">sent {clock(r.at)}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {shown.length ? (
        <ul className="tasks">
          {shown.map((v) => (
            <TaskRow key={v.task.key} v={v} crew={crew} now={now} />
          ))}
        </ul>
      ) : crew.tasks.length ? (
        <Empty title={needle ? 'No task matches.' : filter.id === 'flight' ? 'No task is in flight.' : filter.id === 'waiting' ? 'Nothing is waiting to start.' : 'Nothing has finished yet.'}>
          {filter.id === 'flight' && !needle ? `Tasks the ${LEAD} starts appear here with their phase, their promises and their spend.` : null}
        </Empty>
      ) : (
        <Empty title="No tasks yet.">
          The Jira scan brings in your tickets every 30 minutes on working days, and anything you ask the {LEAD} becomes a T- task. Start one with New task.
        </Empty>
      )}
      {withFinished && crew.archivedMore ? <p className="note">Older finished tasks stay in the board’s database; the newest {crew.archivedCount} show here.</p> : null}
      {hits ? (
        <Section title="In chat and decisions" count={hits.length}>
          {hits.length ? (
            <ul className="hits">
              {hits.map((h, i) => (
                <li key={`${h.kind}${h.ref}${i}`}>
                  <button type="button" className="hit" disabled={!h.taskKey} onClick={() => h.taskKey && ui.openTask(h.taskKey)}>
                    <span className="faint">{h.kind === 'chat' ? 'Chat' : 'Decision'}</span>
                    {h.taskKey ? <span className="mono">{h.taskKey}</span> : null}
                    <span className="hit-s">{h.snippet}</span>
                    <span className="faint num">{ago(h.ts, now)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No matches in chat or decisions." />
          )}
        </Section>
      ) : null}
    </div>
  );
}
