import { useStore } from '../lib/createStore';
import { dismissToast, toastStore } from '../lib/toast';

export function Toasts() {
  const list = useStore(toastStore);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map(t => (
        <div key={t.id} className={`toast ${t.level === 'info' ? '' : t.level}`}>
          <span>{t.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
