// @ts-check
// How the crew command splits its arguments. The policy reads a crew command with the same function, so a flag in
// front of a subcommand can't make the two disagree about what runs.

export const BOOLEAN_FLAGS = new Set(['mechanical', 'fix', 'safe', 'json', 'all', 'restart', 'open']);

/**
 * Splits `--name value`, `--name=value` and boolean flags out of the arguments, keeping the rest in order.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {Record<string, string | boolean | undefined>} */
  const flags = {};
  /** @type {string[]} */
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') || a === '--') {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else if (BOOLEAN_FLAGS.has(a.slice(2))) flags[a.slice(2)] = true;
    else flags[a.slice(2)] = argv[++i];
  }
  return { flags, pos };
}

/** What members other than the Mate may run of each: the subcommand (the first word after the flags; none shows). */
export const MEMBER_READS = /** @type {Record<string, (string | undefined)[]>} */ ({
  org: [undefined, 'show', 'staff', 'model', 'proactive', 'owner'],
  spend: [undefined, 'show'],
});
/** Each Mate-only crew command, and its Mate-only subcommands ('*': all of them; with member reads, anything else). */
export const LEAD_ONLY_SUBS = /** @type {Record<string, string[]>} */ ({
  unregister: ['*'], setup: ['*'], grant: ['*'], helper: ['install', 'bundle'], unpause: ['*'], alerts: ['seen'],
  memory: ['forget', 'pin', 'promote', 'edit', 'scope', 'approve'], org: [], spend: ['check', 'continue'], doctor: [], pack: ['init'],
});

/** Whether a crew command (its name and the words after it) is one only the Mate runs. @param {string} command @param {string[]} rest */
export function mateOnly(command, rest) {
  const subs = LEAD_ONLY_SUBS[command];
  if (!subs) return false;
  const { flags, pos } = parseArgs(rest);
  if (MEMBER_READS[command]?.includes(pos[0])) return false;
  return subs.includes('*') || subs.includes(pos[0]) || !!MEMBER_READS[command] || (command === 'doctor' && !!flags.fix);
}
