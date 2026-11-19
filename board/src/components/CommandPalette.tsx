import { useEffect, useMemo, useRef, useState } from 'react';
import { fuzzyScore } from '../lib/fuzzy';
import { useCrewStore } from '../lib/store';
import { THEME_CHOICES } from '../lib/theme';
import { ui, useUi } from '../lib/ui';
import { Icon, type IconName } from './common';
import { NewTaskForm } from './NewTask';
import { scanJira, setAgentsPaused, setSchedulesPaused } from './shell/Controls';

interface Command {
  id: string;
  label: string;
  sub?: string;
  group: string;
  icon: IconName;
  run: () => void;
}

export function CommandPalette() {
  const crew = useCrewStore().crew;
  const { paletteMode } = useUi();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [mode, setMode] = useState<'list' | 'new'>(paletteMode);
  const listRef = useRef<HTMLUListElement>(null);
  const close = () => ui.closePalette();

  const canWrite = crew?.access.canWrite === true;
  const commands = useMemo<Command[]>(() => {
    if (!crew) return [];
    const c: Command[] = [
      ...(canWrite
        ? ([
            { id: 'new', label: 'New task…', sub: 'Any task, ticket or not', group: 'Action', icon: 'plus', run: () => setMode('new') },
            crew.paused
              ? { id: 'resume', label: 'Resume the crew', group: 'Action', icon: 'play', run: () => void setAgentsPaused(false) }
              : { id: 'pause', label: 'Pause the crew', sub: 'Running sessions stop at their next safe point', group: 'Action', icon: 'pause', run: () => void setAgentsPaused(true) },
            { id: 'scan', label: 'Scan Jira now', group: 'Action', icon: 'scan', run: () => void scanJira() },
            {
              id: 'sched',
              label: crew.schedulesPaused ? 'Resume schedules' : 'Pause schedules',
              sub: 'Watches only; sessions keep going',
              group: 'Action',
              icon: 'clock',
              run: () => void setSchedulesPaused(!crew.schedulesPaused),
            },
          ] satisfies Command[])
        : []),
      { id: 'search', label: 'Search…', sub: 'Tasks, chat and decisions', group: 'Go to', icon: 'search', run: () => ui.focusSearch(q.replace(/^search\s*/i, '')) },
      { id: 'signoffs', label: 'Sign-offs', sub: 'What is waiting for you', group: 'Go to', icon: 'check', run: () => ui.setView('signoffs') },
      { id: 'underway', label: 'Underway', sub: 'Every task', group: 'Go to', icon: 'work', run: () => ui.setView('underway') },
      { id: 'office', label: 'Deck', sub: 'The crew aboard the ship', group: 'Go to', icon: 'beacon', run: () => ui.setView('office') },
      { id: 'log', label: 'Log', sub: 'What happened, in time order', group: 'Go to', icon: 'list', run: () => ui.setView('log') },
      { id: 'chat', label: 'Chat with the Mate', group: 'Go to', icon: 'chat', run: () => ui.openChat() },
      { id: 'crew', label: 'Muster', sub: 'Sessions, spend, watches', group: 'Go to', icon: 'users', run: () => ui.setView('crew') },
      { id: 'orders', label: 'Standing orders', sub: 'Lessons and the standing orders in force', group: 'Go to', icon: 'book', run: () => ui.setView('orders') },
      { id: 'settings', label: 'Settings', group: 'Settings', icon: 'gear', run: () => ui.openSettings() },
      { id: 'crew-settings', label: 'Crew settings', sub: 'Who works, their models and schedules', group: 'Settings', icon: 'users', run: () => ui.openSettings('crew') },
      { id: 'task-settings', label: 'Task settings', sub: 'Jira, repos and goals', group: 'Settings', icon: 'work', run: () => ui.openSettings('tasks') },
      { id: 'limits', label: 'Limits', sub: 'Engineers at once, plan usage, times to ask you', group: 'Settings', icon: 'clock', run: () => ui.openSettings('limits') },
      { id: 'perm', label: 'Rules', sub: 'What the crew may do', group: 'Settings', icon: 'shield', run: () => ui.openSettings('rules') },
      { id: 'logs', label: 'Logs', group: 'Settings', icon: 'list', run: () => ui.openSheet('logs') },
      ...THEME_CHOICES.map(([id, label, hint]): Command => ({ id: `theme-${id}`, label: `Theme: ${label}`, sub: hint, group: 'Settings', icon: 'gear', run: () => (ui.setTheme(id), ui.closePalette()) })),
    ];
    const tasks = [...crew.tasks].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const t of tasks) c.push({ id: `open:${t.key}`, label: `Open ${t.key}`, sub: t.title, group: 'Ticket', icon: 'chevron', run: () => ui.openTask(t.key) });
    return c;
  }, [crew, q, canWrite]);

  const shown = useMemo(() => {
    if (!q.trim()) return commands.filter(c => c.group !== 'Ticket' || commands.indexOf(c) < 22).slice(0, 30);
    return commands
      .map(c => ({ c, s: fuzzyScore(q, `${c.label} ${c.sub ?? ''}`) }))
      .filter((x): x is { c: Command; s: number } => x.s !== null)
      .sort((a, b) => b.s - a.s)
      .slice(0, 30)
      .map(x => x.c);
  }, [commands, q]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (mode === 'new') setMode('list');
        else close();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [mode]);

  if (!crew) return null;
  const choose = (c: Command | undefined) => {
    if (!c) return;
    if (c.id !== 'new') close();
    c.run();
  };
  return (
    <>
      <div className="scrim" onClick={close} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        {mode === 'new' ? (
          <>
            <div className="pin">
              <Icon name="plus" />
              <b>New task</b>
            </div>
            <NewTaskForm onDone={close} />
          </>
        ) : (
          <>
            <div className="pin">
              <Icon name="search" />
              <input
                autoFocus
                value={q}
                placeholder="Type a command or a ticket key"
                aria-label="Command"
                role="combobox"
                aria-expanded="true"
                aria-controls="palette-list"
                aria-activedescendant={shown[active] ? `cmd-${shown[active].id}` : undefined}
                onChange={e => setQ(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActive(a => Math.min(shown.length - 1, a + 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActive(a => Math.max(0, a - 1));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    choose(shown[active]);
                  }
                }}
              />
            </div>
            <ul id="palette-list" role="listbox" ref={listRef}>
              {shown.length ? null : <li className="sub">No matches.</li>}
              {shown.map((c, i) => (
                <li key={c.id} id={`cmd-${c.id}`} role="option" aria-selected={i === active} onMouseMove={() => setActive(i)} onClick={() => choose(c)}>
                  <Icon name={c.icon} />
                  <span>{c.label}</span>
                  {c.sub ? <span className="sub">{c.sub}</span> : null}
                  <span className="grp">{c.group}</span>
                </li>
              ))}
            </ul>
            <div className="foot">
              <span>
                <kbd>↑</kbd> <kbd>↓</kbd> move
              </span>
              <span>
                <kbd>↵</kbd> run
              </span>
              <span>
                <kbd>esc</kbd> close
              </span>
            </div>
          </>
        )}
      </div>
    </>
  );
}
