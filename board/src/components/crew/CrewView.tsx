/** The crew: who is running and what it costs, the watches, spend against budgets, and throughput. */
import { useEffect, useState } from 'react';
import { LEAD, sessionRole } from '../../labels';
import { quietApi } from '../../lib/api';
import { ACTIVITY, shortKey } from '../../lib/derive';
import { ago, hours, modelName, money, ratio } from '../../lib/format';
import { ui } from '../../lib/ui';
import type { CrewState, Metrics, Session } from '../../types';
import { Dot, Empty, FeedNote, PageHeader, Section, useNow, type Tone } from '../common';
import { CONTEXT_WARN_PCT, ContextMeter, SessionActions } from '../SessionBits';
import { Jobs } from './Jobs';
import { Spend } from './Spend';

const ROLE_ORDER: Session['role'][] = ['lead', 'engineer', 'agent'];

function stateOf(s: Session): { text: string; tone: Tone } {
  if (s.paused) return { text: 'Paused', tone: 'block' };
  switch (s.status) {
    case 'starting':
      return { text: 'Starting', tone: 'work' };
    case 'parked':
      return { text: 'Parked', tone: 'muted' };
    case 'stopped':
      return { text: 'Finished', tone: 'muted' };
    case 'interrupted':
      return { text: 'Interrupted', tone: 'warn' };
    case 'error':
      return { text: 'Error', tone: 'block' };
    default:
      if (s.activity === 'waiting') return { text: 'Waiting', tone: 'muted' };
      if (s.activity === 'idle' || s.status === 'idle') return { text: 'Idle', tone: 'muted' };
      return { text: ACTIVITY[s.activity]?.label ?? 'Working', tone: 'work' };
  }
}

const isActive = (s: Session): boolean => s.status === 'running' || s.status === 'starting' || s.status === 'idle';

function SessionRow({ crew, s, now }: { crew: CrewState; s: Session; now: number }) {
  const task = s.taskKey ? crew.tasks.find((t) => t.key === s.taskKey) : undefined;
  const st = stateOf(s);
  const name = s.role === 'lead' ? LEAD : `${sessionRole(s)}${s.job ? ' (on watch)' : ''}`;
  return (
    <li className="sess-row">
      <Dot tone={st.tone} pulse={st.tone === 'work'} />
      <div className="sr-main">
        <b>
          {name}
          {s.taskKey ? (
            <button type="button" className="key" onClick={() => ui.openTask(s.taskKey!)}>
              {shortKey(s.taskKey)}
            </button>
          ) : null}
        </b>
        <span className="faint sr-sub">{s.role === 'lead' ? 'Triage, chat and staffing' : task?.title ?? s.lastText ?? ''}</span>
      </div>
      <span className="sr-state">{st.text}</span>
      <span className="sr-model faint">
        {modelName(s.model)} · {s.effort}
      </span>
      <ContextMeter s={s} />
      <span className="num sr-cost">{money(s.costUsd)}</span>
      <span className="faint num sr-when">{ago(s.lastEventAt, now)}</span>
      <SessionActions s={s} />
    </li>
  );
}

function Throughput() {
  const [m, setM] = useState<Metrics | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => quietApi.metrics().then((r) => live && setM(r), () => undefined);
    void load();
    const t = window.setInterval(load, 60_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, []);
  if (!m) return <p className="note">Loading…</p>;
  const t = m.totals;
  const max = Math.max(1, ...m.daily.map((d) => d.done));
  const stats: [string, string][] = [
    [String(t.done7d), 'done in 7 days'],
    [String(t.done30d), 'done in 30 days'],
    [hours(t.avgCycleHours), 'average cycle'],
    [hours(t.avgWaitOnYouHours), 'average wait on you'],
    [ratio(t.reopenRate), 'reopened by QA'],
  ];
  return (
    <div className="throughput">
      <dl className="stats">
        {stats.map(([v, l]) => (
          <div key={l}>
            <dt>{l}</dt>
            <dd className="num">{v}</dd>
          </div>
        ))}
      </dl>
      <figure className="bars" aria-label="Tasks done per day, last 14 days">
        {m.daily.map((d) => (
          <span key={d.date} title={`${d.date}: ${d.done} done`}>
            <i style={{ height: `${(d.done / max) * 100}%` }} className={d.done ? '' : 'zero'} />
            <small>{Number(d.date.slice(8))}</small>
          </span>
        ))}
        <figcaption>Tasks done per day, last 14 days</figcaption>
      </figure>
    </div>
  );
}

export function CrewView({ crew }: { crew: CrewState }) {
  const now = useNow(30_000);
  const byRole = (a: Session, b: Session) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || b.lastEventAt - a.lastEventAt;
  const active = crew.sessions.filter(isActive).sort(byRole);
  const earlier = crew.sessions
    .filter((s) => !isActive(s))
    .sort((a, b) => b.lastEventAt - a.lastEventAt)
    .slice(0, 20);
  const hot = crew.sessions.filter((s) => s.contextMax && (s.contextTokens ?? 0) / s.contextMax >= CONTEXT_WARN_PCT / 100).length;
  return (
    <div className="view crew">
      <PageHeader
        title="Muster"
        status={
          <>
            <span>
              <b className="num">{active.length}</b> session{active.length === 1 ? '' : 's'} on
            </span>
            {hot ? (
              <span className="warn-text">
                <b className="num">{hot}</b> past {CONTEXT_WARN_PCT}% context
              </span>
            ) : null}
            <span>
              <b className="num">{money(crew.costs?.totalUsd ?? crew.usage.todayCostUsd)}</b> spent
            </span>
          </>
        }
      />
      <Section title="Sessions" count={active.length} meta={<FeedNote feed={crew.feeds.crew} now={now} />}>
        {active.length ? (
          <ul className="sessions">
            {active.map((s) => (
              <SessionRow key={s.id} crew={crew} s={s} now={now} />
            ))}
          </ul>
        ) : (
          <Empty title="No session is running.">The Mate starts engineers and agents as work comes in. Open resumes a real session; Compact frees up its context between its turns.</Empty>
        )}
        {earlier.length ? (
          <details className="earlier">
            <summary>Earlier sessions · {earlier.length}</summary>
            <ul className="sessions">
              {earlier.map((s) => (
                <SessionRow key={s.id} crew={crew} s={s} now={now} />
              ))}
            </ul>
          </details>
        ) : null}
      </Section>
      <Section title="Spend" meta={null} id="crew-spend">
        <Spend crew={crew} now={now} />
      </Section>
      <Section title="Watches" count={crew.schedules.length || undefined}>
        <Jobs crew={crew} now={now} />
      </Section>
      <Section title="Throughput">
        <Throughput />
      </Section>
    </div>
  );
}
