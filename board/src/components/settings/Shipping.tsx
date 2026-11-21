/** Settings → Shipping: who pushes and opens PRs, how hard engineers review their own work, and what happens on merge. */
import { LEAD, REVIEW_LEVELS } from '../../labels';
import type { CrewConfig } from '../../types';
import { Switch } from '../common';
import { Row, Section, type SetConfig } from './parts';

/** `/code-review`'s arguments as the page shows them: a level, whether it fixes, and anything else kept as it is. */
export function reviewOf(args: string): { level: string; fix: boolean; rest: string[] } {
  const t = args.trim().split(/\s+/).filter(Boolean);
  const level = t.find((x) => REVIEW_LEVELS.some(([l]) => l === x)) ?? '';
  return { level, fix: t.includes('--fix'), rest: t.filter((x) => x !== level && x !== '--fix') };
}

const reviewArgs = (r: { level: string; fix: boolean; rest: string[] }): string => [r.level, ...r.rest.filter((x) => x !== '--comment'), ...(r.fix ? ['--fix'] : [])].filter(Boolean).join(' ');

export function ShippingSection({ draft, set, errors, canWrite }: { draft: CrewConfig; set: SetConfig; errors: Record<string, string>; canWrite: boolean }) {
  const review = reviewOf(draft.codeReview.args);
  const setReview = (p: Partial<typeof review>) => set((c) => void (c.codeReview.args = reviewArgs({ ...review, ...p })));
  return (
    <Section id="shipping" title="Shipping" lead="Merging is always yours.">
      <fieldset className="set-fields" disabled={!canWrite}>
        <Row label="Engineers open their own PRs" hint="They push their branch and open or update the PR when the work is reviewed. Off: each waits for your OK under Sign-offs.">
          <Switch checked={(draft.shipMode ?? 'free') === 'free'} onChange={(v) => set((c) => void (c.shipMode = v ? 'free' : 'card'))} label={<span className="sr-only">Engineers open their own PRs</span>} />
        </Row>
        <Row label="Self-review before a PR" hint="How hard engineers check their own changes with Claude Code’s code review. Deeper takes longer." error={errors['codeReview.args']}>
          <select value={review.level} aria-label="Self-review depth" aria-invalid={!!errors['codeReview.args']} onChange={(e) => setReview({ level: e.target.value })}>
            {review.level ? null : <option value="">Choose a depth</option>}
            {REVIEW_LEVELS.map(([l, label]) => (
              <option key={l} value={l}>
                {label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Fix what the review finds" hint="Off: findings are reported and the engineer decides.">
          <Switch checked={review.fix} onChange={(v) => setReview({ fix: v })} label={<span className="sr-only">Fix what the review finds</span>} />
        </Row>
        <Row label="Move a task when its PR merges" hint="To done when it’s low risk, else to QA. On the board only, never in Jira.">
          <Switch checked={draft.merges.autoStatus} onChange={(v) => set((c) => void (c.merges = { ...c.merges, autoStatus: v }))} label={<span className="sr-only">Move a task when its PR merges</span>} />
        </Row>
        <Row label="Approve from your phone" hint={`When the board can’t reach your Mac, your answers on ship and post cards wait for it: the ${LEAD} carries them out within a minute, with the same checks. Diffs and transcripts stay on the Mac.`}>
          <Switch checked={draft.phoneApprovals} onChange={(v) => set((c) => void (c.phoneApprovals = v))} label={<span className="sr-only">Approve from your phone</span>} />
        </Row>
      </fieldset>
    </Section>
  );
}
