/**
 * The board's small building blocks: icons, the brand mark, state pills, section frames, empty states, feed freshness,
 * and a few hooks. Every color comes from the tokens in styles/tokens.css through a `tone`.
 */
import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { ago, copyText } from '../lib/format';
import { useCrewStore } from '../lib/store';
import { toast } from '../lib/toast';
import { ui } from '../lib/ui';
import type { Feed } from '../types';

const PATHS = {
  work: 'M4 5h16v3H4Zm0 5.5h16v3H4ZM4 16h10v3H4Z',
  search: 'M11 4a7 7 0 1 0 4.4 12.4l4.1 4.1 1.4-1.4-4.1-4.1A7 7 0 0 0 11 4Zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z',
  gear: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm0 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm-1.2-8.5h2.4l.5 2.6a7.6 7.6 0 0 1 1.7 1l2.5-.9 1.2 2.1-2 1.7a7.7 7.7 0 0 1 0 2l2 1.7-1.2 2.1-2.5-.9a7.6 7.6 0 0 1-1.7 1l-.5 2.6h-2.4l-.5-2.6a7.6 7.6 0 0 1-1.7-1l-2.5.9-1.2-2.1 2-1.7a7.7 7.7 0 0 1 0-2l-2-1.7 1.2-2.1 2.5.9a7.6 7.6 0 0 1 1.7-1Z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 2a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm-1 2v5.4l4 2.4 1-1.7-3-1.8V7Z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6Z',
  scan: 'M4 4h5v2H6v3H4Zm11 0h5v5h-2V6h-3ZM4 15h2v3h3v2H4Zm14 0h2v5h-5v-2h3ZM7 11h10v2H7Z',
  pause: 'M7 5h3v14H7Zm7 0h3v14h-3Z',
  play: 'M8 5v14l11-7Z',
  shield: 'M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5Zm0 2.2 6 2.2V11c0 3.9-2.5 7.4-6 8.8-3.5-1.4-6-4.9-6-8.8V6.4Z',
  chevron: 'm9 6 6 6-6 6-1.4-1.4 4.6-4.6-4.6-4.6Z',
  command: 'M7 4a3 3 0 0 0 0 6h1v4H7a3 3 0 1 0 3 3v-1h4v1a3 3 0 1 0 3-3h-1v-4h1a3 3 0 1 0-3-3v1h-4V7a3 3 0 0 0-3-3Zm0 2a1 1 0 0 1 1 1v1H7a1 1 0 0 1 0-2Zm10 0a1 1 0 0 1 0 2h-1V7a1 1 0 0 1 1-1Zm-7 4h4v4h-4Zm-3 6h1v1a1 1 0 1 1-1-1Zm9 0h1a1 1 0 1 1-1 1Z',
  chart: 'M4 20V4h2v14h14v2Zm4-4v-5h2v5Zm4 0V7h2v9Zm4 0v-7h2v7Z',
  check: 'm9.5 16.2-4.2-4.2-1.4 1.4 5.6 5.6 11-11-1.4-1.4Z',
  x: 'M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6Z',
  minus: 'M5 11h14v2H5Z',
  alert: 'M12 2 1 21h22Zm0 4 7.5 13h-15Zm-1 4v5h2v-5Zm0 6v2h2v-2Z',
  bell: 'M12 3a6 6 0 0 0-6 6v3.6L4.3 15.4A1 1 0 0 0 5.2 17h13.6a1 1 0 0 0 .9-1.6L18 12.6V9a6 6 0 0 0-6-6Zm0 2a4 4 0 0 1 4 4v4.1l1 1.9H7l1-1.9V9a4 4 0 0 1 4-4Zm-2 13a2 2 0 0 0 4 0Z',
  bellOff: 'M3.7 2.3 2.3 3.7l3.9 3.9A6 6 0 0 0 6 9v3.6l-1.7 2.8A1 1 0 0 0 5.2 17h11.4l3.7 3.7 1.4-1.4ZM8 10.4 14.6 15H7l1-1.9ZM12 3a6 6 0 0 0-3.2.9l1.5 1.5A4 4 0 0 1 16 9v3.5l2 2V9a6 6 0 0 0-6-6Zm-2 15a2 2 0 0 0 4 0Z',
  folder: 'M3 5h7l2 2h9v12H3Zm2 2v10h14V9h-7.8l-2-2Z',
  terminal: 'M3 4h18v16H3Zm2 2v12h14V6Zm2 2.5 3.5 3.5L7 15.5l1.4 1.4 4.9-4.9-4.9-4.9ZM13 15h4v2h-4Z',
  code: 'm8.6 16.6-4.6-4.6 4.6-4.6L7.2 6 1.2 12l6 6Zm6.8 0 4.6-4.6-4.6-4.6L16.8 6l6 6-6 6Z',
  open: 'M14 3h7v7h-2V6.4l-7.3 7.3-1.4-1.4L17.6 5H14ZM4 5h7v2H6v11h11v-5h2v7H4Z',
  expand: 'M4 4h6v2H7.4l3.3 3.3-1.4 1.4L6 7.4V10H4Zm10 0h6v6h-2V7.4l-3.3 3.3-1.4-1.4L16.6 6H14ZM4 14h2v2.6l3.3-3.3 1.4 1.4L7.4 18H10v2H4Zm16 0v6h-6v-2h2.6l-3.3-3.3 1.4-1.4 3.3 3.3V14Z',
  compact: 'M3.3 19.3 8.6 14H5v-2h7v7h-2v-3.6l-5.3 5.3Zm17.4-14.6L15.4 10H19v2h-7V5h2v3.6l5.3-5.3Z',
  transcript: 'M5 3h10l4 4v14H5Zm2 2v14h10V8h-3V5Zm2 6h6v2H9Zm0 4h6v2H9Z',
  chat: 'M4 4h16v12H8.4L4 19.6Zm2 2v9.2L7.6 14H18V6Z',
  sidebar: 'M3 4h18v16H3Zm2 2v12h4V6Zm6 0v12h8V6Z',
  list: 'M4 6h2v2H4Zm4 0h12v2H8Zm-4 5h2v2H4Zm4 0h12v2H8Zm-4 5h2v2H4Zm4 0h12v2H8Z',
  link: 'M9 2h2v4h2V2h2v4h2v5a5 5 0 0 1-4 4.9V22h-2v-6.1A5 5 0 0 1 7 11V6h2Zm0 6v3a3 3 0 0 0 6 0V8Z',
  users: 'M9 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7 1a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 2a1 1 0 1 1 0 2 1 1 0 0 1 0-2ZM9 13c-3.3 0-6 1.7-6 4v3h12v-3c0-2.3-2.7-4-6-4Zm0 2c2.3 0 4 1 4 2v1H5v-1c0-1 1.7-2 4-2Zm7-1c-.6 0-1.2.1-1.7.2.9.8 1.5 1.8 1.6 2.8H19v2h2v-2c0-1.7-2.2-3-5-3Z',
  book: 'M6 2h13v20H6a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3Zm0 2a1 1 0 0 0-1 1v10.2c.3-.1.6-.2 1-.2h11V4Zm0 13a1 1 0 0 0 0 2h11v-2ZM8 7h7v2H8Zm0 3h5v2H8Z',
  pin: 'M14.6 2 22 9.4l-1.4 1.4-1-1-3.9 3.9.3 4.3-1.5 1.5-3.4-3.4L6.4 20.8 5 19.4l4.7-4.7-3.4-3.4 1.5-1.5 4.3.3 3.9-3.9-1-1Z',
  refresh: 'M12 4a8 8 0 0 0-7.4 5H7a6 6 0 0 1 10.2-1.2L15 10h6V4l-2.3 2.3A8 8 0 0 0 12 4Zm-7 10v6l2.3-2.3A8 8 0 0 0 19.4 15H17a6 6 0 0 1-10.2 1.2L9 14Z',
  flag: 'M5 3h2v18H5Zm3 1h11l-2.5 4 2.5 4H8Z',
  lock: 'M12 2a5 5 0 0 0-5 5v3H5v12h14V10h-2V7a5 5 0 0 0-5-5Zm0 2a3 3 0 0 1 3 3v3H9V7a3 3 0 0 1 3-3Zm-5 8h10v8H7Z',
  coin: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 2a7 7 0 1 1 0 14 7 7 0 0 1 0-14Zm-1 2v1.1c-1.7.3-3 1.4-3 2.9 0 1.8 1.6 2.4 3.4 2.8 1.5.3 2.1.6 2.1 1.2 0 .6-.7 1-1.8 1-1.2 0-1.9-.5-2-1.3H7.7c.1 1.6 1.4 2.8 3.3 3.1V19h2v-1.2c1.8-.3 3-1.4 3-3 0-1.9-1.6-2.5-3.5-2.9-1.4-.3-2-.6-2-1.1 0-.5.6-.9 1.6-.9s1.6.4 1.7 1.1h2c-.1-1.5-1.2-2.6-2.8-2.9V7Z',
  beacon: 'M12 2 22 12 12 22 2 12Z',
  arrow: 'M13.2 5.8 11.8 7.2l3.8 3.8H4v2h11.6l-3.8 3.8 1.4 1.4L19.4 12Z',
  send: 'M11 20V7.8l-4.6 4.6L5 11l7-7 7 7-1.4 1.4L13 7.8V20Z',
  dots: 'M5 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm7 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, title, className }: { name: IconName; title?: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className ? `ic ${className}` : 'ic'} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The anchor K: a K whose stem is an anchor's shank (ring and stock on top) and whose lower leg ends in a fluke. */
export function BrandMark() {
  return (
    <svg viewBox="0 0 56 56" aria-hidden="true" className="brand-mark">
      <rect x="0.75" y="0.75" width="54.5" height="54.5" rx="12" fill="var(--surface)" stroke="var(--line-strong)" strokeWidth="1.5" />
      <circle cx="19" cy="10.5" r="3" fill="none" stroke="var(--ink)" strokeWidth="2.6" />
      <rect x="12" y="15" width="14" height="3.4" rx="1.7" fill="var(--ink)" />
      <rect x="16.5" y="13" width="5" height="32" rx="1.2" fill="var(--ink)" />
      <path d="M21 30 L37 13" stroke="var(--ink)" strokeWidth="5" strokeLinecap="round" />
      <path d="M21 30 Q31 34 38 43" stroke="var(--ink)" strokeWidth="5" fill="none" strokeLinecap="round" />
      <path d="M32.5 45 L41.5 46 L39.5 37 Z" fill="var(--you)" />
    </svg>
  );
}

/**
 * State tones. work: moving. you: waiting on the captain. block: can't go on. ok: done or passing. qa: with QA. warn:
 * worth a look. muted: idle or off. neutral: plain information.
 */
export type Tone = 'work' | 'you' | 'block' | 'ok' | 'qa' | 'warn' | 'muted' | 'neutral' | 'agent';

/** Inline style setting the `--c` colour from a tone (or a raw token like `--ok`). */
export const tone = (t: Tone | string): CSSProperties => ({ '--c': `var(${t.startsWith('--') ? t : `--${t}`})` }) as CSSProperties;
/** Alias of `tone`, for components that pass a token. */
export const cvar = tone;

/** A state pill: shape and color say the state, the words say it again. `solid` for the one that matters most. */
export function Pill({ tone: t = 'neutral', children, solid, icon, title }: { tone?: Tone | string; children: ReactNode; solid?: boolean; icon?: IconName; title?: string }) {
  return (
    <span className={solid ? 'pill solid' : 'pill'} style={tone(t)} title={title}>
      {icon ? <Icon name={icon} /> : <i aria-hidden="true" />}
      {children}
    </span>
  );
}

/** A small round state light. */
export const Dot = ({ tone: t, pulse, label }: { tone: Tone | string; pulse?: boolean; label?: string }) => (
  <span className={pulse ? 'dot pulse' : 'dot'} style={tone(t)} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />
);

/** A task key that opens the task. */
export function KeyLink({ k, tab }: { k: string; tab?: Parameters<typeof ui.openTask>[1] }) {
  return (
    <button type="button" className="key" onClick={(e) => (e.stopPropagation(), ui.openTask(k, tab))}>
      {k}
    </button>
  );
}

/** A page's title row: what this is, a one-line status, and its main actions. */
export function PageHeader({ title, status, actions }: { title: string; status?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="ph-text">
        <h1>{title}</h1>
        {status ? <p className="ph-status">{status}</p> : null}
      </div>
      {actions ? <div className="ph-actions">{actions}</div> : null}
    </header>
  );
}

/** A titled section with a count, a freshness note and actions on the right. */
export function Section({ title, count, meta, actions, children, id, tone: t, className }: { title: string; count?: number | string; meta?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string; tone?: Tone; className?: string }) {
  return (
    <section className={className ? `section ${className}` : 'section'} id={id} aria-label={title}>
      <div className="sec-head" style={t ? tone(t) : undefined}>
        <h2>
          {title}
          {count !== undefined && count !== '' ? <span className="count">{count}</span> : null}
        </h2>
        {meta ? <span className="sec-meta">{meta}</span> : null}
        {actions ? <span className="sec-actions">{actions}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** An empty state: what will appear here, and how it gets here. */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

/**
 * A helper-backed section's freshness: "Updated 2m ago", or the error with the age of the data still shown, or that
 * the helper lacks the tool. Nothing before the first load.
 */
export function FeedNote({ feed, now, label = 'Updated' }: { feed: Feed; now: number; label?: string }) {
  if (feed.missing) return <span className="feed missing">Needs a newer helper</span>;
  if (feed.error) return <span className="feed err" title={feed.error}>{feed.at ? `Couldn’t refresh · data from ${ago(feed.at, now)}` : 'Couldn’t load'}</span>;
  if (!feed.at) return null;
  return <span className="feed">{label} {ago(feed.at, now)}</span>;
}

/** A share bar (0..1+) with a 85% tick, toned by level. */
export function ShareBar({ share, tone: t, label }: { share: number | null; tone: Tone; label: string }) {
  const p = share == null ? 0 : Math.min(1, share);
  return (
    <span className="share" style={tone(t)} role="img" aria-label={label}>
      <i style={{ width: `${Math.round(p * 100)}%` }} />
      <b aria-hidden="true" />
    </span>
  );
}

export function CopyButton({ text, label = 'Copy', done = 'Copied', className = 'btn sm' }: { text: string; label?: string; done?: string; className?: string }) {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!ok) return;
    const t = window.setTimeout(() => setOk(false), 1600);
    return () => window.clearTimeout(t);
  }, [ok]);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        if (await copyText(text)) setOk(true);
        else toast(`Copy failed. ${text}`, 'warn');
      }}
    >
      {ok ? done : label}
    </button>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

