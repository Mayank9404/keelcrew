import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ROLE_LABEL } from '../../labels';
import { api, errorText, type DiffResult } from '../../lib/api';
import { parseUnifiedDiff, type DiffFile, type DiffLine } from '../../lib/diff';
import { useCanWrite } from '../../lib/store';
import { toast } from '../../lib/toast';
import type { DiffComment, Task } from '../../types';
import { Details } from '../common';

interface Draft {
  id: number;
  /** `${fileIndex}:${lineIndex}`; lineIndex -1 is a file-level comment. */
  anchor: string;
  file: string;
  line: DiffLine | null;
  body: string;
  editing: boolean;
}

const LINE_CAP = 1200;
const STATUS_LABEL: Record<DiffFile['status'], string> = { modified: '', added: 'new', deleted: 'deleted', renamed: 'renamed', binary: 'binary' };

function CommentEditor({ draft, onSave, onCancel, onRemove }: { draft: Draft; onSave: (body: string) => void; onCancel: () => void; onRemove: () => void }) {
  const [body, setBody] = useState(draft.body);
  if (!draft.editing) {
    return (
      <div className="cmt-box">
        <div className="done">
          <p>{draft.body}</p>
          <button type="button" className="btn sm ghost" onClick={onCancel}>
            Edit
          </button>
          <button type="button" className="btn sm ghost danger" onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>
    );
  }
  return (
    <form
      className="cmt-box"
      onSubmit={e => {
        e.preventDefault();
        if (body.trim()) onSave(body.trim());
      }}
    >
      <textarea
        rows={3}
        autoFocus
        value={body}
        placeholder="What should change here?"
        aria-label="Review comment"
        onChange={e => setBody(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) {
            e.preventDefault();
            onSave(body.trim());
          }
          if (e.key === 'Escape') (draft.body ? onCancel : onRemove)();
        }}
      />
      <div className="field-row">
        <button type="submit" className="btn sm primary" disabled={!body.trim()}>
          Add comment
        </button>
        <button type="button" className="btn sm ghost" onClick={draft.body ? onCancel : onRemove}>
          Cancel
        </button>
      </div>
    </form>
  );
}

interface ViewProps {
  text: string;
  drafts?: Draft[];
  onLine?: (fileIdx: number, file: DiffFile, lineIdx: number, line: DiffLine | null) => void;
  renderDraft?: (d: Draft) => ReactNode;
}

