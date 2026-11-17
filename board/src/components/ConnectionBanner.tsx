import { useState } from 'react';
import { helperNote, panelNote } from '../lib/compat';
import { useCrewStore } from '../lib/store';
import type { CrewState } from '../types';

/** Shown when this view has no board database (a browser tab outside Claude, or access withdrawn). */
export function ConnectionBanner() {
  const { conn, crew } = useCrewStore();
  if (conn !== 'down') return null;
  return (
    <div className="banner" role="alert">
      <span className="dot" />
      <span>
        The Keelcrew board’s data isn’t available in this view
        {crew?.tasks.length ? <span className="sub"> · showing the last known state</span> : <span className="sub"> · open it in the Claude app or on claude.ai</span>}
      </span>
      <button type="button" className="btn sm" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  );
}

/** Quiet notes under the top bar: a read-only board for anyone but the captain, a helper that doesn't match, and a Mate
 * session that stopped watching the board. */
export function Notices({ crew }: { crew: CrewState }) {
  const [hidden, setHidden] = useState<string | null>(null);
  const notes: { id: string; text: string }[] = [];
  if (!crew.access.canWrite && crew.access.reason) notes.push({ id: 'access', text: crew.access.reason });
  const helper = helperNote(crew.helper, crew.config.phoneApprovals);
  if (helper) notes.push({ id: 'helper', text: helper });
  const panel = panelNote(crew.panelAt, crew.now, crew.helper.status);
  if (panel) notes.push({ id: 'panel', text: panel });
  const shown = notes.filter((n) => n.id !== hidden);
  if (!shown.length) return null;
  return (
    <div className="notices" role="status">
      {shown.map((n) => (
        <div className="notice" key={n.id}>
          <span>{n.text}</span>
          {n.id === 'helper' ? (
            <button type="button" className="x" aria-label="Hide this note" onClick={() => setHidden(n.id)}>
              ×
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
