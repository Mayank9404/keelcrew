import { createStore } from './createStore';

export type ToastLevel = 'info' | 'warn' | 'error';

export interface Toast {
  id: number;
  text: string;
  level: ToastLevel;
}

export const toastStore = createStore<Toast[]>([]);
let seq = 0;

/** Show a short notice; errors stay a little longer. */
export function toast(text: string, level: ToastLevel = 'info'): void {
  const id = ++seq;
  toastStore.set(list => [...list.slice(-3), { id, text, level }]);
  const ms = level === 'error' ? 7000 : level === 'warn' ? 5000 : 3200;
  window.setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id: number): void {
  toastStore.set(list => (list.some(t => t.id === id) ? list.filter(t => t.id !== id) : list));
}
