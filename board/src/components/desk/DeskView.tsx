/**
 * Sign-offs: the desk. One waiting item at a time, most urgent first, with its full document on the left and, for a
 * change that wants to leave, the signature block on the right. The desk keeps the item it shows until you pick
 * another or answer it, so a new or re-ranked item never swaps in under your cursor; after an answer it waits for
 * you to ask for the next one.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { LEAD, fromLabel } from '../../labels';
import { DAY, ago } from '../../lib/format';
import { isAutoApproved } from '../../lib/inbox';
import { VARIANT_LABEL, cardVariant, cardsForYou, heldCards, nextWindow, stuckItems } from '../../lib/triage';
import { ui, useUi } from '../../lib/ui';
import type { CrewState, InboxItem } from '../../types';
import { Card, CardBody, CardNotes, ResolvedCard } from '../cards/Card';
import { Details, Icon, KeyLink, Pill, cls, useNow } from '../common';
import { RiskPill } from '../parts/RiskBlock';
import { Manifest } from './Manifest';
import { Signature } from './Signature';

type HeadRef = RefObject<HTMLHeadingElement | null>;

/** What kind of item it is. */
const kindLine = (i: InboxItem): string => VARIANT_LABEL[cardVariant(i)];

/** The item on the desk, as a document. */
function DeskItem({ item, now, headRef }: { item: InboxItem; now: number; headRef: HeadRef }) {
  const ship = cardVariant(item) === 'ship';
  return (
    <article className={cls('doc', item.withdrawn && 'withdrawn')} id={`card-${item.id}`} aria-label={`${kindLine(item)}: ${item.title}`}>
      <header className="doc-head">
        <p className="doc-kicker">
          {ship ? 'Manifest for' : `${kindLine(item)} from ${fromLabel(item.from)}, ${ago(item.createdAt, now)}`}
          {item.taskKey ? <KeyLink k={item.taskKey} /> : ship ? ' this change' : null}
          {item.urgent ? (
            <Pill tone="block" solid icon="flag">
              Urgent
            </Pill>
          ) : null}
          {ship ? <RiskPill risk={item.risk} /> : null}
        </p>
        <h1 ref={headRef} tabIndex={-1}>
          {item.title || kindLine(item)}
        </h1>
        <CardNotes item={item} />
        {item.held ? <p className="note">Held until tomorrow{item.heldReason ? `: ${item.heldReason}` : '.'}</p> : null}
      </header>
      {ship ? (
        <Manifest item={item} now={now} />
      ) : (
        <div className="doc-body">
          <CardBody item={item} now={now} />
        </div>
      )}
    </article>
  );
}

/** The item that was on the desk has been answered: say how it ended, and wait to be asked for the next one. */
function Settled({ item, next, onNext, headRef }: { item: InboxItem | null; next: InboxItem | null; onNext: () => void; headRef: HeadRef }) {
  return (
    <article className="doc">
      <header className="doc-head">
        <h1 ref={headRef} tabIndex={-1}>
          {item ? 'Answered' : 'No longer waiting'}
        </h1>
      </header>
      <div className="doc-body">
        {item ? (
          <div className="resolved-list">
            <ResolvedCard item={item} />
          </div>
        ) : (
          <p>That item is not waiting for you any more.</p>
        )}
        {next ? (
          <div>
            <button type="button" className="btn primary" onClick={onNext}>
              Show the next one
            </button>
          </div>
        ) : (
          <p>Nothing else is waiting for your signature.</p>
        )}
      </div>
    </article>
  );
}

function EmptyDesk({ crew, moving, headRef }: { crew: CrewState; moving: number; headRef: HeadRef }) {
  const windows = crew.config.questionWindows;
  return (
    <article className="doc">
      <header className="doc-head">
        <h1 ref={headRef} tabIndex={-1}>
          Nothing is waiting for your signature
        </h1>
      </header>
      <div className="doc-body">
        <p>
          Changes ready to leave, questions, QA verdicts, drafts to post and proposed standing orders arrive here, most urgent first.
          {windows.length ? ` Questions that can wait arrive at ${windows.join(' and ')}.` : ''}
        </p>
        <p>
          {moving ? `${moving} task${moving === 1 ? ' is' : 's are'} underway.` : 'No task is underway.'}{' '}
          <button type="button" className="link" onClick={() => ui.setView('underway')}>
            See what is underway
          </button>
        </p>
      </div>
    </article>
  );
}

