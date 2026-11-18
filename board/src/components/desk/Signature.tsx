/**
 * The signature block for a change waiting to leave. Signing approves exactly one commit: open the pull request, open
 * it as a draft, push only, or not yet. A high-risk change unlocks only after the captain ticks that they checked the risk.
 */
import { useState } from 'react';
import { ago, clock } from '../../lib/format';
import { approveGate, gateTier } from '../../lib/risk';
import { useCrewStore } from '../../lib/store';
import type { InboxItem } from '../../types';
import { Icon } from '../common';
import { AnswerBox, ReadOnly, useDecide } from '../cards/parts';

/** Requests whose risk the captain acknowledged, so the tick survives a re-render. */
const acked = new Set<string>();

/** `nested`: inside a card that already has a heading, so this one steps down a level. */
export function Signature({ item, now, nested }: { item: InboxItem; now: number; nested?: boolean }) {
  const H = nested ? 'h4' : 'h2';
  const crew = useCrewStore().crew;
  const task = item.taskKey ? crew?.tasks.find((t) => t.key === item.taskKey) : undefined;
  const canWrite = crew?.access.canWrite === true;
  const { busy, decide } = useDecide(item);
  const [ack, setAck] = useState(() => acked.has(item.id));
  const [notYet, setNotYet] = useState(false);
  if (item.status !== 'open') return null;
  const gate = approveGate(item, ack, task?.contract ?? []);
  const high = gateTier(item.risk) === 'high';
  const head = item.receipts?.head ?? null;
  const off = !gate.canApprove || busy !== null;

  return (
    <section className="signature" aria-label="Your signature">
      <H>Your signature</H>
      <p>
        {head ? (
          <>
            Signing lets commit <code>{head.slice(0, 7)}</code> leave this machine, and nothing else. A later commit needs a new signature.
          </>
        ) : (
          'No commit is recorded on this request, so the signature binds to the worktree’s HEAD.'
        )}
      </p>
      {gate.warnings.length ? (
        <ul className="warnings">
          {gate.warnings.map((w) => (
            <li key={w}>
              <Icon name="alert" />
              {w}
            </li>
          ))}
        </ul>
      ) : null}
      {!canWrite ? (
        <ReadOnly />
      ) : notYet ? (
        <AnswerBox placeholder="What should change? (optional)" submitLabel="Not yet" danger optional onSubmit={(t) => void decide('reject', t || undefined)} onCancel={() => setNotYet(false)} />
      ) : (
        <>
          {high ? (
            <label className="ack">
              <input type="checkbox" checked={ack} onChange={(e) => (e.target.checked ? acked.add(item.id) : acked.delete(item.id), setAck(e.target.checked))} />
              I’ve checked the risk
            </label>
          ) : null}
          <div className="sig-actions">
            <button type="button" className="btn sign" disabled={off} onClick={() => void decide('approve')}>
              {busy === 'approve' ? 'Signing…' : 'Sign and open the pull request'}
            </button>
            <button type="button" className="btn" disabled={off} onClick={() => void decide('draft')}>
              {busy === 'draft' ? 'Signing…' : 'Sign and open it as a draft'}
            </button>
            <button type="button" className="btn" disabled={off} onClick={() => void decide('push')}>
              {busy === 'push' ? 'Signing…' : 'Sign and push only'}
            </button>
            <button type="button" className="btn ghost" disabled={busy !== null} onClick={() => setNotYet(true)}>
              Not yet
            </button>
          </div>
          {gate.reason ? (
            <p className="gate locked">
              <Icon name="lock" />
              {gate.reason}
            </p>
          ) : null}
        </>
      )}
      <p className="held-line">
        <i aria-hidden="true" />
        Held at the gate since {clock(item.createdAt)}, {ago(item.createdAt, now)}
      </p>
    </section>
  );
}
