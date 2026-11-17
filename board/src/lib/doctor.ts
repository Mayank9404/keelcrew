import type { DoctorCheck } from '../types';
import { errorText, quietApi } from './api';
import { createStore } from './createStore';

export interface DoctorState {
  checks: DoctorCheck[] | null;
  loading: boolean;
  error: string | null;
  ranAt: number | null;
}

export const doctorStore = createStore<DoctorState>({ checks: null, loading: false, error: null, ranAt: null });

const KEY = 'crew-doctor-dismissed';

/** Identifies this set of open problems, so a dismissed checklist comes back only when something new is wrong. */
export function checklistVersion(checks: DoctorCheck[]): string {
  const bad = checks
    .filter(c => c.status !== 'ok')
    .map(c => `${c.id}:${c.status}`)
    .sort();
  return bad.length ? `v1:${bad.join(',')}` : '';
}

export function isDismissed(version: string): boolean {
  try {
    return localStorage.getItem(KEY) === version;
  } catch {
    return false;
  }
}

export function dismissChecklist(version: string): void {
  try {
    localStorage.setItem(KEY, version);
  } catch {
    /* storage blocked */
  }
}

let inflight: Promise<DoctorCheck[] | null> | null = null;

export function runDoctor(): Promise<DoctorCheck[] | null> {
  if (inflight) return inflight;
  doctorStore.set(s => ({ ...s, loading: true, error: null }));
  inflight = quietApi
    .doctor()
    .then(
      checks => {
        doctorStore.set(s => ({ ...s, checks, loading: false, ranAt: Date.now() }));
        return checks;
      },
      e => {
        doctorStore.set(s => ({ ...s, loading: false, error: errorText(e) }));
        return null;
      },
    )
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
