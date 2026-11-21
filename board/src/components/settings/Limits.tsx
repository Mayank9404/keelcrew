/** Settings → Limits: how much runs at once, how much of your plan the crew may use, and when it may ask you things. */
import { useState } from 'react';
import { LEAD, fromLabel } from '../../labels';
import { AGENTS } from '../../lib/agentCatalog';
import { DEPARTMENTS } from '../../lib/departmentCatalog';
import { departmentOn } from '../../lib/org';
import { isTime } from '../../lib/schedule';
import { useCrewStore } from '../../lib/store';
import type { CrewConfig } from '../../types';
import { Icon, Switch } from '../common';
import { Num, Row, Section, type SetConfig } from './parts';

/** Members that can have a cap per session: the Mate, then every agent. */
const CAPPED = ['lead', ...AGENTS.map((a) => a.id)];

/** An optional amount: empty is none. */
function Amount({ value, onChange, label, unit, pre, placeholder, invalid }: { value: number | null | undefined; onChange: (v: number | null) => void; label: string; unit?: string; pre?: string; placeholder: string; invalid?: boolean }) {
  return (
    <span className={invalid ? 'num-field invalid' : 'num-field'}>
      {pre ? <span className="unit pre">{pre}</span> : null}
      <input type="number" inputMode="decimal" min={0} value={value ?? ''} placeholder={placeholder} aria-label={label} aria-invalid={invalid} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />
      {unit ? <span className="unit">{unit}</span> : null}
    </span>
  );
}

/** Caps must be positive, shares 0–100 and question times real times. */
export function validateLimits(c: CrewConfig): Record<string, string> {
  const e: Record<string, string> = {};
  const bad = (v: unknown) => v != null && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0);
  if (bad(c.budgets.perTicketUsd)) e['budgets.perTicketUsd'] = 'A positive amount, or empty.';
  for (const [r, v] of Object.entries(c.budgets.perRoleUsd ?? {})) if (bad(v)) e[`budgets.perRoleUsd.${r}`] = 'A positive amount, or empty.';
  if (c.questionWindows.some((w) => !isTime(w))) e.questionWindows = 'Times as HH:MM.';
  return e;
}

