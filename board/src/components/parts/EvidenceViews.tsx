/** Structured evidence: a reviewer's diff walkthrough, an agent's handoff, and an engineer's receipts. */
import { ago } from '../../lib/format';
import type { Handoff, Receipt, Receipts, WalkthroughGroup } from '../../types';
import { Dot, Pill, type Tone } from '../common';

const SEVERITY_TONE: Record<WalkthroughGroup['severity'], Tone> = { blocker: 'block', major: 'block', minor: 'warn', nit: 'muted', none: 'ok' };
const SEVERITY_RANK: Record<WalkthroughGroup['severity'], number> = { blocker: 0, major: 1, minor: 2, nit: 3, none: 4 };

/** Hunks grouped by what they're for, worst open finding first. */
export function Walkthrough({ groups }: { groups: WalkthroughGroup[] }) {
  if (!groups.length) return <p className="note">The walkthrough has no groups.</p>;
  const sorted = [...groups].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return (
    <ol className="walk">
      {sorted.map((g, i) => (
        <li key={`${g.intent}${i}`} style={{ ['--c' as string]: `var(--${SEVERITY_TONE[g.severity]})` }}>
          <div className="walk-h">
            <b>{g.intent}</b>
            <Pill tone={SEVERITY_TONE[g.severity]}>{g.severity === 'none' ? 'no findings' : g.severity}</Pill>
          </div>
          {g.files.length ? (
            <ul className="walk-files">
              {g.files.map((f) => (
                <li key={f} className="mono">
                  {f}
                </li>
              ))}
            </ul>
          ) : null}
          {g.notes ? <p>{g.notes}</p> : null}
        </li>
      ))}
    </ol>
  );
}

/** A fixed-schema handoff: where it stands, what was decided, what failed, the next step, and open questions. */
export function HandoffView({ h }: { h: Handoff }) {
  return (
    <dl className="handoff">
      {h.state ? (
        <>
          <dt>Where it stands</dt>
          <dd>{h.state}</dd>
        </>
      ) : null}
      {h.next ? (
        <>
          <dt>Next step</dt>
          <dd className="next">{h.next}</dd>
        </>
      ) : null}
      {h.decisions.length ? (
        <>
          <dt>Decisions</dt>
          <dd>
            <ul>{h.decisions.map((d) => <li key={d}>{d}</li>)}</ul>
          </dd>
        </>
      ) : null}
      {h.deadEnds.length ? (
        <>
          <dt>Dead ends</dt>
          <dd>
            <ul>{h.deadEnds.map((d) => <li key={d}>{d}</li>)}</ul>
          </dd>
        </>
      ) : null}
      {h.questions.length ? (
        <>
          <dt>Open questions</dt>
          <dd>
            <ul>{h.questions.map((d) => <li key={d}>{d}</li>)}</ul>
          </dd>
        </>
      ) : null}
    </dl>
  );
}

const receiptTone = (r: Receipt | null): Tone => {
  const s = (r?.status ?? '').toLowerCase();
  if (!r) return 'muted';
  if (/^(pass|ok|done|green)/.test(s)) return 'ok';
  if (/^(fail|red|error)/.test(s)) return 'block';
  return 'warn';
};

/** The commit an engineer ships and what was proved on it. */
export function ReceiptsLine({ receipts, now }: { receipts: Receipts; now: number }) {
  const item = (label: string, r: Receipt | null) => (
    <span className="rcpt" key={label}>
      <Dot tone={receiptTone(r)} />
      {label} <b>{r ? r.status : 'missing'}</b>
      {r?.detail ? <span className="faint"> · {r.detail}</span> : null}
      {r?.at ? <span className="faint"> · {ago(r.at, now)}</span> : null}
    </span>
  );
  return (
    <div className={receipts.stale ? 'receipts stale' : 'receipts'}>
      <span className="rcpt">
        <Dot tone={receipts.head ? 'ok' : 'muted'} />
        Head <code>{receipts.head ? receipts.head.slice(0, 7) : 'not recorded'}</code>
      </span>
      {item('Review', receipts.review)}
      {item('Tests', receipts.tests)}
      {receipts.stale ? <span className="rcpt block-text">A receipt covers another commit.</span> : null}
    </div>
  );
}
