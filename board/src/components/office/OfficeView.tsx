/**
 * Deck: the crew in a harbour, one boat per department, every agent at its post (a switched-off one leaves an empty
 * seat). Whoever is waiting for you waves a flag at its post, and anyone stuck slumps there. The same crew is in the
 * muster list, which is the whole screen on a phone or when the browser cannot draw 3D, and the way in for keyboards and
 * screen readers. Clicking a sailor shows its card on the
 * Deck, with buttons for its sign-off, task, transcript or settings; nothing leaves the Deck until one is pressed.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { LEAD } from '../../labels';
import { MOOD_LABEL, SCARF, STATIONS, boatOf, officeModel, officeSummary, sailorActions, type Boat, type Mood, type Office, type Sailor, type SailorAction } from '../../lib/office';
import { ui, uiStore, useUi } from '../../lib/ui';
import type { CrewState } from '../../types';
import { Icon, KeyLink, PageHeader, cls, useMedia, useNow } from '../common';

type Mode = 'ship' | 'list';
const MODE_KEY = 'keel.office';

const readMode = (fallback: Mode): Mode => {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === 'ship' || v === 'list' ? v : fallback;
  } catch {
    return fallback;
  }
};
const saveMode = (m: Mode) => {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* a per-viewer convenience only */
  }
};

function run(a: SailorAction): void {
  if (a.kind === 'card') ui.showCard(a.id);
  else if (a.kind === 'task') ui.openTask(a.key);
  else if (a.kind === 'chat') ui.openChat();
  else if (a.kind === 'transcript') ui.openTranscript(a.id);
  else if (a.kind === 'agent') ui.openSettings('crew');
  else ui.setView('crew');
}

const ACTION_LABEL: Record<SailorAction['kind'], string> = {
  card: 'Open sign-off',
  task: 'Open task',
  chat: `Talk to the ${LEAD}`,
  transcript: 'Transcript',
  agent: 'Agent settings',
  crew: 'See in Muster',
};

