/**
 * The Deck's 3D harbour, mounted into an element. The Deck screen loads this module only when it opens, builds one
 * harbour per visit, hands it the `Office` model on every poll (sailors change mood without a rebuild, keep their berth, and the
 * camera stays where the viewer left it), and disposes of everything when it closes.
 *
 * The flagship carries the Mate and Engineering; every other department has its own boat, out on the water when its
 * department is on and moored under a cover when it is off. Over the canvas: a label per boat ("Product & Design · 3 of
 * 4 on"), a name chip per sailor (shown once the viewer zooms in; always for anyone waiting for you or stuck), a "more"
 * chip for a post with more crew than berths, and a tip on hover. Chips are buttons that keep their element across
 * polls, so keyboard focus stays put. The muster list carries the same crew for keyboards and screen readers.
 */
import * as THREE from 'three';
import { clock } from '../lib/format';
import { BOATS, berths, boatOf, MOOD_LABEL, officeSummary, type BoatId, type Office, type Sailor, type StationId } from '../lib/office';
import type { Theme } from '../lib/theme';
import { buildCoast, OFFICE, OFFICE_ROOF, type Coast } from './coast';
import type { Glows, Yard } from './fittings';
import { buildFleet, type SmallBoat } from './fleet';
import { buildHarbourmaster, type Harbourmaster } from './harbourmaster';
import { buildDeck, type Berth, type Deck } from './hull';
import { ORDER, softSpot } from './paint';
import { Bin, Shapes, paints } from './parts';
import { SailorFigure, sailorParts } from './sailor';
import { Stage } from './stage';

export interface ShipOptions {
  motion: boolean;
  theme: Theme;
  /** A sailor was clicked, or empty water (null): the screen shows or closes that sailor's card. */
  onPick(s: Sailor | null): void;
  /** A boat's label was clicked: the screen shows that department's card. */
  onBoat(id: BoatId): void;
  /** A prop on the harbourmaster's terrace was clicked: the harbour board, the radio cabinet or the signal mast. */
  onProp(kind: 'board' | 'helper' | 'signals'): void;
}

export interface Ship {
  update(office: Office): void;
  setTheme(theme: Theme): void;
  dispose(): void;
}

const FONTS = ['600 64px "Literata"', '600 30px "JetBrains Mono"', '700 15px "Archivo"'];
const about = (s: Sailor) => `${s.name}. ${s.off ? 'Switched off' : MOOD_LABEL[s.mood]}${s.detail && !s.off ? `: ${s.detail}` : ''}`;
/** Sailors are drawn a size up from the figure's own units, so they read at the default camera distance. */
const SIZE = 1.2;
/** Closer than this (camera to target) and every sailor's name shows. */
const NAMES_WITHIN = 47;
/** Where a chip floats: just above the sailor's hat, or above an empty seat. */
const overHead = (b: Berth, off: boolean) => (off ? b.seat + 0.55 : b.seat ? b.seat + 1.25 * SIZE : 1.75 * SIZE);

interface Placed {
  root: THREE.Object3D;
  fig: SailorFigure | null;
  sailor: Sailor;
  station: StationId;
  spot: number;
  berth: Berth;
}

interface Tag {
  el: HTMLElement;
  at: THREE.Vector3;
  ride?: THREE.Object3D;
  used: boolean;
}

