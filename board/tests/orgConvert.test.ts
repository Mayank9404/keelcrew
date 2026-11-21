import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { mergesOf, orgInfoOf, spendOf, toInbox, toTask, type Row } from '../src/board/convert';
import { SourceTags } from '../src/components/cards/ProposalCard';
import { StaffBits } from '../src/components/parts/TaskBits';
import { normalizeManifest } from '../src/lib/agents';
import { outcome } from '../src/lib/inbox';
import { cardsForYou, heldCards, rankCards } from '../src/lib/triage';
import type { InboxItem, Task } from '../src/types';
import { card, crew, task } from './build';

const row = (id: string, body: Record<string, unknown>): Row => ({ ...body, _id: id, _v: 'v1' });
const ctx = { overlaps: {}, now: 1000 };

describe('rows and cards of the company', () => {
  it('reads a task row’s goal, merge and auto-start, and tells a contractor', () => {
    const t = toTask(row('D-1', { status: 'pr', goal: 'g1', mergedAt: 5, autoStarted: true }), ctx);
    expect([t.contractor, t.goal, t.mergedAt, t.autoStarted]).toEqual([false, 'g1', 5, true]);
    expect(toTask(row('D-2', { status: 'active', role: 'contractor' }), ctx).contractor).toBe(true);
    expect(toTask(row('D-3', { status: 'active' }), ctx)).toMatchObject({ contractor: false, goal: null, mergedAt: null, autoStarted: false });
  });

  it('reads rank, held and a suggestion’s source on cards', () => {
    const c = toInbox(row('q1', { kind: 'proposal', from: 'suggest', rank: 2, held: true, heldReason: 'can wait', source: 'deps', impact: 'high', security: true, urgent: true }));
    expect(c).toMatchObject({ rank: 2, held: true, heldReason: 'can wait', source: 'deps', security: true, urgent: true });
    expect(toInbox(row('q2', {}))).toMatchObject({ rank: null, held: false, source: null, security: false });
  });

  it('tags a task the Mate started by itself, after who works it', () => {
    const staff = (t: Task) => renderToStaticMarkup(createElement(StaffBits, { crew: crew(), task: t }));
    expect(staff(task('D-1', { sessionId: 's1', autoStarted: true }))).toMatch(/^<span class="staff">engineer<\/span><span class="tag"[^>]*>auto-started<\/span>$/);
    expect(staff(task('D-2', { sessionId: 's2' }))).toBe('<span class="staff">engineer</span>');
  });

  it('tags a suggestion’s card with its source, and a security finding once', () => {
    const tags = (p: Partial<InboxItem>) => renderToStaticMarkup(createElement(SourceTags, { item: card('p1', { kind: 'proposal', from: 'suggest', ...p }) }));
    expect(tags({ source: 'errors' })).toBe('<span class="tag">errors</span>');
    expect(tags({ source: 'deps', security: true })).toBe('<span class="tag">deps</span><span class="tag block">security</span>');
    expect(tags({ source: 'security', security: true })).toBe('<span class="tag block">security</span>');
    expect(tags({ from: 'cto', source: 'errors' })).toBe('');
  });

  it('says when the Mate started a suggestion by itself', () => {
    const c = toInbox(row('proposal-suggest-a', { kind: 'proposal', from: 'suggest', status: 'answered', answer: 'Start it', autoStarted: true }));
    expect([c.autoStarted, outcome(c)]).toEqual([true, 'Started by the Mate, within your auto-start settings.']);
    expect(outcome(toInbox(row('proposal-suggest-b', { kind: 'proposal', from: 'suggest', status: 'answered', answer: 'Start it' })))).toBe('You answered “Start it”.');
  });

  it('reads the manifests’ department, kind and proposed model', () => {
    const m = normalizeManifest({ id: 'cto', name: 'CTO', summary: 's', kind: 'scheduled', skill: 'keel-cto', department: 'engineering', memberKind: 'agent', proposedModel: { model: 'claude-opus-5-5', effort: 'high' } })!;
    expect([m.department, m.memberKind, m.proposedModel]).toEqual(['engineering', 'agent', { model: 'claude-opus-5-5', effort: 'high' }]);
    expect(normalizeManifest({ id: 'qa', name: 'QA', summary: 's', kind: 'ticket', skill: 'keel-qa' })).toMatchObject({ department: null, memberKind: 'agent', proposedModel: null });
  });
});

