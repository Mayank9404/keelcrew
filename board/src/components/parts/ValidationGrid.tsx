/** Promised and shown: each promise in the contract, what showed it, who judged it, and whether it was shown, failed or not tested. */
import { fromLabel } from '../../labels';
import { ago } from '../../lib/format';
import { ui } from '../../lib/ui';
import { gridSummary, summaryText, type GridRow } from '../../lib/validation';
import type { ValidationStatus } from '../../types';
import { Icon, tone, type IconName, type Tone } from '../common';

const STATUS: Record<ValidationStatus, { label: string; tone: Tone; icon: IconName }> = {
  pass: { label: 'Shown', tone: 'ok', icon: 'check' },
  fail: { label: 'Failed', tone: 'block', icon: 'x' },
  untested: { label: 'Not tested', tone: 'you', icon: 'minus' },
};

/** A strip of one block per assertion, colored by status: the grid at a glance. */
export function ValidationStrip({ rows }: { rows: GridRow[] }) {
  if (!rows.length) return null;
  const s = gridSummary(rows);
  return (
    <span className="vstrip" role="img" aria-label={summaryText(s)} title={summaryText(s)}>
      {rows.map((r) => (
        <i key={r.id} className={`v-${r.status}`} />
      ))}
    </span>
  );
}

export function StatusChip({ status }: { status: ValidationStatus }) {
  const m = STATUS[status];
  return (
    <span className={`vchip v-${status}`} style={tone(m.tone)}>
      <Icon name={m.icon} />
      {m.label}
    </span>
  );
}

/** The grid. `taskKey` makes evidence ids open the task's evidence. */
export function ValidationGrid({ rows, taskKey, now }: { rows: GridRow[]; taskKey: string | null; now: number }) {
  if (!rows.length) return <p className="note">No promises yet. The Mate writes numbered promises (VAL-…) before staffing; each gets a result here.</p>;
  return (
    <div className="vgrid" role="table" aria-label="Validation">
      <div className="vg-row vg-head" role="row">
        <span role="columnheader">Promised</span>
        <span role="columnheader">Shown by</span>
        <span role="columnheader">Result</span>
      </div>
      {rows.map((r) => (
        <div className={`vg-row v-${r.status}`} role="row" key={r.id}>
          <span className="vg-a" role="cell">
            <span className="mono vg-id">
              {r.id}
              {r.kind === 'negative' ? <span className="neg" title="Negative case: something must not happen">neg</span> : null}
            </span>
            {r.text ? <span className="vg-text">{r.text}</span> : <span className="vg-text faint">Not in the contract any more</span>}
          </span>
          <span className="vg-e" role="cell">
            {r.evidenceId && taskKey ? (
              <button type="button" className="link mono" onClick={() => ui.openTask(taskKey, 'evidence', r.evidenceId)}>
                {r.evidenceId}
              </button>
            ) : null}
            <span className={r.status === 'untested' && !r.evidence ? 'block-text' : ''}>{r.evidenceId ? r.evidence.replace(/^\s*[^:]+:\s*/, '') : r.evidence || (r.recorded ? 'No reason given.' : 'Nobody has checked this yet.')}</span>
            {r.at ? <span className="faint"> · {ago(r.at, now)}</span> : null}
          </span>
          <span className="vg-s" role="cell">
            <StatusChip status={r.status} />
            {r.by ? <span className="faint">{fromLabel(r.by)}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}