export async function mountShip(host: HTMLElement, opts: ShipOptions): Promise<Ship> {
  // Lettering is painted onto canvases, so the faces must be ready first.
  await Promise.all(FONTS.map((f) => document.fonts.load(f).catch(() => [])));
  const canvas = document.createElement('canvas');
  canvas.className = 'ship-canvas';
  canvas.setAttribute('role', 'img');
  const tags = document.createElement('div');
  tags.className = 'ship-tags';
  const tip = document.createElement('div');
  tip.className = 'ship-tip';
  tip.hidden = true;
  host.append(canvas, tags, tip);

  const bin = new Bin();
  const scratch = new THREE.Vector3();
  const placed = new Map<string, Placed>();
  const floating = new Map<string, Tag>();
  let stage: Stage | null = null;
  let deck: Deck;
  let fleet: ReturnType<typeof buildFleet>;
  let parts: ReturnType<typeof sailorParts>;
  let seatTemplate: THREE.Group;
  let coast: Coast;
  let master: Harbourmaster;
  try {
    const p = paints(bin);
    const glows: Glows = { screens: [], pools: [], lamps: [], glass: [p.glow], windows: [], beams: [] };
    const yard: Yard = { bin, s: new Shapes(bin), p, glows, spot: softSpot(bin) };
    parts = sailorParts(bin, p);
    const scene = new THREE.Scene();
    deck = buildDeck(yard, scene);
    coast = buildCoast(yard, scene);
    master = buildHarbourmaster(yard, scene, OFFICE, OFFICE_ROOF);
    fleet = buildFleet(yard, scene, (dept) => BOATS.find((b) => b.dept === dept)?.colour ?? '#7A8494');
    // A folded jersey and cap, left where a switched-off hand would sit.
    seatTemplate = new THREE.Group();
    yard.s.box(seatTemplate, [0.44, 0.1, 0.34], p.white, [0, 0.05, 0], 0.03);
    yard.s.box(seatTemplate, [0.44, 0.04, 0.07], p.navy, [0, 0.11, -0.07], 0.01);
    yard.s.post(seatTemplate, 0.12, 0.14, 0.09, p.navy, [0.05, 0.16, 0.04], 16);
    yard.s.box(seatTemplate, [0.2, 0.02, 0.12], p.black, [0.05, 0.12, 0.17], 0.01);
    const ticks = [...deck.ticks, ...coast.ticks, ...master.ticks, ...fleet.ticks];
    const s: Stage = new Stage(host, canvas, glows, opts.motion, {
      frame: (t, dt) => {
        if (opts.motion) for (const tick of ticks) tick(t, dt);
        for (const { fig } of placed.values()) fig?.tick(t, opts.motion ? 1 : 0);
      },
      drawn: () => {
        host.classList.toggle('near', s.camera.position.distanceTo(s.controls.target) < NAMES_WITHIN);
        // Three passes (project, measure, place) so the browser lays the chips out once per frame, not once per chip.
        // A chip that would sit on one placed before it is lifted, or moved aside when lifting would take it too far from its
        // sailor, so names stack instead of piling up.
        const boxes: { l: number; r: number; t: number; b: number }[] = [];
        const spots: { el: HTMLElement; q: { x: number; y: number } }[] = [];
        for (const { el, at, ride } of floating.values()) {
          const q = s.project(ride ? ride.localToWorld(scratch.copy(at)) : at);
          el.hidden = !q;
          if (q) spots.push({ el, q });
        }
        // A quiet name hidden by the stylesheet (not zoomed in) measures 0 wide and takes no room.
        // Lowest on screen first: a higher name then needs at most one chip height of lift to clear it.
        const width = host.clientWidth;
        const sized = spots.map((x) => ({ ...x, w: x.el.offsetWidth, h: x.el.offsetHeight })).sort((a, b) => b.q.y - a.q.y);
        for (const { el, q, w, h } of sized) {
          if (!w) continue;
          let [x, y] = [q.x, q.y];
          for (let i = 0; i < 6; i++) {
            const hit = boxes.find((o) => x - w / 2 < o.r + 2 && x + w / 2 > o.l - 2 && y - h < o.b && y > o.t);
            if (!hit) break;
            // Lift at most a few chip heights, so a name never drifts away from its sailor; past that, step aside.
            if (q.y - (hit.t - 2) <= h * 2.6) y = hit.t - 2;
            else {
              // Toward the side with room, so a name near the edge isn't pushed out of the picture.
              const [left, right] = [hit.l - w / 2 - 2, hit.r + w / 2 + 2];
              x = right <= width - w / 2 && (left < w / 2 || x >= (hit.l + hit.r) / 2) ? right : left;
            }
          }
          boxes.push({ l: x - w / 2, r: x + w / 2, t: y - h, b: y });
          el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
        }
      },
    });
    stage = s;
    s.scene.add(...scene.children);
    s.castShadows();
  } catch (err) {
    stage?.dispose();
    bin.dispose();
    canvas.remove();
    tags.remove();
    tip.remove();
    throw err;
  }
  const st: Stage = stage;
  const allBerths: Partial<Record<StationId, Berth[]>> = { ...deck.berths, ...fleet.berths };

  /** The sailor under a point on the canvas, if any. Hidden props (a flag or mug not in hand) don't count. */
  const ray = new THREE.Raycaster();
  const shown = (o: THREE.Object3D | null): boolean => !o || (o.visible && shown(o.parent));
  /** The sailor, or the terrace prop, under a point on the canvas. */
  const pick = (e: PointerEvent): { sailor?: Placed; prop?: THREE.Object3D } => {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), st.camera);
    const roots = [...[...placed.values()].map((x) => x.root), ...master.props];
    let o: THREE.Object3D | null = ray.intersectObjects(roots, true).find((h) => shown(h.object))?.object ?? null;
    while (o && !o.userData.sailorId && !o.userData.prop) o = o.parent;
    if (!o) return {};
    return o.userData.prop ? { prop: o } : { sailor: placed.get(o.userData.sailorId as string) };
  };
  const onMove = (e: PointerEvent) => {
    if (e.buttons) return;
    const { sailor: hit, prop } = pick(e);
    canvas.style.cursor = hit || prop?.userData.prop === 'board' ? 'pointer' : '';
    tip.hidden = !hit && !prop;
    if (!hit && !prop) return;
    const r = host.getBoundingClientRect();
    const [title, line] = prop ? ((prop.userData.tip as [string, string] | undefined) ?? ['', '']) : [hit!.sailor.name, hit!.sailor.off ? 'Switched off' : `${MOOD_LABEL[hit!.sailor.mood]}${hit!.sailor.detail ? `: ${hit!.sailor.detail}` : ''}`];
    const name = Object.assign(document.createElement('b'), { textContent: title });
    const what = Object.assign(document.createElement('span'), { textContent: line });
    tip.replaceChildren(name, what);
    const x = Math.min(e.clientX - r.left + 14, r.width - tip.offsetWidth - 8);
    const y = Math.min(e.clientY - r.top + 14, r.height - tip.offsetHeight - 8);
    tip.style.transform = `translate(${Math.max(0, x)}px, ${Math.max(0, y)}px)`;
  };
  let down: { x: number; y: number } | null = null;
  const onDown = (e: PointerEvent) => void (down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null);
  const onUp = (e: PointerEvent) => {
    const click = e.button === 0 && down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5;
    down = null;
    if (!click) return;
    const { sailor: hit, prop } = pick(e);
    if (prop) opts.onProp(prop.userData.prop);
    else opts.onPick(hit?.sailor ?? null);
  };
  const onLeave = () => void (tip.hidden = true);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', onLeave);

  /** Show a chip, reusing the element it had last poll so focus on it survives. */
  const float = (key: string, at: readonly [number, number, number], ride: THREE.Object3D | undefined, text: string, className: string, title: string, onClick?: () => void, dot?: string) => {
    let t = floating.get(key);
    if (!t) {
      const el = document.createElement(onClick ? 'button' : 'span');
      if (el instanceof HTMLButtonElement) el.type = 'button';
      // Hidden until the next draw puts it in place, so it never shows in the corner.
      el.hidden = true;
      tags.append(el);
      t = { el, at: new THREE.Vector3(), used: true };
      floating.set(key, t);
    }
    t.used = true;
    t.ride = ride;
    t.at.set(at[0], at[1], at[2]);
    t.el.className = className;
    t.el.textContent = text;
    t.el.title = title;
    if (dot) t.el.style.setProperty('--dept', dot);
    t.el.onclick = onClick ?? null;
  };

  /** Seat a post's sailors: those already there keep their berth; newcomers take the first free one. */
  const seat = (station: StationId, crew: Sailor[], spots: Berth[]): [Sailor, number][] => {
    const taken = new Set<number>();
    const out: [Sailor, number][] = [];
    const later: Sailor[] = [];
    for (const s of crew) {
      const was = placed.get(s.id);
      if (was && was.station === station && was.spot < spots.length && !taken.has(was.spot)) {
        taken.add(was.spot);
        out.push([s, was.spot]);
      } else later.push(s);
    }
    // A newcomer takes the berth laid out for its agent when that is free, else the first free one meant for nobody.
    const pickFor = (agent: string): number => {
      const own = spots.findIndex((b, i) => !taken.has(i) && b.agent === agent);
      if (own >= 0) return own;
      const open = spots.findIndex((b, i) => !taken.has(i) && !b.agent);
      return open >= 0 ? open : spots.findIndex((_, i) => !taken.has(i));
    };
    for (const s of later) {
      const i = pickFor(s.agent);
      taken.add(i);
      out.push([s, i]);
    }
    return out;
  };

  const make = (sailor: Sailor): Pick<Placed, 'root' | 'fig'> => {
    if (sailor.off) {
      const root = seatTemplate.clone(true);
      root.userData.sailorId = sailor.id;
      return { root, fig: null };
    }
    const fig = new SailorFigure(parts, sailor.id, sailor.agent, sailor.home, sailor.mood);
    fig.root.scale.setScalar(SIZE);
    return { root: fig.root, fig };
  };

  const ship: Ship = {
    update(office) {
      canvas.setAttribute('aria-label', `The crew in the harbour: ${officeSummary(office)}. The list view has the same crew.`);
      master.update(office.harbour);
      coast.setHelper(office.harbour.helper);
      for (const b of office.boats) if (b.id !== 'flagship') fleet.setOn[b.id as SmallBoat](b.on || office.stations.some((x) => x.boat === b.id && x.sailors.length > 0));
      const seen = new Set<string>();
      const more: [StationId, number, Berth][] = [];
      for (const station of office.stations) {
        const spots = allBerths[station.id] ?? [];
        const { shown: aboard, more: extra } = berths(station, spots.length);
        if (extra && spots.length) more.push([station.id, extra, spots[spots.length - 1]]);
        for (const [sailor, spot] of seat(station.id, aboard, spots)) {
          const berth = spots[spot];
          let it = placed.get(sailor.id);
          // A hand switched on or off swaps between a sailor and an empty seat.
          if (it && !it.fig !== sailor.off) {
            it.root.parent?.remove(it.root);
            placed.delete(sailor.id);
            it = undefined;
          }
          const fresh = !it;
          if (!it) {
            it = { ...make(sailor), sailor, station: station.id, spot, berth };
            placed.set(sailor.id, it);
          }
          Object.assign(it, { sailor, station: station.id, spot, berth });
          const parent = berth.ride ?? st.scene;
          if (it.root.parent !== parent) parent.add(it.root);
          it.root.position.set(berth.at[0], berth.at[1] + (sailor.off ? berth.seat : 0), berth.at[2]);
          it.root.rotation.y = berth.face;
          if (it.fig) {
            it.fig.setMood(sailor.mood);
            it.fig.setSeat(berth.seat / SIZE);
            if (fresh || !opts.motion) it.fig.settle();
          }
          seen.add(sailor.id);
        }
      }
      for (const [id, it] of placed) {
        if (seen.has(id)) continue;
        it.root.parent?.remove(it.root);
        placed.delete(id);
      }
      st.castShadows();

      // The consoles show their sailor's task; a free console shows a cursor.
      const at = new Map<number, Sailor>();
      for (const { sailor, berth } of placed.values()) if (berth.console !== undefined && !sailor.off) at.set(berth.console, sailor);
      deck.screens.forEach((show, i) => show(at.has(i) ? (at.get(i)!.taskKey ?? at.get(i)!.name) : null));
      const lead = placed.get('lead');
      deck.bridgeOrder(lead ? (lead.sailor.cards && lead.sailor.mood !== 'stuck' ? ORDER.waiting : ORDER[lead.sailor.mood]) : ORDER.idle);
      const engine = office.stations.find((x) => x.id === 'engine')!.sailors.filter((s) => !s.off);
      deck.engineOrder(engine.length ? Math.min(...engine.map((s) => ORDER[s.mood])) : ORDER.idle);
      deck.clock(office.nextRound ? clock(office.nextRound) : '');

      for (const t of floating.values()) t.used = false;
      // One label per boat, in its department's colour.
      for (const b of office.boats) {
        const a = b.id === 'flagship' ? { at: deck.anchors.flagship, ride: undefined } : fleet.anchors[b.id as SmallBoat];
        const text = b.on ? `${b.deptName} · ${b.agentsOn} of ${b.agents} on` : `${b.deptName} · off`;
        float(`boat:${b.id}`, a.at, a.ride, text, `ship-boat${b.on ? '' : ' off'}`, `${b.deptName}: who is aboard and who is switched off`, () => opts.onBoat(b.id), b.colour);
      }
      // A name over every sailor; the quiet ones show only up close.
      for (const it of placed.values()) {
        const s = it.sailor;
        const flagged = s.id === 'lead' && s.cards > 0 && s.mood !== 'stuck';
        const loud = !s.off && (s.mood === 'waiting' || s.mood === 'stuck' || flagged);
        const text = flagged ? `${s.name}: ${s.cards} for you` : s.off ? `${s.name} · off` : s.mood === 'stuck' ? `Stuck: ${s.name}` : s.name;
        const kind = s.off ? 'off' : flagged ? 'm-waiting' : `m-${s.mood}`;
        const dept = BOATS.find((b) => b.id === boatOf(it.station))?.colour;
        float(`n:${s.id}`, [it.berth.at[0], it.berth.at[1] + overHead(it.berth, s.off), it.berth.at[2]], it.berth.ride, text, `ship-name ${kind}${loud ? ' loud' : ''}`, about(s), () => opts.onPick(s), dept);
      }
      for (const [id, n, b] of more) float(`more@${id}`, [b.at[0], b.at[1] + 2.6, b.at[2]], b.ride, `+${n} more`, 'ship-more', `${n} more at this post: see the list view`);
      for (const [key, t] of floating) {
        if (t.used) continue;
        t.el.remove();
        floating.delete(key);
      }
      st.invalidate();
    },
    setTheme: (theme) => st.setTheme(theme),
    dispose() {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      st.dispose();
      bin.dispose();
      placed.clear();
      floating.clear();
      canvas.remove();
      tags.remove();
      tip.remove();
      host.classList.remove('near');
    },
  };
  st.setTheme(opts.theme);
  st.start();
  return ship;
}
