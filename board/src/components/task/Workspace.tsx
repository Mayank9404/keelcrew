import { useState } from 'react';
import { EDITOR_LABEL } from '../../labels';
import { api, type OpenTarget } from '../../lib/api';
import { ui } from '../../lib/ui';
import type { CrewConfig, Task } from '../../types';
import { CopyButton, Icon } from '../common';

/** "Open in Cursor", Finder, Terminal and Copy path for the task's worktree. */
export function OpenIn({ task, editor, terminal }: { task: Task; editor: CrewConfig['editor']; terminal: CrewConfig['terminal'] }) {
  const [busy, setBusy] = useState<OpenTarget | null>(null);
  if (!task.worktree) return null;
  const open = async (app: OpenTarget) => {
    setBusy(app);
    try {
      await api.openIn(task.key, app);
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="open-in" role="group" aria-label="Open the worktree">
      <button type="button" className="btn sm" disabled={!!busy} onClick={() => void open('editor')}>
        <Icon name="code" />
        Open in {EDITOR_LABEL[editor] ?? editor}
      </button>
      <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => void open('finder')}>
        <Icon name="folder" />
        Finder
      </button>
      <button type="button" className="btn sm ghost" disabled={!!busy} onClick={() => void open('terminal')}>
        <Icon name="terminal" />
        {terminal === 'warp' ? 'Warp' : 'Terminal'}
      </button>
      <CopyButton text={task.worktree} label="Copy path" className="btn sm ghost" />
    </div>
  );
}

/** Files this ticket shares with other active tickets. */
export function OverlapNote({ task }: { task: Task }) {
  if (!task.overlaps?.length) return null;
  return (
    <div className="overlap-note" role="note">
      {task.overlaps.map(o => (
        <p key={o.key}>
          Also edited by{' '}
          <button type="button" className="link" onClick={() => ui.openTask(o.key)}>
            {o.key}
          </button>
          : {o.files.slice(0, 3).join(', ')}
          {o.files.length > 3 ? `, and ${o.files.length - 3} more` : ''}
        </p>
      ))}
    </div>
  );
}
