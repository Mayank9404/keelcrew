import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CrewSection, setRole } from '../src/components/settings/Crew';
import { LimitsSection } from '../src/components/settings/Limits';
import { SettingsView, validate } from '../src/components/settings/SettingsView';
import { ShippingSection, reviewOf } from '../src/components/settings/Shipping';
import { TasksSection } from '../src/components/settings/Tasks';
import { ModelPick } from '../src/components/settings/parts';
import { modelLabel } from '../src/labels';
import { AGENTS } from '../src/lib/agentCatalog';
import { aboveMate, modelTier } from '../src/lib/models';
import { roleOn } from '../src/lib/org';
import { cronAt, cronWords, simpleCron } from '../src/lib/schedule';
import { crewStore } from '../src/lib/store';
import { ui, uiStore } from '../src/lib/ui';
import type { CrewConfig, CrewState } from '../src/types';
import { crew } from './build';

const S = 'claude-sonnet-5-5';
const config = (): CrewConfig => structuredClone(crew().config);
const show = (c: CrewConfig, el: Parameters<typeof renderToStaticMarkup>[0], p: Partial<CrewState> = {}): string => {
  crewStore.set({ crew: crew({ config: c, ...p }), conn: 'open', events: [] });
  return renderToStaticMarkup(el);
};
const props = (c: CrewConfig, errors: Record<string, string> = {}) => ({ draft: c, set: () => undefined, errors, canWrite: true });

