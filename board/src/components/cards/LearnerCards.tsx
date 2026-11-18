/** The learner's cards: standing order changes to approve, and two lessons that contradict each other. */
import { useState } from 'react';
import { fromLabel } from '../../labels';
import { useCrewStore } from '../../lib/store';
import type { CardLesson, InboxItem } from '../../types';
import { Details, Pill, type Tone } from '../common';
import { Markdown } from '../Markdown';
import { AnswerBox, Options, ReadOnly, Recommendation, useDecide } from './parts';

const STATUS_TONE: Record<string, Tone> = { candidate: 'warn', active: 'ok', pinned: 'agent', retired: 'muted' };

function LessonLine({ l }: { l: CardLesson }) {
  return (
    <li className="lesson-line">
      <div className="ll-h">
        <span className="mono">{l.key}</span>
        {l.status ? <Pill tone={STATUS_TONE[l.status] ?? 'neutral'}>{l.status}</Pill> : null}
        {l.confidence != null ? <span className="faint num">{Math.round(l.confidence * 100)}%</span> : null}
        {l.scope ? <span className="faint">{l.scope}</span> : null}
      </div>
      <p>{l.text}</p>
      {l.evidence.length ? <p className="faint small">Evidence: {l.evidence.slice(0, 3).join(' · ')}{l.evidence.length > 3 ? ` and ${l.evidence.length - 3} more` : ''}</p> : null}
    </li>
  );
}

/** A unified diff of the standing orders, with added and removed lines marked. */
function PlaybookDiff({ text }: { text: string }) {
  return (
    <pre className="block pdiff">
      {text.split('\n').map((l, i) => (
        <span key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : ''}>
          {l}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

function Commands({ item }: { item: InboxItem }) {
  if (!item.commands.length) return null;
  return (
    <Details label="What each answer runs" openLabel="Hide the commands">
      <ul className="commands">
        {item.commands.map((c) => (
          <li key={c.option}>
            <b>{c.option}</b>
            {c.commands.map((cmd) => (
              <code key={cmd}>{cmd}</code>
            ))}
          </li>
        ))}
      </ul>
    </Details>
  );
}

export function PlaybookCard({ item }: { item: InboxItem }) {
  const canWrite = useCrewStore().crew?.access.canWrite === true;
  const { busy, decide } = useDecide(item);
  const [noting, setNoting] = useState(false);
  return (
    <>
      {item.body ? <Markdown text={item.body} /> : null}
      {item.lessons.length ? (
        <ul className="lesson-lines">
          {item.lessons.map((l) => (
            <LessonLine key={l.key} l={l} />
          ))}
        </ul>
      ) : null}
      {item.diff ? (
        <Details label="What changes" openLabel="Hide the diff">
          <PlaybookDiff text={item.diff} />
        </Details>
      ) : null}
      <Commands item={item} />
      <Recommendation item={item} />
      {item.status !== 'open' ? null : !canWrite ? (
        <ReadOnly />
      ) : noting ? (
        <AnswerBox placeholder="Keys to leave out, and why" submitLabel="Approve the rest" onSubmit={(t) => void decide('answer', 'Approve', { note: t })} onCancel={() => setNoting(false)} />
      ) : (
        <Options
          item={item}
          busy={busy}
          allowFree={false}
          onAnswer={(a) => void decide('answer', a)}
          extra={
            item.options.includes('Approve') ? (
              <button type="button" className="btn ghost" onClick={() => setNoting(true)} disabled={busy !== null}>
                Approve some…
              </button>
            ) : null
          }
        />
      )}
    </>
  );
}

export function ConflictCard({ item }: { item: InboxItem }) {
  const canWrite = useCrewStore().crew?.access.canWrite === true;
  const { busy, decide } = useDecide(item);
  return (
    <>
      {item.body ? <Markdown text={item.body} /> : null}
      {item.lessons.length ? (
        <div className="conflict">
          {item.lessons.map((l, i) => (
            <div className="side" key={`${l.key}${i}`}>
              <span className="eyebrow">{i === 0 ? 'One lesson' : 'The other'}</span>
              <LessonLine l={l} />
            </div>
          ))}
        </div>
      ) : null}
      <Commands item={item} />
      <Recommendation item={{ ...item, from: item.from || fromLabel('learner') }} />
      {item.status !== 'open' ? null : canWrite ? <Options item={item} busy={busy} onAnswer={(a, o) => void decide('answer', a, { neverAsk: o.neverAsk })} /> : <ReadOnly />}
    </>
  );
}