export function DeskView({ crew }: { crew: CrewState }) {
  const now = useNow(30_000);
  const { focusCard } = useUi();
  const queue = cardsForYou(crew);
  const [selId, setSelId] = useState<string | null>(() => focusCard?.id ?? queue[0]?.id ?? null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const moveFocus = useRef(false);
  const pick = (id: string): void => {
    moveFocus.current = true;
    setSelId(id);
  };

  // An item opened from elsewhere (the log, a task) comes to the desk once; the request is then spent.
  useEffect(() => {
    if (!focusCard) return;
    setSelId(focusCard.id);
    ui.clearFocusCard();
  }, [focusCard]);
  // An empty desk takes the first item that arrives.
  const first = queue[0]?.id ?? null;
  useEffect(() => {
    if (selId === null && first) setSelId(first);
  }, [selId, first]);

  // May be held or with the Mate, so not in the queue; it shows all the same.
  const item = selId ? (crew.inbox.find((i) => i.id === selId && i.status === 'open') ?? null) : null;
  const settled = selId !== null && !item;
  const settledItem = settled ? (crew.inbox.find((i) => i.id === selId) ?? null) : null;
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    headRef.current?.focus();
  }, [selId]);

  // Answering removes the button that had focus; put it on what replaced the document.
  useEffect(() => {
    if (settled && document.activeElement === document.body) headRef.current?.focus();
  }, [settled]);

  const at = item ? queue.findIndex((i) => i.id === item.id) : -1;
  const rest = queue.filter((i) => i.id !== item?.id);
  const held = heldCards(crew);
  const today = crew.inbox.filter((i) => i.status !== 'open' && now - (i.resolvedAt ?? i.createdAt) < DAY).sort((a, b) => (b.resolvedAt ?? b.createdAt) - (a.resolvedAt ?? a.createdAt));
  const leftAlone = today.filter((i) => isAutoApproved(i) || i.autoStarted);
  const answered = today.filter((i) => !isAutoApproved(i) && !i.autoStarted).slice(0, 8);
  const stuck = stuckItems(crew, now).length;
  const moving = crew.tasks.filter((t) => t.status === 'active' || t.status === 'pr' || t.status === 'qa').length;
  const win = nextWindow(crew.config.questionWindows, now);
  const windows = crew.config.questionWindows;

  return (
    <div className="view desk">
      <div className="desk-grid">
        <div className="desk-main">
          {item ? (
            <DeskItem key={item.id} item={item} now={now} headRef={headRef} />
          ) : settled ? (
            <Settled item={settledItem} next={queue[0] ?? null} onNext={() => queue[0] && pick(queue[0].id)} headRef={headRef} />
          ) : (
            <EmptyDesk crew={crew} moving={moving} headRef={headRef} />
          )}
        </div>

        <aside className="desk-side" aria-label="The queue">
          <div className="pager">
            <p aria-live="polite">{queue.length ? (at >= 0 ? `${at + 1} of ${queue.length} waiting for you` : `${queue.length} waiting for you`) : 'Nothing waiting for you'}</p>
            {queue.length > 1 ? (
              <div className="pager-b">
                <button type="button" className="btn icon" aria-label="Previous" disabled={at <= 0} onClick={() => pick(queue[at - 1].id)}>
                  <Icon name="chevron" className="flip" />
                </button>
                <button type="button" className="btn icon" aria-label="Next" disabled={at >= queue.length - 1} onClick={() => pick(queue[at + 1].id)}>
                  <Icon name="chevron" />
                </button>
              </div>
            ) : null}
          </div>

          {item && cardVariant(item) === 'ship' ? <Signature key={item.id} item={item} now={now} /> : null}

          {rest.length ? (
            <section className="next" aria-label="Next in line">
              <h2>Next in line</h2>
              <ul>
                {rest.map((i) => (
                  <li key={i.id}>
                    <button type="button" className="next-i" onClick={() => pick(i.id)}>
                      <b>{i.title || kindLine(i)}</b>
                      <span>
                        {kindLine(i)} from {fromLabel(i.from)}
                        {i.taskKey ? ` on ${i.taskKey}` : ''}
                        {i.urgent ? ', urgent' : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {crew.heldQuestions ? (
            <p className="note">
              The {LEAD} is holding {crew.heldQuestions} question{crew.heldQuestions === 1 ? '' : 's'} that can wait{win ? ` until ${win.label}` : ''}.
            </p>
          ) : windows.length && queue.length ? (
            <p className="note">Questions that can wait arrive at {windows.join(' and ')}.</p>
          ) : null}

          {stuck ? (
            <button type="button" className="stuck-flag" onClick={() => ui.setView('underway')}>
              <Icon name="alert" />
              {stuck} stuck. See Underway
            </button>
          ) : null}

          {held.length ? (
            <Details label={`Held until tomorrow: ${held.length}`} openLabel="Hide held">
              <div className="cards">
                {held.map((i) => (
                  <div key={i.id} className="held">
                    {i.heldReason ? <p className="note">Held: {i.heldReason}</p> : null}
                    <Card item={i} />
                  </div>
                ))}
              </div>
            </Details>
          ) : null}
          {leftAlone.length ? (
            <Details label={`Left without you today: ${leftAlone.length}`} openLabel="Hide">
              <div className="resolved-list">
                {leftAlone.map((i) => (
                  <ResolvedCard key={i.id} item={i} />
                ))}
              </div>
            </Details>
          ) : null}
          {answered.length ? (
            <Details label={`Answered today: ${answered.length}`} openLabel="Hide answered">
              <div className="resolved-list">
                {answered.map((i) => (
                  <ResolvedCard key={i.id} item={i} />
                ))}
              </div>
            </Details>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
