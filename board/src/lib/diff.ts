export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffFile {
  path: string;
  oldPath: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'binary';
  adds: number;
  dels: number;
  lines: DiffLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

const stripPrefix = (p: string): string => p.replace(/^"?[ab]\//, '').replace(/"$/, '');

/** Parse `git diff` output (several files, possibly the same file twice) into files and numbered lines. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const start = (path: string, oldPath = path): DiffFile => {
    const f: DiffFile = { path, oldPath, status: 'modified', adds: 0, dels: 0, lines: [] };
    files.push(f);
    inHunk = false;
    return f;
  };
  for (const raw of (text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(raw);
      file = start(m?.[2] ?? raw.slice(11), m?.[1] ?? raw.slice(11));
      continue;
    }
    if (!inHunk && raw.startsWith('--- ')) {
      const p = raw.slice(4).trim();
      if (!file) file = start(stripPrefix(p));
      if (p === '/dev/null') file.status = 'added';
      else file.oldPath = stripPrefix(p);
      continue;
    }
    if (!inHunk && raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      if (!file) file = start(stripPrefix(p));
      if (p === '/dev/null') file.status = 'deleted';
      else file.path = stripPrefix(p);
      continue;
    }
    if (!file) continue;
    const h = HUNK_RE.exec(raw);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      inHunk = true;
      file.lines.push({ kind: 'hunk', text: raw, oldNo: null, newNo: null });
      continue;
    }
    if (!inHunk) {
      if (raw.startsWith('new file mode')) file.status = 'added';
      else if (raw.startsWith('deleted file mode')) file.status = 'deleted';
      else if (raw.startsWith('rename from ')) {
        file.status = 'renamed';
        file.oldPath = raw.slice(12);
      } else if (raw.startsWith('rename to ')) file.path = raw.slice(10);
      else if (raw.startsWith('Binary files')) {
        file.status = 'binary';
        file.lines.push({ kind: 'meta', text: raw, oldNo: null, newNo: null });
      }
      continue;
    }
    const c = raw[0];
    if (c === '+') {
      file.adds++;
      file.lines.push({ kind: 'add', text: raw.slice(1), oldNo: null, newNo: newNo++ });
    } else if (c === '-') {
      file.dels++;
      file.lines.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++, newNo: null });
    } else if (c === ' ') {
      file.lines.push({ kind: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (c === '\\') {
      file.lines.push({ kind: 'meta', text: raw, oldNo: null, newNo: null });
    } else if (raw === '') {
      // trailing blank line at the end of the output, or an empty context line from some tools
      continue;
    } else {
      inHunk = false;
    }
  }
  return files;
}

/** Pull "+42 −7"-style totals out of a diffstat string. */
export function diffstatTotals(stat: string | undefined | null): { adds: number; dels: number; files: number | null } | null {
  if (!stat) return null;
  const ins = /(\d+) insertions?\(\+\)/.exec(stat);
  const del = /(\d+) deletions?\(-\)/.exec(stat);
  const files = /(\d+) files? changed/.exec(stat);
  if (ins || del) return { adds: Number(ins?.[1] ?? 0), dels: Number(del?.[1] ?? 0), files: files ? Number(files[1]) : null };
  const short = /\+(\d+)\s*[−-](\d+)/.exec(stat);
  if (short) return { adds: Number(short[1]), dels: Number(short[2]), files: files ? Number(files[1]) : null };
  return null;
}

/** Per-file rows of a `git diff --stat` block. */
export function diffstatFiles(stat: string | undefined | null): { path: string; adds: number; dels: number }[] {
  if (!stat) return [];
  const rows: { path: string; adds: number; dels: number }[] = [];
  for (const line of stat.split('\n')) {
    const m = /^\s*(.+?)\s+\|\s+(\d+)\s*(\+*)(-*)\s*$/.exec(line);
    if (!m) continue;
    const total = Number(m[2]);
    const plus = m[3].length;
    const minus = m[4].length;
    const adds = plus + minus ? Math.round((total * plus) / (plus + minus)) : 0;
    rows.push({ path: m[1], adds, dels: total - adds });
  }
  return rows;
}