/** A card over the ship's top-right corner; Escape or its X closes it, and its first button takes focus. */
function DeckCard({ title, scarf, label, focusKey, onClose, children }: { title: string; scarf: string; label: string; focusKey: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLElement>(null);
  useEffect(() => box.current?.querySelector<HTMLButtonElement>('.sc-body button')?.focus({ preventScroll: true }), [focusKey]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <section ref={box} className="sailor-card" aria-label={label}>
      <header>
        <i className="scarf" style={{ background: scarf }} aria-hidden />
        <b>{title}</b>
        <button type="button" className="btn icon ghost sm" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>
      <div className="sc-body">{children}</div>
    </section>
  );
}

/** The clicked sailor: who, where, what it is doing, and what to open. */
function SailorCard({ s, onClose }: { s: Sailor; onClose: () => void }) {
  const where = STATIONS.find((x) => x.id === s.station)?.name ?? s.station;
  return (
    <DeckCard title={s.name} scarf={s.off ? 'transparent' : SCARF[s.mood]} label={`${s.name}, ${s.off ? 'switched off' : MOOD_LABEL[s.mood]}`} focusKey={s.id} onClose={onClose}>
      <p className={cls('sc-where', s.off ? 'm-off' : `m-${s.mood}`)}>
        {where}, {s.off ? 'switched off' : MOOD_LABEL[s.mood].toLowerCase()}
        {s.taskKey ? <span className="mono"> {s.taskKey}</span> : null}
      </p>
      {s.detail && s.detail !== MOOD_LABEL[s.mood] && !s.off ? <p className="sc-detail">{s.detail}</p> : null}
      {s.cards > 1 || (s.cards && s.mood !== 'waiting') ? <p className="sc-you">{s.cards === 1 ? '1 item waiting for you' : `${s.cards} items waiting for you`}</p> : null}
      <div className="sc-acts">
        {sailorActions(s).map((a, i) => (
          <button key={a.kind} type="button" className={cls('btn sm', i === 0 ? 'primary' : 'ghost')} onClick={() => run(a)}>
            {ACTION_LABEL[a.kind]}
          </button>
        ))}
      </div>
    </DeckCard>
  );
}

/** A department's boat: who is aboard, who is switched off, and where to change that. */
function BoatCard({ boat, crew, onPick, onClose }: { boat: Boat; crew: Sailor[]; onPick: (id: string) => void; onClose: () => void }) {
  return (
    <DeckCard title={boat.deptName} scarf={boat.colour} label={boat.on ? `${boat.deptName}, ${boat.agentsOn} of ${boat.agents} on` : `${boat.deptName}, off`} focusKey={`boat:${boat.id}`} onClose={onClose}>
      <p className="sc-where">{boat.on ? `${boat.name}: ${boat.agentsOn} of ${boat.agents} agents on` : `${boat.name}, moored: the department is off`}</p>
      {crew.length ? (
        <ul className="sc-list">
          {crew.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => onPick(s.id)}>
                <i className="scarf" style={{ background: s.off ? 'transparent' : SCARF[s.mood] }} aria-hidden />
                <span>{s.name}</span>
                <span className={cls('sc-state', s.off ? 'off' : `m-${s.mood}`)}>{s.off ? 'Switched off' : MOOD_LABEL[s.mood]}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="sc-acts">
        <button type="button" className="btn sm ghost" onClick={() => ui.openSettings('crew')}>
          {boat.on ? 'Crew settings' : 'Turn on in Crew settings'}
        </button>
      </div>
    </DeckCard>
  );
}

const LEGEND: [Mood, string][] = [
  ['working', 'Working, or thinking with a hand to the chin'],
  ['waiting', 'Waiting for you, waving a flag at their post'],
  ['stuck', 'Stuck or paused'],
  ['done', 'Just finished, holding a mug'],
  ['idle', 'Idle'],
];

/** The 3D ship, loaded on first use and torn down when the screen closes. */
function ShipPane({ office, onFail }: { office: Office; onFail: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const ship = useRef<import('../../ship').Ship | null>(null);
  const latest = useRef(office);
  latest.current = office;
  const { chart } = useUi();
  const still = useMedia('(prefers-reduced-motion: reduce)');
  const [ready, setReady] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const close = useCallback(() => setPicked(null), []);
  const sailor = picked ? office.sailors.find((s) => s.id === picked) : undefined;
  const boat = picked?.startsWith('boat:') ? office.boats.find((b) => `boat:${b.id}` === picked) : undefined;

  useEffect(() => {
    let live = true;
    const el = host.current;
    if (!el) return;
    import('../../ship')
      .then((m) => m.mountShip(el, { motion: !still, theme: uiStore.get().chart, onPick: (s) => setPicked(s?.id ?? null), onBoat: (id) => setPicked(`boat:${id}`), onProp: (kind) => kind === 'board' && ui.setView('crew') }))
      .then((s) => {
        if (!live) return s.dispose();
        ship.current = s;
        s.setTheme(uiStore.get().chart);
        s.update(latest.current);
        setReady(true);
      })
      .catch(() => live && onFail());
    return () => {
      live = false;
      ship.current?.dispose();
      ship.current = null;
      setReady(false);
    };
  }, [still, onFail]);
  useEffect(() => ship.current?.update(office), [office]);
  useEffect(() => ship.current?.setTheme(chart), [chart]);

  return (
    <div className="ship-wrap">
      <div className="ship-stage">
        <div ref={host} className="ship">
          {ready ? null : <p className="ship-loading">Rigging the harbour…</p>}
        </div>
        {sailor ? <SailorCard s={sailor} onClose={close} /> : boat ? <BoatCard boat={boat} crew={office.sailors.filter((x) => boatOf(x.station) === boat.id)} onPick={setPicked} onClose={close} /> : null}
      </div>
      <p className="ship-hint">Drag to turn, scroll in to see every name. Click a sailor, or a boat's label, to see who it is and what to open.</p>
    </div>
  );
}

function Muster({ office }: { office: Office }) {
  return (
    <div className="muster">
      {office.boats.map((b) => {
        const crew = office.stations.filter((st) => st.boat === b.id).flatMap((st) => st.sailors);
        return (
          <section key={b.id} className={cls('muster-st', !b.on && 'off')} style={{ '--dept': b.colour } as CSSProperties} aria-label={b.deptName}>
            <h2>
              {b.deptName}
              <span className="count">{b.on ? `${b.agentsOn} of ${b.agents} on` : 'off'}</span>
              <span className="st-blurb">{b.on ? (b.id === 'flagship' ? 'Flagship: the Mate and Engineering' : b.name) : `${b.name}, moored under a cover. Turn its team on in Settings → Crew.`}</span>
            </h2>
            {crew.length ? (
              <ul>
                {crew.map((s) => (
                  <li key={s.id}>
                    <button type="button" className={cls('muster-row', s.off && 'off')} onClick={() => run(sailorActions(s)[0])}>
                      <i className="scarf" style={{ background: s.off ? 'transparent' : SCARF[s.mood] }} aria-hidden />
                      <b>{s.name}</b>
                      <span className={cls('mr-mood', s.off ? 'm-off' : `m-${s.mood}`)}>{s.off ? 'Switched off' : s.id === 'lead' && s.cards ? `${s.cards} for you` : MOOD_LABEL[s.mood]}</span>
                      <span className="mr-detail">{s.off ? 'Turn it on in Settings → Crew' : s.detail}</span>
                    </button>
                    {s.taskKey ? <KeyLink k={s.taskKey} /> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

export function OfficeView({ crew }: { crew: CrewState }) {
  const now = useNow(30_000);
  const office = useMemo(() => officeModel(crew, now), [crew, now]);
  const phone = useMedia('(max-width: 640px)');
  const [mode, setMode] = useState<Mode>(() => readMode('ship'));
  const [broken, setBroken] = useState(false);
  const fail = useCallback(() => setBroken(true), []);
  const shown: Mode = phone || broken ? 'list' : mode;
  const pick = (m: Mode) => {
    setMode(m);
    saveMode(m);
  };

  return (
    <div className="view office">
      <PageHeader
        title="Deck"
        status={officeSummary(office)}
        actions={
          phone || broken ? null : (
            <div className="seg" role="group" aria-label="Show the crew as">
              {(['ship', 'list'] as const).map((m) => (
                <button key={m} type="button" aria-pressed={shown === m} onClick={() => pick(m)}>
                  {m === 'ship' ? 'Ship' : 'List'}
                </button>
              ))}
            </div>
          )
        }
      />
      {broken ? <p className="note">This browser can’t draw the 3D ship, so the crew is shown as a list.</p> : null}
      {shown === 'ship' ? (
        <>
          <ShipPane office={office} onFail={fail} />
          <ul className="ship-legend" aria-label="What the neckerchief colours mean">
            {LEGEND.map(([m, label]) => (
              <li key={m}>
                <i style={{ background: SCARF[m] }} aria-hidden />
                {label}
              </li>
            ))}
            <li>
              <i className="off" aria-hidden />
              Folded cap on an empty seat: switched off
            </li>
          </ul>
        </>
      ) : (
        <Muster office={office} />
      )}
    </div>
  );
}
