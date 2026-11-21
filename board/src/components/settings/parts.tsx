import { useState, type ReactNode } from 'react';
import { modelLabel } from '../../labels';
import { EFFORTS, type AgentManifest } from '../../lib/agents';
import { modelFor, storedChoice, withApproved } from '../../lib/models';
import type { CrewConfig, Difficulty, Effort, ModelChoice } from '../../types';

export type SetConfig = (fn: (c: CrewConfig) => void) => void;

/** One group of the settings page: a heading the index links to, a line on what it holds, then its rows. */
export function Section({ id, title, lead, children }: { id: string; title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <section className="sset" id={`set-${id}`} aria-labelledby={`set-${id}-h`}>
      <h2 id={`set-${id}-h`}>{title}</h2>
      {lead ? <p className="note sset-lead">{lead}</p> : null}
      {children}
    </section>
  );
}

/** One setting: what it does on the left, its control on the right. `wide` puts the control underneath. */
export function Row({ label, hint, error, children, wide }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'srow wide' : 'srow'}>
      <div className="srow-l">
        <span className="srow-t">{label}</span>
        {hint ? <span className="note">{hint}</span> : null}
      </div>
      <div className="srow-r">
        {children}
        {error ? <span className="err">{error}</span> : null}
      </div>
    </div>
  );
}

/** A short number field with its unit beside it. */
export function Num({ value, onChange, invalid, unit, label, disabled, placeholder }: { value: number; onChange: (n: number) => void; invalid?: boolean; unit?: string; label: string; disabled?: boolean; placeholder?: string }) {
  return (
    <span className={invalid ? 'num-field invalid' : 'num-field'}>
      <input
        type="number"
        inputMode="numeric"
        value={Number.isFinite(value) ? value : ''}
        placeholder={placeholder}
        aria-invalid={invalid}
        aria-label={label}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
      />
      {unit ? <span className="unit">{unit}</span> : null}
    </span>
  );
}

export function EffortSelect({ value, onChange, label, disabled }: { value: Effort; onChange: (e: Effort) => void; label: string; disabled?: boolean }) {
  return (
    <select value={value} aria-label={label} disabled={disabled} onChange={(e) => onChange(e.target.value as Effort)}>
      {EFFORTS.map((x) => (
        <option key={x}>{x}</option>
      ))}
    </select>
  );
}

/** Models offered in the model fields (any id can be typed). */
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'];

/** The model menu's last choice: type any model id, such as one newer than this list. */
const TYPED = 'typed';

/**
 * A role's model and effort (`settings/main.org.models.approved`): what it uses now, greyed while it's the default, with
 * Default to clear the captain's choice. A model the role already uses stays in its list, even one no longer offered;
 * Type a model name takes any other id, such as a model newer than this build of the board.
 */
export function ModelPick({ draft, set, id, manifest, difficulty = null, label, effort = true, invalid }: { draft: CrewConfig; set: SetConfig; id: string; manifest: AgentManifest | null; difficulty?: Difficulty | null; label: string; effort?: boolean; invalid?: boolean }) {
  const stored = storedChoice(draft.org, id, difficulty);
  const use = modelFor(draft.org, id, manifest, difficulty);
  const shown: ModelChoice = { model: stored?.model ?? use.model, effort: stored && EFFORTS.includes(stored.effort) ? stored.effort : use.effort };
  const models = MODELS.includes(shown.model) ? MODELS : [...MODELS, shown.model];
  const [typed, setTyped] = useState<string | null>(null);
  const choose = (choice: ModelChoice | null) =>
    set((c) => {
      const org = (c.org ??= {});
      org.models = { ...org.models, approved: withApproved(org.models?.approved, id, choice, difficulty) };
    });
  return (
    <span className={stored ? 'model-pick' : 'model-pick dflt'}>
      <select
        value={typed !== null ? TYPED : shown.model}
        aria-label={`${label} model`}
        aria-invalid={invalid}
        onChange={(e) => {
          setTyped(e.target.value === TYPED ? shown.model : null);
          if (e.target.value !== TYPED) choose({ model: e.target.value, effort: shown.effort });
        }}
      >
        {models.map((m) => (
          <option key={m} value={m}>
            {modelLabel(m)}
          </option>
        ))}
        <option value={TYPED}>Type a model name…</option>
      </select>
      {typed !== null ? (
        <input
          type="text"
          className="w-md mono"
          value={typed}
          spellCheck={false}
          aria-label={`${label} model name`}
          aria-invalid={invalid}
          placeholder="claude-opus-5-5"
          onChange={(e) => {
            setTyped(e.target.value);
            if (e.target.value.trim()) choose({ model: e.target.value.trim(), effort: shown.effort });
          }}
        />
      ) : null}
      {effort ? <EffortSelect label={`${label} effort`} value={shown.effort} onChange={(x) => choose({ model: shown.model, effort: x })} /> : null}
      {stored ? (
        <button
          type="button"
          className="btn xs ghost"
          onClick={() => {
            setTyped(null);
            choose(null);
          }}
        >
          Default
        </button>
      ) : null}
    </span>
  );
}
