import { useState } from 'react';
import { ROLE_LABEL } from '../../labels';
import { api } from '../../lib/api';
import { AGENTS } from '../../lib/agentCatalog';
import { EFFORTS } from '../../lib/agents';
import { isJiraKey, isLive, type TaskView } from '../../lib/derive';
import { modelFor } from '../../lib/models';
import { READ_ONLY_NOTE } from '../../lib/owner';
import { patchCrew, useCanWrite } from '../../lib/store';
import { toast } from '../../lib/toast';
import type { Effort, CrewState, Task } from '../../types';
import { SkipTicket } from '../SkipTicket';

const ENGINEER = ROLE_LABEL.engineer.toLowerCase();

function useTaskCall() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (name: string, fn: () => Promise<Task | { ok: boolean }>, done: string): Promise<boolean> => {
    setBusy(name);
    try {
      const r = await fn();
      if ('key' in r) patchCrew(h => ({ ...h, tasks: h.tasks.map(t => (t.key === r.key ? r : t)) }));
      toast(done);
      return true;
    } catch {
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

export function ManageTab({ crew, task, view }: { crew: CrewState; task: Task; view: TaskView }) {
  const { busy, run } = useTaskCall();
  const [message, setMessage] = useState('');
  const [resumeText, setResumeText] = useState('');
  const [effort, setEffort] = useState<Effort | ''>('');
  const [confirm, setConfirm] = useState<'stop' | 'cancel' | null>(null);
  const session = view.session;
  const running = isLive(session);
  const closed = task.status === 'done' || task.status === 'cancelled';
  const canStart = task.status === 'proposed' || task.status === 'queued';
  const canStop = task.status === 'active' && running;
  const defaultEffort = modelFor(crew.config.org, 'engineer', AGENTS.find(a => a.id === 'engineer') ?? null, task.difficulty).effort;
  const canWrite = useCanWrite();
  if (!canWrite) return <p className="note">{READ_ONLY_NOTE}</p>;

  return (
    <div className="actions">
      {canStart ? (
        <div className="section">
          <h5>Start</h5>
          <p className="note" style={{ marginBottom: 10 }}>
            {task.status === 'queued' ? 'Queued for a free cabin. Start now to take the next one that opens.' : `Proposed. Starting gives it a cabin and an ${ENGINEER} at ${defaultEffort} effort.`}
          </p>
          <button type="button" className="btn primary" disabled={!!busy} onClick={() => void run('start', () => api.startTask(task.key), `${task.key} is starting.`)}>
            {busy === 'start' ? 'Starting…' : 'Start'}
          </button>
        </div>
      ) : null}

      {task.sessionId && !closed ? (
        <form
          className="section"
          onSubmit={async e => {
            e.preventDefault();
            const text = message.trim();
            if (!text) return;
            if (await run('message', () => api.messageTask(task.key, text), `Sent to the ${ENGINEER} on ${task.key}.`)) setMessage('');
          }}
        >
          <h5>Message the {ENGINEER}</h5>
          <div className="inline-form">
            <textarea rows={2} value={message} placeholder={`About this ticket only; goes straight to the ${ENGINEER}, not through the Mate. New work: add a task.`} aria-label={`Message the ${ENGINEER}`} onChange={e => setMessage(e.target.value)} />
            <button type="submit" className="btn" disabled={!message.trim() || !!busy}>
              Send
            </button>
          </div>
        </form>
      ) : null}

      {task.sessionId && !running ? (
        <form
          className="section"
          onSubmit={async e => {
            e.preventDefault();
            const ok = await run(
              'resume',
              () => api.resumeTask(task.key, { ...(resumeText.trim() ? { text: resumeText.trim() } : {}), ...(effort ? { effort } : {}) }),
              `${task.key} resumed.`,
            );
            if (ok) {
              setResumeText('');
              setEffort('');
            }
          }}
        >
          <h5>Resume</h5>
          <p className="note" style={{ marginBottom: 10 }}>
            Picks up the same session{session ? ` (${session.status})` : ''}, so it keeps everything it already knows.
          </p>
          <div className="field-row">
            <input type="text" style={{ flex: 1 }} value={resumeText} placeholder="What to do next (optional)" aria-label="Resume note" onChange={e => setResumeText(e.target.value)} />
            <select value={effort} onChange={e => setEffort(e.target.value as Effort | '')} aria-label="Effort">
              <option value="">Effort: {session?.effort ?? defaultEffort}</option>
              {EFFORTS.map(x => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
            <button type="submit" className="btn primary" disabled={!!busy}>
              {busy === 'resume' ? 'Resuming…' : 'Resume'}
            </button>
          </div>
        </form>
      ) : null}

      {!closed ? (
        <div className="section">
          <h5>Stop or cancel</h5>
          {confirm === 'stop' ? (
            <div className="confirm reveal">
              <p>Stop the {ENGINEER} on {task.key}? Its session, branch and worktree are kept, so it can resume later.</p>
              <button type="button" className="btn danger solid" disabled={!!busy} onClick={async () => (await run('stop', () => api.stopTask(task.key), `${task.key} stopped.`)) && setConfirm(null)}>
                Stop
              </button>
              <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>
                Keep running
              </button>
            </div>
          ) : confirm === 'cancel' ? (
            <div className="confirm reveal">
              <p>Cancel {task.key}? The Mate stops working on it and frees its cabin. The branch stays on disk.</p>
              <button type="button" className="btn danger solid" disabled={!!busy} onClick={async () => (await run('cancel', () => api.cancelTask(task.key), `${task.key} cancelled.`)) && setConfirm(null)}>
                Cancel ticket
              </button>
              <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>
                Keep it
              </button>
            </div>
          ) : (
            <div className="field-row">
              {canStop ? (
                <button type="button" className="btn danger" onClick={() => setConfirm('stop')}>
                  Stop {ENGINEER}
                </button>
              ) : null}
              <button type="button" className="btn ghost danger" onClick={() => setConfirm('cancel')}>
                Cancel ticket
              </button>
            </div>
          )}
        </div>
      ) : null}

      {isJiraKey(task.key) ? (
        <div className="section">
          <h5>Intake</h5>
          <p className="note" style={{ marginBottom: 8 }}>
            {view.skipped ? 'Future Jira scans skip this ticket.' : 'Skipping keeps future Jira scans from proposing this ticket again.'}
          </p>
          <SkipTicket taskKey={task.key} skipped={view.skipped} />
        </div>
      ) : null}
    </div>
  );
}
