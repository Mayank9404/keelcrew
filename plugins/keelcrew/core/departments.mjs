// @ts-check
// The org's departments: departments/<id>.json manifests. A department groups roles (agents/<id>.json `department`),
// has a head role, a place in the order and a switch in Settings → Crew.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { paths } from './paths.mjs';

const ID = /^[a-z][a-z0-9-]*$/;

/**
 * @typedef {{
 *   id: string, name: string, summary: string, head: string, order: number, colour: string,
 *   budgetShare: number, defaultEnabled: boolean, switchable: boolean
 * }} Department
 */

/** @param {unknown} v */
const text = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * What's wrong with a department manifest; empty when it is valid.
 * @param {any} d @param {string} [fileId]
 * @returns {string[]}
 */
export function departmentProblems(d, fileId) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return ['not a JSON object'];
  /** @type {string[]} */
  const out = [];
  if (typeof d.id !== 'string' || !ID.test(d.id)) out.push('id must be lowercase letters, digits and dashes');
  else if (fileId && d.id !== fileId) out.push(`id "${d.id}" doesn't match the file name`);
  for (const k of ['name', 'summary']) if (!text(d[k])) out.push(`${k} is required`);
  if (typeof d.head !== 'string' || !ID.test(d.head)) out.push('head must be a role id');
  if (!Number.isInteger(d.order) || d.order < 0) out.push('order must be a whole number from 0');
  if (typeof d.colour !== 'string' || !/^#[0-9a-f]{6}$/i.test(d.colour)) out.push('colour must be #rrggbb');
  if (!(typeof d.budgetShare === 'number' && d.budgetShare >= 0 && d.budgetShare <= 1)) out.push('budgetShare must be a number from 0 to 1');
  for (const k of ['defaultEnabled', 'switchable']) if (typeof d[k] !== 'boolean') out.push(`${k} must be true or false`);
  return out;
}

/**
 * Every department manifest in a folder: valid ones sorted by order, invalid ones with what's wrong.
 * @param {string} [dir]
 * @returns {{ departments: Department[], invalid: { file: string, problems: string[] }[] }}
 */
export function scanDepartments(dir = paths.departments()) {
  /** @type {string[]} */
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    /* no departments yet */
  }
  /** @type {Department[]} */
  const departments = [];
  /** @type {{ file: string, problems: string[] }[]} */
  const invalid = [];
  for (const file of files) {
    let d;
    try {
      d = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (e) {
      invalid.push({ file, problems: [`not valid JSON (${/** @type {Error} */ (e).message})`] });
      continue;
    }
    const problems = departmentProblems(d, basename(file, '.json'));
    if (problems.length) invalid.push({ file, problems });
    else departments.push(d);
  }
  departments.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return { departments, invalid };
}

/** The valid departments, in order. @param {string} [dir] */
export const listDepartments = (dir) => scanDepartments(dir).departments;
