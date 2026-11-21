/** Settings → Tasks: where tasks come from, which start without asking, the repos the crew works in, and your goals. */
import { useState } from 'react';
import { LEAD } from '../../labels';
import { AGENTS } from '../../lib/agentCatalog';
import { agentConfig, coerceSetting } from '../../lib/agents';
import { isJiraKey } from '../../lib/derive';
import { DEPARTMENTS } from '../../lib/departmentCatalog';
import { DIFFICULTIES, MAX_GOALS, departmentOn, roleOn, uniqueId } from '../../lib/org';
import type { CrewConfig, Difficulty } from '../../types';
import { Icon, Switch } from '../common';
import { setSkipped } from '../SkipTicket';
import { setRole } from './Crew';
import { Num, Row, Section, type SetConfig } from './parts';

const SCAN = AGENTS.find((a) => a.id === 'scan');
const SCAN_ON = SCAN?.defaultEnabled ?? true;
const CEO = DEPARTMENTS.find((d) => d.id === 'ceo') ?? { id: 'ceo', switchable: true, defaultEnabled: false };

function SkipList({ keys, canWrite }: { keys: string[]; canWrite: boolean }) {
  const [add, setAdd] = useState('');
  const [busy, setBusy] = useState(false);
  const k = add.trim().toUpperCase();
  const err = k && !isJiraKey(k) ? 'Use a Jira key like BRIN-1234.' : k && keys.includes(k) ? 'Already skipped.' : null;
  return (
    <Row wide label="Tickets to leave out" hint="The scan never brings these in, even when the query matches. Saved right away." error={err ?? undefined}>
      {keys.length ? (
        <div className="skips">
          {keys.map((key) => (
            <span className="skip" key={key}>
              <span className="mono">{key}</span>
              {canWrite ? (
                <button type="button" aria-label={`Stop leaving out ${key}`} title="Stop leaving out" onClick={() => void setSkipped(key, false)}>
                  ×
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      {canWrite ? (
        <form
          className="field-row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!k || err) return;
            setBusy(true);
            if (await setSkipped(k, true)) setAdd('');
            setBusy(false);
          }}
        >
          <input type="text" className="w-md mono" value={add} placeholder="BRIN-1234" aria-label="Ticket key to leave out" aria-invalid={!!err} onChange={(e) => setAdd(e.target.value)} />
          <button type="submit" className="btn sm" disabled={!k || !!err || busy}>
            Leave out
          </button>
        </form>
      ) : null}
    </Row>
  );
}

export function TasksSection({ draft, live, set, errors, canWrite }: { draft: CrewConfig; live: CrewConfig; set: SetConfig; errors: Record<string, string>; canWrite: boolean }) {
  const jira = roleOn(draft, 'scan', SCAN_ON);
  const [queryOpen] = useState(!!draft.intake.jql);
  const scanValues = SCAN ? agentConfig(SCAN, draft.agents.scan, draft.org).values : {};
  const setScan = (key: string, v: unknown) => set((c) => void (c.agents = { ...c.agents, scan: { ...c.agents.scan, [key]: v } }));
  const o = draft.org ?? {};
  const goals = o.goals ?? [];
  const goalsCount = departmentOn(o, CEO);
  const editGoal = (id: string, patch: Partial<(typeof goals)[number]>) => set((c) => void ((c.org ??= {}).goals = (c.org.goals ?? []).map((g) => (g.id === id ? { ...g, ...patch } : g))));
  const repos = Object.entries(draft.repos);
  return (
    <Section id="tasks" title="Tasks" lead={`Where work comes from and where it happens. You can always add a task on the board or tell the ${LEAD} in its chat.`}>
      <fieldset className="set-fields" disabled={!canWrite}>
        <Row label="Where tasks come from" hint={jira ? `The ${LEAD} brings in your Jira tickets every 30 minutes on working days, as well as tasks you add.` : 'Only tasks you add on the board or give the Mate.'}>
          <select value={jira ? 'jira' : 'board'} aria-label="Where tasks come from" onChange={(e) => set((c) => setRole(c, 'scan', e.target.value === 'jira'))}>
            <option value="board">The board</option>
            <option value="jira">The board and Jira</option>
          </select>
        </Row>
        <Row label="Jira site" hint="Ticket keys on the board link here.">
          <input type="text" className="w-lg mono" value={draft.intake.jiraSite} placeholder="https://your-team.atlassian.net" spellCheck={false} aria-label="Jira site" onChange={(e) => set((c) => void (c.intake.jiraSite = e.target.value.trim()))} />
        </Row>
        {jira ? (
          <details className="srow-more" open={queryOpen}>
            <summary>Which tickets, and how</summary>
            <Row wide label="Jira query (JQL)" hint="Empty: your team pack’s query, usually your open tickets.">
              <textarea rows={2} className="mono" value={draft.intake.jql} spellCheck={false} aria-label="Jira query" placeholder="assignee = currentUser() AND statusCategory != Done" onChange={(e) => set((c) => void (c.intake.jql = e.target.value))} />
            </Row>
            {SCAN?.settings.map((st) => (
              <Row key={st.key} label={st.label} wide={st.type !== 'number' && st.type !== 'boolean'}>
                {st.type === 'boolean' ? (
                  <Switch checked={scanValues[st.key] === true} onChange={(v) => setScan(st.key, v)} label={<span className="sr-only">{st.label}</span>} />
                ) : (
                  <input type={st.type === 'number' ? 'number' : 'text'} className={st.type === 'number' ? 'w-sm' : 'w-md'} value={String(scanValues[st.key] ?? '')} aria-label={st.label} onChange={(e) => setScan(st.key, coerceSetting(st, e.target.value))} />
                )}
              </Row>
            ))}
          </details>
        ) : null}
        <Row label="Start without asking" hint="Tickets up to this difficulty start on their own. Harder ones wait for your OK.">
          <select value={draft.intake.autoStartMaxDifficulty} aria-label="Start without asking up to" onChange={(e) => set((c) => void (c.intake.autoStartMaxDifficulty = e.target.value as Difficulty))}>
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                Up to {d}
              </option>
            ))}
          </select>
        </Row>
      </fieldset>
      {jira ? <SkipList keys={live.intake.skipKeys ?? []} canWrite={canWrite} /> : null}

      <h3 className="sset-sub" id="set-repos">
        Repos
      </h3>
      <p className="note">
        {repos.length ? 'The crew branches from each base branch and never works on it directly. Switch a repo off to keep the crew out of it.' : 'No repos yet. Run setup again from the folder that holds your repos.'}
      </p>
      <fieldset className="set-fields" disabled={!canWrite}>
        {repos.map(([name, r]) => (
          <Row
            key={name}
            label={name}
            hint={
              <>
                <span className="mono">{r.path}</span>
                {r.prGate ? ` · runs ${r.prGate} before each PR` : ''}
              </>
            }
            error={errors[`repos.${name}`]}
          >
            <span className="repo-ctl">
              <label className="inline-field">
                <span className="faint small">Base</span>
                <input type="text" className="w-sm mono" value={r.baseBranch} aria-label={`${name} base branch`} aria-invalid={!!errors[`repos.${name}`]} placeholder="main" onChange={(e) => set((c) => void (c.repos[name].baseBranch = e.target.value))} />
              </label>
              <Switch checked={r.enabled} onChange={(v) => set((c) => void (c.repos[name].enabled = v))} label={<span className="sr-only">{name} on</span>} />
            </span>
          </Row>
        ))}
      </fieldset>

      <h3 className="sset-sub" id="set-goals">
        Goals
      </h3>
      <p className="note">
        Up to {MAX_GOALS}. The {LEAD} tags tickets with them, and a goal’s weight raises its tickets’ priority.
        {goalsCount ? '' : ' They count once the CEO office team is on, under Crew.'}
      </p>
      <fieldset className="set-fields" disabled={!canWrite}>
        {goals.map((g) => (
          <div className="org-goal" key={g.id}>
            <input type="text" value={g.title} placeholder="Faster onboarding" aria-label="Goal" aria-invalid={!!errors[`org.goals.${g.id}`]} onChange={(e) => editGoal(g.id, { title: e.target.value })} />
            <input type="text" value={g.metric} placeholder="Days to first PR" aria-label="How it’s measured" onChange={(e) => editGoal(g.id, { metric: e.target.value })} />
            <input type="text" value={g.target} placeholder="Under 3" aria-label="Target" onChange={(e) => editGoal(g.id, { target: e.target.value })} />
            <Num label="Goal weight" value={g.weight} unit="weight" invalid={!!errors[`org.goals.${g.id}`]} onChange={(n) => editGoal(g.id, { weight: n })} />
            <button type="button" className="btn icon sm ghost" aria-label={`Remove ${g.title || 'goal'}`} onClick={() => set((c) => void ((c.org ??= {}).goals = (c.org.goals ?? []).filter((x) => x.id !== g.id)))}>
              <Icon name="x" />
            </button>
            {errors[`org.goals.${g.id}`] ? <span className="err">{errors[`org.goals.${g.id}`]}</span> : null}
          </div>
        ))}
        {errors['org.goals'] ? <span className="err">{errors['org.goals']}</span> : null}
        {goals.length < MAX_GOALS ? (
          <div className="row-actions">
            <button type="button" className="btn sm" onClick={() => set((c) => void ((c.org ??= {}).goals = [...(c.org.goals ?? []), { id: uniqueId('goal', (c.org.goals ?? []).map((x) => x.id)), title: '', metric: '', target: '', weight: 1 }]))}>
              <Icon name="plus" />
              Add goal
            </button>
          </div>
        ) : null}
      </fieldset>
    </Section>
  );
}
