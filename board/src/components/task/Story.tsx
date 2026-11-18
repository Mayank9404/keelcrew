/**
 * A task's story, in the order work happens: contract, agents, evidence, validation, ship, QA. Each stage says where
 * it stands in its heading, so the column reads as a timeline.
 */
import { useState, type ReactNode } from 'react';
import { LEAD, fromLabel } from '../../labels';
import { api, errorText } from '../../lib/api';
import { verdictTone } from '../../lib/inbox';
import { useCanWrite } from '../../lib/store';
import { toast } from '../../lib/toast';
import { cardVariant } from '../../lib/triage';
import { ui } from '../../lib/ui';
import { gridSummary, summaryText, validationGrid } from '../../lib/validation';
import type { CrewState, Evidence, InboxItem, Risk, Task, TaskAgent, TaskDetail } from '../../types';
import { Card, ResolvedCard } from '../cards/Card';
import { Details, Empty, Icon, Pill, cls, type Tone } from '../common';
import { Markdown } from '../Markdown';
import { HandoffView, ReceiptsLine, Walkthrough } from '../parts/EvidenceViews';
import { RiskBlock } from '../parts/RiskBlock';
import { ValidationGrid, ValidationStrip } from '../parts/ValidationGrid';
import { OpenIn, OverlapNote } from './Workspace';

type StageState = 'done' | 'now' | 'you' | 'block' | 'todo';

function Stage({ n, title, state, summary, children }: { n: number; title: string; state: StageState; summary?: ReactNode; children: ReactNode }) {
  return (
    <section className={`stage st-${state}`} aria-label={title}>
      <div className="stage-rail" aria-hidden="true">
        <span className="stage-n">{state === 'done' ? <Icon name="check" /> : n}</span>
      </div>
      <div className="stage-body">
        <h3>
          {title}
          {summary ? <span className="stage-sum">{summary}</span> : null}
        </h3>
        {children}
      </div>
    </section>
  );
}

const agentTone = (a: TaskAgent): Tone => {
  if (a.paused) return 'block';
  if (a.resultStatus === 'BLOCKED' || a.resultStatus === 'NEEDS_CONTEXT' || /^(block|fail|error)/i.test(a.status)) return 'block';
  if (/^(run|active|work|start)/i.test(a.status)) return 'work';
  if (/^wait/i.test(a.status)) return 'you';
  if (/^(done|pass)/i.test(a.status) || a.resultStatus?.startsWith('DONE')) return 'ok';
  return 'muted';
};

