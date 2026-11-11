// @ts-check
// The helper's plumbing: running commands with a PATH that finds Homebrew tools, reading files line by line or from the
// end without loading them whole, and the helper's own log (logs/helper.log).
import { execFile } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { appendRotating, eachLine } from '../core/fsx.mjs';
import { paths } from '../core/paths.mjs';

/** The Claude app starts the helper with a bare PATH, so git and gh from Homebrew need adding (when installed). */
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin'].filter((p) => existsSync(p));
const ENV = { ...process.env, PATH: [...EXTRA_PATH, process.env.PATH ?? ''].filter(Boolean).join(':') };

const LOG_MAX_BYTES = 1024 * 1024;

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} RunResult
 */

/**
 * Runs a command and resolves with its exit code and output; never rejects (a timeout or a missing command is code 1).
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number }} [options]
 * @returns {Promise<RunResult>}
 */
export function run(cmd, args, { cwd, timeoutMs = 60_000 } = {}) {
  return new Promise((done) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: ENV }, (err, stdout, stderr) => {
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Quotes a value for a POSIX shell. @param {unknown} s */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Reads `length` bytes at `position`.
 * @param {string} path @param {number} position @param {number} length
 */
export function readRange(path, position, length) {
  const buf = Buffer.alloc(Math.max(0, length));
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, buf.length, position);
  } finally {
    closeSync(fd);
  }
  return buf;
}

/**
 * The complete lines in the last `bytes` of a file (a line cut by the window is dropped), without blank ones.
 * @param {string} path @param {number} bytes
 * @returns {string[]}
 */
export function tail(path, bytes) {
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const lines = readRange(path, start, size - start).toString('utf8').split('\n');
  if (start > 0) lines.shift();
  return lines.filter(Boolean);
}

/** Reads a file line by line from a byte offset; shared with core so the crew command can count costs too. */
export { eachLine };

/**
 * Appends to logs/helper.log (rotated at 1 MB). Never throws: logging can't break a tool.
 * @param {'info' | 'warn' | 'error'} level @param {string} message
 */
export function log(level, message) {
  try {
    appendRotating(join(paths.logs(), 'helper.log'), `${new Date().toISOString()} ${level.toUpperCase()} ${message.replace(/\s+/g, ' ').slice(0, 4000)}`, LOG_MAX_BYTES);
  } catch {
    /* the log folder is unwritable; nothing better to do */
  }
}

/** A readable message from anything thrown. @param {unknown} e */
export const messageOf = (e) => (e instanceof Error ? e.message : String(e));
