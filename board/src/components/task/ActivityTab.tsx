import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { sessionRole } from '../../labels';
import { api } from '../../lib/api';
import { clock, toolName, toMs } from '../../lib/format';
import type { CrewEvent, CrewState, Task, TaskDetail } from '../../types';

const KIND_TEXT: Record<CrewEvent['kind'], string> = {
  user: 'message',
  tool: 'tool',
  turn_end: 'turn end',
  crew: 'crew',
};

function EventRow({ ev, who }: { ev: CrewEvent; who: string | null }) {
  const label = ev.kind === 'tool' ? toolName(ev.tool) || 'tool' : KIND_TEXT[ev.kind];
  const cls = ev.isError ? 'k-error' : ev.kind === 'user' ? 'k-user' : ev.kind === 'crew' ? 'k-crew' : '';
  return (
    <div className={ev.isError ? 'ev err' : 'ev'}>
      <span className="tm">{clock(ev.ts)}</span>
      <span className={`tl ${cls}`} title={ev.tool ?? ev.kind}>
        {label}
      </span>
      <span className="sm">
        {who ? <span className="who">{who} · </span> : null}
        {ev.summary}
      </span>
    </div>
  );
}

/** Live events for this task plus older pages from the session log. */
export function ActivityTab({ crew, task, detail, live }: { crew: CrewState; task: Task; detail: TaskDetail | null; live: CrewEvent[] }) {
  const [older, setOlder] = useState<CrewEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const events = useMemo(() => {
    const map = new Map<number, CrewEvent>();
    for (const e of older) map.set(e.id, e);
    for (const e of detail?.events ?? []) map.set(e.id, { ...map.get(e.id), ...e });
    for (const e of live) if (e.taskKey === task.key && !map.has(e.id)) map.set(e.id, e);
    return [...map.values()].sort((a, b) => toMs(a.ts) - toMs(b.ts) || a.id - b.id);
  }, [older, detail, live, task.key]);
  const roles = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of [...crew.sessions, ...(detail?.sessions ?? [])]) m.set(s.id, sessionRole(s));
    return m;
  }, [crew.sessions, detail]);
  const multi = new Set(events.map(e => e.sessionId)).size > 1;

  const count = events.length;
  useLayoutEffect(() => {
    const body = endRef.current?.closest('.dr-body');
    if (!body) return;
    if (body.scrollHeight - body.scrollTop - body.clientHeight < 140 || count < 40) endRef.current?.scrollIntoView({ block: 'end' });
  }, [count]);
  useEffect(() => {
    setOlder([]);
    setExhausted(false);
  }, [task.key]);

  const loadOlder = async () => {
    const oldest = events[0];
    const sid = oldest?.sessionId ?? task.sessionId;
    if (!sid) return;
    setLoading(true);
    try {
      const page = await api.sessionEvents(sid, oldest?.id, 200);
      if (!page.length) setExhausted(true);
      setOlder(prev => [...page, ...prev]);
    } catch {
      /* toasted */
    } finally {
      setLoading(false);
    }
  };

  if (!detail && !events.length) return <p className="empty">Loading activity…</p>;
  return (
    <div className="events" aria-live="polite">
      {events.length && (task.sessionId || events[0]?.sessionId) && !exhausted ? (
        <button type="button" className="link" style={{ alignSelf: 'flex-start', marginBottom: 6 }} disabled={loading} onClick={loadOlder}>
          {loading ? 'Loading…' : 'Load older'}
        </button>
      ) : null}
      {!events.length ? <p className="empty">No activity yet.</p> : null}
      {events.map(e => (
        <EventRow key={e.id} ev={e} who={multi ? roles.get(e.sessionId) ?? null : null} />
      ))}
      <div ref={endRef} />
    </div>
  );
}
