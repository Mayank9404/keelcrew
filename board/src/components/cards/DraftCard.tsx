/** A draft from the writer, the reviewer or the release captain: read it here, then approve it to post once. */
import { useState } from 'react';
import { useCrewStore } from '../../lib/store';
import type { InboxItem } from '../../types';
import { CopyButton, Details } from '../common';
import { Markdown } from '../Markdown';
import { Options, PostLine, ReadOnly, Recommendation, useDecide } from './parts';

const CHANNEL: Record<string, string> = {
  confluence: 'Confluence page',
  'jira-comment': 'Jira comment',
  'pr-description': 'PR description',
  'github-review': 'GitHub review',
  email: 'Email',
  teams: 'Teams message',
  doc: 'Document',
};

const PREVIEW_LINES = 14;

export function DraftCard({ item, now }: { item: InboxItem; now: number }) {
  const canWrite = useCrewStore().crew?.access.canWrite === true;
  const { busy, decide } = useDecide(item);
  const [all, setAll] = useState(false);
  const d = item.draft!;
  const lines = d.body.split('\n');
  const long = lines.length > PREVIEW_LINES;
  return (
    <>
      {item.body ? <Markdown text={item.body} /> : null}
      <div className="draft">
        <div className="draft-h">
          <b>{CHANNEL[d.channel] ?? (d.channel || 'Draft')}</b>
          {d.destination ? <span className="faint">→ {d.destination}</span> : null}
          {d.mode ? <span className="faint">· {d.mode === 'update' ? 'updates it' : 'creates it'}</span> : null}
          <span className="grow" />
          <CopyButton text={d.subject ? `${d.subject}\n\n${d.body}` : d.body} label="Copy" className="btn xs ghost" />
        </div>
        {d.subject ? <p className="draft-subject">{d.subject}</p> : null}
        <div className={all || !long ? 'paper' : 'paper clipped'}>
          <Markdown text={all || !long ? d.body : lines.slice(0, PREVIEW_LINES).join('\n')} />
        </div>
        {long ? (
          <button type="button" className="link small" onClick={() => setAll((a) => !a)}>
            {all ? 'Show less' : `Show all ${lines.length} lines`}
          </button>
        ) : null}
        {d.comments.length ? (
          <Details label={`${d.comments.length} inline comment${d.comments.length === 1 ? '' : 's'}`} openLabel="Hide the comments">
            <ul className="draft-comments">
              {d.comments.map((c, i) => (
                <li key={`${c.path}${c.line}${i}`}>
                  <span className="mono">
                    {c.path}
                    {c.line != null ? `:${c.line}` : ''}
                  </span>
                  <span>{c.body}</span>
                </li>
              ))}
            </ul>
          </Details>
        ) : null}
        <PostLine post={item.post} grant={item.postGrant} now={now} />
      </div>
      <Recommendation item={item} />
      {item.status !== 'open' ? null : canWrite ? <Options item={item} busy={busy} onAnswer={(a, o) => void decide(o.post ? 'post' : 'answer', a, { neverAsk: o.neverAsk })} /> : <ReadOnly />}
    </>
  );
}
