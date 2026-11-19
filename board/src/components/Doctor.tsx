import { useEffect, useState } from 'react';
import { useStore } from '../lib/createStore';
import { checklistVersion, dismissChecklist, doctorStore, runDoctor } from '../lib/doctor';
import { ago } from '../lib/format';
import { ui } from '../lib/ui';
import type { DoctorCheck } from '../types';
import { CopyButton, useNow } from './common';

const STEPS = ['Checking the crew files', 'Checking the plugin and the Mate', 'Checking the board link'];

function Loading() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setI(x => (x + 1) % STEPS.length), 900);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="doc-loading" role="status">
      <span className="doc-spinner" aria-hidden="true" />
      <div>
        <b>Checking your setup</b>
        <span key={i} className="reveal">
          {STEPS[i]}…
        </span>
      </div>
    </div>
  );
}

const MARK: Record<DoctorCheck['status'], string> = { ok: '✓', warn: '!', fail: '✕' };

function Row({ c }: { c: DoctorCheck }) {
  return (
    <li className={`doc-row ${c.status}`}>
      <span className="doc-mark" aria-label={c.status}>
        {MARK[c.status]}
      </span>
      <div className="doc-main">
        <b>{c.label}</b>
        <span>{c.detail}</span>
        {c.command && c.status !== 'ok' ? (
          <div className="copyrow">
            <code>{c.command}</code>
            <CopyButton text={c.command} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** Health checks list; runs on mount when asked. */
export function DoctorList({ autoRun }: { autoRun?: boolean }) {
  const { checks, loading, error, ranAt } = useStore(doctorStore);
  const now = useNow(30_000);
  useEffect(() => {
    if (autoRun) void runDoctor();
  }, [autoRun]);
  const sorted = checks ? [...checks].sort((a, b) => ['fail', 'warn', 'ok'].indexOf(a.status) - ['fail', 'warn', 'ok'].indexOf(b.status)) : [];
  const bad = sorted.filter(c => c.status !== 'ok').length;
  return (
    <div className="doctor">
      {loading ? <Loading /> : null}
      {error && !loading ? <p className="err-box">{error}</p> : null}
      {checks && !loading ? (
        <>
          <p className="note">
            {bad ? `${bad} thing${bad === 1 ? '' : 's'} to look at.` : 'Everything checks out.'}
            {ranAt ? ` Checked ${ago(ranAt, now)}.` : ''}
          </p>
          <ul className="doc-list">
            {sorted.map(c => (
              <Row key={c.id} c={c} />
            ))}
          </ul>
        </>
      ) : null}
      <div>
        <button type="button" className="btn sm ghost" disabled={loading} onClick={() => void runDoctor()}>
          {loading ? 'Checking…' : 'Check again'}
        </button>
      </div>
    </div>
  );
}

/** First-run checklist, shown when something needs setting up. */
export function DoctorSheet() {
  const { checks } = useStore(doctorStore);
  const version = checks ? checklistVersion(checks) : '';
  const close = () => {
    if (version) dismissChecklist(version);
    ui.closeSheet();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });
  return (
    <>
      <div className="scrim" onClick={close} />
      <div className="sheet narrow" role="dialog" aria-modal="true" aria-labelledby="doc-title">
        <div className="sheet-head">
          <div>
            <h2 id="doc-title">Let&rsquo;s get Keelcrew ready</h2>
            <p className="note" style={{ marginTop: 4 }}>
              A quick check of the tools the team relies on. Fix what you can now; the rest can wait.
            </p>
          </div>
          <span className="spacer" />
          <button type="button" className="x" aria-label="Close" onClick={close}>
            ×
          </button>
        </div>
        <div className="sheet-body">
          <DoctorList />
        </div>
        <div className="sheet-foot">
          <span className="note">Run these again from Settings → This Mac. <code>keelctl doctor --fix</code> repairs what it safely can.</span>
          <span className="spacer" />
          <button type="button" className="btn primary" onClick={close}>
            {version ? 'I’ll do the rest later' : 'Done'}
          </button>
        </div>
      </div>
    </>
  );
}
