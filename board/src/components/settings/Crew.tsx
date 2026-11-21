/**
 * Settings → Crew: how sessions start, then one row per crew member (the Mate, then each team's members) with its model
 * and switch; a row opens to its schedule, its own options and Run now. The instruction files sit at the end. Every edit
 * here is part of the one settings form, saved with Save; only the instruction files save on their own.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { LEAD, modelLabel } from '../../labels';
import { api, errorText, quietApi, type PromptFile } from '../../lib/api';
import { AGENTS } from '../../lib/agentCatalog';
import { agentConfig, coerceSetting, type AgentManifest } from '../../lib/agents';
import { DEPARTMENTS } from '../../lib/departmentCatalog';
import { dayTime } from '../../lib/format';
import { aboveMate, modelFor } from '../../lib/models';
import { DIFFICULTIES, SUBAGENTS, departmentOn, roleOn } from '../../lib/org';
import { SCHEDULE_DAYS, cronAt, cronWords, simpleCron } from '../../lib/schedule';
import { useCrewStore } from '../../lib/store';
import { toast } from '../../lib/toast';
import type { CrewConfig, Decision, Department, StartMethod } from '../../types';
import { Dot, Icon, Switch } from '../common';
import { ModelPick, Row, Section, type SetConfig } from './parts';

type Notes = Record<string, { teamSkills: string[]; teamNotes: string | null }>;

const START_METHODS: [StartMethod, string][] = [
  ['card', 'You click Start in the Mate session'],
  ['routine', 'They start on their own'],
];

/** Turns a crew member on or off. Core reads `org.roles` before `agents`, so both move together. */
export function setRole(c: CrewConfig, id: string, on: boolean): void {
  const org = (c.org ??= {});
  org.roles = { ...org.roles, [id]: { enabled: on } };
  c.agents = { ...c.agents, [id]: { ...c.agents[id], enabled: on } };
}

/** What runs a member and when, in a few words. */
function cadence(m: AgentManifest, schedule: string): string {
  if (m.kind === 'on-demand') return 'When you ask';
  if (m.kind === 'ticket') return 'On each ticket';
  if (schedule) return cronWords(schedule);
  return m.schedules.map((s) => s.label).join(' · ');
}

/** The model a member runs on, in words; the engineer's spans its difficulties. */
function modelText(c: CrewConfig, m: AgentManifest): string {
  if (m.id !== 'engineer') {
    const x = modelFor(c.org, m.id, m);
    return `${modelLabel(x.model)} · ${x.effort}`;
  }
  const all = DIFFICULTIES.map((d) => modelFor(c.org, m.id, m, d));
  const models = [...new Set(all.map((x) => modelLabel(x.model)))].join(' / ');
  const first = all[0].effort;
  const last = all[all.length - 1].effort;
  return first === last ? `${models} · ${first}` : `${models} · ${first} to ${last}`;
}

/**
 * A schedule: Default keeps the member's own; Days and time covers one run on a day choice; Cron takes anything else,
 * such as several times a day. A stored cron opens in the mode that can show it.
 */
function SchedulePick({ m, value, onChange }: { m: AgentManifest; value: string; onChange: (cron: string) => void }) {
  const [mode, setMode] = useState<'default' | 'pick' | 'cron'>(!value ? 'default' : simpleCron(value) ? 'pick' : 'cron');
  const simple = simpleCron(value) ?? simpleCron(m.schedules[0].cron) ?? { days: '1-5', time: '09:00' };
  const choose = (next: 'default' | 'pick' | 'cron') => {
    setMode(next);
    if (next === 'default') onChange('');
    else if (next === 'pick') onChange(cronAt(simple.days, simple.time));
    else onChange(value || m.schedules[0].cron);
  };
  return (
    <span className="sched-pick">
      <select value={mode} aria-label={`${m.name} schedule`} onChange={(e) => choose(e.target.value as typeof mode)}>
        <option value="default">Default: {m.schedules[0].label}</option>
        <option value="pick">Days and time</option>
        <option value="cron">Cron</option>
      </select>
      {mode === 'pick' ? (
        <>
          <select value={simple.days} aria-label={`${m.name} days`} onChange={(e) => onChange(cronAt(e.target.value, simple.time))}>
            {SCHEDULE_DAYS.map(([d, label]) => (
              <option key={d} value={d}>
                {label}
              </option>
            ))}
          </select>
          <input type="time" value={simple.time} aria-label={`${m.name} time`} onChange={(e) => e.target.value && onChange(cronAt(simple.days, e.target.value))} />
        </>
      ) : mode === 'cron' ? (
        <input type="text" className="w-md mono" value={value} placeholder={m.schedules[0].cron} spellCheck={false} aria-label={`${m.name} cron`} onChange={(e) => onChange(e.target.value)} />
      ) : null}
    </span>
  );
}

