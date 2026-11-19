import { useState, type CSSProperties } from 'react';
import { api } from '../lib/api';
import { patchCrew, useCanWrite, useCrewStore } from '../lib/store';
import { toast } from '../lib/toast';
import { ui } from '../lib/ui';
import type { Session } from '../types';
import { Icon } from './common';

/** 48_210 → "48k"; 1_200_000 → "1.2M". */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

const contextPct = (s: Session): number | null => (s.contextTokens != null && s.contextMax ? Math.round((s.contextTokens / s.contextMax) * 100) : null);

/** The share of the context window at which the meter turns amber: time to wrap up or compact. */
export const CONTEXT_WARN_PCT = 70;

/** How full the session's context window is, as of its last turn. */
export function ContextMeter({ s }: { s: Session }) {
  const at = CONTEXT_WARN_PCT;
  const p = contextPct(s);
  if (p == null || s.contextTokens == null || !s.contextMax)
    return (
      <span className="ctx" title="Measured when this session's next turn ends.">
        Context —
      </span>
    );
  const title = `${s.contextTokens.toLocaleString()} of ${s.contextMax.toLocaleString()} tokens in context (${p}%).`;
  return (
    <span className={p >= 90 ? 'ctx full' : p >= at ? 'ctx hot' : 'ctx'} title={title} role="img" aria-label={title}>
      <span className="bar">
        <i style={{ '--p': `${Math.min(100, p)}%` } as CSSProperties} />
      </span>
      <span>
        <b>{tokens(s.contextTokens)}</b> / {tokens(s.contextMax)}
      </span>
    </span>
  );
}

const busy = (s: Session): boolean => s.status === 'starting' || (s.status === 'running' && s.activity !== 'idle' && s.activity !== 'waiting');
export const canOpen = (s: Session): boolean => !!s.cwd || s.role === 'lead';


/** Open the real session in Terminal, read its transcript, compact it. `labels` shows words next to the icons. */
export function SessionActions({ s, labels, transcript = true }: { s: Session; labels?: 'short' | 'long'; transcript?: boolean }) {
  const [working, setWorking] = useState<'open' | 'compact' | null>(null);
  const target = useCrewStore().crew?.config.terminal;
  const owner = useCanWrite();
  const app = target === 'terminal' ? 'Terminal' : target === 'desktop' ? 'the Claude app' : 'Warp';
  const open = async () => {
    setWorking('open');
    try {
      await api.openSession(s.id);
      toast(`Opened in ${app}. What you type there continues the same conversation.`);
    } catch {
      /* toasted */
    } finally {
      setWorking(null);
    }
  };
  const compact = async () => {
    setWorking('compact');
    try {
      const next = await api.compactSession(s.id);
      patchCrew(h => ({ ...h, sessions: h.sessions.map(x => (x.id === next.id ? next : x)) }));
      toast(s.taskKey ? 'It compacts itself between its turns; the board closes the request.' : 'Asked the Mate to compact it.');
    } catch {
      /* toasted */
    } finally {
      setWorking(null);
    }
  };
  const isBusy = busy(s);
  const cls = labels ? 'btn sm ghost' : 'btn icon sm ghost';
  return (
    <span className="acts">
      {owner && canOpen(s) ? (
        <button type="button" className={cls} onClick={() => void open()} disabled={working !== null} title={`Open this session in ${app}`} aria-label={`Open the session in ${app}`}>
          <Icon name="open" />
          {labels ? <span className="lbl">{labels === 'long' ? 'Open session' : 'Open'}</span> : null}
        </button>
      ) : null}
      {transcript ? (
        <button type="button" className={cls} onClick={() => ui.openTranscript(s.id)} title="Read the full conversation" aria-label="Transcript">
          <Icon name="transcript" />
          {labels ? <span className="lbl">Transcript</span> : null}
        </button>
      ) : null}
      {owner && canOpen(s) ? (
        <button type="button" className={cls} onClick={() => void compact()} disabled={working !== null || isBusy} title={isBusy ? 'Mid-turn. Compact once it goes idle.' : 'Summarise the conversation to free the context window (/compact)'} aria-label="Compact context">
          <Icon name="compact" />
          {labels ? <span className="lbl">Compact</span> : null}
        </button>
      ) : null}
    </span>
  );
}