export function LimitsSection({ draft, set, errors, canWrite }: { draft: CrewConfig; set: SetConfig; errors: Record<string, string>; canWrite: boolean }) {
  const crew = useCrewStore().crew;
  const [add, setAdd] = useState('');
  const [capsOpen] = useState(draft.budgets.perTicketUsd != null || Object.keys(draft.budgets.perRoleUsd ?? {}).length > 0);
  const o = draft.org ?? {};
  const departments = crew?.org?.departments?.length ? crew.org.departments : DEPARTMENTS;
  const windows = [...draft.questionWindows].sort();
  const t = add.trim();
  const addErr = t && !isTime(t) ? 'Use a time like 16:30.' : t && windows.includes(t) ? 'Already there.' : null;
  const setShare = (id: string, v: number | null) =>
    set((c) => {
      const org = (c.org ??= {});
      const next = { ...(org.budgets?.departments ?? {}) };
      if (v == null) delete next[id];
      else next[id] = v;
      org.budgets = { ...org.budgets, departments: next };
    });
  return (
    <Section id="limits" title="Limits" lead="Keep the crew inside your plan and your day.">
      <fieldset className="set-fields" disabled={!canWrite}>
        <Row label="Engineers at once" hint="Tickets worked at the same time. Each ticket gets its own engineer." error={errors.maxWorkers}>
          <Num label="Engineers at once" value={draft.maxWorkers} invalid={!!errors.maxWorkers} onChange={(n) => set((c) => void (c.maxWorkers = n))} />
        </Row>
        <Row label="Pause near your plan’s limits" hint="Past these shares of your plan’s usage windows, no new work starts. Work already running finishes.">
          <Switch checked={draft.usageGuard.enabled} onChange={(v) => set((c) => void (c.usageGuard.enabled = v))} label={<span className="sr-only">Pause near your plan’s limits</span>} />
        </Row>
        {draft.usageGuard.enabled ? (
          <div className="srow-group">
            <Row label="5-hour window" error={errors['usageGuard.maxFiveHourPct']}>
              <Num label="5-hour window limit" unit="%" value={draft.usageGuard.maxFiveHourPct} invalid={!!errors['usageGuard.maxFiveHourPct']} onChange={(n) => set((c) => void (c.usageGuard.maxFiveHourPct = n))} />
            </Row>
            <Row label="Weekly window" error={errors['usageGuard.maxSevenDayPct']}>
              <Num label="Weekly window limit" unit="%" value={draft.usageGuard.maxSevenDayPct} invalid={!!errors['usageGuard.maxSevenDayPct']} onChange={(n) => set((c) => void (c.usageGuard.maxSevenDayPct = n))} />
            </Row>
          </div>
        ) : null}
        <Row label="Your day starts at" hint="Do not disturb offers “until tomorrow” up to this time." error={errors['workingHours.start']}>
          <input type="time" value={draft.workingHours.start} aria-label="Day starts at" aria-invalid={!!errors['workingHours.start']} onChange={(e) => set((c) => void (c.workingHours.start = e.target.value))} />
        </Row>
        <Row wide label="Times to ask you" hint={`The ${LEAD} saves questions that can wait and asks them together at these times. Outages, security, data at risk and paused work never wait. None: it asks right away.`} error={errors.questionWindows ?? addErr ?? undefined}>
          <div className="windows">
            {windows.map((w) => (
              <span className="chip" key={w}>
                <Icon name="clock" />
                <span className="num">{w}</span>
                <button type="button" aria-label={`Remove ${w}`} onClick={() => set((c) => void (c.questionWindows = c.questionWindows.filter((x) => x !== w)))}>
                  <Icon name="x" />
                </button>
              </span>
            ))}
            <span
              className="field-row"
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !t || addErr) return;
                e.preventDefault();
                set((c) => void (c.questionWindows = [...c.questionWindows, t].sort()));
                setAdd('');
              }}
            >
              <input type="time" value={add} aria-label="Add a time to ask you" aria-invalid={!!addErr} onChange={(e) => setAdd(e.target.value)} />
              <button
                type="button"
                className="btn sm"
                disabled={!t || !!addErr}
                onClick={() => {
                  set((c) => void (c.questionWindows = [...c.questionWindows, t].sort()));
                  setAdd('');
                }}
              >
                Add time
              </button>
            </span>
          </div>
        </Row>
      </fieldset>

      <h3 className="sset-sub" id="set-shares">
        Weekly share per team
      </h3>
      <p className="note">How much of your plan’s weekly usage each team may take. Empty keeps the team’s default.</p>
      <fieldset className="set-fields" disabled={!canWrite}>
        {departments
          .filter((d) => departmentOn(o, d))
          .map((d) => {
            const used = crew?.spend?.departments[d.id]?.usedPct;
            return (
              <Row key={d.id} label={d.name} hint={used != null ? `Used ${Math.round(used)}% this week` : undefined} error={errors[`org.budgets.departments.${d.id}`]}>
                <Amount label={`${d.name} weekly share`} unit="%" value={o.budgets?.departments?.[d.id]} placeholder={String(Math.round(d.budgetShare * 100))} invalid={!!errors[`org.budgets.departments.${d.id}`]} onChange={(v) => setShare(d.id, v)} />
              </Row>
            );
          })}
        <Row label="Pause a ticket that runs long" hint={`A ticket well past what similar tickets took gets a flag; far past, its sessions pause and the ${LEAD} asks you. Learns from your first weeks of tickets.`}>
          <Switch checked={o.budgets?.spendAlarm !== false} onChange={(v) => set((c) => void ((c.org ??= {}).budgets = { ...c.org.budgets, spendAlarm: v }))} label={<span className="sr-only">Pause a ticket that runs long</span>} />
        </Row>
        <Row label="Keep a record per ticket" hint="What each ticket and proposal took and how it ended. The pause above and proposal hit rates need it.">
          <Switch checked={draft.ledger.enabled} onChange={(v) => set((c) => void (c.ledger = { ...c.ledger, enabled: v }))} label={<span className="sr-only">Keep a record per ticket</span>} />
        </Row>
        <details className="srow-more" open={capsOpen || Object.keys(errors).some((k) => k.startsWith('budgets.')) || undefined}>
          <summary>Hard caps</summary>
          <p className="note">Leave empty for none. At 85% you get a warning; at 100% the {LEAD} pauses that work and asks you.</p>
          <Row label="Per ticket" hint="Across all of a ticket’s sessions." error={errors['budgets.perTicketUsd']}>
            <Amount label="Cap per ticket" pre="$" placeholder="none" value={draft.budgets.perTicketUsd} invalid={!!errors['budgets.perTicketUsd']} onChange={(v) => set((c) => void (c.budgets = { ...c.budgets, perTicketUsd: v }))} />
          </Row>
          {CAPPED.map((r) => (
            <Row key={r} label={`${r === 'lead' ? LEAD : fromLabel(r)}, per session`} error={errors[`budgets.perRoleUsd.${r}`]}>
              <Amount
                label={`Cap per session for ${r === 'lead' ? LEAD : fromLabel(r)}`}
                pre="$"
                placeholder="none"
                value={draft.budgets.perRoleUsd?.[r]}
                invalid={!!errors[`budgets.perRoleUsd.${r}`]}
                onChange={(v) =>
                  set((c) => {
                    const next = { ...(c.budgets.perRoleUsd ?? {}) };
                    if (v == null) delete next[r];
                    else next[r] = v;
                    c.budgets = { ...c.budgets, perRoleUsd: next };
                  })
                }
              />
            </Row>
          ))}
        </details>
      </fieldset>
    </Section>
  );
}
