/**
 * A start card: the Mate has proposed a new session in its own session (a New task card from start_session). The
 * button opens the Mate's session in the Claude app, where the captain clicks Start. Opening doesn't answer the card; the
 * Mate closes it when the new session joins.
 */
import { useState } from 'react';
import { LEAD } from '../../labels';
import { api } from '../../lib/api';
import { clock, modelName } from '../../lib/format';
import { useCrewStore } from '../../lib/store';
import { toast } from '../../lib/toast';
import type { InboxItem } from '../../types';
import { Markdown } from '../Markdown';
import { Options, ReadOnly, useDecide } from './parts';

/** What the new session will run on, e.g. "Opus 5.5 · xhigh · Auto"; null when the card names neither. */
export function startUse(start: InboxItem['start']): string | null {
  if (!start || (!start.model && !start.effort)) return null;
  return [start.model ? modelName(start.model) : null, start.effort, 'Auto'].filter(Boolean).join(' · ');
}

/**
 * Asks the Mate to post this card's proposal again, so its New task card is the newest thing in the chat rather than far
 * up (an engineer's card, with no proposal: the Mate ends its turn with a Start <KEY> button), then opens the Mate's
 * session. The request goes first, so a failed open never loses it. Resolves to when it opened, or null when it didn't
 * (the error is toasted).
 */
export async function openLead(item: Pick<InboxItem, 'id' | 'taskKey'> & { start?: InboxItem['start'] }, now: () => number = Date.now): Promise<number | null> {
  try {
    await api.resurfaceStart(item.id, item.taskKey);
    await api.openLeadSession();
  } catch {
    return null;
  }
  toast(
    item.start && !item.start.proposal
      ? `Opened the ${LEAD} session. A "Start ${item.taskKey ?? ''}" button comes up at the bottom of its chat within a minute.`
      : `Opened the ${LEAD} session. Its Start card comes up at the bottom of the chat within a minute.`,
  );
  return now();
}

export function StartCard({ item }: { item: InboxItem }) {
  const canWrite = useCrewStore().crew?.access.canWrite === true;
  const { busy, decide } = useDecide(item);
  const [opening, setOpening] = useState(false);
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const use = startUse(item.start);
  const comesUp = item.start && !item.start.proposal ? `a "Start ${item.taskKey ?? ''}" button comes up at the bottom of its chat` : 'a fresh Start card comes up at the bottom of its chat';
  const open = async () => {
    setOpening(true);
    const at = await openLead(item);
    setOpening(false);
    if (at) setOpenedAt(at);
  };
  return (
    <>
      {item.body ? <Markdown text={item.body} /> : null}
      <p className="note">The {LEAD} is asking to start this session. Open its session: {comesUp} within a minute, with the settings below.</p>
      {use ? (
        <p className="start-use">
          Use: <b>{use}</b>
        </p>
      ) : null}
      {openedAt ? (
        <p className="ok-text">
          Opened the {LEAD} session at {clock(openedAt)} — {comesUp}.
        </p>
      ) : null}
      {item.status !== 'open' ? null : canWrite ? (
        <>
          <div className="opt-row">
            <button type="button" className="btn primary" disabled={opening || busy !== null} onClick={() => void open()}>
              {opening ? 'Opening…' : `Open the ${LEAD} session`}
            </button>
          </div>
          <Options item={item} busy={busy} onAnswer={(a, o) => void decide('answer', a, { neverAsk: o.neverAsk })} />
        </>
      ) : (
        <ReadOnly />
      )}
    </>
  );
}
