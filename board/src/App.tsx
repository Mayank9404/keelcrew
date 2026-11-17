/**
 * The shell: the top bar, the current screen, the Mate chat docked beside it on wide screens, the task detail panel,
 * and the sheets and palette on top.
 */
import { useEffect } from 'react';
import { ChatPanel } from './components/chat/ChatPanel';
import { CommandPalette } from './components/CommandPalette';
import { BrandMark, cls, useMedia } from './components/common';
import { ConnectionBanner, Notices } from './components/ConnectionBanner';
import { CrewView } from './components/crew/CrewView';
import { DoctorSheet } from './components/Doctor';
import { DeskView } from './components/desk/DeskView';
import { LogView } from './components/log/LogView';
import { LogsSheet } from './components/Logs';
import { MemoryView } from './components/memory/MemoryView';
import { OfficeView } from './components/office/OfficeView';
import { SettingsView } from './components/settings/SettingsView';
import { TopBar } from './components/shell/Nav';
import { TaskDetail } from './components/task/TaskDetail';
import { Toasts } from './components/Toasts';
import { TranscriptSheet } from './components/Transcript';
import { UnderwayView } from './components/underway/UnderwayView';
import { checklistVersion, isDismissed, runDoctor } from './lib/doctor';
import { useCrewStore } from './lib/store';
import { DOCK_MEDIA, isAskMateKey, ui, uiStore, useUi } from './lib/ui';

function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (uiStore.get().paletteOpen) ui.closePalette();
        else ui.openPalette();
      }
      if (isAskMateKey(e)) {
        e.preventDefault();
        ui.askMate();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

let interacted = false;
for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, () => void (interacted = true), { once: true, capture: true });

/** Run the health checks once per load; open the checklist only if nothing has been clicked yet. */
function useFirstRunDoctor(ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    let live = true;
    void runDoctor().then((checks) => {
      if (!live || !checks) return;
      const version = checklistVersion(checks);
      if (version && !isDismissed(version) && !interacted && !uiStore.get().sheet) ui.openSheet('doctor');
    });
    return () => {
      live = false;
    };
  }, [ready]);
}

export function App() {
  const { crew, conn } = useCrewStore();
  const { view, task, sheet, paletteOpen, chatDock } = useUi();
  const wide = useMedia(DOCK_MEDIA);
  useGlobalKeys();
  useFirstRunDoctor(crew?.helper.status === 'ok');
  useEffect(() => {
    const m = document.getElementById('main');
    if (m) m.scrollTop = 0;
  }, [view]);
  if (!crew) {
    return (
      <div className="boot">
        <BrandMark />
        <b>Keelcrew</b>
        <p>{conn === 'down' ? 'Open Keelcrew in Claude to see your crew.' : 'Connecting…'}</p>
        <ConnectionBanner />
        <Toasts />
      </div>
    );
  }
  const docked = wide && chatDock && view !== 'chat';
  return (
    <div className={cls('app', docked && 'docked')}>
      <TopBar crew={crew} />
      <main className="main" id="main">
        <Notices crew={crew} />
        {view === 'signoffs' ? <DeskView crew={crew} /> : null}
        {view === 'underway' ? <UnderwayView crew={crew} /> : null}
        {view === 'office' ? <OfficeView crew={crew} /> : null}
        {view === 'orders' ? <MemoryView crew={crew} /> : null}
        {view === 'log' ? <LogView crew={crew} /> : null}
        {view === 'chat' ? <ChatPanel crew={crew} docked={false} /> : null}
        {view === 'crew' ? <CrewView crew={crew} /> : null}
        {view === 'settings' ? <SettingsView /> : null}
      </main>
      {docked ? <ChatPanel crew={crew} docked /> : null}
      {task ? (
        <>
          <div className="scrim detail-scrim" onClick={() => ui.closeTask()} />
          <TaskDetail key={task.key} crew={crew} taskKey={task.key} tab={task.tab} evidenceId={task.evidenceId} />
        </>
      ) : null}
      {sheet === 'doctor' ? <DoctorSheet /> : null}
      {sheet === 'transcript' ? <TranscriptSheet /> : null}
      {sheet === 'logs' ? <LogsSheet /> : null}
      {paletteOpen ? <CommandPalette /> : null}
      <ConnectionBanner />
      <Toasts />
    </div>
  );
}
