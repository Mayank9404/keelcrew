/** Pieces every card uses: answering, the option buttons, the recommendation and the header. */
import { useState, type ReactNode } from 'react';
import { fromLabel } from '../../labels';
import { isPostingOption } from '../../lib/answers';
import { api, type InboxDecision } from '../../lib/api';
import { ago } from '../../lib/format';
import { READ_ONLY_NOTE } from '../../lib/owner';
import { patchCrew } from '../../lib/store';
import { VARIANT_LABEL, cardSeverity, cardVariant } from '../../lib/triage';
import type { InboxItem } from '../../types';
import { Icon, KeyLink, Pill } from '../common';
import { Markdown } from '../Markdown';

/** Answers a card and folds the result in before the database's own snapshot arrives. */
export function useDecide(item: InboxItem) {
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (decision: InboxDecision, answer?: string, opts: { neverAsk?: boolean; note?: string } = {}): Promise<boolean> => {
    setBusy(answer ?? decision);
    try {
      const next = await api.decideInbox(item, decision, answer, opts);
      patchCrew((h) => ({ ...h, inbox: h.inbox.map((i) => (i.id === next.id ? next : i)) }));
      return true;
    } catch {
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, decide };
}

/** A free-text answer box revealed on demand. */
export function AnswerBox({ placeholder, submitLabel, onSubmit, onCancel, danger, optional }: { placeholder: string; submitLabel: string; onSubmit: (text: string) => void; onCancel: () => void; danger?: boolean; optional?: boolean }) {
  const [text, setText] = useState('');
  const ok = optional || !!text.trim();
  return (
    <form
      className="answer-box"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSubmit(text.trim());
      }}
    >
      <textarea
        rows={2}
        value={text}
        autoFocus
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (ok) onSubmit(text.trim());
          }
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="row-actions">
        <button type="submit" className={danger ? 'btn sm danger' : 'btn sm primary'} disabled={!ok}>
          {submitLabel}
        </button>
        <button type="button" className="btn sm ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The posting agent's recommendation. */
export function Recommendation({ item }: { item: Pick<InboxItem, 'recommendation' | 'from'> }) {
  if (!item.recommendation) return null;
  return (
    <div className="recommend">
      <span className="eyebrow">{fromLabel(item.from)} recommends</span>
      <Markdown text={item.recommendation} />
    </div>
  );
}

export const ReadOnly = () => <p className="note">{READ_ONLY_NOTE}</p>;

/** Kind, urgency, task key, who posted it and when; extra pills on the right. */
export function CardHead({ item, now, right }: { item: InboxItem; now: number; right?: ReactNode }) {
  const v = cardVariant(item);
  return (
    <div className="card-head">
      <span className="kind">{VARIANT_LABEL[v]}</span>
      {item.urgent ? (
        <Pill tone="block" solid icon="flag">
          Urgent
        </Pill>
      ) : null}
      {item.taskKey ? <KeyLink k={item.taskKey} /> : null}
      <span className="from">
        {fromLabel(item.from)} · {ago(item.createdAt, now)}
      </span>
      <span className="grow" />
      {right}
    </div>
  );
}

/** The severity class for a card's stripe. */
export const sevClass = (item: InboxItem): string => `sev-${cardSeverity(item)}`;

/**
 * Option buttons (the recommended one first and marked), a free answer, and "Don't ask me again" when the card has a
 * never-ask key. A posting option on a card that says where it posts becomes "Approve and post".
 */
export function Options({
  item,
  busy,
  onAnswer,
  options = item.options,
  allowFree = true,
  canPost = !!item.post,
  extra,
}: {
  item: Pick<InboxItem, 'options' | 'recommendation' | 'neverAskKey' | 'post'>;
  busy: string | null;
  onAnswer: (answer: string, opts: { neverAsk: boolean; post: boolean }) => void;
  options?: string[];
  allowFree?: boolean;
  canPost?: boolean;
  extra?: ReactNode;
}) {
  const [writing, setWriting] = useState(false);
  const [neverAsk, setNeverAsk] = useState(false);
  const disabled = busy !== null;
  if (writing) return <AnswerBox placeholder="Your answer" submitLabel="Send answer" onSubmit={(t) => onAnswer(t, { neverAsk, post: false })} onCancel={() => setWriting(false)} />;
  const recommended = item.recommendation ? options.find((o) => new RegExp(`(^|\\W)${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`, 'i').test(item.recommendation!)) ?? options[0] : null;
  return (
    <div className="options">
      <div className="opt-row">
        {options.map((o) => {
          const post = canPost && isPostingOption(o);
          const rec = o === recommended;
          return (
            <button key={o} type="button" className={post ? 'btn primary post' : rec ? 'btn primary' : 'btn'} disabled={disabled} onClick={() => onAnswer(o, { neverAsk, post })} title={post ? 'Records your answer, then lets the crew make exactly this one post' : undefined}>
              {busy === o ? 'Sending…' : post ? (
                <>
                  <Icon name="check" />
                  Approve and post
                  <span className="opt-sub">{o}</span>
                </>
              ) : (
                o
              )}
            </button>
          );
        })}
        {allowFree ? (
          <button type="button" className={options.length ? 'btn ghost' : 'btn primary'} onClick={() => setWriting(true)} disabled={disabled}>
            {options.length ? 'Other answer…' : 'Answer'}
          </button>
        ) : null}
        {extra}
      </div>
      {item.neverAskKey ? (
        <label className="check">
          <input type="checkbox" checked={neverAsk} onChange={(e) => setNeverAsk(e.target.checked)} />
          Don’t ask me this again
        </label>
      ) : null}
    </div>
  );
}

/** Where an approved draft goes, and whether the one-shot grant is in place. */
export function PostLine({ post, grant, now }: { post: InboxItem['post']; grant: InboxItem['postGrant']; now: number }) {
  if (!post) return <p className="note">The crew can’t post this one; once you approve, copy it and send it yourself.</p>;
  const tool = post.tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').replace(/^mcp__/, '');
  return (
    <p className="post-line">
      <Icon name="lock" />
      <span>
        Posts once with <code>{tool}</code>
        {post.match ? (
          <>
            {' '}
            to <code>{post.match}</code>
          </>
        ) : null}
        {grant ? <b className="ok-text"> · approved{grant.expires ? `, valid ${grant.expires > now ? `for ${Math.max(1, Math.round((grant.expires - now) / 60_000))} min` : 'until it was used or expired'}` : ''}</b> : null}
      </span>
    </p>
  );
}
