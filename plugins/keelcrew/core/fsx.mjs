// @ts-check
// File primitives every Keelcrew process shares: strict JSON reads, atomic writes, a cross-process lock, log rotation, and
// reading a file line by line without holding it whole.
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** A crew file that exists but can't be used: not valid JSON, or not the shape it must have. Callers fail closed on it. */
export class CorruptFileError extends Error {
  /** @param {string} path @param {unknown} cause @param {string} [problem] what is wrong, when it parses but has the wrong shape */
  constructor(path, cause, problem) {
    super(`${path} ${problem ?? 'is not valid JSON'}; run \`keelctl doctor\``);
    this.path = path;
    this.cause = cause ?? new Error(problem ?? 'not valid JSON');
  }
}

/** A lock another live process holds for longer than the caller was willing to wait. */
export class LockTimeoutError extends Error {
  /** @param {string} lockPath */
  constructor(lockPath) {
    super(`Timed out waiting for ${lockPath}`);
    this.lockPath = lockPath;
  }
}

/** Whether a value is a plain JSON object (not null, not an array). @param {unknown} v @returns {v is Record<string, any>} */
export const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** A hook's JSON input from stdin, or {} when it can't be read. @returns {Record<string, any>} */
export function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * The parsed file, or `fallback` when the file doesn't exist.
 * @template T
 * @param {string} path
 * @param {T} fallback
 * @returns {any}
 * @throws {CorruptFileError} when the file exists but isn't valid JSON
 */
export function readJsonStrict(path, fallback) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CorruptFileError(path, e);
  }
}

/**
 * The parsed file, or `fallback` on any failure. Only for reads that feed a display, never a decision.
 * @template T
 * @param {string} path
 * @param {T} fallback
 * @returns {any}
 */
export function readJsonLoose(path, fallback) {
  try {
    return readJsonStrict(path, fallback);
  } catch {
    return fallback;
  }
}

/** Writes JSON so a reader sees the old file or the new one, never half of one. @param {string} path @param {unknown} value */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

/** @param {number} ms */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const OWNER_FILE = 'owner.json';

/** Whether a process is running. A process of another user (EPERM) counts as running. @param {number} pid */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}

/**
 * Who holds a lock directory: `{pid, token, at}` from its owner file, or null when it has none (an older Keelcrew, or a
 * holder that died between creating the folder and writing the file).
 * @param {string} lockPath
 * @returns {{ pid: number, token: string, at: number } | null}
 */
export function lockOwner(lockPath) {
  const o = readJsonLoose(join(lockPath, OWNER_FILE), null);
  return isObject(o) && typeof o.token === 'string' ? { pid: Number(o.pid), token: o.token, at: Number(o.at) || 0 } : null;
}

/**
 * How long a live process may hold a lock: past this its pid is taken to be a reused one and the lock abandoned. No crew
 * step holds a lock anywhere near this long. Doctor's held-too-long check uses the same limit.
 */
export const LOCK_HELD_MAX_MS = 10 * 60_000;

/**
 * Whether a lock was left behind: its holder's process is gone, its owner file was written more than LOCK_HELD_MAX_MS ago
 * (the pid was reused by another process), or (with no owner file) the folder is older than `staleMs`.
 * @param {string} lockPath @param {number} staleMs @param {number} [now]
 */