/** "Show details" toggle around secondary content. */
export function Details({ children, label = 'Show details', openLabel = 'Hide details', defaultOpen = false, onOpen }: { children: ReactNode; label?: ReactNode; openLabel?: ReactNode; defaultOpen?: boolean; onOpen?: () => void }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="details">
      <button
        type="button"
        className="disclosure"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen((o) => !o);
        }}
      >
        <Icon name="chevron" />
        {open ? openLabel : label}
      </button>
      {open ? <div className="details-body">{children}</div> : null}
    </div>
  );
}

/** Re-render on an interval (relative times, countdowns). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

/** A media query, live. */
export function useMedia(query: string): boolean {
  const get = () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
  const [on, setOn] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(query);
    const fn = () => setOn(m.matches);
    fn();
    m.addEventListener('change', fn);
    return () => m.removeEventListener('change', fn);
  }, [query]);
  return on;
}

/** Known task keys, for linking them in Markdown. */
export function useTaskKeys(): ReadonlySet<string> {
  const tasks = useCrewStore().crew?.tasks;
  return useMemo(() => new Set((tasks ?? []).map((t) => t.key)), [tasks]);
}

/** Close on Escape and on clicks outside the given element; a popover inside it is nudged back on screen. */
export function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void): void {
  useLayoutEffect(() => {
    const el = open ? ref.current?.querySelector<HTMLElement>(':scope > .popover') : null;
    if (!el) return;
    el.style.translate = '';
    const r = el.getBoundingClientRect();
    const pad = 8;
    const dx = r.left < pad ? pad - r.left : r.right > window.innerWidth - pad ? window.innerWidth - pad - r.right : 0;
    if (dx) el.style.translate = `${Math.round(dx)}px 0`;
  }, [open, ref]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [open, ref, close]);
}

/** Joins class names, skipping falsy ones. */
export const cls = (...xs: (string | false | null | undefined)[]): string => xs.filter(Boolean).join(' ');
