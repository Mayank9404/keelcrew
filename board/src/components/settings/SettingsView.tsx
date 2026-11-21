/**
 * Settings: one page in six groups (Crew, Tasks, Shipping, Limits, This Mac, Rules) with an index beside it. Everything
 * but the instruction files is one form, saved as an `update` of what changed, pinned to the version it was read at.
 * Mac-side keys go to the helper's config.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { errorText, quietApi } from '../../lib/api';
import { validateModels } from '../../lib/models';
import { validateOrg } from '../../lib/org';
import { isTime } from '../../lib/schedule';
import { patchCrew, useCrewStore } from '../../lib/store';
import { toast } from '../../lib/toast';
import { useUi, type SettingsSection } from '../../lib/ui';
import { applyPatch, diffPatch } from '../../lib/versions';
import type { CrewConfig } from '../../types';
import { PageHeader } from '../common';
import { PermissionsPanel } from '../Permissions';
import { CrewSection } from './Crew';
import { LimitsSection, validateLimits } from './Limits';
import { ShippingSection, reviewOf } from './Shipping';
import { TasksSection } from './Tasks';
import { ThisMacSection } from './ThisMac';
import { Section } from './parts';

const json = (c: CrewConfig | null): string => JSON.stringify(c);

const GROUPS: [SettingsSection, string][] = [
  ['crew', 'Crew'],
  ['tasks', 'Tasks'],
  ['shipping', 'Shipping'],
  ['limits', 'Limits'],
  ['mac', 'This Mac'],
  ['rules', 'Rules'],
];

/** Which group holds a field with an error, by its path. */
const GROUP_OF: [RegExp, SettingsSection][] = [
  [/^(models|agents)\./, 'crew'],
  [/^(intake|repos|org\.goals)/, 'tasks'],
  [/^codeReview/, 'shipping'],
  [/^(maxWorkers|usageGuard|workingHours|questionWindows|budgets|org\.budgets)/, 'limits'],
];

/** What's wrong with the fields that lib/models, lib/org and Limits' caps don't check, by field path. */
export function validate(c: CrewConfig): Record<string, string> {
  const e: Record<string, string> = {};
  const int = (path: string, v: number, min: number, max: number) => {
    if (!Number.isInteger(v) || v < min || v > max) e[path] = `A whole number from ${min} to ${max}.`;
  };
  int('maxWorkers', c.maxWorkers, 1, 24);
  if (!isTime(c.workingHours.start)) e['workingHours.start'] = 'A time like 09:00.';
  if (!reviewOf(c.codeReview.args).level) e['codeReview.args'] = 'Choose a depth.';
  else if (/--comment\b/.test(c.codeReview.args)) e['codeReview.args'] = 'Your settings ask the review to post on the PR (--comment). Change the depth or the fix switch to drop it.';
  if (c.usageGuard.enabled) {
    int('usageGuard.maxFiveHourPct', c.usageGuard.maxFiveHourPct, 1, 100);
    int('usageGuard.maxSevenDayPct', c.usageGuard.maxSevenDayPct, 1, 100);
  }
  for (const [id, a] of Object.entries(c.agents)) if (typeof a?.schedule === 'string' && a.schedule && !/^\S+( \S+){4}$/.test(a.schedule.trim())) e[`agents.${id}.schedule`] = 'Five cron fields, like 30 9 * * 1-5.';
  for (const [name, r] of Object.entries(c.repos)) if (!r.baseBranch.trim()) e[`repos.${name}`] = 'Name its base branch.';
  return e;
}

/** The settings as saved: the support source is typed freely (a Teams channel can have spaces) and trimmed only here. */
export function forSave(c: CrewConfig): CrewConfig {
  const source = c.agents.support?.source;
  return typeof source === 'string' && source !== source.trim() ? { ...c, agents: { ...c.agents, support: { ...c.agents.support, source: source.trim() } } } : c;
}

/**
 * The captain's edits rebased on a newer version after a 409: what they changed applied as the store applies an update
 * (null deletes, so a cleared field stays cleared).
 */
export function rebaseDraft(base: CrewConfig, draft: CrewConfig, live: CrewConfig): CrewConfig {
  return applyPatch(structuredClone(live), diffPatch(base, draft) ?? {});
}

const jump = (id: SettingsSection) => document.getElementById(`set-${id}`)?.scrollIntoView({ block: 'start' });

/** The index beside the page: a link per group, the one in view marked. */
function SettingsIndex({ bad }: { bad: Set<SettingsSection> }) {
  const [here, setHere] = useState<SettingsSection>('crew');
  // The group whose heading has passed the top of the scrolling area; the last one once the page is at its end.
  useEffect(() => {
    const scroller = document.getElementById('set-crew')?.closest('.main');
    if (!scroller) return;
    const update = () => {
      const line = scroller.getBoundingClientRect().top + 48;
      let cur = GROUPS[0][0];
      for (const [id] of GROUPS) if ((document.getElementById(`set-${id}`)?.getBoundingClientRect().top ?? Infinity) <= line) cur = id;
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) cur = GROUPS[GROUPS.length - 1][0];
      setHere(cur);
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    return () => scroller.removeEventListener('scroll', update);
  }, []);
  return (
    <nav className="set-index" aria-label="Settings groups">
      {GROUPS.map(([id, label]) => (
        <a key={id} href={`#set-${id}`} aria-current={here === id ? 'true' : undefined} onClick={(e) => (e.preventDefault(), jump(id))}>
          {label}
          {bad.has(id) ? <span className="set-bad" aria-label="has a field to fix" /> : null}
        </a>
      ))}
    </nav>
  );
}

