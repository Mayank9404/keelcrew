/**
 * Where the captain is: the screen, the open task, sheets, the palette and the chat dock. The chat dock is a per-viewer
 * preference kept in localStorage, wrapped so a blocked storage changes nothing.
 */
import { createStore, useStore } from './createStore';
import { readThemePref, saveThemePref, watchTheme, type Theme, type ThemePref } from './theme';

/** The screens: the five in the top bar, then the Mate chat, Muster and settings. */
export type View = 'signoffs' | 'underway' | 'office' | 'orders' | 'log' | 'chat' | 'crew' | 'settings';
export const VIEWS: View[] = ['signoffs', 'underway', 'office', 'orders', 'log', 'chat', 'crew', 'settings'];

/** A task's detail: the story first, then the raw material. */
export type TaskTab = 'story' | 'evidence' | 'diff' | 'transcript' | 'activity' | 'manage';
export type Sheet = 'doctor' | 'transcript' | 'logs' | null;
/** The groups of the settings page, top to bottom. */
export type SettingsSection = 'crew' | 'tasks' | 'shipping' | 'limits' | 'mac' | 'rules';
export type UnderwayFilter = 'flight' | 'waiting' | 'done' | 'all';

export interface UiState {
  view: View;
  /** The task open in the detail panel, and its tab. */
  task: { key: string; tab: TaskTab; evidenceId: string | null } | null;
  sheet: Sheet;
  /** A request to bring a settings group into view. */
  settingsFocus: { section: SettingsSection; n: number } | null;
  paletteOpen: boolean;
  /** The command palette opens on its command list or on the New task form. */
  paletteMode: 'list' | 'new';
  /** On wide screens the Mate chat sits beside every screen. */
  chatDock: boolean;
  underwayFilter: UnderwayFilter;
  /** A request to focus the Underway search box with a query. */
  search: { q: string; n: number } | null;
  /** A waiting item to bring to the desk on Sign-offs. */
  focusCard: { id: string; n: number } | null;
  /** Session shown in the transcript sheet. */
  transcriptId: string | null;
  /** The viewer's theme choice (per browser), and the theme it comes to: `auto` follows the system. */
  theme: ThemePref;
  chart: Theme;
}

const DOCK_KEY = 'crew.chatDock';
function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function saveFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* per-viewer preference only */
  }
}

export const uiStore = createStore<UiState>({
  view: 'signoffs',
  task: null,
  sheet: null,
  settingsFocus: null,
  paletteOpen: false,
  paletteMode: 'list',
  chatDock: readFlag(DOCK_KEY),
  underwayFilter: 'flight',
  search: null,
  focusCard: null,
  transcriptId: null,
  theme: readThemePref(),
  chart: 'day',
});

export const useUi = (): UiState => useStore(uiStore);

const patch = (p: Partial<UiState>): void => uiStore.set((s) => ({ ...s, ...p }));
let seq = 0;

/** Whether the chat can sit beside the view (wide screens); narrower screens open it as its own view. */
export const DOCK_MEDIA = '(min-width: 880px)';

/** Whether a key press is the / shortcut to the Mate chat: not while typing, and not behind the palette, a sheet or a task. */
export function isAskMateKey(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'target'>): boolean {
  const s = uiStore.get();
  const t = e.target as Element | null;
  return e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !s.paletteOpen && !s.sheet && !s.task && !t?.closest?.('input, textarea, select, [contenteditable], [role=dialog]');
}
export const canDock = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia(DOCK_MEDIA).matches;

export const ui = {
  setView(view: View): void {
    patch({ view, paletteOpen: false, settingsFocus: null });
  },
  openTask(key: string, tab: TaskTab = 'story', evidenceId: string | null = null): void {
    patch({ task: { key, tab, evidenceId }, paletteOpen: false });
  },
  setTaskTab(tab: TaskTab, evidenceId: string | null = null): void {
    uiStore.set((s) => (s.task ? { ...s, task: { ...s.task, tab, evidenceId } } : s));
  },
  closeTask(): void {
    patch({ task: null });
  },
  openSheet(sheet: Sheet): void {
    patch({ sheet, paletteOpen: false });
  },
  closeSheet(): void {
    patch({ sheet: null });
  },
  /** Opens Settings, at one of its groups when given. */
  openSettings(section: SettingsSection | null = null): void {
    patch({ view: 'settings', settingsFocus: section ? { section, n: ++seq } : null, paletteOpen: false, task: null });
  },
  /** Opens the New task form (a request the Mate turns into a task). */
  newTask(): void {
    patch({ paletteOpen: true, paletteMode: 'new' });
  },
  openTranscript(id: string): void {
    patch({ sheet: 'transcript', transcriptId: id, paletteOpen: false });
  },
  openPalette(): void {
    patch({ paletteOpen: true, paletteMode: 'list' });
  },
  closePalette(): void {
    patch({ paletteOpen: false });
  },
  /** Shows the Mate chat: docked beside the view on wide screens, as the Chat view otherwise. */
  openChat(): void {
    if (canDock()) ui.setChatDock(true);
    else patch({ view: 'chat' });
  },
  /** Opens the Mate chat with the cursor in its message box (the top bar's field, and the / key). */
  askMate(): void {
    ui.openChat();
    requestAnimationFrame(() => setTimeout(() => document.getElementById('chat-input')?.focus()));
  },
  setChatDock(chatDock: boolean): void {
    saveFlag(DOCK_KEY, chatDock);
    patch({ chatDock, ...(chatDock && uiStore.get().view === 'chat' ? { view: 'signoffs' as View } : {}) });
  },
  setUnderwayFilter(underwayFilter: UnderwayFilter): void {
    patch({ underwayFilter });
  },
  focusSearch(q = ''): void {
    patch({ view: 'underway', underwayFilter: 'all', search: { q, n: ++seq }, paletteOpen: false });
  },
  /** Applies a theme choice to the page and remembers it; `auto` keeps following the system. */
  setTheme(theme: ThemePref): void {
    saveThemePref(theme);
    patch({ theme });
    watchTheme(theme, (chart) => patch({ chart }));
  },
  clearFocusCard(): void {
    patch({ focusCard: null });
  },
  /** Sign-offs, with one waiting item on the desk. */
  showCard(id: string): void {
    patch({ view: 'signoffs', task: null, focusCard: { id, n: ++seq } });
  },
};
