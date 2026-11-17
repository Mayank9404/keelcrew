/** A diff's risk tier with each reason and the engineer's note on it. */
import { RISK_LABEL } from '../../lib/risk';
import type { Risk } from '../../types';
import { Pill, type Tone } from '../common';

export const riskTone = (r: Risk | null): Tone => (!r ? 'muted' : r.tier === 'low' ? 'ok' : r.tier === 'medium' ? 'warn' : 'block');

/** Notes are "reason: note" lines; pair each with its reason, and keep notes that match none. */
function pair(risk: Risk, notes: string[]): { reason: string; note: string | null }[] {
  const left = [...notes];
  const out = risk.reasons.map((reason) => {
    const i = left.findIndex((n) => n.toLowerCase().startsWith(reason.toLowerCase()));
    const note = i >= 0 ? left.splice(i, 1)[0].slice(reason.length).replace(/^\s*[:·—-]\s*/, '') : null;
    return { reason, note };
  });
  return [...out, ...left.map((n) => ({ reason: '', note: n }))];
}

export function RiskPill({ risk }: { risk: Risk | null }) {
  if (!risk) return null;
  return (
    <Pill tone={riskTone(risk)} solid={risk.tier === 'high' || risk.tier === 'unknown'} icon={risk.tier === 'high' || risk.tier === 'unknown' ? 'alert' : undefined}>
      {RISK_LABEL[risk.tier]}
    </Pill>
  );
}

/** The tier and why. `compact` (on a card that already shows the tier) titles it "Why it's … risk" instead. */
export function RiskBlock({ risk, notes = [], compact }: { risk: Risk; notes?: string[]; compact?: boolean }) {
  const rows = pair(risk, notes);
  const size = [risk.files != null ? `${risk.files} file${risk.files === 1 ? '' : 's'}` : '', risk.added != null || risk.deleted != null ? `+${risk.added ?? 0} −${risk.deleted ?? 0}` : ''].filter(Boolean).join(' · ');
  return (
    <div className="risk" data-tier={risk.tier}>
      <div className="risk-h">
        {compact ? <span className="eyebrow">Why it’s {risk.tier === 'unknown' ? 'treated as high' : risk.tier} risk</span> : <RiskPill risk={risk} />}
        {size && !compact ? <span className="num faint">{size}</span> : null}
      </div>
      {rows.length ? (
        <ul className="risk-list">
          {rows.map((r, i) => (
            <li key={`${r.reason}${i}`}>
              {r.reason ? <b>{r.reason}</b> : null}
              {r.note ? <span>{r.note}</span> : r.reason ? <span className="faint">No note from the engineer.</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">{risk.tier === 'low' ? 'Nothing in the diff matched a risk pattern.' : 'No reasons recorded.'}</p>
      )}
    </div>
  );
}