function Rules() {
  const [open, setOpen] = useState(false);
  return (
    <Section id="rules" title="Rules" lead="What every crew session may and may not do. Set by Keelcrew and your team pack; read only here.">
      <div className="row-actions">
        <button type="button" className="btn sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Hide the rules' : 'Show the rules'}
        </button>
      </div>
      {open ? <PermissionsPanel /> : null}
    </Section>
  );
}

export function SettingsView() {
  const crew = useCrewStore().crew;
  const live = crew?.config;
  const liveVersion = crew?.settingsVersion ?? null;
  const canWrite = crew?.access.canWrite === true;
  const { settingsFocus } = useUi();
  const [base, setBase] = useState<CrewConfig | null>(() => (live ? structuredClone(live) : null));
  const [baseVersion, setBaseVersion] = useState<string | null>(liveVersion);
  const [draft, setDraft] = useState<CrewConfig | null>(() => (live ? structuredClone(live) : null));
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  // A newer config that arrived while the captain had unsaved edits: offered as a reload, never applied over them.
  const [elsewhere, setElsewhere] = useState<CrewConfig | null>(null);
  const dirty = useMemo(() => !!draft && !!base && json(draft) !== json(base), [draft, base]);
  const current = useRef({ dirty, base });
  current.current = { dirty, base };
  const load = (c: CrewConfig, version: string | null) => {
    setBase(structuredClone(c));
    setBaseVersion(version);
    setDraft(structuredClone(c));
    setElsewhere(null);
  };

  useEffect(() => {
    let alive = true;
    quietApi.getConfig().then(
      (c) => {
        if (!alive) return;
        if (!current.current.dirty) {
          setBase(structuredClone(c));
          setDraft(structuredClone(c));
        } else if (json(c) !== json(current.current.base)) setElsewhere(c);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);

  // Follow changes made elsewhere while there are no local edits.
  useEffect(() => {
    if (!live) return;
    if (!dirty) load(live, liveVersion);
    else if (liveVersion !== baseVersion) setElsewhere(live);
  }, [live, liveVersion]);

  const ready = !!draft;
  useEffect(() => {
    if (ready && settingsFocus) jump(settingsFocus.section);
  }, [ready, settingsFocus?.n]);

  if (!draft || !live || !base) return null;
  const errors = { ...validate(draft), ...validateLimits(draft), ...validateOrg(draft), ...validateModels(draft) };
  const bad = new Set(Object.keys(errors).map((k) => GROUP_OF.find(([re]) => re.test(k))?.[1] ?? 'crew'));
  const hasErrors = bad.size > 0;
  const set = (fn: (c: CrewConfig) => void) => {
    setDraft((d) => {
      if (!d) return d;
      const next = structuredClone(d);
      fn(next);
      return next;
    });
  };
  const save = async () => {
    if (hasErrors) return;
    setSaving(true);
    setServerError(null);
    try {
      const next = await quietApi.saveSettings(base, baseVersion, forSave(draft));
      patchCrew((h) => ({ ...h, config: next }));
      setBase(structuredClone(next));
      setDraft(structuredClone(next));
      setElsewhere(null);
      toast('Settings saved. The Mate applies them on its next wake.');
    } catch (e) {
      if ((e as { status?: number }).status === 409) {
        // Someone changed the settings meanwhile: keep the captain's own edits on top of the new version.
        setBase(structuredClone(live));
        setBaseVersion(liveVersion);
        setDraft(rebaseDraft(base, draft, live));
        setElsewhere(null);
        setServerError('Settings changed elsewhere while you were editing. Your edits are kept on top of the new version; check them and save again.');
      } else setServerError(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  const badNames = GROUPS.filter(([id]) => bad.has(id));
  const props = { draft, set, errors, canWrite };
  return (
    <div className="view settings">
      <PageHeader title="Settings" status={canWrite ? 'Changes wait for Save.' : 'Read only: only the captain can change settings.'} />
      <div className="set-layout">
        <SettingsIndex bad={bad} />
        <div className="set-groups">
          <CrewSection {...props} />
          <TasksSection {...props} live={live} />
          <ShippingSection {...props} />
          <LimitsSection {...props} />
          <ThisMacSection draft={draft} set={set} canWrite={canWrite} />
          <Rules />
          {canWrite && (dirty || serverError) ? (
            <div className="savebar" role="region" aria-label="Unsaved settings">
              {serverError ? (
                <span className="err-box">{serverError}</span>
              ) : elsewhere ? (
                <span className="warn-text">Settings changed elsewhere. Reload to see the latest; this drops your unsaved edits.</span>
              ) : hasErrors ? (
                <span className="block-text">
                  Fix the marked fields in{' '}
                  {badNames.map(([id, label], i) => (
                    <span key={id}>
                      {i ? (i === badNames.length - 1 ? ' and ' : ', ') : ''}
                      <button type="button" className="link" onClick={() => jump(id)}>
                        {label}
                      </button>
                    </span>
                  ))}{' '}
                  to save.
                </span>
              ) : (
                <span>Unsaved changes.</span>
              )}
              <span className="grow" />
              {elsewhere ? (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    load(elsewhere, liveVersion);
                    setServerError(null);
                  }}
                >
                  Reload
                </button>
              ) : (
                <button
                  type="button"
                  className="btn ghost"
                  disabled={!dirty}
                  onClick={() => {
                    setDraft(structuredClone(base));
                    setServerError(null);
                  }}
                >
                  Discard
                </button>
              )}
              <button type="button" className="btn primary" disabled={!dirty || hasErrors || saving} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
