import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_CHOICES, isThemePref, readThemePref, resolveTheme } from '../src/lib/theme';

const css = readFileSync(fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url)), 'utf8');
/** The colour tokens one theme block sets. */
function block(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  const body = css.slice(at, css.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2]]));
}
const day = block(':root');
const THEMES: Record<string, Record<string, string>> = { day, dusk: { ...day, ...block(':root[data-chart="dusk"]') }, night: { ...day, ...block(':root[data-chart="night"]') } };

const lum = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

describe('themes', () => {
  it('resolves a choice: a named theme is itself, auto follows the host page and then the system', () => {
    expect(resolveTheme('dusk', 'dark', true)).toBe('dusk');
    expect(resolveTheme('auto', null, false)).toBe('day');
    expect(resolveTheme('auto', null, true)).toBe('night');
    expect(resolveTheme('auto', 'light', true)).toBe('day');
    expect(resolveTheme('auto', 'dark', false)).toBe('night');
  });

  it('offers Day, Dusk, Night and Auto, and defaults to Day when nothing is saved or storage is blocked', () => {
    expect(THEME_CHOICES.map(([id]) => id)).toEqual(['day', 'dusk', 'night', 'auto']);
    expect(isThemePref('night')).toBe(true);
    expect(isThemePref('dark')).toBe(false);
    expect(readThemePref()).toBe('day');
  });

  it('gives Dusk and Night every colour token Day has', () => {
    const colours = Object.keys(day).filter((k) => !k.startsWith('code-'));
    for (const name of ['dusk', 'night']) expect(Object.keys(block(`:root[data-chart="${name}"]`)).sort(), name).toEqual(colours.sort());
  });

  it.each(Object.keys(THEMES))('%s: text reads on every surface it sits on (4.5 to 1)', (name) => {
    const t = THEMES[name];
    const pairs: [string, string][] = [];
    for (const text of ['fg', 'fg-2', 'muted', 'faint', 'link', 'you', 'block', 'ok', 'qa', 'warn', 'agent', 'work']) for (const ground of ['surface', 'surface-2']) pairs.push([text, ground]);
    for (const text of ['fg', 'muted', 'link', 'you', 'block']) pairs.push([text, 'bg'], [text, 'surface-3']);
    for (const text of ['fg', 'link', 'you', 'block', 'buff-ink']) pairs.push([text, 'buff']);
    pairs.push(['fg', 'you-wash'], ['you', 'you-wash'], ['on-ink', 'ink']);
    // Text on a filled state colour uses the surface or the on-ink colour.
    for (const fill of ['you', 'block', 'ok', 'warn']) pairs.push(['surface', fill]);
    pairs.push(['on-ink', 'you']);
    const low = pairs.filter(([a, b]) => contrast(t[a], t[b]) < 4.5).map(([a, b]) => `${a} on ${b}: ${contrast(t[a], t[b]).toFixed(2)}`);
    expect(low).toEqual([]);
  });
});
