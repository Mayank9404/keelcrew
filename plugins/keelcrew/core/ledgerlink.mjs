// @ts-check
// What happens after a merge, traced back to the ticket that caused it. A bug: `git blame` on the base branch finds the
// commit behind the broken line, and its PR number (squash merges end their subject with "(#123)") or the first-parent
// merge that brought it in finds the ticket's record. A revert: a commit on the base whose body says "This reverts
// commit <sha>" of a crew ticket's commit or merge. Both only apply ledger events, and only within the rules' window.
import { execFileSync } from 'node:child_process';
import { readConfig } from './crew.mjs';
import { applyEvent, listRecords } from './ledger.mjs';
import { orgRules } from './org.mjs';
import { expand } from './paths.mjs';
import { baseBranchOf } from './risk.mjs';

const DAY = 86_400_000;
const GIT_MS = 15_000;
const PR_IN_SUBJECT = /\(#(\d+)\)\s*$|^Merge pull request #(\d+)/;

/** @param {string} dir @param {string[]} args */
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_MS }).trim();

/** @param {string} subject */
const prOf = (subject) => {
  const m = subject.match(PR_IN_SUBJECT);
  return m ? Number(m[1] ?? m[2]) : null;
};

/**
 * The ledger record a commit on the base branch belongs to: the commit itself (a crew commit or a merge), its PR number,
 * else the oldest first-parent merge after it on the base (the one that brought it in). Null for a commit whose PR isn't
 * a crew ticket's, and for one on the base's first-parent line (no merge brought it in).
 * @param {string} dir @param {string} base @param {string} sha @param {import('./ledger.mjs').LedgerRecord[]} records
 */
export function recordForCommit(dir, base, sha, records) {
  /** @param {string} s */
  const bySha = (s) => records.find((r) => r.kind === 'ticket' && (r.mergeSha === s || r.crewShas.includes(s))) ?? null;
  /** @param {number | null} n */
  const byPr = (n) => (n === null ? null : records.find((r) => r.kind === 'ticket' && (r.prNumber === n || r.prs.some((u) => u.endsWith(`/pull/${n}`)))) ?? null);
  const direct = bySha(sha);
  if (direct) return direct;
  const pr = prOf(git(dir, ['log', '-1', '--format=%s', sha]));
  if (pr !== null) return byPr(pr);
  // The oldest commit after it on the base's first-parent line is the merge that brought it in, unless the commit is on
  // that line itself (then that is its child).
  const after = git(dir, ['rev-list', '--first-parent', '--ancestry-path', '--parents', `${sha}..origin/${base}`]).split('\n').filter(Boolean);
  const [merge, firstParent, second] = (after[after.length - 1] ?? '').split(' ');
  if (!merge || !second || firstParent === sha) return null;
  return bySha(merge) ?? byPr(prOf(git(dir, ['log', '-1', '--format=%s', merge])));
}

/** A configured repo's checkout and base branch. @param {string} name */
export function repoOf(name) {
  const r = readConfig().repos?.[name];
  if (!r?.path) throw new Error(`No repo "${name}" in config.json`);
  const dir = expand(String(r.path));
  const base = baseBranchOf(dir, readConfig().pack);
  if (!base) throw new Error(`Can't tell ${name}'s base branch`);
  return { dir, base };
}

/**
 * Links a bug ticket to the crew ticket whose change the broken line came from. Returns the record's key, or null when
 * the line isn't a crew change; `ignored` when the merge is older than the rules' window.
 * @param {{ bug: string, repo: string, file: string, line: number, severity?: string | null, now?: number }} a
 */
export function linkBug({ bug, repo, file, line, severity = null, now = Date.now() }) {
  if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(bug)) throw new Error(`"${bug}" isn't a ticket key`);
  if (!Number.isInteger(line) || line < 1) throw new Error('--line must be a line number');
  const { dir, base } = repoOf(repo);
  const sha = git(dir, ['blame', '--porcelain', '-L', `${line},${line}`, `origin/${base}`, '--', file]).split(/\s/)[0];
  const r = recordForCommit(dir, base, sha, listRecords().records);
  if (!r) return { key: null, sha, ignored: null };
  const window = Number(orgRules().bugLinkWindowDays ?? 30) * DAY;
  const landed = r.mergedAt ?? r.closedAt;
  if (landed && now - landed > window) return { key: r.key, sha, ignored: `merged more than ${window / DAY} days ago` };
  applyEvent('bug', r.key, { id: `bug:${bug}`, ticket: bug, severity, at: now }, { now });
  return { key: r.key, sha, ignored: null };
}

/**
 * Records reverts of crew tickets' changes on each configured repo's base branch in the rules' window (from the local
 * checkout's origin/<base>; no fetch). Returns the keys that got one.
 * @param {{ now?: number }} [opts]
 */
export function scanReverts({ now = Date.now() } = {}) {
  const days = Number(orgRules().bugLinkWindowDays ?? 30);
  const records = listRecords().records;
  /** @type {string[]} */
  const hit = [];
  for (const name of Object.keys(readConfig().repos ?? {})) {
    let repo;
    try {
      repo = repoOf(name);
    } catch {
      continue;
    }
    let out = '';
    try {
      out = git(repo.dir, ['log', `origin/${repo.base}`, `--since=${days}.days`, '--format=%H%x1f%ct%x1f%s%x1f%b%x1e']);
    } catch {
      continue;
    }
    for (const entry of out.split('\x1e')) {
      const [sha, at, subject, body] = entry.trim().split('\x1f');
      if (!sha || !/^Revert "/.test(subject ?? '')) continue;
      const reverted = (body ?? '').match(/This reverts commit ([0-9a-f]{7,40})/)?.[1];
      if (!reverted) continue;
      let r = null;
      try {
        r = recordForCommit(repo.dir, repo.base, git(repo.dir, ['rev-parse', reverted]), records);
      } catch {
        continue;
      }
      // As for bugs: a revert counts only within the window after the ticket landed.
      const landed = r?.mergedAt ?? r?.closedAt;
      if (!r || (landed && Number(at) * 1000 - landed > days * DAY)) continue;
      if (applyEvent('revert', r.key, { id: `revert:${sha}`, sha, at: Number(at) * 1000 }, { now })) hit.push(r.key);
    }
  }
  return hit;
}
