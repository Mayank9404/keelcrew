/** The departments, bundled at build time from plugins/keelcrew/departments/*.json, as agentCatalog.ts does the agents. */
import type { Department } from '../types';

const modules = import.meta.glob('../../../plugins/keelcrew/departments/*.json', { eager: true, import: 'default' });

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);

export const DEPARTMENTS: Department[] = Object.values(modules)
  .flatMap((d) => {
    const o = d as Record<string, unknown> | null;
    if (!o || typeof o.id !== 'string') return [];
    return [
      {
        id: o.id,
        name: str(o.name, o.id),
        summary: str(o.summary),
        head: typeof o.head === 'string' ? o.head : null,
        order: typeof o.order === 'number' ? o.order : 99,
        colour: str(o.colour, '#888888'),
        budgetShare: typeof o.budgetShare === 'number' ? o.budgetShare : 0,
        defaultEnabled: o.defaultEnabled === true,
        switchable: o.switchable !== false,
      },
    ];
  })
  .sort((a, b) => a.order - b.order);
