// @ts-check
// The crew's memory: lessons about how the captain works, kept in HOME/memory (a git repo) as an append-only lessons.jsonl,
// and the standing orders compiled from it into playbook.md, which crew sessions read when they join. Every change is one commit.
// A lesson starts as a candidate unless the captain said it; the Mate's promote, on the captain's OK, makes it active. Only active and pinned lessons reach the standing orders. Lessons are guidance, never permission.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonLoose, withLock, writeJsonAtomic } from './fsx.mjs';
import { paths } from './paths.mjs';
import { loadRules } from './rules.mjs';

export const LESSON_TYPES = ['preference', 'style', 'decision', 'correction', 'process', 'repo-fact'];
export const EVIDENCE_SOURCES = ['chat', 'card', 'pr-review', 'edit', 'commit', 'owner'];
export const LESSON_STATUSES = ['candidate', 'active', 'pinned', 'retired'];
/** Words a lesson type must never be: approvals come from the launch card and the captain's decisions, never from memory. */
const AUTHORITY = /\b(permission|permit|authori[sz]|grant|approv|allow|trust|access|consent)/i;
if (LESSON_TYPES.some((t) => AUTHORITY.test(t))) throw new Error('A lesson type must never mean a permission.');
export const PLAYBOOK_MAX_BYTES = 12 * 1024;
export const PLAYBOOK_MIN_CONFIDENCE = 0.5;
const DEFAULT_CONFIDENCE = 0.7;
const MAX_TEXT = 1000;
const MAX_EVIDENCE = 50;
/** @type {Record<string, string>} */
const HEADINGS = { preference: 'Preferences', style: 'Style', decision: 'Decisions', correction: 'Corrections', process: 'Process', 'repo-fact': 'Repo facts' };
const INTRO = 'What the crew has learned about how the captain works. Follow it unless the captain says otherwise; change it with `keelctl memory`.';
const NOT_AUTHORITY = "Lessons are guidance, never permission: approvals come only from the launch card and the captain's own decisions.";
const EMPTY_PLAYBOOK = '# Crew standing orders\n\nNo lessons yet.\n';

/**
 * @typedef {{ repo?: string, agent?: string, area?: string, task?: string }} Scope
 * @typedef {{ source: string, ref: string, quote?: string }} Evidence
 * @typedef {'candidate' | 'active' | 'pinned' | 'retired'} LessonStatus
 * @typedef {{
 *   id: string, at: number, type: string, key: string, text: string, scope: Scope, evidence: Evidence[],
 *   confidence: number, status: LessonStatus, supersedes?: string, seenAt?: number
 * }} Lesson
 * @typedef {Lesson & { seen: number, since: number, seenAt: number }} LessonView the newest line for a key, how often it
 *   was seen, since when, and when it was last seen (added or confirmed)
 */

export const lessonsPath = () => join(paths.memory(), 'lessons.jsonl');
export const playbookPath = () => join(paths.memory(), 'playbook.md');
/** The standing orders the captain last approved: `{at, lessons: {key: {type, text, scope}}}`. */
export const approvedPath = () => join(paths.memory(), 'approved.json');

/* ---------- git ---------- */

