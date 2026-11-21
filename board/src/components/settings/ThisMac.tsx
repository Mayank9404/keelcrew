/** Settings → This Mac: the apps the board opens, how crew sessions keep their context small, the Harbour look and the setup check. */
import { EDITOR_LABEL, LEAD } from '../../labels';
import type { CrewConfig } from '../../types';
import { Switch } from '../common';
import { DoctorList } from '../Doctor';
import { Row, Section, type SetConfig } from './parts';

const EDITORS: CrewConfig['editor'][] = ['cursor', 'pycharm', 'vscode', 'sublime', 'zed'];
const COMPACT_WINDOWS: ['auto' | number, string][] = [
  ['auto', 'The model’s own limit'],
  [200_000, '200k tokens'],
  [300_000, '300k tokens'],
  [400_000, '400k tokens'],
  [600_000, '600k tokens'],
  [800_000, '800k tokens'],
  [1_000_000, '1M tokens'],
];
/** The compaction choices, plus the Mac's current value when the list doesn't offer it. */
const compactOptions = (cur: 'auto' | number): ['auto' | number, string][] =>
  COMPACT_WINDOWS.some(([v]) => v === cur) ? COMPACT_WINDOWS : [...COMPACT_WINDOWS, [cur, `${Math.round(Number(cur) / 1000)}k tokens`]];

export function ThisMacSection({ draft, set, canWrite }: { draft: CrewConfig; set: SetConfig; canWrite: boolean }) {
  return (
    <Section id="mac" title="This Mac" lead="The apps the board opens, how crew sessions stay fast, and the Mate’s look in the Claude app.">
      <fieldset className="set-fields" disabled={!canWrite}>
        <Row label="Code editor" hint="Open in editor uses it.">
          <select value={draft.editor} aria-label="Code editor" onChange={(e) => set((c) => void (c.editor = e.target.value as CrewConfig['editor']))}>
            {EDITORS.map((x) => (
              <option key={x} value={x}>
                {EDITOR_LABEL[x]}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Open crew sessions in" hint="Where Open takes you. The Claude app also lists them in its sidebar.">
          <select value={draft.terminal} aria-label="Open crew sessions in" onChange={(e) => set((c) => void (c.terminal = e.target.value as CrewConfig['terminal']))}>
            <option value="desktop">Claude app</option>
            <option value="warp">Warp</option>
            <option value="terminal">Terminal</option>
          </select>
        </Row>
        <Row label="Summarise sessions at" hint={`Crew sessions summarise their history at this size, so they stay fast. lead.md and the board keep what matters. Applies from a session’s next turn.`}>
          <select value={String(draft.compactWindow ?? 'auto')} aria-label="Summarise sessions at" onChange={(e) => set((c) => void (c.compactWindow = e.target.value === 'auto' ? 'auto' : Number(e.target.value)))}>
            {compactOptions(draft.compactWindow ?? 'auto').map(([v, label]) => (
              <option key={v} value={String(v)}>
                {label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Summarise engineers between turns" hint={`Right after a turn, while it’s cheap, once a session passes 200k tokens or its ticket starts waiting. The ${LEAD} keeps its own limit.`}>
          <Switch checked={draft.org.compaction?.enabled === true} onChange={(v) => set((c) => void ((c.org ??= {}).compaction = { enabled: v }))} label={<span className="sr-only">Summarise engineers between turns</span>} />
        </Row>
        <Row label="Harbour light look" hint={`The ${LEAD}’s chat in the Claude app shows a harbour behind it: a pennant while cards wait for you, today’s watches and the crew at the jetty.`}>
          <Switch checked={draft.harbourLook} onChange={(v) => set((c) => void (c.harbourLook = v))} label={<span className="sr-only">Harbour light look</span>} />
        </Row>
        <Row label="Push notifications" hint="Launch cards, failed QA and urgent cards reach your phone and this Mac through the Claude app. Off by default; the bell mutes them for a while.">
          <Switch checked={draft.pushNotifications} onChange={(v) => set((c) => void (c.pushNotifications = v))} label={<span className="sr-only">Push notifications</span>} />
        </Row>
      </fieldset>
      <h3 className="sset-sub" id="set-health">
        Setup check
      </h3>
      <p className="note">Checks Keelcrew’s setup on this Mac each time you open Settings.</p>
      <fieldset className="set-fields" disabled={!canWrite}>
        <DoctorList autoRun />
      </fieldset>
    </Section>
  );
}
