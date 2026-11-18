import { useState } from 'react';
import { api } from '../lib/api';
import { patchCrew } from '../lib/store';
import { toast } from '../lib/toast';

/** Add or remove a Jira key from `config.intake.skipKeys`, mirroring the server locally. */
export async function setSkipped(key: string, skip: boolean, reason?: string): Promise<boolean> {
  try {
    const r = await api.skip(key, skip, reason);
    patchCrew(h => {
      const keys = new Set(h.config.intake.skipKeys ?? []);
      if (skip) keys.add(key);
      else keys.delete(key);
      return { ...h, config: { ...h.config, intake: { ...h.config.intake, skipKeys: [...keys].sort() } } };
    });
    toast(r.message || (skip ? `${key} skipped.` : `${key} is no longer skipped.`));
    return true;
  } catch {
    return false;
  }
}

/** A quiet "Skip ticket" link that asks for an optional reason. */
export function SkipTicket({ taskKey, skipped }: { taskKey: string; skipped: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (skipped) {
    return (
      <button
        type="button"
        className="link"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await setSkipped(taskKey, false);
          setBusy(false);
        }}
      >
        Stop skipping {taskKey}
      </button>
    );
  }
  if (!open) {
    return (
      <button type="button" className="link" onClick={() => setOpen(true)}>
        Skip ticket
      </button>
    );
  }
  return (
    <form
      className="inline-form reveal"
      onSubmit={async e => {
        e.preventDefault();
        setBusy(true);
        const ok = await setSkipped(taskKey, true, reason.trim() || undefined);
        setBusy(false);
        if (ok) setOpen(false);
      }}
    >
      <input type="text" value={reason} autoFocus placeholder="Reason (optional)" aria-label={`Why skip ${taskKey}`} onChange={e => setReason(e.target.value)} onKeyDown={e => e.key === 'Escape' && setOpen(false)} />
      <button type="submit" className="btn sm" disabled={busy}>
        Skip {taskKey}
      </button>
      <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}
