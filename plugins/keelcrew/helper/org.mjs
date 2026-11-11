// @ts-check
// The company for the board: departments and the resolved org.
import { listDepartments } from '../core/departments.mjs';
import { readOrg } from '../core/org.mjs';

/** Departments (order, colours, heads, switches) and the org as code resolves it (switches, seats, approved models, budgets, goals). */
export const orgGet = () => ({ departments: listDepartments(), org: readOrg() });