/** Unified diff with file headers and old/new line numbers. Lines are clickable when `onLine` is given. */
export function DiffView({ text, drafts = [], onLine, renderDraft }: ViewProps) {
  const files = useMemo(() => parseUnifiedDiff(text), [text]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const total = files.reduce((a, f) => a + f.lines.length, 0);
  const byAnchor = useMemo(() => {
    const m = new Map<string, Draft[]>();
    for (const d of drafts) m.set(d.anchor, [...(m.get(d.anchor) ?? []), d]);
    return m;
  }, [drafts]);
  if (!files.length) return <pre className="block wrap">{text || 'Empty diff.'}</pre>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {files.map((f, fi) => {
        const capped = !expanded.has(fi) && f.lines.length > LINE_CAP;
        const lines = capped ? f.lines.slice(0, LINE_CAP) : f.lines;
        const fileDrafts = byAnchor.get(`${fi}:-1`) ?? [];
        return (
          <details className="dfile" key={`${f.path}${fi}`} open={total < 4000 || files.length < 6}>
            <summary>
              <span className="p">
                {f.status === 'renamed' ? `${f.oldPath} → ${f.path}` : f.path}
                {STATUS_LABEL[f.status] ? <span style={{ color: 'var(--muted)' }}> · {STATUS_LABEL[f.status]}</span> : null}
              </span>
              <span className="add">+{f.adds}</span>
              <span className="del">−{f.dels}</span>
              {onLine ? (
                <button
                  type="button"
                  className="fc"
                  onClick={e => {
                    e.preventDefault();
                    onLine(fi, f, -1, null);
                  }}
                >
                  Comment on file
                </button>
              ) : null}
            </summary>
            <table className="dtable">
              <tbody>
                {fileDrafts.map(d => (
                  <tr key={d.id} className="cmt">
                    <td colSpan={3}>{renderDraft?.(d)}</td>
                  </tr>
                ))}
                {lines.map((l, li) => {
                  const clickable = !!onLine && (l.kind === 'add' || l.kind === 'del' || l.kind === 'ctx');
                  const ds = byAnchor.get(`${fi}:${li}`);
                  return (
                    <Fragment key={li}>
                      <tr
                        className={`dl-${l.kind}${clickable ? ' line' : ''}`}
                        onClick={clickable ? () => onLine?.(fi, f, li, l) : undefined}
                        title={clickable ? 'Click to comment on this line' : undefined}
                      >
                        <td className="no">{l.oldNo ?? ''}</td>
                        <td className="no">{l.newNo ?? ''}</td>
                        <td className="code">
                          {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : l.kind === 'ctx' ? ' ' : ''}
                          {l.text}
                        </td>
                      </tr>
                      {ds?.map(d => (
                        <tr key={d.id} className="cmt">
                          <td colSpan={3}>{renderDraft?.(d)}</td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
                {capped ? (
                  <tr className="dl-meta">
                    <td colSpan={3}>
                      <button type="button" className="fc" style={{ border: 0, background: 'none', color: 'var(--muted)', padding: '6px 0' }} onClick={() => setExpanded(s => new Set(s).add(fi))}>
                        Show all {f.lines.length} lines
                      </button>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </details>
        );
      })}
    </div>
  );
}

let draftSeq = 0;

export function DiffTab({ task }: { task: Task }) {
  const canWrite = useCanWrite();
  const [result, setResult] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [summary, setSummary] = useState('');
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setResult(await api.taskDiff(task.key));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [task.key]);

  useEffect(() => {
    void load();
  }, [load]);

  const addDraft = (fi: number, file: DiffFile, li: number, line: DiffLine | null) => {
    const anchor = `${fi}:${li}`;
    setDrafts(ds => {
      if (ds.some(d => d.anchor === anchor && d.editing)) return ds;
      return [...ds, { id: ++draftSeq, anchor, file: file.path, line, body: '', editing: true }];
    });
  };
  const patch = (id: number, p: Partial<Draft>) => setDrafts(ds => ds.map(d => (d.id === id ? { ...d, ...p } : d)));
  const remove = (id: number) => setDrafts(ds => ds.filter(d => d.id !== id));
  const saved = drafts.filter(d => !d.editing && d.body);

  const send = async () => {
    if (!saved.length && !summary.trim()) return;
    const comments: DiffComment[] = saved.map(d => {
      const l = d.line;
      if (l && l.newNo == null && l.oldNo != null) return { file: d.file, line: null, body: `(on removed line ${l.oldNo}: \`${l.text.trim()}\`) ${d.body}` };
      return { file: d.file, line: l?.newNo ?? null, body: d.body };
    });
    setSending(true);
    try {
      await api.reviewTask(task.key, comments, summary.trim() || undefined);
      toast(`Review sent to ${task.key}.`);
      setDrafts([]);
      setSummary('');
    } catch {
      /* toasted */
    } finally {
      setSending(false);
    }
  };

  if (!result) return <p className="empty">{error ?? (loading ? 'Loading diff…' : 'No diff yet.')}</p>;
  return (
    <>
      <div className="diff-head">
        <span className="mono">
          {result.branch} → origin/{result.base}
        </span>
        <span className="spacer" />
        <button type="button" className="btn sm ghost" onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {result.status.trim() ? (
        <Details label="Uncommitted changes" openLabel="Hide uncommitted changes">
          <pre className="block">{result.status}</pre>
        </Details>
      ) : null}
      {result.diff.trim() ? (
        <>
          <p className="note">Click a line to leave a comment. Comments go to the {ROLE_LABEL.engineer.toLowerCase()} together when you send the review.</p>
          <DiffView
            text={result.diff}
            drafts={drafts}
            onLine={canWrite ? addDraft : undefined}
            renderDraft={d => (
              <CommentEditor
                key={d.id}
                draft={d}
                onSave={body => patch(d.id, { body, editing: false })}
                onCancel={() => patch(d.id, { editing: !d.editing })}
                onRemove={() => remove(d.id)}
              />
            )}
          />
        </>
      ) : (
        <p className="empty">No changes against origin/{result.base} yet.</p>
      )}
      {result.diff.trim() && canWrite ? (
        <div className="review-bar">
          <textarea rows={saved.length ? 2 : 1} value={summary} placeholder="Overall note (optional)" aria-label="Review summary" onChange={e => setSummary(e.target.value)} />
          <div className="field-row">
            <span className="note">
              {saved.length ? `${saved.length} comment${saved.length === 1 ? '' : 's'}` : 'No comments yet'}
            </span>
            <span className="spacer" />
            <button type="button" className="btn primary" disabled={sending || (!saved.length && !summary.trim())} onClick={() => void send()}>
              {sending ? 'Sending…' : `Send review to ${ROLE_LABEL.engineer.toLowerCase()}`}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
