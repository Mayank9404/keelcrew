import { Fragment, useEffect, useState, type CSSProperties } from 'react';
import { LEAD } from '../labels';
import { errorText, quietApi } from '../lib/api';
import type { PolicyRule, PolicySummary } from '../types';
import { Icon, cvar } from './common';

function Rules({ title, intro, rules, color, mark }: { title: string; intro: string; rules: PolicyRule[]; color: string; mark: string }) {
  return (
    <section className="perm-sec" style={cvar(color)}>
      <h3>
        <i />
        {title}
      </h3>
      <p>{intro}</p>
      {rules.length ? (
        <ul className="rules" style={{ '--mark': `"${mark}"` } as CSSProperties}>
          {rules.map(r => (
            <li key={r.rule}>
              {r.rule}
              {r.detail ? <span className="d">{r.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">None.</p>
      )}
    </section>
  );
}

/** What crew sessions may do, written from rules.json at build time. */
export function PermissionsPanel() {
  const [policy, setPolicy] = useState<PolicySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    quietApi.policy().then(
      p => live && setPolicy(p),
      e => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  const roles = policy?.roles ?? [];
  return (
    <div className="perm">
      <div className="perm-mode">
        <Icon name="shield" />
        <div>
          <b>Auto mode, plus the crew rules below</b>
          <span>Every crew session runs in Claude Code&rsquo;s auto mode. The crew policy hook sits on top and is the same for the {LEAD} and every agent. Your team pack can add rules of its own. Three denials in a row, or twenty in one session, pause it until you unpause it.</span>
        </div>
      </div>
      {error ? <p className="err-box">{error}</p> : null}
      {!policy && !error ? <p className="note">Loading…</p> : null}
      {policy ? (
        <>
          <Rules title="Allowed without asking" intro="The crew does these on its own." rules={policy.allowed} color="--ok" mark="✓" />
          <Rules
            title="Needs your approval"
            intro="An item lands on Sign-offs, or the session asks, first."
            rules={policy.needsApproval}
            color="--warn"
            mark="?"
          />
          <Rules title="Never allowed" intro="Blocked outright, whatever the session asks." rules={policy.never} color="--block" mark="✕" />
          <section className="perm-sec">
            <h3>Who does what</h3>
            <dl className="roles">
              {roles.map(r => (
                <Fragment key={r.role}>
                  <dt>{r.role}</dt>
                  <dd>{r.summary}</dd>
                </Fragment>
              ))}
            </dl>
          </section>
        </>
      ) : null}
    </div>
  );
}
