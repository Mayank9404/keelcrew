/**
 * A small Markdown renderer for chat, inbox bodies, specs and dossiers.
 * Handles paragraphs, headings, bold/italic/strike, inline code, fenced code, lists (nested),
 * blockquotes, simple tables and links. All input is HTML-escaped; only http(s)/mailto links survive as links. Links to a
 * file on the captain's Mac (file://, an absolute or ~ path, or such a path alone in inline code) become file chips whose
 * buttons the Markdown component handles.
 */

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, c => ESC[c] ?? c);

export interface MarkdownOptions {
  /** Known task keys become buttons that open the task. */
  taskKeys?: ReadonlySet<string>;
}

function safeUrl(url: string): string | null {
  const u = url.trim();
  if (/^(https?:|mailto:)/i.test(u)) return u;
  return null;
}

/** A file on the captain's Mac, as a link target: file:///…, ~/…, or a path in the home or temp folders. */
const LOCAL_RE = /^(file:\/\/\/|~\/|\/(Users|private|tmp|var)\/)/;
/** Inline code that is only such a path. */
const PATH_CODE_RE = /^(file:\/\/\/|~\/|\/(Users|private|tmp|var)\/)[^\s`]+$/;

const fileChip = (label: string, path: string): string =>
  `<span class="fchip" data-file="${escapeHtml(path)}" title="${escapeHtml(path)}"><span class="fname">${label}</span><button type="button" data-act="open">Open</button><button type="button" data-act="reveal">Show in Finder</button></span>`;

const KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

function inline(src: string, opts: MarkdownOptions, allowLinks = true): string {
  const slots: string[] = [];
  // Code spans as plain code, for link labels: a path chip can't sit inside a link.
  const codes: string[] = [];
  const hold = (html: string): string => `\u0000${slots.push(html) - 1}\u0000`;
  // A top-level call strips both markers from the text; a label's \u0001 markers are its own.
  let s = src.replace(allowLinks ? /[\u0000\u0001]/g : /\u0000/g, '');
  s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, code: string) => {
    const html = `<code>${escapeHtml(code)}</code>`;
    const held = hold(allowLinks && PATH_CODE_RE.test(code) ? fileChip(html, code) : html);
    codes[slots.length - 1] = html;
    return held;
  });
  /** A link's label, keeping the code spans already taken out of it. */
  const label = (text: string): string =>
    inline(text.replace(/\u0000(\d+)\u0000/g, '\u0001$1\u0001'), opts, false).replace(/\u0001(\d+)\u0001/g, (_m, i: string) => codes[Number(i)] ?? '');
  if (allowLinks) {
    s = s.replace(/\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (m, text: string, url: string) => {
      if (LOCAL_RE.test(url.trim())) return hold(fileChip(label(text), url.trim()));
      const u = safeUrl(url);
      return u ? hold(`<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${label(text)}</a>`) : m;
    });
    s = s.replace(/<(https?:\/\/[^>\s]+)>/g, (_m, url: string) => hold(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`));
    s = s.replace(/\bhttps?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_]/g, url => hold(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`));
  }
  s = escapeHtml(s);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![_\w])/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  const keys = opts.taskKeys;
  if (keys && keys.size) {
    s = s.replace(KEY_RE, k => (keys.has(k) ? `<button type="button" class="tk" data-task="${k}">${k}</button>` : k));
  }
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)] ?? '');
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const LIST_RE = /^(\s*)([-*+•]|\d{1,9}[.)])\s+(.*)$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (line: string): number => line.length - line.trimStart().length;

function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || LIST_RE.test(line) || (line.includes('|') && next !== undefined && TABLE_SEP_RE.test(next));
}

function splitRow(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

function parseList(lines: string[], start: number, opts: MarkdownOptions): [string, number] {
  const first = LIST_RE.exec(lines[start]);
  if (!first) return ['', start + 1];
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i]);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
    const text = [m[3]];
    let nested = '';
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const nm = j < lines.length ? LIST_RE.exec(lines[j]) : null;
        if (nm && nm[1].length >= indent) {
          i = j;
          continue;
        }
        break;
      }
      const nm = LIST_RE.exec(line);
      if (nm && nm[1].length > indent) {
        const [html, next] = parseList(lines, i, opts);
        nested += html;
        i = next;
        continue;
      }
      if (nm) break;
      if (indentOf(line) > indent && !FENCE_RE.test(line)) {
        text.push(line.trim());
        i++;
        continue;
      }
      break;
    }
    items.push(`<li>${text.map(t => inline(t, opts)).join('<br>')}${nested}</li>`);
  }
  const tag = ordered ? 'ol' : 'ul';
  const n = ordered ? parseInt(first[2], 10) : 1;
  return [`<${tag}${ordered && n !== 1 ? ` start="${n}"` : ''}>${items.join('')}</${tag}>`, i];
}

export function renderMarkdown(src: string, opts: MarkdownOptions = {}): string {
  const lines = (src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const close = fence[1];
      const lang = fence[2];
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) buf.push(lines[i++]);
      i++;
      out.push(
        `<div class="md-pre"><pre${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(buf.join('\n'))}</code></pre><button type="button" class="md-copy" data-copy>Copy</button></div>`,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      const level = Math.min(6, h[1].length + 2);
      out.push(`<h${level}>${inline(h[2], opts)}</h${level}>`);
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        const q = QUOTE_RE.exec(lines[i]);
        buf.push(q ? q[1] : lines[i]);
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'), opts)}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const cell = (tag: string, c: string, k: number) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c, opts)}</${tag}>`;
      out.push(
        `<div class="md-table"><table><thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead><tbody>${rows
          .map(r => `<tr>${head.map((_c, k) => cell('td', r[k] ?? '', k)).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    if (LIST_RE.test(line)) {
      const [html, next] = parseList(lines, i, opts);
      out.push(html);
      i = Math.max(next, i + 1);
      continue;
    }
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++].trim());
    out.push(`<p>${para.map(p => inline(p, opts)).join('<br>')}</p>`);
  }
  return out.join('');
}
