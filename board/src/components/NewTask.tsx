import { useState } from 'react';
import { LEAD } from '../labels';
import { api } from '../lib/api';
import { AGENTS } from '../lib/agentCatalog';
import { enabledAgents } from '../lib/agents';
import { useCrewStore } from '../lib/store';
import { toast } from '../lib/toast';

/**
 * Asks the Mate for a task, Jira or not: a `requests` document `{kind: "task", text, agent?}`. The Mate creates the
 * `T-<n>` task and routes it to the agent picked here, or to the best one that's on.
 */
export function NewTaskForm({ onDone, autoFocus = true }: { onDone: () => void; autoFocus?: boolean }) {
  const agents = enabledAgents(AGENTS, useCrewStore().crew?.config);
  const [text, setText] = useState('');
  const [agent, setAgent] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        setBusy(true);
        try {
          await api.newTask({ text: text.trim(), ...(agent ? { agent } : {}) });
          toast(`Sent to the ${LEAD}. It shows up as a T- task once the ${LEAD} picks it up.`);
          onDone();
        } catch {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        <span>What needs doing?</span>
        <textarea rows={4} autoFocus={autoFocus} value={text} placeholder="A question to look into, a doc to write, a fix, anything. Links and context help." onChange={(e) => setText(e.target.value)} />
      </label>
      {agents.length ? (
        <label className="field">
          <span>Agent (optional)</span>
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">Let the {LEAD} pick</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="field-row">
        <span className="note">No ticket needed: the {LEAD} gives it a T- key and starts a fresh session for it.</span>
        <span className="spacer" />
        <button type="button" className="btn ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={!text.trim() || busy}>
          {busy ? 'Sending…' : 'Add task'}
        </button>
      </div>
    </form>
  );
}
