import { useCallback, useEffect, useMemo, useState } from 'react';
import { LEAD, sessionRole } from '../labels';
import { api, errorText } from '../lib/api';
import { isLive, shortKey } from '../lib/derive';
import { dayTime, modelName, money } from '../lib/format';
import { useCrewStore } from '../lib/store';
import { ui, useUi } from '../lib/ui';
import type { Session, TranscriptEntry } from '../types';
import { CopyButton, Icon } from './common';
import { Markdown } from './Markdown';
import { ContextMeter, SessionActions } from './SessionBits';

const PAGE = 300;
const LIVE_REFRESH_MS = 15_000;

export const sessionName = (s: Session): string => (s.role === 'lead' ? LEAD : `${sessionRole(s)}${s.taskKey ? ` · ${shortKey(s.taskKey)}` : ''}`);

/** The most telling field of a tool call's input, for its one-line summary. */
function gist(input: string | undefined): string {
  if (!input) return '';
  try {
    const o = JSON.parse(input) as Record<string, unknown>;
    for (const k of ['command', 'file_path', 'pattern', 'path', 'url', 'query', 'description', 'prompt', 'text', 'summary']) {
      if (typeof o[k] === 'string' && o[k]) return String(o[k]).split('\n')[0];
    }
    const first = Object.values(o).find(v => typeof v === 'string');
    return typeof first === 'string' ? first.split('\n')[0] : '';
  } catch {
    return input.slice(0, 120);
  }
}

/** "mcp__keelcrew-local__diff" → "keelcrew-local · diff"; connector ids that are just UUIDs are dropped. */
function toolLabel(name: string | undefined): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name ?? '');
  if (!m) return name ?? 'tool';
  return /^[0-9a-f-]{20,}$/.test(m[1]) ? m[2] : `${m[1].replace(/_/g, ' ')} · ${m[2]}`;
}

type Step = { kind: 'entry'; e: TranscriptEntry } | { kind: 'call'; e: TranscriptEntry; result: TranscriptEntry | null };

/** Tool calls take the next result in order, so parallel calls pair up correctly. */
function pairUp(entries: TranscriptEntry[]): Step[] {
  const steps: Step[] = [];
  const pending: Extract<Step, { kind: 'call' }>[] = [];
  for (const e of entries) {
    if (e.kind === 'tool') {
      const c: Extract<Step, { kind: 'call' }> = { kind: 'call', e, result: null };
      steps.push(c);
      pending.push(c);
    } else if (e.kind === 'result' && pending.length) pending.shift()!.result = e;
    else steps.push({ kind: 'entry', e });
  }
  return steps;
}