function AgentRow({ task, a }: { task: Task; a: TaskAgent }) {
  const canWrite = useCanWrite();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const running = /^(run|active|work|start)/i.test(a.status);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done);
      setConfirm(false);
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="agent-row" style={{ ['--c' as string]: `var(--${agentTone(a)})` }}>
      <div className="ar-h">
        <b>{fromLabel(a.id)}</b>
        <Pill tone={agentTone(a)}>{a.paused ? 'paused' : a.status}</Pill>
        {a.verdict ? <Pill tone={verdictTone(a.verdict)}>{a.verdict}</Pill> : null}
        {a.round ? <span className="faint">round {a.round}</span> : null}
        <span className="grow" />
        {a.sessionLink ? (
          <a className="btn xs ghost" href={a.sessionLink} target="_blank" rel="noopener noreferrer">
            Session
          </a>
        ) : null}
        {canWrite && a.paused && !confirm ? (
          <button type="button" className="btn xs" onClick={() => setConfirm(true)}>
            Unpause…
          </button>
        ) : null}
        {canWrite && running && a.id !== 'engineer' ? (
          <button type="button" className="btn xs ghost danger" disabled={busy} onClick={() => void act(() => api.agentAction(a.id, 'stop', task.key), `Asked the ${LEAD} to stop the ${fromLabel(a.id)} on ${task.key}.`)}>
            Stop
          </button>
        ) : null}
      </div>
      {a.result ? <p className="ar-result">{a.result}</p> : null}
      {a.paused ? (
        <div className="ar-paused">
          <span>Crew policy paused it after repeated denials{a.pauseReasons.length ? ':' : '.'}</span>
          {a.pauseReasons.length ? (
            <ul className="reasons">
              {a.pauseReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : null}
          {confirm ? (
            <div className="confirm">
              <span>Unpause the {fromLabel(a.id)} on {task.key}?</span>
              <button type="button" className="btn sm primary" disabled={busy} onClick={() => void act(() => api.unpause({ key: task.key, agent: a.id, sessionId: a.sessionId }), `Asked the ${LEAD} to unpause it.`)}>
                Unpause
              </button>
              <button type="button" className="btn sm ghost" onClick={() => setConfirm(false)}>
                Keep paused
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** "Check risk now": the helper's tier for the committed diff, on demand. */
function RiskCheck({ task, initial }: { task: Task; initial: Risk | null }) {
  const [risk, setRisk] = useState<Risk | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setRisk(await api.risk(task.key));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="risk-check">
      {risk ? <RiskBlock risk={risk} /> : <p className="note">No risk tier yet: the engineer adds it when it ships.</p>}
      {task.worktree || task.branch ? (
        <button type="button" className="btn xs ghost" disabled={busy} onClick={() => void check()}>
          <Icon name="refresh" />
          {busy ? 'Checking…' : risk ? 'Check the risk again' : 'Check the risk now'}
        </button>
      ) : null}
      {error ? <p className="note block-text">{error}</p> : null}
    </div>
  );
}

const newest = (list: Evidence[], kind: Evidence['kind']): Evidence | undefined => [...list].filter((e) => e.kind === kind).sort((a, b) => b.createdAt - a.createdAt)[0];

export function Story({ crew, task, detail, now }: { crew: CrewState; task: Task; detail: TaskDetail | null; now: number }) {
  const all = new Map<string, InboxItem>();
  for (const i of [...(detail?.inbox ?? []), ...crew.inbox.filter((x) => x.taskKey === task.key)]) all.set(i.id, i);
  const cards = [...all.values()].sort((a, b) => b.createdAt - a.createdAt);
  const open = cards.filter((i) => i.status === 'open');
  const ships = cards.filter((i) => i.kind === 'ship');
  const qas = cards.filter((i) => i.kind === 'qa');
  const others = cards.filter((i) => i.status !== 'open' && i.kind !== 'ship' && i.kind !== 'qa');
  const evidence = detail?.evidence ?? [];
  const handoff = newest(evidence, 'handoff');
  const walk = newest(evidence, 'walkthrough');
  const context = evidence.filter((e) => e.kind === 'context').sort((a, b) => b.createdAt - a.createdAt);
  const evalCases = evidence.filter((e) => e.tags.includes('eval-case'));
  const rows = validationGrid(task.contract, task.validation);
  const s = gridSummary(rows);
  const latestShip = ships[0];
  const latestQa = qas[0];
  const qaAgent = task.agents.find((a) => a.id === 'qa');
  const others2 = task.agents;
  const running = others2.some((a) => /^(run|active|work|start)/i.test(a.status));
  const blocked = others2.some((a) => agentTone(a) === 'block');
  const negatives = task.contract.filter((c) => c.kind === 'negative').length;

  const shipState: StageState = latestShip?.status === 'open' ? 'you' : task.prUrl || task.status === 'pr' || task.status === 'qa' || task.status === 'done' ? 'done' : latestShip ? 'now' : 'todo';
  const qaState: StageState = latestQa?.status === 'open' ? 'you' : task.status === 'done' ? 'done' : /^fail/i.test(latestQa?.verdict ?? qaAgent?.verdict ?? '') ? 'block' : qaAgent ? 'now' : 'todo';

  return (
    <div className="story">
      {open.length ? (
        <div className="story-cards">
          {open.map((i) => (
            <Card key={i.id} item={i} />
          ))}
        </div>
      ) : null}
      <OverlapNote task={task} />
      {task.lastSummary ? <p className="lede">{task.lastSummary}</p> : null}

      <Stage n={1} title="Contract" state={task.contract.length ? 'done' : task.spec ? 'now' : 'todo'} summary={task.contract.length ? `${task.contract.length} assertions${negatives ? `, ${negatives} negative` : ''}` : 'not written yet'}>
        {task.contract.length ? (
          <ol className="contract">
            {task.contract.map((c) => (
              <li key={c.id}>
                <span className="mono">{c.id}</span>
                {c.kind === 'negative' ? <span className="neg">neg</span> : null}
                <span>{c.text}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="note">The {LEAD} writes the contract (numbered assertions, negative cases too) before staffing.</p>
        )}
        {task.spec ? (
          <Details label="Spec" openLabel="Hide the spec" defaultOpen={!task.contract.length}>
            <Markdown text={task.spec} />
          </Details>
        ) : task.description ? (
          <Details label="Description" openLabel="Hide the description">
            <Markdown text={task.description} />
          </Details>
        ) : null}
        {context.map((e) => (
          <Details key={e.id} label={`${e.title}${e.agent ? ` · ${fromLabel(e.agent)}` : ''}`} openLabel="Hide">
            <Markdown text={e.content} />
          </Details>
        ))}
      </Stage>

      <Stage n={2} title="Agents" state={blocked ? 'block' : running ? 'now' : task.agents.length ? 'done' : 'todo'} summary={task.agents.length ? task.agents.map((a) => fromLabel(a.id)).join(', ') : 'none yet'}>
        {task.agents.length ? (
          <ul className="agent-rows">
            {task.agents.map((a) => (
              <AgentRow key={a.id} task={task} a={a} />
            ))}
          </ul>
        ) : (
          <p className="note">Nobody is on it yet. The {LEAD} staffs the scout, the engineer, the reviewer and QA as the ticket moves.</p>
        )}
      </Stage>

      <Stage n={3} title="Evidence" state={evidence.length ? 'done' : 'todo'} summary={detail ? `${evidence.length} item${evidence.length === 1 ? '' : 's'}${evalCases.length ? ` · ${evalCases.length} eval case${evalCases.length === 1 ? '' : 's'}` : ''}` : 'loading'}>
        {handoff?.handoff ? (
          <div className="ev-highlight">
            <span className="eyebrow">
              Newest handoff · {handoff.agent ? fromLabel(handoff.agent) : 'agent'}
            </span>
            <HandoffView h={handoff.handoff} />
          </div>
        ) : null}
        {walk?.walkthrough ? (
          <Details label={`Reviewer’s walkthrough · ${walk.walkthrough.length} group${walk.walkthrough.length === 1 ? '' : 's'}`} openLabel="Hide the walkthrough">
            <Walkthrough groups={walk.walkthrough} />
          </Details>
        ) : null}
        {evidence.length ? (
          <button type="button" className="link small" onClick={() => ui.setTaskTab('evidence')}>
            All {evidence.length} evidence items
          </button>
        ) : detail ? (
          <p className="note">Agents attach plans, commands, responses, reviews and handoffs here as they work.</p>
        ) : null}
      </Stage>

      <Stage n={4} title="Validation" state={!rows.length ? 'todo' : s.fail ? 'block' : s.untested ? 'now' : 'done'} summary={rows.length ? <span className={cls(s.fail || s.untested ? 'block-text' : '')}><ValidationStrip rows={rows} /> {summaryText(s)}</span> : 'no contract'}>
        <ValidationGrid rows={rows} taskKey={task.key} now={now} />
      </Stage>

      <Stage n={5} title="Ship" state={shipState} summary={latestShip?.status === 'open' ? 'waiting on you' : task.prUrl ? 'PR open' : latestShip ? latestShip.answer ?? 'answered' : 'not yet'}>
        <RiskCheck task={task} initial={latestShip?.risk ?? null} />
        {task.receipts ? <ReceiptsLine receipts={task.receipts} now={now} /> : null}
        <dl className="kv">
          <dt>Branch</dt>
          <dd className="mono">
            {detail?.branchUrl ? (
              <a href={detail.branchUrl} target="_blank" rel="noopener noreferrer">
                {task.branch}
              </a>
            ) : (
              task.branch ?? '—'
            )}
          </dd>
          {task.prUrl ? (
            <>
              <dt>Pull request</dt>
              <dd>
                <a href={task.prUrl} target="_blank" rel="noopener noreferrer">
                  {task.prUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '')}
                </a>
              </dd>
            </>
          ) : null}
          {task.shepherd.map((p) => (
            <div key={p.label} className="kv-pair">
              <dt>{p.label}</dt>
              <dd>{p.value}</dd>
            </div>
          ))}
        </dl>
        {ships.filter((c) => c.status !== 'open').length ? (
          <div className="resolved-list">
            {ships
              .filter((c) => c.status !== 'open')
              .map((c) => (
                <ResolvedCard key={c.id} item={c} />
              ))}
          </div>
        ) : null}
      </Stage>

      <Stage n={6} title="QA" state={qaState} summary={latestQa?.verdict ? `${latestQa.verdict}${latestQa.round ? ` · round ${latestQa.round}` : ''}` : qaAgent ? qaAgent.status : 'after deploy'}>
        {latestQa && latestQa.status !== 'open' ? (
          <div className="qa-summary">
            <ResolvedCard item={latestQa} />
            {latestQa.cases.length ? (
              <p className="faint">
                {latestQa.cases.filter((c) => c.verdict === 'pass' || c.verdict === 'flaky').length}/{latestQa.cases.length} cases passed
                {latestQa.flakeRate != null ? ` · flake rate ${Math.round(latestQa.flakeRate * 100)}%` : ''}
              </p>
            ) : null}
          </div>
        ) : !latestQa ? (
          <p className="note">{task.status === 'qa' ? 'Waiting for the deploy; the QA agent tests the contract in a browser and posts a verdict card.' : 'Once the PR merges and deploys, the QA agent tests each assertion and posts a verdict here.'}</p>
        ) : null}
      </Stage>

      {others.length ? (
        <Details label={`Other cards · ${others.length}`} openLabel="Hide other cards">
          <div className="resolved-list">
            {others.map((c) => (
              <ResolvedCard key={c.id} item={c} />
            ))}
          </div>
        </Details>
      ) : null}
      <Details label="Workspace" openLabel="Hide the workspace">
        <OpenIn task={task} editor={crew.config.editor} terminal={crew.config.terminal} />
        <dl className="kv">
          <dt>Repo</dt>
          <dd className="mono">{task.repo || '—'}</dd>
          <dt>Worktree</dt>
          <dd className="mono">{task.worktree ?? '—'}</dd>
          <dt>Session</dt>
          <dd className="mono">{task.sessionId ?? '—'}</dd>
          <dt>Card kinds</dt>
          <dd>{[...new Set(cards.map((c) => cardVariant(c)))].join(', ') || '—'}</dd>
        </dl>
      </Details>
      {!task.contract.length && !task.agents.length && !evidence.length && !cards.length ? <Empty title="Nothing has happened on this task yet.">The {LEAD} picks it up on its next wake.</Empty> : null}
    </div>
  );
}
