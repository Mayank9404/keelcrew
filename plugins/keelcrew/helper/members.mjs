// @ts-check
// Who is in the crew on this Mac and how the Mac is set up: the registered folders with what the hooks last recorded about
// each, the repo a folder belongs to, and the active team pack.
import { agentOf } from '../core/costs.mjs';
import { crewDirs, readConfig } from '../core/crew.mjs';
import { readJsonLoose } from '../core/fsx.mjs';
import { expand, inside, paths } from '../core/paths.mjs';
import { loadPack } from '../core/rules.mjs';

/**
 * @typedef {{
 *   dir: string, role: string, key: string | null, agent?: string, at?: number, aliveAt: number | null,
 *   sessionId?: string, transcript?: string, busy?: boolean, activity?: string, lastTool?: string, lastText?: string, lastAt?: number
 * }} Member
 */

/** Which member a ticket key means when several sessions share it: the engineer first, then any other agent. */
const RANK = /** @type {Record<string, number>} */ ({ engineer: 0, agent: 1 });

/** The active team pack, or {} when none is set or it can't be read. For display and defaults only. @returns {Record<string, any>} */
export function packOf() {
  try {
    return loadPack(readConfig().pack);
  } catch {
    return {};
  }
}

/**
 * The configured repo a folder is in (its checkout or a `<checkout>-worktrees/` sibling), or null.
 * @param {string} dir
 * @returns {({ name: string, path: string } & Record<string, any>) | null}
 */
export function repoFor(dir) {
  for (const [name, r] of Object.entries(readConfig().repos ?? {})) {
    if (!r?.path) continue;
    const path = expand(r.path);
    if (inside(path, dir) || inside(`${path}-worktrees`, dir)) return { ...r, name, path };
  }
  return null;
}

/** When a mod last ran in the folder's session (epoch ms), or null. @param {string} dir */
function aliveAt(dir) {
  const v = readJsonLoose(paths.alive(dir), null);
  return typeof v === 'number' ? v : null;
}

/**
 * Every registered crew folder with the hooks' latest state for it. The registry is read strictly: a damaged crew.json is
 * an error the board shows (with "run keelctl doctor"), not an empty crew.
 * @returns {Member[]}
 */
export function members() {
  return crewDirs().map((m) => ({ ...m, aliveAt: aliveAt(m.dir) }));
}

/** @param {string | null | undefined} a @param {string} b */
const sameKey = (a, b) => (a ?? '-').toUpperCase() === (b || '-').toUpperCase();

/**
 * The crew member a board call names: "lead", or a ticket key (with `agent` to pick e.g. the QA session over the engineer).
 * @param {unknown} key
 * @param {string} [agent]
 * @returns {Member}
 */
export function findMember(key, agent) {
  const want = String(key ?? '').trim();
  const all = members();
  const found =
    want === 'lead'
      ? all.find((m) => m.role === 'lead')
      : all
          .filter((m) => m.role in RANK && sameKey(m.key, want) && (!agent || agentOf(m) === agent))
          .sort((a, b) => RANK[a.role] - RANK[b.role])[0];
  if (!found) throw new Error(`${want || 'That session'}${agent ? ` (${agent})` : ''} has no crew session on this Mac yet.`);
  return found;
}
