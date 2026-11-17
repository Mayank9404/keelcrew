/** Subsequence match score; higher is better, null when the query does not match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct !== -1) return 1000 - direct * 2 - (t.length - q.length) * 0.1 + (direct === 0 || /[\s#·-]/.test(t[direct - 1] ?? '') ? 200 : 0);
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 6 - Math.min(found - ti, 10);
    if (found === 0 || /[\s#·/_-]/.test(t[found - 1] ?? '')) score += 12;
    ti = found + 1;
  }
  return score - t.length * 0.05;
}