describe('the settings page', () => {
  it('is one page in six groups, with an index and no tabs', () => {
    const html = show(config(), createElement(SettingsView));
    const ids = [...html.matchAll(/<section class="sset" id="set-([a-z]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['crew', 'tasks', 'shipping', 'limits', 'mac', 'rules']);
    for (const label of ['Crew', 'Tasks', 'Shipping', 'Limits', 'This Mac', 'Rules']) expect(html).toMatch(new RegExp(`<a href="#set-[a-z]+"[^>]*>${label}<`));
    expect(html).not.toContain('role="tab"');
  });

  it('says it is read only, and greys every field, for someone who can’t write', () => {
    const html = show(config(), createElement(SettingsView), { access: { canWrite: false, reason: null } });
    expect(html).toContain('Read only');
    expect(html).not.toMatch(/<fieldset class="set-fields">/);
  });

  it('brings a group into view when another screen opens it', () => {
    ui.openSettings('limits');
    expect(uiStore.get()).toMatchObject({ view: 'settings', settingsFocus: { section: 'limits' } });
    ui.openSettings('limits');
    ui.setView('signoffs');
    expect(uiStore.get().settingsFocus).toBeNull();
  });

  it('checks only fields the page shows: the usage limits while the pause is on', () => {
    const c = config();
    c.usageGuard = { ...c.usageGuard, enabled: false, maxFiveHourPct: 0 };
    expect(validate(c)['usageGuard.maxFiveHourPct']).toBeUndefined();
    c.usageGuard.enabled = true;
    expect(validate(c)['usageGuard.maxFiveHourPct']).toBeTruthy();
  });

  it('asks for a review depth, and five fields in a typed schedule', () => {
    const c = config();
    c.codeReview.args = '';
    c.agents = { cto: { schedule: '0 10 * *' } };
    expect(Object.keys(validate(c)).sort()).toEqual(['agents.cto.schedule', 'codeReview.args']);
  });
});

describe('Settings → Crew', () => {
  it('has the Mate, always on, and one row with a switch per member, but no Jira scan', () => {
    const html = show(config(), createElement(CrewSection, props(config())));
    expect(html).toMatch(/member-name">Mate<[\s\S]*?Always on/);
    const on = AGENTS.filter((a) => a.id !== 'scan' && ['engineering', 'operations', 'product'].includes(a.department ?? 'engineering'));
    for (const a of on) expect(html).toContain(`>${a.name} on<`);
    expect(html).not.toContain('>Jira scan<');
  });

  it('names models in words, the engineer’s across its difficulties', () => {
    const c = config();
    c.org = { models: { approved: { qa: { model: S, effort: 'low' } } } };
    const html = show(c, createElement(CrewSection, props(c)));
    expect(html).toMatch(/member-name">QA agent<[\s\S]*?member-model">Sonnet 5\.5 · low</);
    expect(html).toMatch(/member-name">Engineer<[\s\S]*?member-model">Sonnet 5\.5 · high to xhigh</);
  });

  it('hides a team’s members while the team is off', () => {
    const c = config();
    c.org = { departments: { marketing: { enabled: false }, support: { enabled: true } } };
    const html = show(c, createElement(CrewSection, props(c)));
    expect(html).not.toContain('member-name">Marketing<');
    expect(html).toContain('member-name">Support<');
  });

  it('shows the members of a team that is off when one has a field to fix', () => {
    const c = config();
    c.org = { departments: { marketing: { enabled: false } } };
    expect(show(c, createElement(CrewSection, props(c, { 'models.marketing': 'Name a model.' })))).toContain('aria-label="Marketing model"');
  });

  it('opens a row that has a field to fix', () => {
    const c = config();
    const closed = show(c, createElement(CrewSection, props(c)));
    expect(closed).not.toContain('aria-label="QA agent model"');
    const open = show(c, createElement(CrewSection, props(c, { 'models.qa': 'Name a model.' })));
    expect(open).toContain('aria-label="QA agent model"');
    expect(open).toContain('Name a model.');
  });

  it('names the sessions the app would hold down to a lower Mate', () => {
    const c = config();
    expect(show(c, createElement(CrewSection, props(c)))).not.toContain('crew-held');
    c.org = { models: { approved: { engineer: { byDifficulty: { critical: { model: 'claude-opus-5-5', effort: 'max' } } } } } };
    expect(show(c, createElement(CrewSection, props(c)))).toMatch(/crew-held[^>]*>[^<]*\(Sonnet 5\.5 · xhigh\), so these run lower than set: Engineer \(critical tickets\)\./);
    c.org = { models: { approved: { lead: { model: S, effort: 'high' } } } };
    expect(show(c, createElement(CrewSection, props(c)))).toMatch(/so these run lower than set: Engineer \(moderate tickets\), Engineer \(complex tickets\), Engineer \(critical tickets\)\./);
  });

  it('turns a member on or off in both places core reads', () => {
    const c = config();
    setRole(c, 'qa', false);
    expect(c.org.roles?.qa).toEqual({ enabled: false });
    expect(c.agents.qa).toMatchObject({ enabled: false });
    expect(roleOn(c, 'qa', true)).toBe(false);
  });

  it('picks a model by name, greys the default, and offers Default only on a choice you made', () => {
    const c = config();
    const dflt = show(c, createElement(ModelPick, { draft: c, set: () => undefined, id: 'qa', manifest: null, label: 'QA' }));
    expect(dflt).toContain('model-pick dflt');
    expect(dflt).toContain('>Opus 5.5<');
    expect(dflt).not.toContain('>Default<');
    c.org = { models: { approved: { qa: { model: 'claude-opus-4-5', effort: 'high' } } } };
    const set = show(c, createElement(ModelPick, { draft: c, set: () => undefined, id: 'qa', manifest: null, label: 'QA' }));
    expect(set).toContain('<option value="claude-opus-4-5" selected');
    expect(set).toContain('>Default<');
    expect(set).toContain('>Type a model name…<');
    expect(set).toContain('>Fable 5.2<');
  });
});

describe('Settings → Tasks', () => {
  it('asks where tasks come from, and shows the Jira fields only with Jira', () => {
    const c = config();
    c.agents = { scan: { enabled: false } };
    const board = show(c, createElement(TasksSection, { ...props(c), live: c }));
    expect(board).toContain('<option value="board" selected');
    expect(board).toContain('Jira site');
    expect(board).not.toContain('Jira query');
    setRole(c, 'scan', true);
    const jira = show(c, createElement(TasksSection, { ...props(c), live: c }));
    expect(jira).toContain('<option value="jira" selected');
    expect(jira).toContain('Jira query');
    expect(jira).toContain('Tickets to leave out');
  });

  it('lists each repo with its base branch and switch', () => {
    const c = config();
    c.repos = { 'brinewick-api': { path: '/w/brinewick-api', baseBranch: 'develop', enabled: true, prGate: null }, 'brinewick-web': { path: '/w/brinewick-web', baseBranch: 'main', enabled: false, prGate: null } };
    const html = show(c, createElement(TasksSection, { ...props(c), live: c }));
    expect(html).toMatch(/brinewick-api[\s\S]*value="develop"[\s\S]*brinewick-web/);
    expect(html).toContain('>brinewick-web on<');
  });
});

describe('Settings → Shipping', () => {
  it('shows the self-review as a depth and a fix switch, keeping other arguments', () => {
    expect(reviewOf('xhigh --fix')).toEqual({ level: 'xhigh', fix: true, rest: [] });
    expect(reviewOf('')).toEqual({ level: '', fix: false, rest: [] });
    expect(reviewOf('max --base dev')).toEqual({ level: 'max', fix: false, rest: ['--base', 'dev'] });
    const c = config();
    c.codeReview.args = 'xhigh --fix';
    const html = show(c, createElement(ShippingSection, props(c)));
    expect(html).toContain('<option value="xhigh" selected="">Thorough</option>');
  });
});

describe('Settings → Limits', () => {
  it('shows each team’s weekly share as a percent, never an amount spent', () => {
    const c = config();
    const html = show(c, createElement(LimitsSection, props(c)), { spend: { departments: { engineering: { usedPct: 40, spentUsd: 12.5 } } } as never });
    expect(html).toContain('Used 40% this week');
    expect(html).not.toContain('12.5');
  });

  it('keeps the hard caps folded until one is set', () => {
    const c = config();
    expect(show(c, createElement(LimitsSection, props(c)))).toMatch(/<details class="srow-more">/);
    c.budgets.perTicketUsd = 20;
    expect(show(c, createElement(LimitsSection, props(c)))).toMatch(/<details class="srow-more" open="">/);
  });
});

describe('model tiers', () => {
  it('ranks families, and holds down a higher family or effort than the Mate’s', () => {
    expect(['claude-haiku-5-5', 'sonnet', 'claude-opus-5-5', 'claude-fable-5-2', 'other'].map(modelTier)).toEqual([1, 2, 3, 4, null]);
    const mate = { model: 'claude-sonnet-5-5', effort: 'high' as const };
    expect(aboveMate({ model: 'claude-opus-5-5', effort: 'high' }, mate)).toBe(true);
    expect(aboveMate({ model: 'claude-sonnet-5-5', effort: 'max' }, mate)).toBe(true);
    expect(aboveMate({ model: 'claude-haiku-5-5', effort: 'low' }, mate)).toBe(false);
    expect(aboveMate({ model: 'my-model', effort: 'high' }, mate)).toBe(false);
  });
});

describe('words for the settings', () => {
  it('turns a model id into its name', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-haiku-5-5')).toBe('Haiku 5.5');
    expect(modelLabel('my-model')).toBe('my-model');
  });

  it('reads a schedule as days and a time, and writes it back', () => {
    expect(simpleCron('30 9 * * 1-5')).toEqual({ days: '1-5', time: '09:30' });
    expect(simpleCron('0 16 * * 5')).toEqual({ days: '5', time: '16:00' });
    expect(simpleCron('15 9,13,17 * * 1-5')).toBeNull();
    expect(simpleCron('0 9 * * 2-4')).toBeNull();
    expect(cronAt('*', '07:05')).toBe('5 7 * * *');
    expect(cronWords('30 9 * * 1-5')).toBe('Weekdays 09:30');
    expect(cronWords('15 10-18/2 * * 1-5')).toBe('cron 15 10-18/2 * * 1-5');
  });
});
