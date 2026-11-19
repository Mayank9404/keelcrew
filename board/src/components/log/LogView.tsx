/** Log: what happened, newest first, by day. An entry still waiting for you opens that item on the desk. */
import { useMemo, useState } from 'react';
import { LEAD, fromLabel } from '../../labels';
import { DAY, clock } from '../../lib/format';
import { byDay, logEntries } from '../../lib/log';
import { ui } from '../../lib/ui';
import type { CrewState } from '../../types';
import { Empty, KeyLink, PageHeader, cls, useNow } from '../common';

const PAGE = 120;

const whoLabel = (who: string): string => (who === 'you' ? 'You' : who === 'lead' ? LEAD : who === 'keelcrew' ? 'Keelcrew' : fromLabel(who));

function dayLabel(day: number, now: number): string {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - day) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(day).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

export function LogView({ crew }: { crew: CrewState }) {
  const now = useNow(60_000);
  const [shown, setShown] = useState(PAGE);
  const all = useMemo(() => logEntries(crew), [crew]);
  const days = byDay(all.slice(0, shown));
  const today = all.filter((e) => now - e.ts < DAY).length;
  const waiting = all.filter((e) => e.waitingId).length;
  return (
    <div className="view log">
      <PageHeader
        title="Log"
        status={
          <>
            <span>
              <b className="num">{today}</b> in the last day
            </span>
            <span className={waiting ? 'you-text' : ''}>
              <b className="num">{waiting}</b> still waiting for you
            </span>
          </>
        }
      />
      {days.length ? (
        days.map((d) => (
          <section key={d.day} className="log-day" aria-label={dayLabel(d.day, now)}>
            <h2>{dayLabel(d.day, now)}</h2>
            <ol className="log-list">
              {d.entries.map((e) => (
                <li key={e.id} className={cls('log-row', `lt-${e.tone}`)}>
                  <span className="log-t num">{clock(e.ts)}</span>
                  <span className="log-who">{whoLabel(e.who)}</span>
                  <span className="log-text">
                    {e.taskKey ? <KeyLink k={e.taskKey} /> : null} {e.text}
                    {e.waitingId ? (
                      <button type="button" className="log-wait" onClick={() => ui.showCard(e.waitingId!)}>
                        Waiting for you
                      </button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ))
      ) : (
        <Empty title="Nothing has happened yet.">Tasks starting, agents reporting, items sent for your signature and your answers show here in time order.</Empty>
      )}
      {all.length > shown ? (
        <button type="button" className="btn" onClick={() => setShown((n) => n + PAGE)}>
          Show older entries
        </button>
      ) : null}
    </div>
  );
}
