#!/usr/bin/env node
// @ts-check
// PreToolUse: the crew's rules, enforced in crew sessions only (core/policy.mjs decides). Claude Code lets a call go
// ahead when this hook crashes, exits with an error, times out or prints nothing, so this entry imports the policy
// itself inside a try and answers for crew members whatever happens: if the policy can't run, a crew member's call asks
// (or, when the captain chose promptMode "deny", is denied), and only a session crew.json plainly says isn't crew passes.
// The fallback uses nothing but node, since a broken core module may be what failed. The policy runs in a worker thread
// so a watchdog can still answer (refuse) when it is too slow: past the hook's timeout the call would go ahead.
import { readFileSync, realpathSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** @returns {unknown} */
function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

/** @param {{ decision: string | null, reason: string } | null} out @returns {never} */
function emit(out) {
  if (out?.decision) {
    const text = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: out.decision, permissionDecisionReason: out.reason } });
    for (let tries = 0; tries < 50; tries++) {
      try {
        writeSync(1, text);
        break;
      } catch (e) {
        if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EAGAIN') break;
      }
    }
  }
  process.exit(0);
}

/**
 * Whether the calling session is crew, from crew.json alone: 'member', 'none', or 'unknown' when the file can't be read.
 * @param {unknown} raw
 */
function crewOf(raw) {
  const home = process.env.KEELCREW_HOME ?? join(homedir(), '.keelcrew');
  /** @type {any} */
  let reg;
  try {
    reg = JSON.parse(readFileSync(join(home, 'crew.json'), 'utf8'));
  } catch (e) {
    return { crew: /** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT' ? 'none' : 'unknown', home };
  }
  if (!isObject(reg) || (reg.sessions !== undefined && !isObject(reg.sessions)) || (reg.dirs !== undefined && !isObject(reg.dirs))) return { crew: 'unknown', home };
  const input = isObject(raw) ? raw : {};
  const sid = typeof input.session_id === 'string' ? input.session_id : '';
  if (sid && isObject(reg.sessions?.[sid])) return { crew: 'member', home };
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  /** @param {string} p */
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  /** @param {string} root @param {string} p */
  const inside = (root, p) => {
    const rel = relative(root, resolve(root, p));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  for (const [dir, m] of Object.entries(reg.dirs ?? {})) {
    if (!isObject(m) || (m.role !== 'engineer' && m.role !== 'agent')) continue;
    if (inside(dir, cwd) || inside(real(dir), real(cwd))) return { crew: 'member', home };
  }
  return { crew: 'none', home };
}

/** The answer when the policy itself failed. @param {unknown} raw @param {unknown} err */
function fallback(raw, err) {
  const { crew, home } = crewOf(raw);
  if (crew === 'none') return null;
  let mode = 'ask';
  if (crew === 'member') {
    try {
      const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
      mode = isObject(config) && config.promptMode === 'ask' ? 'ask' : 'deny';
    } catch {
      mode = 'ask';
    }
  }
  const why = String(/** @type {Error} */ (err)?.message ?? err).split('\n')[0].slice(0, 200);
  const next = mode === 'deny' ? 'Tell the Mate (or the captain) the crew policy is failing, and end your turn.' : 'Approve only if you meant to.';
  try {
    process.stderr.write(`keelcrew policy: ${why}\n`);
  } catch {
    /* nothing more to do */
  }
  return { decision: mode, reason: `Crew policy: the policy check failed (${why}), so this ${mode === 'deny' ? 'is refused' : 'asks first'}. Run \`keelctl doctor\`. ${next}` };
}

if (!isMainThread) {
  const { policyDecision } = await import('../core/policy.mjs');
  parentPort?.postMessage(policyDecision(workerData));
} else {
  const raw = readInput();
  process.on('uncaughtException', (e) => emit(fallback(raw, e)));
  process.on('unhandledRejection', (e) => emit(fallback(raw, e)));
  // Well inside the 10s timeout in hooks.json (the git checks give up after 1.5s each).
  // Never past 8 s: Claude Code's own 10 s hook timeout lets the call through.
  const limit = Math.min(Number(process.env.KEELCREW_POLICY_WATCHDOG_MS) || 8000, 8000);
  setTimeout(() => {
    const slow = crewOf(raw).crew === 'none' ? null : { decision: 'deny', reason: 'Crew policy: the policy check took too long, so this is refused; split the command up.' };
    emit(slow);
  }, limit);
  try {
    const worker = new Worker(new URL(import.meta.url), { workerData: raw });
    worker.on('message', (out) => emit(out));
    worker.on('error', (e) => emit(fallback(raw, e)));
    worker.on('exit', () => emit(fallback(raw, new Error('the policy stopped without an answer'))));
  } catch (e) {
    emit(fallback(raw, e));
  }
}
