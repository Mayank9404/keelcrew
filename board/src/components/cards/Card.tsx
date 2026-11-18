/** One card waiting on the captain, drawn by what it is; or, once answered, one line saying how it ended. */
import { isAutoApproved, outcome } from '../../lib/inbox';
import { useCrewStore } from '../../lib/store';
import { VARIANT_LABEL, cardVariant } from '../../lib/triage';
import type { InboxItem } from '../../types';
import { Icon, KeyLink, cls, useNow } from '../common';
import { Manifest } from '../desk/Manifest';
import { Signature } from '../desk/Signature';
import { Markdown } from '../Markdown';
import { RiskPill } from '../parts/RiskBlock';
import { BatchCard } from './BatchCard';
import { DigestCard } from './DigestCard';
import { DraftCard } from './DraftCard';
import { ConflictCard, PlaybookCard } from './LearnerCards';
import { ProposalCard, SourceTags } from './ProposalCard';
import { QaCard } from './QaCard';
import { StartCard } from './StartCard';
import { CardHead, Options, ReadOnly, Recommendation, sevClass, useDecide } from './parts';

function QuestionCard({ item }: { item: InboxItem }) {
  const canWrite = useCrewStore().crew?.access.canWrite === true;
  const { busy, decide } = useDecide(item);
  return (
    <>
      {item.body ? <Markdown text={item.body} /> : null}
      <Recommendation item={item} />
      {canWrite ? <Options item={item} busy={busy} onAnswer={(a, o) => void decide(o.post ? 'post' : 'answer', a, { neverAsk: o.neverAsk })} /> : <ReadOnly />}
    </>
  );
}

function InfoCard({ item }: { item: InboxItem }) {
  const canWrite = useCrewStore().crew?.access.canWrite === true;
  const { busy, decide } = useDecide(item);
  return (
    <>
      {item.body ? <Markdown text={item.body} /> : null}
      {canWrite ? (
        <div className="opt-row">
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void decide('dismiss')}>
            Got it
          </button>
        </div>
      ) : null}
    </>
  );
}

/** What a waiting item shows and asks, by what it is. A change to sign shows its manifest, then the signature block. */
export function CardBody({ item, now }: { item: InboxItem; now: number }) {
  switch (cardVariant(item)) {
    case 'ship':
      return (
        <>
          <Manifest item={item} now={now} nested />
          <Signature item={item} now={now} nested />
        </>
      );
    case 'qa':
      return <QaCard item={item} now={now} />;
    case 'proposal':
      return <ProposalCard item={item} />;
    case 'start':
      return <StartCard item={item} />;
    case 'playbook':
      return <PlaybookCard item={item} />;
    case 'conflict':
      return <ConflictCard item={item} />;
    case 'batch':
      return <BatchCard item={item} />;
    case 'digest':
      return <DigestCard item={item} now={now} />;
    case 'draft':
      return <DraftCard item={item} now={now} />;
    case 'info':
      return <InfoCard item={item} />;
    default:
      return <QuestionCard item={item} />;
  }
}

/** An answered (or withdrawn) card in one line. */
export function ResolvedCard({ item }: { item: InboxItem }) {
  return (
    <div className={cls('resolved', item.withdrawn && 'withdrawn', isAutoApproved(item) && 'auto')}>
      <span className="kind">{VARIANT_LABEL[cardVariant(item)]}</span>
      {item.taskKey ? <KeyLink k={item.taskKey} /> : null}
      <span className="r-title">{item.title}</span>
      <span className="r-out">{outcome(item)}</span>
    </div>
  );
}

/** Why an open item needs another look: the Mate withdrew it, or the Mac couldn't carry out the last answer. */
export function CardNotes({ item }: { item: InboxItem }) {
  return (
    <>
      {item.withdrawn ? (
        <p className="withdrawn-note">
          <Icon name="alert" /> Withdrawn by the Mate: {item.withdrawn}
        </p>
      ) : null}
      {item.grantError ? (
        <p className="withdrawn-note">
          <Icon name="alert" /> Your Mac couldn’t carry out your last answer: {item.grantError.replace(/\.\s*$/, '')}. Answer again.
        </p>
      ) : null}
    </>
  );
}

/** A card. Answered cards collapse to their outcome. */
export function Card({ item }: { item: InboxItem }) {
  const now = useNow(60_000);
  if (item.status !== 'open') return <ResolvedCard item={item} />;
  const right = item.kind === 'ship' ? <RiskPill risk={item.risk} /> : item.kind === 'proposal' ? <SourceTags item={item} /> : null;
  return (
    <article className={cls('card', sevClass(item), item.urgent && 'urgent', item.withdrawn && 'withdrawn')} id={`card-${item.id}`} aria-label={`${VARIANT_LABEL[cardVariant(item)]}: ${item.title}`}>
      <CardHead item={item} now={now} right={right} />
      <h3>{item.title || VARIANT_LABEL[cardVariant(item)]}</h3>
      <CardNotes item={item} />
      <CardBody item={item} now={now} />
    </article>
  );
}