function MemberBody({ m, draft, set, errors, notes, canWrite }: { m: AgentManifest; draft: CrewConfig; set: SetConfig; errors: Record<string, string>; notes?: Notes[string]; canWrite: boolean }) {
  const saved = useCrewStore().crew?.config;
  const cfg = agentConfig(m, draft.agents[m.id], draft.org);
  const savedOn = !!saved && agentConfig(m, saved.agents[m.id], saved.org).enabled;
  const [busy, setBusy] = useState(false);
  const setValue = (key: string, v: unknown) => set((c) => void (c.agents = { ...c.agents, [m.id]: { ...c.agents[m.id], [key]: v } }));
  const setSchedule = (cron: string) =>
    set((c) => {
      const next = { ...c.agents[m.id] };
      if (cron.trim()) next.schedule = cron.trim();
      else delete next.schedule;
      c.agents = { ...c.agents, [m.id]: next };
    });
  const run = async () => {
    setBusy(true);
    try {
      await api.agentAction(m.id, 'run');
      toast(`Asked the ${LEAD} to run ${m.name} now.`);
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="member-body">
      <p className="note">{m.summary}</p>
      <fieldset className="set-fields" disabled={!canWrite}>
        {m.id === 'engineer' ? (
          DIFFICULTIES.map((d) => (
            <Row key={d} label={`Model for ${d} tickets`} error={errors[`models.engineer.${d}`]}>
              <ModelPick draft={draft} set={set} id="engineer" manifest={m} difficulty={d} label={`Engineer · ${d}`} invalid={!!errors[`models.engineer.${d}`]} />
            </Row>
          ))
        ) : (
          <Row label="Model" error={errors[`models.${m.id}`]}>
            <ModelPick draft={draft} set={set} id={m.id} manifest={m} label={m.name} invalid={!!errors[`models.${m.id}`]} />
          </Row>
        )}
        {m.schedules.length ? (
          <Row label="When it runs" error={errors[`agents.${m.id}.schedule`]} hint={m.schedules.length > 1 ? `Its other runs keep their times: ${m.schedules.slice(1).map((s) => s.label).join(' · ')}.` : undefined}>
            <SchedulePick m={m} value={cfg.schedule} onChange={setSchedule} />
          </Row>
        ) : null}
        {m.id === 'support' ? (
          <Row label="Reads issues from" hint="A Jira project (jira:SUP) or a Teams channel (teams:customer-issues). Nothing is sent; replies stay drafts." error={errors['agents.support.source']}>
            <input type="text" className="w-md mono" value={String(draft.agents.support?.source ?? '')} placeholder="jira:SUP" spellCheck={false} aria-label="Support source" aria-invalid={!!errors['agents.support.source']} onChange={(e) => setValue('source', e.target.value)} />
          </Row>
        ) : null}
        {m.settings.map((st) => (
          <Row key={st.key} label={st.label} wide={st.type !== 'number' && st.type !== 'boolean'}>
            {st.type === 'boolean' ? (
              <Switch checked={cfg.values[st.key] === true} onChange={(v) => setValue(st.key, v)} label={<span className="sr-only">{st.label}</span>} />
            ) : (
              <input
                type={st.type === 'number' ? 'number' : 'text'}
                className={st.type === 'number' ? 'w-sm' : 'w-md'}
                value={String(cfg.values[st.key] ?? '')}
                aria-label={st.label}
                onChange={(e) => setValue(st.key, coerceSetting(st, e.target.value))}
              />
            )}
          </Row>
        ))}
      </fieldset>
      {notes && (notes.teamSkills.length || notes.teamNotes) ? (
        <p className="note">
          From your team pack: {notes.teamSkills.length ? `skills ${notes.teamSkills.join(', ')}` : ''}
          {notes.teamSkills.length && notes.teamNotes ? '. ' : ''}
          {notes.teamNotes ?? ''}
        </p>
      ) : null}
      {canWrite && m.kind === 'on-demand' && savedOn ? (
        <div className="member-acts">
          <button type="button" className="btn sm" disabled={busy} onClick={() => void run()}>
            {busy ? 'Asking…' : 'Run now'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** One crew member: a row that opens. A row with an error opens itself. */
function Member({ name, sub, model, on, onToggle, hasError, canWrite, children }: { name: string; sub: string; model: string; on: boolean | null; onToggle?: (v: boolean) => void; hasError: boolean; canWrite: boolean; children: ReactNode }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const shown = open ?? hasError;
  return (
    <div className={['member', on === false ? 'off' : '', shown ? 'open' : ''].filter(Boolean).join(' ')}>
      <div className="member-h">
        <button type="button" className="member-btn" aria-expanded={shown} onClick={() => setOpen(!shown)}>
          <Dot tone={on === false ? 'muted' : hasError ? 'block' : 'ok'} />
          <span className="member-name">{name}</span>
          <span className="member-sub">{sub}</span>
          <span className="member-model">{model}</span>
          <Icon name="chevron" className="member-chev" />
        </button>
        {on === null ? <span className="faint small member-sw">Always on</span> : <span className="member-sw"><Switch checked={on} disabled={!canWrite} onChange={(v) => onToggle?.(v)} label={<span className="sr-only">{name} on</span>} /></span>}
      </div>
      {shown ? children : null}
    </div>
  );
}

function Decisions({ canWrite }: { canWrite: boolean }) {
  const [list, setList] = useState<Decision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    quietApi.decisions().then(
      (d) => live && setList(d),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  if (error) return <p className="err-box">{error}</p>;
  if (!list) return <p className="note">Loading…</p>;
  if (!list.length) return <p className="note">None yet. When you settle a question, the {LEAD} remembers it here.</p>;
  return (
    <div>
      {list.map((d) => (
        <div className="decision" key={d.id}>
          <b>{d.topic.startsWith('never-ask:') ? `Don’t ask again: ${d.topic.slice(10)}` : d.topic}</b>
          <p>{d.decision}</p>
          <span className="meta">
            {dayTime(d.createdAt)}
            {d.taskKey ? ` · from ${d.taskKey}` : ''}
          </span>
          {canWrite ? (
            <button
              type="button"
              className="btn sm ghost danger"
              aria-label={`Forget: ${d.topic}`}
              onClick={async () => {
                try {
                  await api.deleteDecision(d.id);
                  setList((l) => (l ?? []).filter((x) => x.id !== d.id));
                  toast(`The ${LEAD} will forget “${d.topic}”.`);
                } catch {
                  /* toasted */
                }
              }}
            >
              Forget
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** The crew's instruction files (the skills and the Mate's notes), saved on their own. */
function Prompts({ canWrite }: { canWrite: boolean }) {
  const [files, setFiles] = useState<PromptFile[] | null>(null);
  const [file, setFile] = useState('');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    quietApi.prompts().then(
      (list) => {
        setFiles(list);
        const first = list.find((p) => p.file === 'lead.md') ?? list[0];
        setFile(first?.file ?? '');
        setText(first?.text ?? '');
      },
      (e) => setError(errorText(e)),
    );
  }, []);
  const current = files?.find((p) => p.file === file);
  const dirty = !!current && current.text !== text;
  const pick = (f: string) => {
    if (dirty && !window.confirm(`Discard your edits to ${file}?`)) return;
    setFile(f);
    setText(files?.find((p) => p.file === f)?.text ?? '');
  };
  const save = async () => {
    setSaving(true);
    try {
      setFiles(await api.savePrompt(file, text));
      toast(`${file} saved. Agents pick it up the next time they start.`);
    } catch {
      /* toasted */
    } finally {
      setSaving(false);
    }
  };
  if (error) return <div className="err-box">{error}</div>;
  if (!files) return <p className="note">Loading…</p>;
  return (
    <div className="prompts">
      <select value={file} onChange={(e) => pick(e.target.value)} aria-label="Instruction file">
        {files.map((p) => (
          <option key={p.file} value={p.file}>
            {p.file.replace(/\.md$/, '')}
          </option>
        ))}
      </select>
      <p className="note">{current?.about}</p>
      <textarea className="prompt-edit" value={text} spellCheck={false} readOnly={!canWrite} onChange={(e) => setText(e.target.value)} aria-label={`Edit ${file}`} rows={18} />
      {canWrite ? (
        <div className="acts">
          <span className="note">{dirty ? 'Unsaved edits to this file.' : 'Saved on its own, not with the settings.'}</span>
          <span className="spacer" />
          <button type="button" className="btn ghost sm" disabled={!dirty} onClick={() => setText(current?.text ?? '')}>
            Revert
          </button>
          <button type="button" className="btn primary sm" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : `Save ${file}`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Turns a team on or off; turning one on also turns on its head. */
function setDepartment(c: CrewConfig, d: Department, roles: AgentManifest[], on: boolean): void {
  const org = (c.org ??= {});
  org.departments = { ...org.departments, [d.id]: { enabled: on } };
  const head = roles.find((r) => r.id === d.head);
  if (on && head && !roleOn(c, head.id, head.defaultEnabled)) setRole(c, head.id, true);
}

export function CrewSection({ draft, set, errors, canWrite }: { draft: CrewConfig; set: SetConfig; errors: Record<string, string>; canWrite: boolean }) {
  const crew = useCrewStore().crew;
  const [live, setLive] = useState<AgentManifest[]>([]);
  const [notes, setNotes] = useState<Notes>({});
  const [promptsOpen, setPromptsOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    quietApi.roleManifests().then((m) => alive && setLive(m), () => undefined);
    quietApi.agentNotes().then((n) => alive && setNotes(n), () => undefined);
    quietApi.org().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  // The Jira scan is Settings → Tasks' "Where tasks come from"; it has no row here.
  const roles = (live.length ? live : AGENTS).filter((r) => r.id !== 'scan');
  const known = crew?.org?.departments?.length ? [...crew.org.departments].sort((a, b) => a.order - b.order) : DEPARTMENTS;
  // Roles with no department, or one this board doesn't know, count as on (core agentDepartmentOn): listed last, always on.
  const other: Department = { id: '', name: 'Other', summary: 'Roles outside the teams above.', head: null, order: 99, colour: '#888888', budgetShare: 0, defaultEnabled: true, switchable: false };
  const teamOf = (r: AgentManifest) => (r.department && known.some((d) => d.id === r.department) ? r.department : '');
  const departments = [...known, other];
  const errorFor = (id: string) => Object.keys(errors).some((k) => k === `models.${id}` || k.startsWith(`models.${id}.`) || k.startsWith(`agents.${id}.`));
  const lead = modelFor(draft.org, 'lead', null);
  // Sessions the Mate starts (engineers and session agents) that the app would hold down to its model and effort.
  const held = roles
    .filter((r) => r.runAs === 'session' && roleOn(draft, r.id, r.defaultEnabled) && departmentOn(draft.org, known.find((d) => d.id === teamOf(r)) ?? other))
    .flatMap((r) =>
      r.id === 'engineer'
        ? DIFFICULTIES.filter((d) => aboveMate(modelFor(draft.org, r.id, r, d), lead)).map((d) => `${r.name} (${d} tickets)`)
        : aboveMate(modelFor(draft.org, r.id, r), lead)
          ? [r.name]
          : [],
    );

  return (
    <Section id="crew" title="Crew" lead={`Who works for you, on which model. Open a row for its schedule and options. The ${LEAD} applies changes on its next wake; running sessions keep theirs.`}>
      <fieldset className="set-fields" disabled={!canWrite}>
        <Row label="New engineers and agents" hint={`Click Start: the ${LEAD} proposes each session with its model and mode, and you start it from the ${LEAD}’s chat. On their own: they start with no click on the app’s default model and switch after their first turn.`}>
          <select value={draft.sessions.startMethod} aria-label="How new sessions start" onChange={(e) => set((c) => void (c.sessions = { startMethod: e.target.value as StartMethod }))}>
            {START_METHODS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </Row>
      </fieldset>

      <div className="members">
        <Member name={LEAD} sub="Runs the crew from your chat" model={`${modelLabel(lead.model)} · ${lead.effort}`} on={null} hasError={errorFor('lead') || errorFor(SUBAGENTS)} canWrite={canWrite}>
          <div className="member-body">
            <p className="note">
              A Claude Code session in the folder that holds your repos. Takes in work, writes specs, staffs the crew and keeps you informed. It can’t switch its own session: when its model changes here, it asks you to pick the model in its chat.
            </p>
            <fieldset className="set-fields" disabled={!canWrite}>
              <Row label="Model" error={errors['models.lead']}>
                <ModelPick draft={draft} set={set} id="lead" manifest={null} label={LEAD} invalid={!!errors['models.lead']} />
              </Row>
              <Row label="Helpers’ model" hint="The short-lived helpers sessions start for a quick job, like the planning critic." error={errors[`models.${SUBAGENTS}`]}>
                <ModelPick draft={draft} set={set} id={SUBAGENTS} manifest={null} label="Helpers" invalid={!!errors[`models.${SUBAGENTS}`]} />
              </Row>
            </fieldset>
            <h4 className="sub">Standing answers</h4>
            <p className="note">What the {LEAD} remembers you decided. Forget one and it asks again next time.</p>
            <Decisions canWrite={canWrite} />
          </div>
        </Member>
      </div>
      {held.length ? (
        <p className="note warn-text crew-held" role="status">
          The Claude app starts no session above the {LEAD}’s own model and effort ({modelLabel(lead.model)} · {lead.effort}), so these run lower than set: {held.join(', ')}. Raise the {LEAD}’s model or effort to lift them.
        </p>
      ) : null}

      {departments.map((d) => {
        const members = roles.filter((r) => teamOf(r) === d.id);
        if (!members.length) return null;
        const deptOn = departmentOn(draft.org, d);
        const on = members.filter((r) => roleOn(draft, r.id, r.defaultEnabled)).length;
        return (
          <div className={deptOn ? 'team' : 'team off'} key={d.id}>
            <div className="team-h">
              <i className="team-mark" style={{ background: d.colour }} aria-hidden="true" />
              <div className="team-t">
                <b>{d.name}</b>
                <span className="note">{deptOn ? `${on} of ${members.length} on. ${d.summary}` : d.summary}</span>
              </div>
              {d.switchable ? <Switch checked={deptOn} disabled={!canWrite} onChange={(v) => set((c) => setDepartment(c, d, roles, v))} label={<span className="sr-only">{d.name} on</span>} /> : <span className="faint small">Always on</span>}
            </div>
            {deptOn || members.some((m) => errorFor(m.id)) ? (
              <div className="members">
                {members.map((m) => {
                  const cfg = agentConfig(m, draft.agents[m.id], draft.org);
                  return (
                    <Member key={m.id} name={m.name} sub={cadence(m, cfg.schedule)} model={modelText(draft, m)} on={roleOn(draft, m.id, m.defaultEnabled)} onToggle={(v) => set((c) => setRole(c, m.id, v))} hasError={errorFor(m.id)} canWrite={canWrite}>
                      <MemberBody m={m} draft={draft} set={set} errors={errors} notes={notes[m.id]} canWrite={canWrite} />
                    </Member>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}

      <div className="team">
        <div className="team-h">
          <Icon name="book" className="team-ic" />
          <div className="team-t">
            <b>Instructions</b>
            <span className="note">The files the {LEAD} and each agent work from. Each saves on its own.</span>
          </div>
          <button type="button" className="btn sm ghost" aria-expanded={promptsOpen} onClick={() => setPromptsOpen(!promptsOpen)}>
            {promptsOpen ? 'Close' : 'Open'}
          </button>
        </div>
        {promptsOpen ? <Prompts canWrite={canWrite} /> : null}
      </div>
    </Section>
  );
}
