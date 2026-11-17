/** Small task pieces shared by Sign-offs and Underway: the phase steps, a state pill, spend, staffing. */
import { budgetLevel, ticketSpend, usd } from '../../lib/costs';
import { PHASES, phaseIndex, type TaskView } from '../../lib/derive';
import type { CrewState, Task } from '../../types';
import { Pill, type Tone } from '../common';

const TONE_OF: Record<string, Tone> = { '--work': 'work', '--you': 'you', '--block': 'block', '--ok': 'ok', '--qa': 'qa', '--muted': 'muted', '--warn': 'warn', '--agent': 'agent' };

/** A task view's color token as a tone. */
export const viewTone = (v: TaskView): Tone => TONE_OF[v.color] ?? 'neutral';

/** Plan · Build · Verify · Review · Ship · QA as six ticks, the current one marked. */
export function PhaseSteps({ task }: { task: Task }) {
  const done = task.status === 'done';
  const i = done ? PHASES.length : task.status === 'qa' ? 5 : phaseIndex(task.phase);
  return (
    <span className="steps" role="img" aria-label={done ? 'Done' : `Phase: ${PHASES[Math.min(i, PHASES.length - 1)]}`} title={done ? 'Done' : PHASES[Math.min(i, PHASES.length - 1)]}>
      {PHASES.map((p, n) => (
        <i key={p} className={n < i ? 'past' : n === i ? 'now' : ''} />
      ))}
    </span>
  );
}

export function StatePill({ v }: { v: TaskView }) {
  const t = viewTone(v);
  return (
    <Pill tone={t} solid={t === 'you' || t === 'block'}>
      {v.label}
    </Pill>
  );
}

/** The task's spend, toned by its budget. */
export function Spend({ crew, task }: { crew: CrewState; task: Task }) {
  const spend = ticketSpend(crew.costs, task.key, task.costUsd);
  if (!spend) return null;
  const b = budgetLevel(spend, crew.config.budgets.perTicketUsd);
  return (
    <span className={`spend lvl-${b.level}`} title={b.share != null ? `${Math.round(b.share * 100)}% of the per-ticket budget` : 'Spend so far'}>
      {usd(spend)}
    </span>
  );
}

/** Who works the task (an engineer, or a contractor), whether the Mate started it by itself, and its goal. */
export function StaffBits({ crew, task }: { crew: CrewState; task: Task }) {
  const name = task.contractor ? 'contractor' : task.sessionId ? 'engineer' : null;
  const goal = task.goal ? ([...(crew.config.org.goals ?? []), ...(crew.org?.goals ?? [])].find((g) => g.id === task.goal)?.title ?? task.goal) : null;
  return (
    <>
      {name ? <span className="staff">{name}</span> : null}
      {task.autoStarted ? <span className="tag" title="The Mate started this suggestion by itself">auto-started</span> : null}
      {goal ? <span className="tag ok" title="Goal">{goal}</span> : null}
    </>
  );
}

/** The spend alarm's flag on a ticket: soft is a warning, hard paused its session. */
export function SpendFlag({ crew, task }: { crew: CrewState; task: Task }) {
  const f = crew.spend?.flags[task.key];
  if (!f) return null;
  const title = `Spent ${usd(f.spendUsd)}; soft line ${usd(f.softUsd)}, hard line ${usd(f.hardUsd)}`;
  return (
    <span className={f.level === 'hard' ? 'tag block' : 'tag warn'} title={title}>
      {f.level === 'hard' ? 'paused: spend' : 'spend alarm'}
    </span>
  );
}
