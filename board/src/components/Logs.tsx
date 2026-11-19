import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from '../lib/api';
import { clock } from '../lib/format';
import { ui } from '../lib/ui';
import type { LogFile, LogTail } from '../types';
import { Icon } from './common';

const LINE_OPTIONS = [500, 2000, 10000];
const FOLLOW_MS = 10_000;
const ERROR_RE = /\b(error|errors|crash(ed)?|fail(ed|ure)?|exception|denied|refused|timed out|fatal)\b/i;
const STAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z\s(.*)$/;

const size = (n: number): string => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

function Line({ text }: { text: string }) {
  const m = STAMP_RE.exec(text);
  const err = ERROR_RE.test(text);
  return (
    <div className={err ? 'log-line err' : 'log-line'}>
      {m ? <span className="ts">{clock(Date.parse(`${m[1]}Z`))}</span> : null}
      <span>{m ? m[2] : text || ' '}</span>
    </div>
  );
}

/** The crew's logs on this Mac (hooks, helper, sessions), tailed live. */
export function LogsSheet() {
  const [files, setFiles] = useState<LogFile[]>([]);
  const [file, setFile] = useState('');
  const [tail, setTail] = useState<LogTail | null>(null);
  const [lines, setLines] = useState(LINE_OPTIONS[0]);
  const [q, setQ] = useState('');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () =>
      api.logs().then(
        list => {
          setFiles(list);
          setFile(f => f || list[0]?.file || '');
        },
        () => undefined,
      );
    void load();
    const t = window.setInterval(load, 15_000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!file) return;
    let live = true;
    const load = () =>
      api.logTail(file, lines).then(
        t => {
          if (!live) return;
          setTail(t);
          setError(null);
        },
        e => live && setError(errorText(e)),
      );
    void load();
    const t = follow ? window.setInterval(load, FOLLOW_MS) : undefined;
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [file, lines, follow]);

  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => (tail?.lines ?? []).filter(l => (!errorsOnly || ERROR_RE.test(l)) && (!needle || l.toLowerCase().includes(needle))), [tail, errorsOnly, needle]);

  useEffect(() => {
    const el = viewRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [shown, follow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        ui.closeSheet();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  const open = (f: string | null) => void api.openLogs(f).catch(() => undefined);
  const current = files.find(f => f.file === file);
  return (
    <>
      <div className="scrim" onClick={() => ui.closeSheet()} />
      <div className="sheet logs-sheet" role="dialog" aria-modal="true" aria-labelledby="logs-title">
        <div className="sheet-head">
          <div style={{ minWidth: 0 }}>
            <h2 id="logs-title">Logs</h2>
            <p className="note mono">{tail?.path ?? '~/.keelcrew/logs'}</p>
          </div>
          <span className="spacer" />
          <button type="button" className="btn sm ghost" onClick={() => open(null)}>
            <Icon name="folder" />
            Show in Finder
          </button>
          <button type="button" className="btn sm ghost" onClick={() => open(file)} title="Console.app follows the file live">
            <Icon name="open" />
            Open in Console
          </button>
          <button type="button" className="x" aria-label="Close" onClick={() => ui.closeSheet()}>
            ×
          </button>
        </div>
        <div className="log-bar">
          <select value={file} onChange={e => setFile(e.target.value)} aria-label="Log file">
            {files.length ? null : <option value="">No logs yet</option>}
            {files.map(f => (
              <option key={f.file} value={f.file}>
                {f.label} · {size(f.size)}
              </option>
            ))}
          </select>
          <span className="search">
            <Icon name="search" />
            <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Filter lines…" aria-label="Filter lines" />
          </span>
          <button type="button" className="btn sm ghost" aria-pressed={errorsOnly} onClick={() => setErrorsOnly(v => !v)}>
            Errors only
          </button>
          <button type="button" className="btn sm ghost" aria-pressed={follow} onClick={() => setFollow(v => !v)} title="Refresh every 3 seconds and keep the newest line in view">
            {follow ? 'Following' : 'Follow'}
          </button>
          <select value={lines} onChange={e => setLines(Number(e.target.value))} aria-label="Lines to show">
            {LINE_OPTIONS.map(n => (
              <option key={n} value={n}>
                Last {n.toLocaleString()}
              </option>
            ))}
          </select>
        </div>
        {error ? <div className="err-box" style={{ margin: '10px 20px 0' }}>{error}</div> : null}
        <div className="log-view" ref={viewRef} role="log" aria-live="off">
          {shown.map((l, i) => (
            <Line key={i} text={l} />
          ))}
          {tail && !shown.length ? <p className="note">{needle || errorsOnly ? 'No lines match.' : 'Empty so far.'}</p> : null}
        </div>
        <div className="sheet-foot">
          <span className="note">
            {tail ? `${shown.length.toLocaleString()} of the last ${tail.lines.length.toLocaleString()} lines` : 'Loading…'}
            {current ? ` · ${size(current.size)} · updated ${clock(current.mtime)}` : ''}
          </span>
          <span className="spacer" />
          <span className="note">
            Terminal: <code>keelctl status</code>
          </span>
        </div>
      </div>
    </>
  );
}