/** Runs git in the memory folder, isolated from any repo the caller is in and from the user's hooks and signing. @param {string[]} args */
function git(args) {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) delete env[k];
  const config = ['user.name=Keelcrew', 'user.email=keelcrew@localhost', 'commit.gpgsign=false', 'core.hooksPath=/dev/null', 'init.defaultBranch=main'];
  return execFileSync('git', [...config.flatMap((c) => ['-c', c]), ...args], {
    cwd: paths.memory(),
    env,
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function ensureRepo() {
  mkdirSync(paths.memory(), { recursive: true });
  if (!existsSync(join(paths.memory(), '.git'))) git(['init', '-q']);
}

/** Commits whatever changed in the memory folder; does nothing when nothing did. @param {string} message */
function commit(message) {
  // A git killed at its timeout leaves index.lock behind; one this old is no live git's (callers hold the memory lock).
  const indexLock = join(paths.memory(), '.git', 'index.lock');
  try {
    if (Date.now() - statSync(indexLock).mtimeMs > 10 * 60_000) rmSync(indexLock, { force: true });
  } catch {
    /* none */
  }
  git(['add', '-A']);
  try {
    git(['diff', '--cached', '--quiet']);
    return;
  } catch {
    /* exit 1: there is something to commit */
  }
  git(['commit', '-q', '-m', message]);
}

/* ---------- reading ---------- */

/** @param {unknown} v */
const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** Every line of lessons.jsonl, in order. Torn or damaged lines are counted and skipped. */
function readHistory() {
  let text = '';
  try {
    text = readFileSync(lessonsPath(), 'utf8');
  } catch {
    return { lines: /** @type {Lesson[]} */ ([]), damaged: 0 };
  }
  /** @type {Lesson[]} */
  const lines = [];
  let damaged = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const l = JSON.parse(raw);
      if (!l || typeof l.key !== 'string' || !LESSON_TYPES.includes(l.type)) throw new Error('not a lesson');
      lines.push({
        ...l,
        at: Number(l.at) || 0,
        scope: l.scope && typeof l.scope === 'object' ? l.scope : {},
        evidence: Array.isArray(l.evidence) ? l.evidence : [],
        confidence: typeof l.confidence === 'number' ? l.confidence : DEFAULT_CONFIDENCE,
        status: LESSON_STATUSES.includes(l.status) ? l.status : 'active',
      });
    } catch {
      damaged++;
    }
  }
  return { lines, damaged };
}

/** The newest line per key. `since` restarts when a forgotten key is learned again. @param {Lesson[]} lines */
function fold(lines) {
  /** @type {Map<string, LessonView>} */
  const byKey = new Map();
  for (const l of lines) {
    const prev = byKey.get(l.key);
    const since = !prev || prev.status === 'retired' ? l.at : prev.since;
    byKey.set(l.key, { ...l, seen: Math.max(1, l.evidence.length), since, seenAt: Number(l.seenAt) || l.at });
  }
  return byKey;
}

/** Pinned first, then the most trusted, the most seen, the oldest. @param {LessonView} a @param {LessonView} b */
const byWeight = (a, b) =>
  Number(b.status === 'pinned') - Number(a.status === 'pinned') || b.confidence - a.confidence || b.seen - a.seen || a.since - b.since || a.key.localeCompare(b.key);

/** @param {LessonView} a @param {LessonView} b */
const byTypeThenWeight = (a, b) => LESSON_TYPES.indexOf(a.type) - LESSON_TYPES.indexOf(b.type) || byWeight(a, b);

/**
 * Whether a lesson applies where `q` describes. No scope applies everywhere; a repo or agent scope must match; an area
 * narrows only when the caller names one; a task's lessons (decisions about one ticket) go only to that task's session.
 * @param {Scope} s @param {Scope} q
 */
const appliesTo = (s, q) =>
  (!s.repo || s.repo === q.repo) && (!s.agent || s.agent === q.agent) && (!s.area || !q.area || s.area === q.area) && (!s.task || s.task.toUpperCase() === q.task?.toUpperCase());

/**
 * The lessons in force (newest per key), sorted by type then weight.
 * @param {{ scope?: Scope, includeRetired?: boolean }} [options]
 * @returns {LessonView[]}
 */
export function listLessons({ scope, includeRetired = false } = {}) {
  return [...fold(readHistory().lines).values()]
    .filter((l) => includeRetired || l.status !== 'retired')
    // A list shows a ticket's own lessons too, unless the scope names a ticket.
    .filter((l) => !scope || appliesTo(l.scope, { task: l.scope.task, ...scope }))
    .sort(byTypeThenWeight);
}

/** For `keelctl doctor` and `keelctl status`. */
export function memoryStatus() {
  const { lines, damaged } = readHistory();
  const all = [...fold(lines).values()];
  const count = (/** @type {string} */ s) => all.filter((l) => l.status === s).length;
  return { repo: existsSync(join(paths.memory(), '.git')), lessons: all.length - count('retired'), candidates: count('candidate'), retired: count('retired'), damaged };
}

/* ---------- the standing orders ---------- */

/** @param {Scope} s */
function scopeText(s) {
  const parts = [s.task && `task ${s.task}`, s.repo && `repo ${s.repo}`, s.agent && `agent ${s.agent}`, s.area && `area ${s.area}`].filter(Boolean);
  return parts.length ? parts.join(', ') : 'everywhere';
}

