/** Timestamps on the wire are epoch ms; tolerate epoch seconds too. */
export const toMs = (ts: number): number => (ts > 0 && ts < 1e12 ? ts * 1000 : ts);

export const DAY = 86_400_000;

const pad = (n: number): string => String(n).padStart(2, '0');

export function clock(ts: number): string {
  const d = new Date(toMs(ts));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Today 08:12", "Yesterday 17:40" or "Oct 9 · 14:20". */
export function dayTime(ts: number, now = Date.now()): string {
  const d = new Date(toMs(ts));
  const today = new Date(now);
  const yest = new Date(now - DAY);
  if (sameDay(d, today)) return `Today ${clock(ts)}`;
  if (sameDay(d, yest)) return `Yesterday ${clock(ts)}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} · ${clock(ts)}`;
}

/** "Oct 9" (or "Today"). */
export function shortDay(ts: number, now = Date.now()): string {
  const d = new Date(toMs(ts));
  if (sameDay(d, new Date(now))) return 'Today';
  if (sameDay(d, new Date(now - DAY))) return 'Yesterday';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - toMs(ts)) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** "2h 14m" until a timestamp. */
export function until(ts: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((toMs(ts) - now) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const money = (n: number | null | undefined): string => `$${(n ?? 0).toFixed(2)}`;

export const hours = (n: number | null | undefined): string => (n == null ? '—' : n < 10 ? `${n.toFixed(1)} h` : `${Math.round(n)} h`);

export const ratio = (n: number | null | undefined): string => (n == null ? '—' : `${Math.round((n <= 1 ? n * 100 : n))}%`);

/** Utilization may arrive as a 0–1 fraction or a 0–100 percentage. */
export function percent(u: number | null | undefined): number {
  if (u == null || !Number.isFinite(u)) return 0;
  const p = u <= 1 ? u * 100 : u;
  return Math.max(0, Math.min(100, p));
}

/** Tool names arrive as `mcp__server__tool`; show the tool part. */
export function toolName(tool: string | null | undefined): string {
  if (!tool) return '';
  const parts = tool.split('__');
  return parts[parts.length - 1] || tool;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** "claude-opus-5-5" → "Opus 5.5". */
export function modelName(model: string): string {
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(model);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : model;
}
