/** The comms digest: threads in mail and Teams that need the captain, ranked, each with a reply draft. */
import { useState } from 'react';
import { api } from '../../lib/api';
import { isAnswerable } from '../../lib/answers';
import { useCrewStore } from '../../lib/store';
import type { CardItem, InboxItem } from '../../types';
import { CopyButton, Details, Icon, Pill } from '../common';
import { Markdown } from '../Markdown';
import { Options, PostLine, ReadOnly, Recommendation, useDecide } from './parts';

const CHANNEL: Record<string, string> = { email: 'Email', 'teams-chat': 'Teams chat', 'teams-channel': 'Teams channel' };

function DigestItem({ card, it, canWrite, now }: { card: InboxItem; it: CardItem; canWrite: boolean; now: number }) {
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
    <li className="digest-item">
      <div className="di-h">
        <Pill tone="neutral">{CHANNEL[it.channel] ?? (it.channel || 'Thread')}</Pill>
        {it.due ? <Pill tone={/today|overdue/i.test(it.due) ? 'you' : 'muted'}>Due {it.due}</Pill> : null}
        <span className="faint">{it.from}</span>
      </div>
      <b className="di-t">{it.link ? <a href={it.link} target="_blank" rel="noopener noreferrer">{it.title}</a> : it.title}</b>
      {it.ask ? <p>{it.ask}</p> : null}
      {it.draft ? (
        <Details label="Suggested reply" openLabel="Hide the reply">
          <pre className="paper">{it.draft}</pre>
          <CopyButton text={it.draft} label="Copy the reply" className="btn xs ghost" />
          {it.post ? <PostLine post={it.post} grant={it.postGrant} now={now} /> : null}
        </Details>
      ) : null}
      {isAnswerable(card, it) ? (
        it.answer ? (
          <p className="answered">
            <Icon name="check" /> You answered “{it.answer}”{it.postGrant ? ', approved to post once' : ''}.
          </p>
        ) : canWrite ? (
          <Options item={{ options: it.options, recommendation: it.recommendation, neverAskKey: null, post: it.post }} busy={busy} allowFree={false} onAnswer={(a, o) => void answer(a, o.post)} />
        ) : null
      ) : null}
    </li>
  );
}

export function DigestCard({ item, now }: { item: InboxItem; now: number }) {
  const canWrite = useCrewStore().crew?.access.canWrite === true;
  const { busy, decide } = useDecide(item);
  return (
    <>
      {item.body ? <Markdown text={item.body} /> : null}
      <ol className="digest">
        {item.items.map((it) => (
          <DigestItem key={it.id} card={item} it={it} canWrite={canWrite} now={now} />
        ))}
      </ol>
      {item.notes ? (
        <Details label="The whole digest" openLabel="Hide the digest">
          <Markdown text={item.notes} />
        </Details>
      ) : null}
      <Recommendation item={item} />
      {item.status !== 'open' ? null : canWrite ? <Options item={item} busy={busy} onAnswer={(a, o) => void decide(o.post ? 'post' : 'answer', a, { neverAsk: o.neverAsk })} /> : <ReadOnly />}
    </>
  );
}