/** @param {number} ms */
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** @param {LessonView[]} kept @param {string} intro @param {number} dropped */
function format(kept, intro, dropped) {
  const out = ['# Crew standing orders', '', intro, ''];
  for (const type of LESSON_TYPES) {
    const group = kept.filter((l) => l.type === type).sort(byWeight);
    if (!group.length) continue;
    out.push(`## ${HEADINGS[type]}`, '', ...group.map((l) => `- ${oneLine(l.text)} (${scopeText(l.scope)}, seen ${l.seen}×, since ${day(l.since)})`), '');
  }
  if (dropped) out.push(`_${dropped} lower-confidence lesson${dropped === 1 ? '' : 's'} left out to keep this short._`, '');
  return out.join('\n');
}

/**
 * Markdown for the given lessons: active ones at or above the confidence floor plus every pinned one, grouped by type.
 * Over the size limit, the lowest-confidence lessons go first; pinned lessons always stay. Empty when nothing qualifies.
 * @param {LessonView[]} lessons @param {string} intro
 */
function render(lessons, intro) {
  const usable = lessons.filter((l) => l.status === 'pinned' || (l.status === 'active' && l.confidence >= PLAYBOOK_MIN_CONFIDENCE));
  if (!usable.length) return '';
  const droppable = usable.filter((l) => l.status !== 'pinned').sort((a, b) => -byWeight(a, b));
  /** @param {number} n */
  const build = (n) => {
    const drop = new Set(droppable.slice(0, n));
    return format(usable.filter((l) => !drop.has(l)), intro, n);
  };
  const fits = (/** @type {number} */ n) => Buffer.byteLength(build(n)) <= PLAYBOOK_MAX_BYTES;
  // The size shrinks as more lessons drop, so search for the fewest drops that fit.
  let lo = 0;
  let hi = droppable.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) hi = mid;
    else lo = mid + 1;
  }
  return build(lo);
}

function writePlaybook() {
  const md = render(listLessons(), `${INTRO} ${NOT_AUTHORITY}`) || EMPTY_PLAYBOOK;
  writeFileSync(playbookPath(), md);
  return md;
}

/**
 * Rebuilds the standing orders (playbook.md) from every lesson in force and commits them.
 * @returns {string} the markdown
 */
export function compilePlaybook() {
  return withLock(paths.memoryLock(), () => {
    ensureRepo();
    const md = writePlaybook();
    commit('compile standing orders');
    return md;
  });
}

/**
 * The standing orders for one crew session: everything for the Mate, else the lessons whose scope fits the repo, agent and task
 * (an engineer is agent "engineer"). Empty when no lesson applies.
 * @param {{ role: string, repo?: string, agent?: string, task?: string }} who
 * @returns {string}
 */
export function playbookFor({ role, repo, agent, task }) {
  if (role === 'lead' && !repo && !agent) return render(listLessons(), `${INTRO} ${NOT_AUTHORITY}`);
  const as = agent ?? (role === 'engineer' ? 'engineer' : undefined);
  const where = [as && `the ${as}`, repo && `in ${repo}`].filter(Boolean).join(' ');
  return render(listLessons({ scope: { repo, agent: as, task } }), `${INTRO.split('.')[0]}${where ? `, for ${where}` : ''}. ${NOT_AUTHORITY}`);
}

/* ---------- writing ---------- */

const newId = () => randomBytes(6).toString('hex');

/** @param {any} s @returns {Scope} */
function scopeOf(s) {
  /** @type {Scope} */
  const out = {};
  for (const k of /** @type {const} */ (['repo', 'agent', 'area', 'task'])) if (s && typeof s[k] === 'string' && s[k].trim()) out[k] = s[k].trim();
  return out;
}

/** @param {any} e @returns {Evidence} */
function evidenceOf(e) {
  if (!e || !EVIDENCE_SOURCES.includes(e.source)) throw new Error(`Evidence source must be one of: ${EVIDENCE_SOURCES.join(', ')}.`);
  return { source: e.source, ref: String(e.ref ?? ''), ...(e.quote ? { quote: String(e.quote).slice(0, 500) } : {}) };
}

/** Old evidence then new, without repeats, newest kept when there is too much. @param {Evidence[]} a @param {Evidence[]} b */
function mergeEvidence(a, b) {
  /** @type {Map<string, Evidence>} */
  const seen = new Map();
  for (const e of [...a, ...b]) seen.set(`${e.source}|${e.ref}|${e.quote ?? ''}`, e);
  return [...seen.values()].slice(-MAX_EVIDENCE);
}

