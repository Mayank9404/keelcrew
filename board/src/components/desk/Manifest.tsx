/**
 * The manifest for one change waiting to leave: what it covers, what was promised and what was shown, the second
 * reader's findings, the risk and the diff. The signature block beside it (Signature.tsx) does the approving.
 */
import { useEffect, useState } from 'react';
import { fromLabel } from '../../labels';
import { errorText, quietApi, type DiffResult } from '../../lib/api';
import { diffstatFiles, diffstatTotals } from '../../lib/diff';
import { ago } from '../../lib/format';
import { RISK_LABEL } from '../../lib/risk';
import { useCrewStore } from '../../lib/store';
import { ui } from '../../lib/ui';
import { gridSummary, validationGrid } from '../../lib/validation';
import type { Evidence, InboxItem } from '../../types';
import { Details, Icon } from '../common';
import { Markdown } from '../Markdown';
import { ReceiptsLine, Walkthrough } from '../parts/EvidenceViews';
import { RiskBlock } from '../parts/RiskBlock';
import { ValidationGrid } from '../parts/ValidationGrid';
import { DiffView } from '../task/DiffTab';

/** The diff, loaded from the Mac when opened; the diffstat when the Mac isn't reachable from here. */
function DiffPanel({ item }: { item: InboxItem }) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!item.taskKey) return;
    let live = true;
    quietApi.taskDiff(item.taskKey).then(
      (d) => live && setDiff(d),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [item.taskKey]);
  const files = diffstatFiles(item.diffstat);
  if (diff) return <div className="diff-box">{diff.diff.trim() ? <DiffView text={diff.diff} /> : <p className="note">No committed changes against origin/{diff.base}.</p>}</div>;
  return (
    <div className="diff-box">
      {error ? <p className="note">{error} The files below come from the request.</p> : <p className="note">Loading the diff from your Mac…</p>}
      {files.length ? (
        <ul className="files">
          {files.map((f) => (
            <li key={f.path}>
              <span className="mono">{f.path}</span>
              <span className="add">+{f.adds}</span>
              <span className="del">−{f.dels}</span>
            </li>
          ))}
        </ul>
      ) : item.diffstat ? (
        <pre className="block">{item.diffstat}</pre>
      ) : null}
    </div>
  );
}

/** The reviewer's walkthrough evidence, read when opened. */
function WalkthroughPanel({ taskKey, id }: { taskKey: string; id: string }) {
  const [ev, setEv] = useState<Evidence | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    quietApi.evidenceItem(taskKey, id).then(
      (e) => live && setEv(e),
      () => live && setEv(null),
    );
    return () => {
      live = false;
    };
  }, [taskKey, id]);
  if (ev === undefined) return <p className="note">Loading the walkthrough…</p>;
  if (!ev) return <p className="note">The walkthrough {id} isn’t on the board.</p>;
  return ev.walkthrough ? <Walkthrough groups={ev.walkthrough} /> : <Markdown text={ev.content} />;
}

/** `nested`: inside a card that already has a heading, so the sections step down a level. */
export function Manifest({ item, now, nested }: { item: InboxItem; now: number; nested?: boolean }) {
  const H = nested ? 'h4' : 'h2';
  const crew = useCrewStore().crew;
  const task = item.taskKey ? crew?.tasks.find((t) => t.key === item.taskKey) : undefined;
  const contract = task?.contract ?? [];
  const rows = validationGrid(contract, item.validation ?? task?.validation ?? null);
  const summary = gridSummary(rows);
  const receipts = item.receipts ?? task?.receipts ?? null;
  const totals = diffstatTotals(item.diffstat);
  const head = item.receipts?.head ?? null;
  const open = item.status === 'open';
  const checksFail = item.checks.filter((c) => c.status === 'fail').length;
  const checksPass = item.checks.filter((c) => c.status === 'pass').length;

  return (
    <div className="manifest">
      <dl className="mf-facts">
        <div>
          <dt>Repository</dt>
          <dd>{task?.repo || 'Not recorded'}</dd>
        </div>
        <div>
          <dt>Commit this covers</dt>
          <dd>{head ? <code>{head.slice(0, 7)}</code> : 'Not recorded'}</dd>
        </div>
        <div>
          <dt>Size of the change</dt>
          <dd className="num">{totals ? `${totals.files != null ? `${totals.files} file${totals.files === 1 ? '' : 's'}, ` : ''}${totals.adds} added, ${totals.dels} removed` : 'Not recorded'}</dd>
        </div>
        <div>
          <dt>Built by</dt>
          <dd>
            {fromLabel(item.from)}, {ago(item.createdAt, now)}
          </dd>
        </div>
      </dl>

      {item.body ? (
        <div className="mf-sec">
          <Markdown text={item.body.replace(/^\s*High risk:[^.\n]*\.\s*/i, '')} />
        </div>
      ) : null}

      <section className="mf-sec" aria-label="Promised and shown">
        <H>Promised and shown</H>
        {rows.length ? (
          <p className={summary.fail ? 'note block-text' : summary.untested ? 'note you-text' : 'note'}>
            <b>
              {summary.pass} of {summary.total} shown{summary.fail ? `, ${summary.fail} failed` : ''}{summary.untested ? `, ${summary.untested} not tested` : ''}.
            </b>
          </p>
        ) : null}
        {item.checks.length ? <p className={checksFail ? 'note block-text' : 'note'}>{checksFail ? `${checksFail} check${checksFail === 1 ? '' : 's'} failing.` : `${checksPass} of ${item.checks.length} checks pass.`}</p> : null}
        <ValidationGrid rows={rows} taskKey={item.taskKey} now={now} />
        {item.checks.length || item.notes ? (
          <Details label={checksFail ? `Checks and notes: ${checksFail} failing` : 'Checks and notes'} openLabel="Hide checks and notes" defaultOpen={checksFail > 0}>
            {item.checks.length ? (
              <ul className="checks">
                {item.checks.map((c) => (
                  <li key={c.name} className={`c-${c.status}`}>
                    <Icon name={c.status === 'pass' ? 'check' : c.status === 'fail' ? 'x' : 'minus'} />
                    <span>
                      {c.name}
                      {c.detail ? <span className="faint">: {c.detail}</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {item.notes ? <Markdown text={item.notes} /> : null}
          </Details>
        ) : null}
      </section>

      <div className="mf-pair">
        <section className="mf-sec" aria-label="Second reader">
          <H>Second reader</H>
          {receipts ? <ReceiptsLine receipts={receipts} now={now} /> : <p className="note">No receipts: nothing says what was reviewed and tested.</p>}
          {item.walkthroughId && item.taskKey ? (
            <Details label="Read the reviewer’s walkthrough" openLabel="Hide the walkthrough">
              <WalkthroughPanel taskKey={item.taskKey} id={item.walkthroughId} />
            </Details>
          ) : null}
        </section>
        <section className="mf-sec" aria-label="Risk">
          <H>{item.risk ? RISK_LABEL[item.risk.tier] : 'Risk not assessed'}</H>
          {item.risk ? <RiskBlock risk={item.risk} notes={item.riskNotes} compact /> : <p className="note">The request carries no risk tier.</p>}
        </section>
      </div>

      {open ? (
        <div className="mf-sec">
          <Details label="Read the diff" openLabel="Hide the diff">
            <DiffPanel item={item} />
          </Details>
          {item.taskKey ? (
            <button type="button" className="link small" onClick={() => ui.openTask(item.taskKey!, 'diff')}>
              Review line by line and send comments
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
