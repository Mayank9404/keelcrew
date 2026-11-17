/**
 * Document versions and minimal patches for the board's writes.
 *
 * The page's db API has no `if_version` (the ArtifactData tool the Mate uses does), so the board pins a write by reading
 * the document right before it and comparing it with the version this page rendered: the store's own `version` when a
 * runtime puts one on its snapshots, otherwise a fingerprint of the body. A changed document means nothing is written.
 */

/** JSON with object keys sorted, so equal documents always serialize the same way. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

/** A short hash (FNV-1a, two lanes) of a document body. */
export function fingerprint(data: unknown): string {
  const s = stableStringify(data);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return `f${a.toString(36)}${b.toString(36)}${s.length.toString(36)}`;
}

/** The version of a snapshot: the store's own when the runtime exposes one, else the body's fingerprint. */
export function versionOf(snap: { exists: boolean; data(): Record<string, unknown> | undefined }): string {
  if (!snap.exists) return 'missing';
  const own = (snap as { version?: unknown }).version;
  if (typeof own === 'number' || (typeof own === 'string' && own)) return `v${own}`;
  return fingerprint(snap.data() ?? null);
}

export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The smallest `update` body that turns `base` into `next`: changed leaves only, nested objects as nested objects (the
 * store merges them recursively), arrays and scalars whole. A key `next` dropped is written as null, since a page
 * `update` cannot delete a field. Returns null when nothing changed.
 */
export function diffPatch(base: unknown, next: unknown): Record<string, unknown> | null {
  if (!isObj(next)) return null;
  const b = isObj(base) ? base : {};
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(next)])) {
    const nv = next[k];
    const bv = b[k];
    if (nv === undefined) {
      if (bv !== undefined && bv !== null) out[k] = null;
      continue;
    }
    if (isObj(nv) && isObj(bv)) {
      const sub = diffPatch(bv, nv);
      if (sub) out[k] = sub;
    } else if (stableStringify(nv) !== stableStringify(bv)) out[k] = nv;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * `over` merged into `base` the way the store's `update` merges (nested objects recursively, arrays and scalars
 * replaced), except that null and undefined keep the base value: a field the board blanked falls back to its default.
 */
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isObj(over)) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined || v === null) continue;
    const b = out[k];
    out[k] = isObj(b) && isObj(v) ? deepMerge(b, v) : v;
  }
  return out as T;
}

/**
 * A `diffPatch` applied to `base` the way the store's `update` applies it (nested objects merged, arrays and scalars
 * replaced), with null deleting the key: what the board blanked or revoked stays gone.
 */
export function applyPatch<T>(base: T, patch: unknown): T {
  if (!isObj(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete out[k];
    else out[k] = isObj(v) ? applyPatch(isObj(out[k]) ? out[k] : {}, v) : v;
  }
  return out as T;
}