/** Checks a lesson from a caller and fills its defaults. Throws with a plain message. @param {any} l */
function validate(l) {
  if (!l || typeof l !== 'object') throw new Error('A lesson must be an object.');
  if (!LESSON_TYPES.includes(l.type)) {
    if (AUTHORITY.test(String(l.type))) throw new Error("Lessons can't grant permission: approvals come only from the launch card and the captain's own decisions.");
    throw new Error(`Lesson type must be one of: ${LESSON_TYPES.join(', ')}.`);
  }
  const key = oneLine(l.key);
  if (!key || key.length > 200) throw new Error('A lesson needs a key of at most 200 characters.');
  const text = oneLine(l.text);
  if (!text || text.length > MAX_TEXT) throw new Error(`A lesson needs text of at most ${MAX_TEXT} characters.`);
  const confidence = l.confidence === undefined ? DEFAULT_CONFIDENCE : Number(l.confidence);
  if (!(confidence >= 0 && confidence <= 1)) throw new Error('Confidence must be a number from 0 to 1.');
  if (l.status !== undefined && l.status !== 'candidate') {
    throw new Error("A lesson's status comes from its evidence; use keelctl memory promote, pin or forget to change it.");
  }
  if (l.evidence !== undefined && !Array.isArray(l.evidence)) throw new Error('Evidence must be a list.');
  return { ...l, key, text, confidence, scope: scopeOf(l.scope), evidence: (l.evidence ?? []).map(evidenceOf) };
}

/**
 * Whether evidence makes a lesson active by itself: only when the captain said it. Sightings any crew session can add
 * don't, so no session makes its own lesson a standing order. @param {Evidence[]} evidence
 */
const earnsActive = (evidence) => evidence.some((e) => e.source === 'owner');

/** Appends a line, writes the standing orders and commits, under the memory lock. @param {Lesson} rec @param {string} message */
function save(rec, message) {
  ensureRepo();
  appendFileSync(lessonsPath(), `${JSON.stringify(rec)}\n`);
  writePlaybook();
  commit(message);
  return rec;
}

/**
 * Adds a lesson, or a new version of one with the same key: its evidence carries over and it supersedes the old line. A
 * new lesson is a candidate until the captain said it or the Mate promotes it. An active or pinned
 * lesson only gains the new evidence: its text, type, scope and confidence stay (the Mate changes text with `keelctl memory
 * edit`), so adding a sighting can never rewrite a rule in force. The result says `kept: true` when that happened.
 * Throws on an invalid lesson.
 * @param {Partial<Lesson> & { type: string, key: string, text: string }} input
 * @returns {Lesson & { kept?: boolean }}
 */
export function addLesson(input) {
  const l = validate(input);
  return withLock(paths.memoryLock(), () => {
    const prev = fold(readHistory().lines).get(l.key);
    const live = prev && prev.status !== 'retired' ? prev : null;
    const evidence = mergeEvidence(live?.evidence ?? [], l.evidence);
    const now = typeof l.at === 'number' ? l.at : Date.now();
    /** @type {LessonStatus} */
    let status = 'candidate';
    if (live?.status === 'pinned' || live?.status === 'active') status = live.status;
    else if (l.status !== 'candidate' && earnsActive(evidence)) status = 'active';
    // A lesson in force keeps what it says; a new sighting only adds evidence.
    const inForce = live?.status === 'pinned' || live?.status === 'active' ? live : null;
    /** @type {Lesson} */
    const rec = {
      id: typeof l.id === 'string' && l.id ? l.id : newId(),
      at: now,
      type: inForce ? inForce.type : l.type,
      key: l.key,
      text: inForce ? inForce.text : l.text,
      scope: inForce ? inForce.scope : l.scope,
      evidence,
      confidence: inForce ? inForce.confidence : l.confidence,
      status,
      seenAt: now,
    };
    const supersedes = l.supersedes ?? live?.id;
    if (supersedes && supersedes !== rec.id) rec.supersedes = supersedes;
    const promoted = live?.status === 'candidate' && status === 'active' ? ' (now active)' : '';
    const kept = !!inForce && (inForce.text !== l.text || inForce.type !== l.type || JSON.stringify(inForce.scope) !== JSON.stringify(l.scope) || inForce.confidence !== l.confidence);
    const saved = save(rec, `${live ? (inForce ? 'evidence for' : 'update') : 'add'} ${l.key}${promoted}`);
    return kept ? { ...saved, kept: true } : saved;
  });
}

