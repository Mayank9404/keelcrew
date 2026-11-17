/**
 * The crew's agent manifests, bundled at build time from plugins/keelcrew/agents/*.json (zero or more). Kept apart
 * from agents.ts so the pure helpers there can be tested without Vite's glob import.
 */
import { manifestsFrom, type AgentManifest } from './agents';

const modules = import.meta.glob('../../../plugins/keelcrew/agents/*.json', { eager: true, import: 'default' });

export const AGENTS: AgentManifest[] = manifestsFrom(modules);
