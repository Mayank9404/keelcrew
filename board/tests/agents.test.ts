import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENTS } from '../src/lib/agentCatalog';
import { agentConfig, agentName, agentOn, coerceSetting, enabledAgents, manifestsFrom, normalizeManifest } from '../src/lib/agents';

const qa = {
  id: 'qa',
  name: 'QA agent',
  summary: 'Tests deployed tickets.',
  kind: 'ticket',
  runAs: 'session',
  skill: 'keel-qa',
  defaultEnabled: true,
  model: 'claude-opus-5-5',
  effort: 'high',
  settings: { maxRounds: { type: 'number', default: 2, label: 'Rounds' }, shots: { type: 'boolean', default: true } },
};
const briefs = { ...qa, id: 'briefs', name: 'Briefs', kind: 'scheduled', runAs: 'schedule', skill: 'keel-brief', defaultEnabled: false, schedule: [{ cron: '30 9 * * 1-5', label: 'weekdays 9:30' }, { cron: '0 17 * * 5' }], settings: undefined };

describe('agent manifests', () => {
  it('normalizes a valid manifest', () => {
    const m = normalizeManifest(qa, 'qa')!;
    expect(m).toMatchObject({ id: 'qa', kind: 'ticket', defaultEnabled: true, effort: 'high', schedules: [] });
    expect(m.settings).toEqual([
      { key: 'maxRounds', type: 'number', default: 2, label: 'Rounds' },
      { key: 'shots', type: 'boolean', default: true, label: 'shots' },
    ]);
  });

  it('rejects what core agents.mjs rejects', () => {
    expect(normalizeManifest({ ...qa, kind: 'sometimes' })).toBeNull();
    expect(normalizeManifest({ ...qa, name: '' })).toBeNull();
    expect(normalizeManifest(qa, 'other-file')).toBeNull();
    expect(normalizeManifest([qa])).toBeNull();
  });

  it('reads schedules given as one or many', () => {
    const m = normalizeManifest(briefs)!;
    expect(m.schedules).toEqual([
      { cron: '30 9 * * 1-5', label: 'weekdays 9:30' },
      { cron: '0 17 * * 5', label: '0 17 * * 5' },
    ]);
  });

  it('handles zero or more files from the glob, ticket agents first', () => {
    expect(manifestsFrom({})).toEqual([]);
    const list = manifestsFrom({ '/a/briefs.json': briefs, '/a/qa.json': { default: qa }, '/a/bad.json': { id: 'bad' } });
    expect(list.map((m) => m.id)).toEqual(['qa', 'briefs']);
  });

  it('bundles every valid manifest in plugins/keelcrew/agents', () => {
    const dir = new URL('../../plugins/keelcrew/agents/', import.meta.url);
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      files = [];
    }
    const valid = files.filter((f) => normalizeManifest(JSON.parse(readFileSync(new URL(f, dir), 'utf8')), f.replace(/\.json$/, '')));
    expect(AGENTS.map((a) => a.id).sort()).toEqual(valid.map((f) => f.replace(/\.json$/, '')).sort());
  });
});

describe('agent settings', () => {
  const m = normalizeManifest(qa)!;
  const engineer = normalizeManifest({ ...qa, id: 'engineer', name: 'Engineer', model: 'claude-opus-5-5' })!;

  it('defaults to the manifest', () => {
    expect(agentConfig(m, undefined)).toEqual({ enabled: true, model: 'claude-opus-5-5', effort: 'high', schedule: '', values: { maxRounds: 2, shots: true } });
  });

  it('applies what the captain saved, but takes the model only from Settings → Crew', () => {
    const c = agentConfig(m, { enabled: false, model: 'claude-opus-4-5', effort: 'max', maxRounds: 4 });
    expect(c).toMatchObject({ enabled: false, model: 'claude-opus-5-5', effort: 'high', values: { maxRounds: 4, shots: true } });
    expect(agentConfig(m, undefined, { models: { approved: { qa: { model: 'claude-sonnet-5-5', effort: 'low' } } } })).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' });
  });

  it("reads the engineer's model as Settings → Crew resolves it, never a model saved on the agent", () => {
    expect(agentConfig(engineer, { model: 'saved' })).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
    expect(agentConfig(engineer, undefined, { models: { approved: { engineer: { byDifficulty: { moderate: { model: 'claude-sonnet-5-5', effort: 'max' } } } } } })).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'max' });
  });

  it('lists the agents that are on', () => {
    const b = normalizeManifest(briefs)!;
    expect(enabledAgents([m, b], {}).map((x) => x.id)).toEqual(['qa']);
    expect(enabledAgents([m, b], { agents: { qa: { enabled: false }, briefs: { enabled: true } } }).map((x) => x.id)).toEqual(['briefs']);
  });

  it('decides on as core readOrg: department first, then the role switch, then the default', () => {
    const support = normalizeManifest({ ...qa, id: 'support', department: 'support', defaultEnabled: true }, 'support')!;
    const ops = normalizeManifest({ ...qa, id: 'health', department: 'operations', defaultEnabled: true }, 'health')!;
    expect(agentOn({}, support)).toBe(false);
    expect(agentOn({ org: { departments: { support: { enabled: true } } } }, support)).toBe(true);
    expect(agentOn({ org: { departments: { support: { enabled: true } }, roles: { support: { enabled: false } } }, agents: { support: { enabled: true } } }, support)).toBe(false);
    expect(agentOn({ org: { departments: { operations: { enabled: false } } } }, ops)).toBe(true);
    expect(agentOn({}, normalizeManifest({ ...qa, department: 'nowhere' }, 'qa')!)).toBe(false);
    expect(agentConfig(support, { enabled: true }).enabled).toBe(false);
    expect(enabledAgents([m, support], undefined).map((x) => x.id)).toEqual(['qa']);
  });

  it('types form values by the manifest', () => {
    expect(coerceSetting(m.settings[0], '5')).toBe(5);
    expect(coerceSetting(m.settings[0], 'x')).toBe(2);
    expect(coerceSetting(m.settings[1], 'true')).toBe(true);
  });

  it('names agents for cards and sessions', () => {
    expect(agentName([m], 'qa')).toBe('QA agent');
    expect(agentName([m], 'learner')).toBe('Learner');
  });
});
