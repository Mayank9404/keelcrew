/** The board's live state for React: the crew view model, whether the database is reachable, and recent activity. */
import type { CrewEvent, CrewState } from '../types';
import { createStore, useStore } from './createStore';

/** `connecting` until the database answers; `down` when this view has none (a browser tab outside Claude). */
export type ConnStatus = 'connecting' | 'open' | 'down';

export interface CrewStoreState {
  crew: CrewState | null;
  conn: ConnStatus;
  /** Live activity events, oldest first, capped. */
  events: CrewEvent[];
}

const MAX_EVENTS = 4000;

export const crewStore = createStore<CrewStoreState>({ crew: null, conn: 'connecting', events: [] });

export const useCrewStore = (): CrewStoreState => useStore(crewStore);

/** Adds one activity event. */
export function pushEvent(ev: CrewEvent): void {
  crewStore.set((s) => {
    if (s.events.some((e) => e.id === ev.id)) return s;
    const events = s.events.length >= MAX_EVENTS ? [...s.events.slice(-(MAX_EVENTS - 1)), ev] : [...s.events, ev];
    return { ...s, events };
  });
}

/** Folds a result into local state before the database's own snapshot arrives. */
export function patchCrew(fn: (crew: CrewState) => CrewState): void {
  crewStore.set((s) => (s.crew ? { ...s, crew: fn(s.crew) } : s));
}

/** Whether this viewer may change the board. */
export const useCanWrite = (): boolean => useStore(crewStore).crew?.access.canWrite === true;
