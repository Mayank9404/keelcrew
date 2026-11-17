/** Navigation: one top bar with the five screens, the Mate, New task and a menu for everything else. */
import { useCallback, useRef, useState } from 'react';
import { LEAD } from '../../labels';
import { leadAsked, leadStatus } from '../../lib/derive';
import { THEME_CHOICES } from '../../lib/theme';
import { cardsForYou, stuckItems } from '../../lib/triage';
import { ui, useUi, type View } from '../../lib/ui';
import type { CrewState } from '../../types';
import { BrandMark, Dot, Icon, cls, useDismiss, useNow } from '../common';
import { DndMenu, PauseControl, UsageMeters } from './Controls';

interface NavItem {
  id: View;
  label: string;
}

export const NAV: NavItem[] = [
  { id: 'signoffs', label: 'Sign-offs' },
  { id: 'underway', label: 'Underway' },
  { id: 'office', label: 'Deck' },
  { id: 'orders', label: 'Standing orders' },
  { id: 'log', label: 'Log' },
];

/** Counts beside the screen names: items waiting on you, tasks in flight, anything stuck, the Mate asking. */
function useBadges(crew: CrewState, now: number) {
  const you = cardsForYou(crew).length;
  const moving = crew.tasks.filter((t) => t.status === 'active' || t.status === 'pr' || t.status === 'qa').length;
  return { you, moving, stuck: stuckItems(crew, now).length, asked: leadAsked(crew) };
}

/** The way into the Mate chat, drawn as a field to type in: it opens the chat with the cursor in the message box. */
function AskMate({ crew, asked }: { crew: CrewState; asked: boolean }) {
  const s = leadStatus(crew);
  const word = s.word === 'busy' ? s.short : s.word;
  return (
    <button type="button" className={cls('tb-ask', asked && 'asked')} onClick={() => ui.askMate()} title={`Message the ${LEAD} (press /)`} aria-label={asked ? `The ${LEAD} asked you something: open the chat` : `Ask the ${LEAD}, who is ${word}`}>
      <Icon name="chat" />
      <span className="tb-ask-text">{asked ? `The ${LEAD} asked you something` : `Ask the ${LEAD}…`}</span>
      <span className="tb-ask-state">
        <Dot tone={s.color} pulse={s.word === 'busy'} />
        {asked ? null : word}
      </span>
    </button>
  );
}

/** The theme choice: a per-viewer preference, so it lives in the menu and not in Settings. */
function ThemeRow() {
  const { theme } = useUi();
  return (
    <div className="theme-row" role="group" aria-label="Theme">
      <span>Theme</span>
      <div className="seg">
        {THEME_CHOICES.map(([id, label, hint]) => (
          <button key={id} type="button" aria-pressed={theme === id} title={hint} onClick={() => ui.setTheme(id)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function MoreMenu({ crew, now }: { crew: CrewState; now: number }) {
  const { view } = useUi();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);
  const here = view === 'crew' || view === 'settings';
  return (
    <div className="pop-anchor" ref={ref}>
      <button type="button" className={cls('tb-more', here && 'on')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        More
        <Icon name="chevron" />
      </button>
      {open ? (
        <div className="popover menu wide" role="menu">
          <button type="button" className="mi" role="menuitem" onClick={() => (close(), ui.setView('crew'))}>
            <Icon name="users" />
            Muster: sessions, spend and watches
          </button>
          <button type="button" className="mi" role="menuitem" onClick={() => (close(), ui.openSettings())}>
            <Icon name="gear" />
            Settings
          </button>
          <button type="button" className="mi" role="menuitem" onClick={() => (close(), ui.openPalette())}>
            <Icon name="command" />
            Commands
            <kbd className="end">{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
          <hr />
          <ThemeRow />
          <hr />
          <UsageMeters crew={crew} now={now} />
          <PauseControl crew={crew} />
          {crew.access.canWrite ? <DndMenu crew={crew} now={now} /> : null}
        </div>
      ) : null}
    </div>
  );
}

export function TopBar({ crew }: { crew: CrewState }) {
  const { view } = useUi();
  const now = useNow(30_000);
  const b = useBadges(crew, now);
  return (
    <header className="topbar">
      <button type="button" className="brand" onClick={() => ui.setView('signoffs')} aria-label="Keelcrew, go to Sign-offs">
        <BrandMark />
        <span>Keelcrew</span>
      </button>
      <nav className="tb-nav" aria-label="Screens">
        {NAV.map((n) => (
          <button key={n.id} type="button" className={cls('tb-i', view === n.id && 'on')} aria-current={view === n.id ? 'page' : undefined} onClick={() => ui.setView(n.id)}>
            {n.label}
            {n.id === 'signoffs' && b.you ? <span className="badge you" aria-label={`${b.you} waiting for you`}>{b.you}</span> : null}
            {n.id === 'underway' && b.moving ? <span className="badge" aria-label={`${b.moving} in flight`}>{b.moving}</span> : null}
            {n.id === 'underway' && b.stuck ? <span className="badge b-stuck">{`${b.stuck} stuck`}</span> : null}
          </button>
        ))}
      </nav>
      <div className="tb-right">
        <AskMate crew={crew} asked={b.asked} />
        {crew.access.canWrite ? (
          <button type="button" className="btn primary" onClick={() => ui.newTask()}>
            <Icon name="plus" />
            New task
          </button>
        ) : null}
        <MoreMenu crew={crew} now={now} />
      </div>
    </header>
  );
}