describe('what the Mac hands the board', () => {
  it('reads allowances and spend flags', () => {
    const s = spendOf({ at: 2, departments: { engineering: { allowancePct: 60, usedPct: 31.5, spentUsd: 12 }, bad: 3 }, flags: { 'D-1': { level: 'hard', spendUsd: 40, softUsd: 20, hardUsd: 30, at: 3 }, 'D-2': { level: 'weird' } } });
    expect(s?.departments).toEqual({ engineering: { allowancePct: 60, usedPct: 31.5, spentUsd: 12 } });
    expect(s?.flags).toEqual({ 'D-1': { level: 'hard', spendUsd: 40, softUsd: 20, hardUsd: 30, at: 3 } });
    expect(spendOf({ flags: {} })).toBeNull();
  });

  it('reads merges, from the file’s prUrl too, and drops ones without a known target', () => {
    expect(mergesOf({ at: 1, merges: [{ key: 'D-1', prUrl: 'u1', prNumber: 1, mergedAt: 5, mergeSha: 'abc', target: 'done' }, { key: 'D-2', target: 'shipped' }, 'junk'] })).toEqual([
      { key: 'D-1', url: 'u1', mergedAt: 5, target: 'done' },
    ]);
    expect(mergesOf(null)).toEqual([]);
  });

  it('reads the org: departments in order with their switches and goals', () => {
    const o = orgInfoOf({
      departments: [{ id: 'product', name: 'Product', order: 2, switchable: true, defaultEnabled: true, budgetShare: 0.15 }, { id: 'ceo', name: 'CEO office', order: 0, switchable: true, defaultEnabled: false }],
      org: { ceo: true, departments: [{ id: 'ceo', enabled: true }, { id: 'product', enabled: false }], roles: [{ id: 'pm', department: 'product', memberKind: 'agent', enabled: false }], goals: [{ id: 'g1', title: 'Ship', weight: 2 }] },
    });
    expect(o?.departments.map((d) => [d.id, d.enabled])).toEqual([['ceo', true], ['product', false]]);
    expect(o?.goals[0].weight).toBe(2);
    expect(orgInfoOf({ departments: [] })).toBeNull();
  });

});

describe('the Chief of Staff’s order', () => {
  it('keeps its ranks, after urgent cards it has not ranked yet and before unranked ones', () => {
    const list = [card('old-q', { createdAt: 1 }), card('r2', { rank: 2 }), card('urgent', { urgent: true }), card('r1', { rank: 1, createdAt: 9 }), card('ship', { kind: 'ship' })];
    expect(rankCards(list).map((c) => c.id)).toEqual(['urgent', 'r1', 'r2', 'ship', 'old-q']);
  });

  it('keeps held cards out of what needs you until tomorrow', () => {
    const c = crew({ inbox: [card('a'), card('h', { held: true, heldReason: 'can wait' }), card('done', { held: true, status: 'answered' })] });
    c.config.org = { departments: { ceo: { enabled: true } } };
    expect(cardsForYou(c).map((x) => x.id)).toEqual(['a']);
    expect(heldCards(c).map((x) => x.id)).toEqual(['h']);
  });

  it('ignores held with the CEO seat off: only the Chief of Staff clears it, so the card comes straight to you', () => {
    const c = crew({ inbox: [card('a'), card('h', { held: true, heldReason: 'can wait' })] });
    expect(cardsForYou(c).map((x) => x.id)).toEqual(['a', 'h']);
    expect(heldCards(c)).toEqual([]);
  });
});