/** @param {string} key @param {LessonStatus} status @param {string} verb @returns {Lesson | null} */
function setStatus(key, status, verb) {
  return withLock(paths.memoryLock(), () => {
    const cur = fold(readHistory().lines).get(oneLine(key));
    if (!cur || cur.status === 'retired') return null;
    const { seen, since, ...rec } = cur;
    if (rec.status === status) return rec;
    return save({ ...rec, at: Date.now(), status }, `${verb} ${rec.key}`);
  });
}

/**
 * Rewrites a lesson's text as a new version of the same key, keeping its type, scope, evidence, confidence and status.
 * Null when no lesson in force has that key. Throws on empty or overlong text.
 * @param {string} key @param {string} text
 * @returns {Lesson | null}
 */
export function editLesson(key, text) {
  const next = oneLine(text);
  if (!next || next.length > MAX_TEXT) throw new Error(`A lesson needs text of at most ${MAX_TEXT} characters.`);
  return withLock(paths.memoryLock(), () => {
    const cur = fold(readHistory().lines).get(oneLine(key));
    if (!cur || cur.status === 'retired') return null;
    const { seen, since, supersedes, ...rec } = cur;
    return save({ ...rec, id: newId(), at: Date.now(), text: next, supersedes: cur.id }, `edit ${rec.key}`);
  });
}

/**
 * Changes where a lesson applies, as a new version of the same key; '' clears a part (`task`, `repo`, `agent`, `area`),
 * a part left out stays. Null when no lesson in force has that key; a pinned lesson's scope is the captain's and stays.
 * @param {string} key @param {Scope} changes
 * @returns {Lesson | null}
 */
export function scopeLesson(key, changes) {
  return withLock(paths.memoryLock(), () => {
    const cur = fold(readHistory().lines).get(oneLine(key));
    if (!cur || cur.status === 'retired') return null;
    if (cur.status === 'pinned') throw new Error(`"${cur.key}" is pinned: its scope is the captain's.`);
    const { seen, since, supersedes, ...rec } = cur;
    const scope = scopeOf({ ...cur.scope, ...changes });
    return save({ ...rec, id: newId(), at: Date.now(), scope, supersedes: cur.id }, `scope ${rec.key}`);
  });
}

/** Retires a lesson (the line stays in history). Null when no lesson in force has that key. @param {string} key */
export const forgetLesson = (key) => setStatus(key, 'retired', 'forget');

/** Pins a lesson: always in the standing orders, first in its group. Null when no lesson in force has that key. @param {string} key */
export const pinLesson = (key) => setStatus(key, 'pinned', 'pin');

/**
 * Makes a candidate active (the captain approved it), and counts as seeing it. An active or pinned lesson stays as it is.
 * Null when no lesson in force has that key.
 * @param {string} key
 * @returns {Lesson | null}
 */
export function promoteLesson(key) {
  return withLock(paths.memoryLock(), () => {
    const cur = fold(readHistory().lines).get(oneLine(key));
    if (!cur || cur.status === 'retired') return null;
    const { seen, since, ...rec } = cur;
    if (rec.status !== 'candidate') return rec;
    const now = Date.now();
    return save({ ...rec, at: now, seenAt: now, status: 'active' }, `promote ${rec.key}`);
  });
}

/* ---------- upkeep: stale lessons ---------- */

/**
 * Lessons nobody has seen for a while: candidates past the rules' retire age, and active lessons past the stale age.
 * Pinned lessons are the captain's and never go stale.
 * @param {{ now?: number }} [options]
 */
export function staleLessons({ now = Date.now() } = {}) {
  const { candidateRetireMs, activeStaleMs } = loadRules(undefined).memory;
  const all = listLessons();
  return {
    candidates: all.filter((l) => l.status === 'candidate' && now - l.seenAt > candidateRetireMs),
    active: all.filter((l) => l.status === 'active' && now - l.seenAt > activeStaleMs),
  };
}

/**
 * Retires the candidates nobody has seen within the rules' retire age, in one commit.
 * @param {{ now?: number }} [options]
 * @returns {string[]} the keys retired
 */
