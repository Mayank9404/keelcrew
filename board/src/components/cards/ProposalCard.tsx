/** A proposal: a ticket, fix or review the crew would start, why now, and how sure the proposer is. */
import { isJiraKey } from '../../lib/derive';
import { useCrewStore } from '../../lib/store';
import type { InboxItem } from '../../types';
import { Details, ShareBar } from '../common';
import { Markdown } from '../Markdown';
import { SkipTicket } from '../SkipTicket';
import { Options, ReadOnly, Recommendation, useDecide } from './parts';

/** A suggestion's source, and "security" for a security finding, in the card's head. */
export function SourceTags({ item }: { item: InboxItem }) {
  if (item.from !== 'suggest') return null;
  const security = item.security || item.source === 'security';
  return (
    <>
      {item.source && item.source !== 'security' ? <span className="tag">{item.source}</span> : null}
      {security ? <span className="tag block">security</span> : null}
    </>
  );
}

export function ProposalCard({ item }: { item: InboxItem }) {
  const crew = useCrewStore().crew;
  const canWrite = crew?.access.canWrite === true;
  const { busy, decide } = useDecide(item);
  const p = item.proposal;
  const skipped = !!item.taskKey && !!crew?.config.intake.skipKeys.includes(item.taskKey);
  return (
    <>
      {item.body ? <Markdown text={item.body} /> : null}
      {item.rationale || item.confidence != null ? (
        <div className="why">
          {item.rationale ? (
            <p>
              <span className="eyebrow">Why now</span> {item.rationale}
            </p>
          ) : null}
          {item.confidence != null ? (
            <span className="conf">
              <span className="eyebrow">Confidence</span>
              <ShareBar share={item.confidence} tone={item.confidence >= 0.8 ? 'ok' : item.confidence >= 0.6 ? 'work' : 'warn'} label={`${Math.round(item.confidence * 100)}% confident`} />
              <b className="num">{Math.round(item.confidence * 100)}%</b>
            </span>
          ) : null}
        </div>
      ) : null}
      {p ? (
        <Details label={p.title ? `What would start: ${p.title}` : 'What would start'} openLabel="Hide the proposal">
          <dl className="kv">
            {p.repo ? (
              <>
                <dt>Repo</dt>
                <dd className="mono">{p.repo}</dd>
              </>
            ) : null}
            {p.difficulty ? (
              <>
                <dt>Difficulty</dt>
                <dd>{p.difficulty}</dd>
              </>
            ) : null}
            {p.jiraKey ? (
              <>
                <dt>Jira</dt>
                <dd className="mono">{p.jiraKey}</dd>
              </>
            ) : null}
            {p.prUrl ? (
              <>
                <dt>PR</dt>
                <dd>
                  <a href={p.prUrl} target="_blank" rel="noopener noreferrer">
                    {p.prUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '')}
                  </a>
                </dd>
              </>
            ) : null}
            {item.fingerprint ? (
              <>
                <dt>Fingerprint</dt>
                <dd className="mono small">{item.fingerprint}</dd>
              </>
            ) : null}
          </dl>
          {p.description ? <Markdown text={p.description} /> : null}
        </Details>
      ) : null}
      <Recommendation item={item} />
      {item.status !== 'open' ? null : canWrite ? (
        <Options
          item={item}
          busy={busy}
          onAnswer={(a, o) => void decide('answer', a, { neverAsk: o.neverAsk })}
          extra={item.taskKey && isJiraKey(item.taskKey) ? <SkipTicket taskKey={item.taskKey} skipped={skipped} /> : null}
        />
      ) : (
        <ReadOnly />
      )}
    </>
  );
}
