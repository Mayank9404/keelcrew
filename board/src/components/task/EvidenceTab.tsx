/** Everything the agents attached to a task, newest first, filterable by kind; structured kinds render as such. */
import { useEffect, useMemo, useState } from 'react';
import { fromLabel } from '../../labels';
import { dayTime } from '../../lib/format';
import type { Evidence, EvidenceKind, TaskDetail } from '../../types';
import { CopyButton, Empty, Pill, cls, type Tone } from '../common';
import { Markdown } from '../Markdown';
import { HandoffView, Walkthrough } from '../parts/EvidenceViews';
import { DiffView } from './DiffTab';

const KIND: Record<EvidenceKind, { label: string; tone: Tone }> = {
  handoff: { label: 'Handoff', tone: 'you' },
  walkthrough: { label: 'Walkthrough', tone: 'work' },
  context: { label: 'Context', tone: 'neutral' },
  plan: { label: 'Plan', tone: 'neutral' },
  command: { label: 'Command', tone: 'neutral' },
  response: { label: 'Response', tone: 'neutral' },
  diff: { label: 'Diff', tone: 'neutral' },
  review: { label: 'Review', tone: 'work' },
  qa: { label: 'QA', tone: 'qa' },
  screenshot: { label: 'Screenshot', tone: 'neutral' },
  note: { label: 'Note', tone: 'muted' },
};

function Body({ e }: { e: Evidence }) {
  if (e.handoff) return <HandoffView h={e.handoff} />;
  if (e.walkthrough) return <Walkthrough groups={e.walkthrough} />;
  if (e.kind === 'diff') return <DiffView text={e.content} />;
  if (e.kind === 'command' || e.kind === 'response') return <pre className="block">{e.content}</pre>;
  return <Markdown text={e.content} />;
}

export function EvidenceTab({ detail, error, focus }: { detail: TaskDetail | null; error: string | null; focus: string | null }) {
  const [kind, setKind] = useState<EvidenceKind | 'all'>('all');
  const list = useMemo(() => [...(detail?.evidence ?? [])].sort((a, b) => b.createdAt - a.createdAt), [detail]);
  useEffect(() => {
    if (!focus || !list.length) return;
    requestAnimationFrame(() => {
      const el = document.getElementById(`evidence-${focus}`);
      el?.scrollIntoView({ block: 'start' });
      el?.classList.add('flash');
    });
  }, [focus, list.length]);
  if (!detail) return <p className="note">{error ?? 'Loading evidence…'}</p>;
  if (!list.length) return <Empty title="No evidence yet.">Agents attach plans, commands and responses, reviews, walkthroughs, QA cases and handoffs here as they work.</Empty>;
  const kinds = [...new Set(list.map((e) => e.kind))];
  const shown = kind === 'all' ? list : list.filter((e) => e.kind === kind);
  return (
    <div className="evidence">
      {kinds.length > 1 ? (
        <div className="seg wrap" role="group" aria-label="Kind">
          <button type="button" aria-pressed={kind === 'all'} onClick={() => setKind('all')}>
            All <span className="num">{list.length}</span>
          </button>
          {kinds.map((k) => (
            <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
              {KIND[k].label} <span className="num">{list.filter((e) => e.kind === k).length}</span>
            </button>
          ))}
        </div>
      ) : null}
      {shown.map((e) => (
        <article key={e.id} id={`evidence-${e.id}`} className={cls('ev', focus === e.id && 'focus')}>
          <div className="ev-h">
            <Pill tone={KIND[e.kind].tone}>{KIND[e.kind].label}</Pill>
            {e.tags.includes('eval-case') ? <Pill tone="qa">Eval case</Pill> : null}
            <b>{e.title}</b>
            <span className="faint">
              {e.agent ? `${fromLabel(e.agent)} · ` : ''}
              {dayTime(e.createdAt)}
            </span>
            <span className="grow" />
            <span className="mono faint small">{e.id}</span>
            {e.kind === 'command' || e.kind === 'response' ? <CopyButton text={e.content} className="btn xs ghost" /> : null}
          </div>
          <Body e={e} />
        </article>
      ))}
    </div>
  );
}