export function retireStaleCandidates({ now = Date.now() } = {}) {
  const { candidateRetireMs } = loadRules(undefined).memory;
  return withLock(paths.memoryLock(), () => {
    const stale = [...fold(readHistory().lines).values()].filter((l) => l.status === 'candidate' && now - l.seenAt > candidateRetireMs);
    if (!stale.length) return [];
    ensureRepo();
    for (const { seen, since, ...rec } of stale) appendFileSync(lessonsPath(), `${JSON.stringify({ ...rec, at: now, status: 'retired' })}\n`);
    writePlaybook();
    commit(`retire ${stale.length} unseen candidate${stale.length === 1 ? '' : 's'}`);
    return stale.map((l) => l.key);
  });
}

/* ---------- the captain's approval of the standing orders ---------- */

/**
 * @typedef {{ type: string, text: string, scope: Scope }} PlaybookEntry
 * @typedef {{ since: number | null, added: (PlaybookEntry & { key: string })[], changed: { key: string, before: PlaybookEntry, after: PlaybookEntry }[], removed: (PlaybookEntry & { key: string })[], markdown: string }} PlaybookDiff
 */

/** The lessons the standing orders can hold (active above the confidence floor, and pinned), by key. @returns {Record<string, PlaybookEntry>} */
function playbookEntries() {
  /** @type {Record<string, PlaybookEntry>} */
  const out = {};
  for (const l of listLessons()) {
    if (l.status === 'pinned' || (l.status === 'active' && l.confidence >= PLAYBOOK_MIN_CONFIDENCE)) out[l.key] = { type: l.type, text: l.text, scope: l.scope };
  }
  return out;
}

/** @param {PlaybookEntry} e */
const entryLine = (e) => `- ${e.text} (${e.type}, ${scopeText(e.scope)})`;

/**
 * What changed in the standing orders since the captain last approved them (everything, before the first approval), for the
 * learner's approval card.
 * @returns {PlaybookDiff}
 */
export function playbookDiff() {
  const approved = readJsonLoose(approvedPath(), null);
  /** @type {Record<string, PlaybookEntry>} */
  const before = approved && typeof approved.lessons === 'object' ? approved.lessons : {};
  const now = playbookEntries();
  const same = (/** @type {PlaybookEntry} */ a, /** @type {PlaybookEntry} */ b) => a.text === b.text && a.type === b.type && JSON.stringify(a.scope ?? {}) === JSON.stringify(b.scope ?? {});
  const added = Object.keys(now).filter((k) => !before[k]).sort().map((key) => ({ key, ...now[key] }));
  const removed = Object.keys(before).filter((k) => !now[k]).sort().map((key) => ({ key, ...before[key] }));
  const changed = Object.keys(now).filter((k) => before[k] && !same(before[k], now[k])).sort().map((key) => ({ key, before: before[key], after: now[key] }));
  const since = typeof approved?.at === 'number' ? approved.at : null;
  const head = `# Standing order changes since ${since ? day(since) : 'the start'}`;
  /** @type {string[]} */
  const out = [head, ''];
  if (!added.length && !changed.length && !removed.length) out.push('No changes.', '');
  if (added.length) out.push('## Added', '', ...added.map(entryLine), '');
  if (changed.length) out.push('## Changed', '', ...changed.flatMap((c) => [`- ${c.key}: was "${c.before.text}"`, `  now "${c.after.text}" (${c.after.type}, ${scopeText(c.after.scope)})`]), '');
  if (removed.length) out.push('## Removed', '', ...removed.map(entryLine), '');
  return { since, added, changed, removed, markdown: out.join('\n') };
}

/**
 * Records the standing orders as they stand as the version the captain approved, so the next diff starts from here.
 * @param {{ now?: number }} [options]
 * @returns {{ at: number, lessons: number }}
 */
export function approvePlaybook({ now = Date.now() } = {}) {
  return withLock(paths.memoryLock(), () => {
    ensureRepo();
    const lessons = playbookEntries();
    writeJsonAtomic(approvedPath(), { at: now, lessons });
    commit('approve standing orders');
    return { at: now, lessons: Object.keys(lessons).length };
  });
}

/** Creates the memory repo with an empty history and empty standing orders, if it isn't there yet. */
export function initMemory() {
  return withLock(paths.memoryLock(), () => {
    ensureRepo();
    if (!existsSync(lessonsPath())) writeFileSync(lessonsPath(), '');
    writePlaybook();
    commit('start crew memory');
  });
}
