/** Questions the Mate held for a question window, answered one at a time. */
import { useState } from 'react';
import { api } from '../../lib/api';
import { batchProgress } from '../../lib/answers';
import { useCrewStore } from '../../lib/store';
import type { CardItem, InboxItem } from '../../types';
import { Icon, KeyLink, Pill, cls } from '../common';
import { Markdown } from '../Markdown';
import { Options, Recommendation } from './parts';

function BatchItem({ card, it, next, canWrite }: { card: InboxItem; it: CardItem; next: boolean; canWrite: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const answer = async (a: string, post: boolean) => {
    setBusy(a);
    try {
      await api.answerCardItem(card, it.id, a, { post });
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className={cls('batch-item', it.answer && 'done', next && 'next', it.urgent && 'urgent')}>
      <div className="bi-h">
        {it.answer ? <Icon name="check" className="ok-text" /> : <span className="bi-n" aria-hidden="true" />}
        <b>{it.title}</b>
        {it.urgent ? <Pill tone="block">Urgent</Pill> : null}
        {it.taskKey ? <KeyLink k={it.taskKey} /> : null}
      </div>
      {it.answer ? (
        <p className="answered">You answered “{it.answer}”.</p>
      ) : (
        <>
          {it.summary ? <Markdown text={it.summary} /> : null}
          <Recommendation item={{ recommendation: it.recommendation, from: 'lead' }} />
          {canWrite ? <Options item={{ options: it.options, recommendation: it.recommendation, neverAskKey: null, post: it.post }} busy={busy} onAnswer={(a, o) => void answer(a, o.post)} /> : null}
        </>
      )}
    </li>
  );
}

export function BatchCard({ item }: { item: InboxItem }) {
  const canWrite = useCrewStore().crew?.access.canWrite === true;
  const p = batchProgress(item);
  return (
    <>
      <div className="facts">
        <span className="fact num">
          {p.answered} of {p.total} answered
        </span>
        <span className="progress" role="img" aria-label={`${p.answered} of ${p.total} answered`}>
          {item.items.map((it) => (
            <i key={it.id} className={it.answer ? 'on' : ''} />
          ))}
        </span>
      </div>
      {item.body ? <Markdown text={item.body} /> : null}
      <ol className="batch">
        {item.items.map((it) => (
          <BatchItem key={it.id} card={item} it={it} next={p.next?.id === it.id} canWrite={canWrite} />
        ))}
      </ol>
    </>
  );
}
