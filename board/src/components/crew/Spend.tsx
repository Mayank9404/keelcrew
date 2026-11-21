/** Spend per ticket and per role against the captain's budgets (85% is a warning, 100% is over), from the helper's `costs`. */
import { LEAD, fromLabel } from '../../labels';
import { roleTotals, sessionRows, ticketRows, usd, type BudgetLevel, type SpendRow } from '../../lib/costs';
import { ui } from '../../lib/ui';
import type { CrewState } from '../../types';
import { Empty, FeedNote, ShareBar, cls, type Tone } from '../common';

const LEVEL_TONE: Record<BudgetLevel, Tone> = { ok: 'ok', warn: 'warn', over: 'block', none: 'muted' };

function Row({ r, label, onOpen, sub, keyFirst }: { r: SpendRow; label: string; onOpen?: () => void; sub?: string; keyFirst?: boolean }) {
  const inner = (
    <>
      <span className="sp-l">
        <span className={keyFirst ? 'mono' : ''}>{label}</span>
        {sub ? <span className={keyFirst ? 'faint small' : 'faint small mono'}>{sub}</span> : null}
      </span>
      <ShareBar share={r.share} tone={LEVEL_TONE[r.level]} label={r.budget ? `${usd(r.spend)} of ${usd(r.budget)}` : `${usd(r.spend)}, no budget`} />
      <span className="sp-v num">
        <b>{usd(r.spend)}</b>
        {r.budget ? <span className="faint"> / {usd(r.budget)}</span> : null}
      </span>
      <span className={cls('sp-p num', `lvl-${r.level}`)}>{r.share != null ? `${Math.round(r.share * 100)}%` : '—'}</span>
    </>
  );
  return <li className={cls('sp-row', `lvl-${r.level}`)}>{onOpen ? <button type="button" onClick={onOpen}>{inner}</button> : <div>{inner}</div>}</li>;
}

export function Spend({ crew, now }: { crew: CrewState; now: number }) {
  const b = crew.config.budgets;
  const tickets = ticketRows(crew.costs, b);
  const sessions = sessionRows(crew.costs, b);
  const totals = roleTotals(crew.costs);
  const roleName = (r: string) => (r === 'lead' ? LEAD : fromLabel(r));
  const feed = crew.feeds.costs;
  const title = (k: string) => crew.tasks.find((t) => t.key === k)?.title;
  if (!crew.costs) {
    return (
      <div className="spend-wrap">
        <FeedNote feed={feed} now={now} />
        <Empty title={feed.missing ? 'Spend needs a newer helper.' : crew.helper.status === 'missing' || !crew.access.canWrite ? 'Spend is read on your Mac.' : 'Loading spend…'}>
          {feed.missing ? 'Update the keelcrew plugin and restart the Claude app; the helper then reports spend per ticket and role.' : 'The Keelcrew helper estimates each session’s spend from its transcript. Open the board in the Claude app on your Mac to see it.'}
        </Empty>
      </div>
    );
  }
  const noBudgets = b.perTicketUsd == null && !Object.keys(b.perRoleUsd ?? {}).length;
  return (
    <div className="spend-wrap">
      <div className="spend-top">
        <span>
          Total <b className="num">{usd(crew.costs.totalUsd)}</b> across {crew.costs.members.length} session{crew.costs.members.length === 1 ? '' : 's'}
        </span>
        <FeedNote feed={feed} now={now} />
        {noBudgets ? (
          <button type="button" className="link small" onClick={() => ui.openSettings('limits')}>
            Set caps
          </button>
        ) : null}
      </div>
      <div className="spend-cols">
        <div>
          <h3 className="sub">Per ticket{b.perTicketUsd ? ` · budget ${usd(b.perTicketUsd)}` : ''}</h3>
          {tickets.length ? (
            <ul className="sp-list">
              {tickets.map((r) => (
                <Row key={r.id} r={r} label={r.id} keyFirst sub={title(r.id)} onOpen={crew.tasks.some((t) => t.key === r.id) ? () => ui.openTask(r.id) : undefined} />
              ))}
            </ul>
          ) : (
            <Empty title="No ticket spend yet." />
          )}
        </div>
        <div>
          <h3 className="sub">Per session, against its role’s budget</h3>
          {sessions.length ? (
            <ul className="sp-list">
              {sessions.map((r) => (
                <Row key={r.id} r={r} label={roleName(r.role)} sub={r.key ?? (r.role === 'lead' ? 'Triage and chat' : 'Scheduled run')} onOpen={r.key && crew.tasks.some((t) => t.key === r.key) ? () => ui.openTask(r.key!) : undefined} />
              ))}
            </ul>
          ) : (
            <Empty title="No session spend yet." />
          )}
          {totals.length ? <p className="note">By role: {totals.map((t) => `${roleName(t.role)} ${usd(t.spend)}`).join(' · ')}</p> : null}
        </div>
      </div>
    </div>
  );
}
