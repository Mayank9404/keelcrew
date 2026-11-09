#!/usr/bin/env node
// @ts-check
// PostToolUse on AskUserQuestion: when a crew session's ship question ("Ship" header) gets an answer, record it as the
// approval the policy checks, pinned to the worktree's current commit and lasting as long as its risk tier allows (core
// writeGrant assesses it). The answer comes from the person through the app. Hooks run under a 10 s timeout, so the git
// calls and the lock wait here are capped; when they run out, nothing is recorded and the policy refuses the push.
import { memberFor, readConfig } from '../core/crew.mjs';
import { readInput } from '../core/fsx.mjs';
import { LOCK_BUDGET_MS, RISK_BUDGET_MS, clearGrant, headOf, writeGrant } from '../core/grants.mjs';
import { loadRules } from '../core/rules.mjs';

const HEAD_BUDGET_MS = 1500;

/**
 * The label picked for a question: from a structured `answers` map, or the "question"="answer" text form.
 * @param {unknown} response @param {string} question
 * @returns {string | null}
 */
function answerOf(response, question) {
  const seen = new Set();
  /** @param {any} o @returns {string | null} */
  const walk = (o) => {
    if (!o || typeof o !== 'object' || seen.has(o)) return null;
    seen.add(o);
    if (o.answers && typeof o.answers === 'object' && !Array.isArray(o.answers) && typeof o.answers[question] === 'string') return o.answers[question];
    for (const v of Object.values(o)) {
      const hit = walk(v);
      if (hit) return hit;
    }
    return null;
  };
  const structured = walk(response);
  if (structured) return structured;
  const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');
  const esc = question.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`"${esc}"\\s*=\\s*"([^"]+)"`).exec(text)?.[1] ?? null;
}

/** @param {Record<string, any>} input */
function record(input) {
  const member = memberFor(input.cwd || process.cwd(), input.session_id);
  if (!member) return;
  const config = readConfig();
  const rules = loadRules(config.pack);
  const questions = Array.isArray(input.tool_input?.questions) ? input.tool_input.questions : [];
  const ship = questions.find((/** @type {any} */ q) => rules.ship.questionHeader.test(String(q?.header ?? '')));
  if (!ship) return;
  const answer = answerOf(input.tool_response, String(ship.question ?? ''));
  // The choice itself, or with the option's note (`Open PR (recommended)`); a free-text answer that only starts with one grants nothing.
  const said = answer?.trim() ?? '';
  const choice = rules.ship.choices.find((c) => said === c || (said.startsWith(`${c} (`) && said.endsWith(')')));
  if (!choice) {
    clearGrant(member.dir, { lockTimeoutMs: LOCK_BUDGET_MS });
    return;
  }
  // A choice that allows nothing ("Not yet") clears the approval inside writeGrant.
  writeGrant({
    key: member.key ?? null,
    dir: member.dir,
    choice,
    via: 'session',
    head: headOf(member.dir, HEAD_BUDGET_MS),
    packName: config.pack,
    lockTimeoutMs: LOCK_BUDGET_MS,
    gitBudgetMs: RISK_BUDGET_MS,
  });
}

try {
  record(readInput());
} catch (e) {
  // Without a record the policy simply asks again, so a damaged crew file costs a prompt, never an unapproved push.
  process.stderr.write(`keelcrew grant: ${/** @type {Error} */ (e).message}\n`);
}
process.exit(0);