function Call({ step, open }: { step: Extract<Step, { kind: 'call' }>; open: boolean }) {
  const [shown, setShown] = useState(open);
  useEffect(() => setShown(open), [open]);
  const r = step.result;
  return (
    <div className={`tx-call${r?.isError ? ' err' : ''}${step.e.sub ? ' sub' : ''}`}>
      <button type="button" className="tx-call-h" aria-expanded={shown} onClick={() => setShown(v => !v)}>
        <Icon name="chevron" />
        <b>{toolLabel(step.e.tool)}</b>
        <span>{gist(step.e.input)}</span>
        {r?.isError ? <em>error</em> : !r ? <em>running</em> : null}
      </button>
      {shown ? (
        <div className="tx-call-b">
          {step.e.input && step.e.input !== '{}' ? <pre className="block wrap">{step.e.input}</pre> : null}
          {r ? <pre className={`block wrap${r.isError ? ' err' : ''}`}>{r.text || '(no output)'}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

function Entry({ e, showThinking, ownerName }: { e: TranscriptEntry; showThinking: boolean; ownerName: string }) {
  if (e.kind === 'notice') return <p className={`tx-notice${e.isError ? ' err' : ''}`}>{e.text}</p>;
  if (e.kind === 'thinking') {
    if (!showThinking) return null;
    return (
      <div className="tx-think">
        <span className="tx-who">Thinking</span>
        <p>{e.text}</p>
      </div>
    );
  }
  if (e.kind === 'result') return <pre className={`block wrap tx-orphan${e.isError ? ' err' : ''}`}>{e.text}</pre>;
  const incoming = e.role === 'user';
  return (
    <div className={`tx-msg ${incoming ? 'in' : 'out'}${e.sub ? ' sub' : ''}`}>
      <span className="tx-who">{incoming ? (e.text.startsWith(`${ownerName}:`) ? 'You' : /^Keelcrew board:/.test(e.text) ? 'Keelcrew board' : 'Message') : e.sub ? 'Subagent' : 'Agent'}</span>
      <Markdown text={e.text} />
    </div>
  );
}

/** The whole conversation of one session, newest at the bottom, with earlier pages on demand. */
export function TranscriptView({ session }: { session: Session }) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [source, setSource] = useState<'session' | 'events'>('session');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [showThinking, setShowThinking] = useState(true);
  const [expandAll, setExpandAll] = useState(false);
  const live = isLive(session);
  const ownerName = useCrewStore().crew?.config.owner?.name ?? '';

  const loadTail = useCallback(async () => {
    try {
      const t = await api.transcript(session.id, null, PAGE);
      setEntries(prev => {
        const first = prev[0]?.i ?? t.entries[0]?.i ?? 0;
        const keep = prev.filter(e => e.i < (t.entries[0]?.i ?? 0) && e.i >= first);
        return [...keep, ...t.entries];
      });
      setTotal(t.total);
      setSource(t.source);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [session.id]);

  useEffect(() => {
    setEntries([]);
    setLoading(true);
    void loadTail();
  }, [loadTail]);

  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => void loadTail(), LIVE_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [live, loadTail]);

  const loadEarlier = async () => {
    const first = entries[0]?.i ?? 0;
    const from = Math.max(0, first - PAGE);
    const t = await api.transcript(session.id, from, first - from).catch(() => null);
    if (t) setEntries(prev => [...t.entries, ...prev]);
  };

  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => (needle ? entries.filter(e => `${e.tool ?? ''} ${e.text} ${e.input ?? ''}`.toLowerCase().includes(needle)) : entries), [entries, needle]);
  const steps = useMemo(() => pairUp(shown), [shown]);
  const calls = entries.filter(e => e.kind === 'tool').length;

  return (
    <div className="tx">
      <div className="tx-bar">
        <span className="search">
          <Icon name="search" />
          <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search this conversation…" aria-label="Search the transcript" />
        </span>
        <button type="button" className="btn sm ghost" aria-pressed={showThinking} onClick={() => setShowThinking(v => !v)}>
          {showThinking ? 'Hide thinking' : 'Show thinking'}
        </button>
        <button type="button" className="btn sm ghost" aria-pressed={expandAll} onClick={() => setExpandAll(v => !v)}>
          {expandAll ? 'Collapse tools' : 'Expand tools'}
        </button>
      </div>
      <p className="note">
        {total.toLocaleString()} steps · {calls.toLocaleString()} tool calls loaded{source === 'events' ? ' · from the crew’s activity log (this session isn’t saved by Claude Code)' : ''}
        {live ? ' · live' : ''}
      </p>
      {error ? <div className="err-box">{error}</div> : null}
      {loading ? <p className="note">Loading the transcript…</p> : null}
      {entries.length && entries[0].i > 0 && !needle ? (
        <button type="button" className="btn sm" style={{ alignSelf: 'center' }} onClick={() => void loadEarlier()}>
          Load {Math.min(PAGE, entries[0].i)} earlier steps
        </button>
      ) : null}
      <div className="tx-list">
        {steps.map(st => (st.kind === 'call' ? <Call key={st.e.i} step={st} open={expandAll} /> : <Entry key={st.e.i} e={st.e} showThinking={showThinking} ownerName={ownerName} />))}
        {!loading && !steps.length ? <p className="empty">{needle ? 'Nothing matches.' : 'No messages yet.'}</p> : null}
      </div>
    </div>
  );
}

/** ID, folder and resume command, each copyable, plus when it started and what it has cost. */
function SessionMeta({ s }: { s: Session }) {
  const resume = `cd '${s.cwd}' && claude --resume ${s.id}`;
  return (
    <dl className="sess-meta">
      <dt>Session ID</dt>
      <dd>
        <code>{s.id}</code>
        <CopyButton text={s.id} className="btn sm ghost" />
      </dd>
      <dt>Folder</dt>
      <dd>
        <code>{s.cwd}</code>
        <CopyButton text={s.cwd} className="btn sm ghost" />
      </dd>
      <dt>Resume</dt>
      <dd>
        <code>{resume}</code>
        <CopyButton text={resume} className="btn sm ghost" />
      </dd>
      <dt>Activity</dt>
      <dd>
        Started {dayTime(s.createdAt)} · {s.turns} turns · {money(s.costUsd)} · {s.status}
      </dd>
    </dl>
  );
}

/** Full-height sheet with any agent's transcript, opened from a session's Transcript button (Muster, the Deck, a task or the chat). */
export function TranscriptSheet() {
  const crew = useCrewStore().crew;
  const id = useUi().transcriptId;
  const s = crew?.sessions.find(x => x.id === id);
  return (
    <>
      <div className="scrim" onClick={() => ui.closeSheet()} />
      <div className="sheet" role="dialog" aria-label="Transcript">
        <div className="sheet-head">
          <div style={{ minWidth: 0 }}>
            <h2>{s ? sessionName(s) : 'Transcript'}</h2>
            {s ? (
              <p className="note">
                {modelName(s.model)} · {s.effort}
                {s.taskKey ? ` · ${crew?.tasks.find(t => t.key === s.taskKey)?.title ?? s.taskKey}` : ''}
              </p>
            ) : null}
          </div>
          {s ? (
            <span className="tx-head-acts">
              <ContextMeter s={s} />
              <SessionActions s={s} labels="short" transcript={false} />
            </span>
          ) : null}
          <button type="button" className="x" aria-label="Close" onClick={() => ui.closeSheet()}>
            ×
          </button>
        </div>
        <div className="sheet-body">
          {s ? (
            <>
              <SessionMeta s={s} />
              <TranscriptView session={s} />
            </>
          ) : (
            <p className="note">That session is gone.</p>
          )}
        </div>
      </div>
    </>
  );
}
