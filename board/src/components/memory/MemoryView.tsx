/**
 * What the Mate has learned: lessons by status (candidates wait for your OK) and the standing orders it runs on. Changes
 * are requests the Mate carries out with `keelctl memory`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LEAD, fromLabel } from '../../labels';
import { api, errorText, quietApi, type MemoryAction } from '../../lib/api';
import { ago } from '../../lib/format';
import { toast } from '../../lib/toast';
import type { CrewState, Lesson, LessonStatus, MemoryList } from '../../types';
import { Details, Empty, Icon, PageHeader, Pill, Section, cls, useNow, type Tone } from '../common';
import { Markdown } from '../Markdown';

const STATUS: Record<LessonStatus, { label: string; tone: Tone; hint: string }> = {
  candidate: { label: 'Candidate', tone: 'warn', hint: 'Not in the standing orders until you approve it or a second independent signal backs it.' },
  active: { label: 'Active', tone: 'ok', hint: 'In the standing orders.' },
  pinned: { label: 'Pinned', tone: 'agent', hint: 'Always in the standing orders; it beats the Mate’s own judgment.' },
  retired: { label: 'Retired', tone: 'muted', hint: 'Forgotten.' },
};
const ORDER: LessonStatus[] = ['candidate', 'active', 'pinned', 'retired'];
const TYPE_LABEL: Record<string, string> = { preference: 'Preference', style: 'Style', decision: 'Decision', correction: 'Correction', process: 'Process', 'repo-fact': 'Repo fact' };

function blocked(crew: CrewState): string | null {
  if (!crew.access.canWrite) return 'The crew’s memory lives on the captain’s Mac, so only the captain can see it here.';
  if (crew.helper.status === 'missing') return 'The crew’s memory lives on your Mac. Open the Keelcrew board in the Claude app there, with the Keelcrew helper running.';
  return null;
}

function LessonRow({ l, pending, onAct }: { l: Lesson; pending: string | null; onAct: (action: MemoryAction, key: string, text?: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(l.text);
  const [busy, setBusy] = useState(false);
  const act = async (action: MemoryAction, t?: string) => {
    setBusy(true);
    const ok = await onAct(action, l.key, t);
    setBusy(false);
    if (ok) setEditing(false);
  };
  const scope = [l.scope.repo && `repo ${l.scope.repo}`, l.scope.agent && fromLabel(l.scope.agent), l.scope.area].filter(Boolean) as string[];
  return (
    <li className={cls('lesson', `ls-${l.status}`)}>
      <div className="lesson-h">
        <Pill tone={STATUS[l.status].tone} solid={l.status === 'candidate'}>
          {STATUS[l.status].label}
        </Pill>
        <span className="mono">{l.key}</span>
        <span className="faint">{TYPE_LABEL[l.type] ?? l.type}</span>
        {l.confidence != null ? <span className="faint num">{Math.round(l.confidence * 100)}%</span> : null}
        {scope.map((s) => (
          <span className="tag" key={s}>
            {s}
          </span>
        ))}
        <span className="grow" />
        {l.at ? <span className="faint small">{ago(l.at)}</span> : null}
      </div>
      {editing ? (
        <form
          className="answer-box"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() && text.trim() !== l.text) void act('edit', text.trim());
          }}
        >
          <textarea rows={2} value={text} autoFocus aria-label={`Edit ${l.key}`} onChange={(e) => setText(e.target.value)} />
          <div className="row-actions">
            <button type="submit" className="btn sm primary" disabled={busy || !text.trim() || text.trim() === l.text}>
              Send the edit
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p className="lesson-text">{l.text}</p>
      )}
      {l.evidence.length ? (
        <Details label={`Evidence · ${l.evidence.length}`} openLabel="Hide evidence">
          <ul className="evidence-list">
            {l.evidence.map((e, i) => (
              <li key={`${e.ref}${i}`}>
                <b>{e.source}</b> {/^https?:\/\//.test(e.ref) ? <a href={e.ref} target="_blank" rel="noopener noreferrer">{e.ref}</a> : <span className="mono">{e.ref}</span>}
                {e.quote ? <q>{e.quote}</q> : null}
              </li>
            ))}
          </ul>
        </Details>
      ) : null}
      {pending ? (
        <span className="note">Asked the {LEAD} to {pending} it.</span>
      ) : !editing && l.status !== 'retired' ? (
        <div className="row-actions">
          {l.status === 'candidate' ? (
            <button type="button" className="btn sm primary" disabled={busy} onClick={() => void act('promote')} title="Approve it: it enters the standing orders">
              <Icon name="check" />
              Approve
            </button>
          ) : null}
          {l.status === 'active' ? (
            <button type="button" className="btn sm ghost" disabled={busy} onClick={() => void act('pin')} title="Pinned lessons always stay in the standing orders">
              <Icon name="pin" />
              Pin
            </button>
          ) : null}
          <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setEditing(true)}>
            Edit
          </button>
          <button type="button" className="btn sm ghost danger" disabled={busy} onClick={() => void act('forget')}>
            Forget
          </button>
        </div>
      ) : null}
    </li>
  );
}

export function MemoryView({ crew }: { crew: CrewState }) {
  const why = blocked(crew);
  const now = useNow(60_000);
  const [memory, setMemory] = useState<MemoryList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<LessonStatus | 'all'>('all');
  const [tab, setTab] = useState<'lessons' | 'playbook'>('lessons');
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setMemory(await quietApi.memory());
      setError(null);
      setLoadedAt(Date.now());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!why) void load();
  }, [why, load]);
  const pending = useMemo(() => new Map(crew.requests.filter((r) => r.kind === 'memory' && r.key).map((r) => [r.key!, r.action ?? 'change'])), [crew.requests]);
  const act = async (action: MemoryAction, key: string, text?: string): Promise<boolean> => {
    try {
      await api.memoryAction(action, key, text);
      toast(`Asked the ${LEAD} to ${action === 'promote' ? 'approve' : action} “${key}”.`);
      return true;
    } catch {
      return false;
    }
  };
  const lessons = memory?.lessons ?? [];
  const counts = Object.fromEntries(ORDER.map((s) => [s, lessons.filter((l) => l.status === s).length])) as Record<LessonStatus, number>;
  const needle = q.trim().toLowerCase();
  const shown = lessons
    .filter((l) => (status === 'all' ? l.status !== 'retired' : l.status === status))
    .filter((l) => !needle || `${l.key} ${l.text} ${l.type}`.toLowerCase().includes(needle))
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || (b.at ?? 0) - (a.at ?? 0));
  return (
    <div className="view memory">
      <PageHeader
        title="Standing orders"
        status={
          memory ? (
            <>
              <span className={counts.candidate ? 'warn-text' : ''}>
                <b className="num">{counts.candidate}</b> candidate{counts.candidate === 1 ? '' : 's'} to review
              </span>
              <span>
                <b className="num">{counts.active + counts.pinned}</b> in the standing orders
              </span>
              {loadedAt ? <span className="faint">updated {ago(loadedAt, now)}</span> : null}
            </>
          ) : null
        }
        actions={
          why ? null : (
            <button type="button" className="btn ghost" disabled={loading} onClick={() => void load()}>
              <Icon name="refresh" />
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          )
        }
      />
      {why ? (
        <Empty title="Memory isn’t available here.">{why}</Empty>
      ) : (
        <Section
          title={tab === 'lessons' ? 'Lessons' : 'Standing orders'}
          count={tab === 'lessons' ? shown.length : undefined}
          actions={
            <div className="seg" role="group" aria-label="Memory view">
              <button type="button" aria-pressed={tab === 'lessons'} onClick={() => setTab('lessons')}>
                Lessons
              </button>
              <button type="button" aria-pressed={tab === 'playbook'} onClick={() => setTab('playbook')}>
                Standing orders
              </button>
            </div>
          }
        >
          {error ? <p className="err-box">{error}{memory ? ' Showing what loaded last.' : ''}</p> : null}
          {!memory && !error ? <p className="note">Loading the memory…</p> : null}
          {memory && tab === 'lessons' ? (
            <>
              <div className="toolbar">
                <label className="search">
                  <Icon name="search" />
                  <input type="search" id="lesson-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter lessons" aria-label="Filter lessons" />
                </label>
                <div className="seg wrap" role="group" aria-label="Status">
                  <button type="button" aria-pressed={status === 'all'} onClick={() => setStatus('all')}>
                    All <span className="num">{lessons.length - counts.retired}</span>
                  </button>
                  {ORDER.filter((s) => s !== 'retired' || counts.retired).map((s) => (
                    <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)} title={STATUS[s].hint}>
                      {STATUS[s].label} <span className="num">{counts[s]}</span>
                    </button>
                  ))}
                </div>
              </div>
              {shown.length ? (
                <ul className="lessons">
                  {shown.map((l) => (
                    <LessonRow key={l.key} l={l} pending={pending.get(l.key) ?? null} onAct={act} />
                  ))}
                </ul>
              ) : (
                <Empty title={needle || status !== 'all' ? 'No lessons match.' : 'No lessons yet.'}>
                  {needle || status !== 'all' ? null : 'They come from your chats, card answers, PR reviews and edits; the nightly learner proposes them as candidates.'}
                </Empty>
              )}
            </>
          ) : null}
          {memory && tab === 'playbook' ? <div className="playbook">{memory.playbook.trim() ? <Markdown text={memory.playbook} /> : <Empty title="No standing orders yet.">They fill in as lessons become active.</Empty>}</div> : null}
        </Section>
      )}
    </div>
  );
}
