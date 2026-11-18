/** A QA verdict: the cases by assertion with evidence, the flake rate, where it ran, and the Jira note it can post. */
import { verdictTone } from '../../lib/inbox';
import { useCrewStore } from '../../lib/store';
import { ui } from '../../lib/ui';
import type { InboxItem, QaVerdict } from '../../types';
import { CopyButton, Details, Icon, Pill, type IconName, type Tone } from '../common';
import { Markdown } from '../Markdown';
import { Options, PostLine, ReadOnly, Recommendation, useDecide } from './parts';

const CASE: Record<QaVerdict, { label: string; tone: Tone; icon: IconName }> = {
  pass: { label: 'Pass', tone: 'ok', icon: 'check' },
  flaky: { label: 'Flaky', tone: 'warn', icon: 'check' },
  fail: { label: 'Fail', tone: 'block', icon: 'x' },
  env: { label: 'Env', tone: 'muted', icon: 'minus' },
  blocked: { label: 'Blocked', tone: 'muted', icon: 'minus' },
  unknown: { label: '—', tone: 'muted', icon: 'minus' },
};

export function QaCard({ item, now }: { item: InboxItem; now: number }) {
  const canWrite = useCrewStore().crew?.access.canWrite === true;
  const { busy, decide } = useDecide(item);
  const passed = item.cases.filter((c) => c.verdict === 'pass' || c.verdict === 'flaky').length;
  const flaky = item.cases.filter((c) => c.verdict === 'flaky').length;
  return (
    <>
      <div className="facts">
        {item.verdict ? (
          <Pill tone={verdictTone(item.verdict)} solid={verdictTone(item.verdict) === 'block'}>
            {item.verdict.toUpperCase()}
          </Pill>
        ) : null}
        {item.cases.length ? (
          <span className="fact num">
            {passed}/{item.cases.length} cases pass
          </span>
        ) : null}
        {item.round ? <span className="fact">Round {item.round}</span> : null}
        {item.flakeRate != null ? (
          <span className={item.flakeRate > 0.1 ? 'fact warn-text' : 'fact'} title="Flaky steps over all steps run">
            Flake rate {Math.round(item.flakeRate * 100)}%{flaky ? ` · ${flaky} flaky` : ''}
          </span>
        ) : null}
        {item.head ? (
          <span className="fact">
            on <code>{item.head.slice(0, 7)}</code>
          </span>
        ) : null}
      </div>
      {item.body ? <Markdown text={item.body} /> : null}
      {item.cases.length ? (
        <ul className="cases">
          {item.cases.map((c) => {
            const m = CASE[c.verdict];
            return (
              <li key={c.id} className={`case v-${c.verdict}`}>
                <span className="vchip" style={{ ['--c' as string]: `var(--${m.tone})` }}>
                  <Icon name={m.icon} />
                  {m.label}
                </span>
                <span className="case-main">
                  <span className="mono case-id">{c.id}</span>
                  {c.text ? <span>{c.text}</span> : null}
                  {c.note ? <span className="faint">{c.note}</span> : null}
                  {c.expected || c.actual ? (
                    <span className="faint">
                      {c.expected ? `Expected ${c.expected}` : ''}
                      {c.expected && c.actual ? ' · ' : ''}
                      {c.actual ? `got ${c.actual}` : ''}
                    </span>
                  ) : null}
                </span>
                <span className="case-ev">
                  {c.evidenceId && item.taskKey ? (
                    <button type="button" className="link" onClick={() => ui.openTask(item.taskKey!, 'evidence', c.evidenceId)}>
                      Evidence
                    </button>
                  ) : null}
                  {c.screenshot ? <CopyButton text={c.screenshot} label="Screenshot path" className="link" done="Copied" /> : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {item.url ? (
        <p className="note">
          Tested on{' '}
          <a href={item.url} target="_blank" rel="noopener noreferrer">
            {item.url}
          </a>
        </p>
      ) : null}
      {item.draft ? (
        <Details label="Jira note it can post" openLabel="Hide the note">
          <pre className="paper">{item.draft.body}</pre>
          <PostLine post={item.post} grant={item.postGrant} now={now} />
        </Details>
      ) : null}
      <Recommendation item={item} />
      {item.status !== 'open' ? null : canWrite ? <Options item={item} busy={busy} onAnswer={(a, o) => void decide(o.post ? 'post' : 'answer', a, { neverAsk: o.neverAsk })} /> : <ReadOnly />}
    </>
  );
}