export function lockAbandoned(lockPath, staleMs, now = Date.now()) {
  const owner = lockOwner(lockPath);
  if (owner) {
    if (!pidAlive(owner.pid)) return true;
    if (owner.at > 0) return now - owner.at > LOCK_HELD_MAX_MS;
    // An owner file without a time: judge its age by the folder's.
    try {
      return now - statSync(lockPath).mtimeMs > LOCK_HELD_MAX_MS;
    } catch {
      return false;
    }
  }
  try {
    return now - statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/**
 * Removes an abandoned lock. Takeovers go one at a time through `<lock>.break` (mkdir is atomic), and the lock is removed
 * only if, read inside it, it still carries the owner judged dead: a lock is never moved or removed under a fresh holder.
 * A breaker older than `staleMs` was left by a process that died mid-takeover and is cleared.
 * @param {string} lockPath @param {string | null} deadToken the owner token judged dead, or null for an ownerless lock
 * @param {number} staleMs
 */
function takeOver(lockPath, deadToken, staleMs) {
  const breaker = `${lockPath}.break`;
  try {
    mkdirSync(breaker);
  } catch {
    try {
      if (Date.now() - statSync(breaker).mtimeMs > staleMs) rmSync(breaker, { recursive: true, force: true });
    } catch {
      /* gone already */
    }
    return; /* another process is taking it over */
  }
  try {
    if ((lockOwner(lockPath)?.token ?? null) === deadToken && lockAbandoned(lockPath, staleMs)) rmSync(lockPath, { recursive: true, force: true });
  } finally {
    rmSync(breaker, { recursive: true, force: true });
  }
}

/**
 * Runs `fn` while holding a lock directory (mkdir is atomic across processes). The holder writes `{pid, token, at}` into
 * it; a lock is taken over only when that process is gone or has held it past LOCK_HELD_MAX_MS (or, for a lock without an
 * owner file, when it is older than `staleMs`), and released only by the holder whose token it carries.
 * @template T
 * @param {string} lockPath
 * @param {() => T} fn
 * @param {{ timeoutMs?: number, staleMs?: number }} [options]
 * @returns {T}
 * @throws {LockTimeoutError} when a live holder keeps it for longer than `timeoutMs`
 */
export function withLock(lockPath, fn, { timeoutMs = 5000, staleMs = 15000 } = {}) {
  const start = Date.now();
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
  mkdirSync(dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lockPath);
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
      const owner = lockOwner(lockPath);
      if (lockAbandoned(lockPath, staleMs)) {
        takeOver(lockPath, owner?.token ?? null, staleMs);
        if (!existsSync(lockPath)) continue;
      }
      if (Date.now() - start > timeoutMs) throw new LockTimeoutError(lockPath);
      sleep(20);
      continue;
    }
    try {
      writeFileSync(join(lockPath, OWNER_FILE), JSON.stringify({ pid: process.pid, token, at: Date.now() }));
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') continue; /* the new folder was removed meanwhile (doctor, or an older Keelcrew's takeover): try again */
      throw e;
    }
    break;
  }
  try {
    return fn();
  } finally {
    if (lockOwner(lockPath)?.token === token) rmSync(lockPath, { recursive: true, force: true });
  }
}

/**
 * Appends a line, first moving a file past `maxBytes` aside to `<path>.1` (one generation kept).
 * @param {string} path @param {string} line @param {number} [maxBytes]
 */
export function appendRotating(path, line, maxBytes = 4 * 1024 * 1024) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    const st = statSync(path);
    if (st.size > maxBytes) {
      // Moved aside under a name of its own first: if another process rotated it meanwhile, what got moved is that
      // process's fresh file, whose lines go back instead of replacing the full file in <path>.1.
      const aside = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.rot`;
      renameSync(path, aside);
      if (statSync(aside).ino === st.ino) renameSync(aside, `${path}.1`);
      else {
        appendFileSync(path, readFileSync(aside));
        rmSync(aside, { force: true });
      }
    }
  } catch {
    /* no file yet, or another process rotated it first */
  }
  appendFileSync(path, line.endsWith('\n') ? line : `${line}\n`);
}

const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Calls `onLine(line, position)` for each complete, non-empty line from byte `from` on, reading in chunks so a long file
 * is never held whole. A last line without its newline is left for the next call.
 * @param {string} path
 * @param {number} from
 * @param {(line: Buffer, position: number) => void} onLine
 * @returns {number} the byte offset just after the last complete line
 */
export function eachLine(path, from, onLine) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    let lineStart = from;
    let readAt = from;
    let carry = Buffer.alloc(0);
    while (readAt < size) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, size - readAt));
      const n = readSync(fd, chunk, 0, chunk.length, readAt);
      if (n <= 0) break;
      readAt += n;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      let start = 0;
      for (let nl = data.indexOf(10); nl !== -1; nl = data.indexOf(10, start)) {
        if (nl > start) onLine(data.subarray(start, nl), lineStart + start);
        start = nl + 1;
      }
      carry = data.subarray(start);
      lineStart += start;
    }
    return lineStart;
  } finally {
    closeSync(fd);
  }
}
