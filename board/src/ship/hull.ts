/**
 * The flagship, built once per mount: a navy hull with a teak deck afloat in the harbour, Engineering's posts on deck
 * and a quay alongside. Each station lists its berths, the spots where sailors stand or sit, in the order they fill. Things that
 * change with the crew (console screens, the two telegraphs, the clock) come back as setters.
 */
import * as THREE from 'three';
import type { StationId } from '../lib/office';
import { barrel, crate, lantern, lettering, lifeRing, nameBoard, pipeRun, porthole, ropeCoil, telegraph, workConsole, type Yard } from './fittings';
import { dial, drawClock, ensign, painted, planks } from './paint';
import type { Vec } from './parts';
import { SWELL, WATER } from './sea';
import { buildStern } from './sterndeck';

/** Where a sailor goes: its feet, which way it faces (radians about y; 0 faces the viewer), how high it sits (0 stands). */
export interface Berth {
  /** In the scene's frame, or in `ride`'s when the berth is on a boat that moves. */
  at: Vec;
  face: number;
  seat: number;
  /** The console this berth works at, by index into `Deck.screens`. */
  console?: number;
  /** The boat the berth moves with. */
  ride?: THREE.Object3D;
  /** The agent this berth is laid out for (the PM's helm, the designer's board); others take it only when it is free. */
  agent?: string;
}

export interface Deck {
  berths: Partial<Record<StationId, Berth[]>>;
  /** Where the flagship's label floats. */
  anchors: { flagship: Vec };
  screens: ((key: string | null) => void)[];
  bridgeOrder: (order: number) => void;
  engineOrder: (order: number) => void;
  clock: (next: string) => void;
  /** Things that move on their own: funnel smoke, the flywheel, the radar. */
  ticks: ((t: number, dt: number) => void)[];
}

const D = 1.3; // deck height
const UP = D + 0.55; // the raised lookout
const QY = 0.9; // the quay

export function buildDeck(y: Yard, scene: THREE.Scene): Deck {
  const { s, p, bin } = y;
  const screens: Deck['screens'] = [];
  const ticks: Deck['ticks'] = [];
  const teak = (w: number, d: number) => bin.keep(new THREE.MeshStandardMaterial({ map: planks(bin, w, d), roughness: 0.8 }));

  /* Hull, deck and bulwark */
  const hull = new THREE.Shape();
  hull.moveTo(-11.6, -4.2);
  hull.lineTo(5.5, -4.2);
  hull.bezierCurveTo(9.5, -4.2, 12.2, -2.2, 13.6, 0);
  hull.bezierCurveTo(12.2, 2.2, 9.5, 4.2, 5.5, 4.2);
  hull.lineTo(-11.6, 4.2);
  hull.quadraticCurveTo(-12.6, 0, -11.6, -4.2);
  s.slab(scene, hull, D, p.navy, 0);
  s.slab(scene, hull, 0.16, p.buff, 0).scale.set(1.003, 1, 1.006);
  s.slab(scene, hull, 0.16, p.white, D - 0.3).scale.set(1.004, 1, 1.008);
  s.slab(scene, hull, 0, teak(0.5, 0.5), D + 0.004);
  const edge = hull.getPoints(24);
  const rim = new THREE.Shape(edge);
  rim.holes.push(new THREE.Path(edge.map((q) => new THREE.Vector2(0.8 + (q.x - 0.8) * 0.978, q.y * 0.945))));
  s.slab(scene, rim, 0.36, p.white, D);
  s.slab(scene, rim, 0.05, p.darkTeak, D + 0.36);
  for (let x = -10; x <= 4.5; x += 2.05) porthole(y, scene, [x, 0.52, 4.215]);

  /* A line of foam where the hull meets the sea */
  const foamLine = new THREE.Shape(edge.map((q) => new THREE.Vector2(0.8 + (q.x - 0.8) * 1.03, q.y * 1.1)));
  foamLine.holes.push(new THREE.Path(edge));
  const foam = s.slab(scene, foamLine, 0, bin.keep(new THREE.MeshStandardMaterial({ color: '#FFFFFF', roughness: 0.9, transparent: true, opacity: 0.6, depthWrite: false })), WATER + SWELL + 0.02);
  foam.userData.flat = true;

  /* Small helpers */
  const wallAlongX = (x0: number, x1: number, z: number, h: number, base = D) => {
    s.box(scene, [x1 - x0, h, 0.12], p.white, [(x0 + x1) / 2, base + h / 2, z]);
    s.box(scene, [x1 - x0 + 0.06, 0.06, 0.2], p.darkTeak, [(x0 + x1) / 2, base + h + 0.03, z], 0.02);
  };
  const wallAlongZ = (x: number, z0: number, z1: number, h: number, base = D) => {
    s.box(scene, [0.12, h, z1 - z0], p.white, [x, base + h / 2, (z0 + z1) / 2]);
    s.box(scene, [0.2, 0.06, z1 - z0 + 0.06], p.darkTeak, [x, base + h + 0.03, (z0 + z1) / 2], 0.02);
  };
  /** A console with its berth: the sailor stands 0.6 in front of the screen, facing it. */
  const consoleBerth = (x: number, base: number, z: number, turn: number): Berth => {
    screens.push(workConsole(y, scene, [x + Math.sin(turn) * -0.5, base, z + Math.cos(turn) * -0.5], turn));
    return { at: [x + Math.sin(turn) * 0.1, base, z + Math.cos(turn) * 0.1], face: turn + Math.PI, seat: 0, console: screens.length - 1 };
  };
  const at = (x: number, base: number, z: number, face = 0, seat = 0): Berth => ({ at: [x, base, z], face, seat });

  /* Bridge and chart room: a two-storey stern deckhouse, the bridge and the chart room on its roof */
  const stern = buildStern(y, scene, D, teak(2, 3.6));
  lettering(y, scene, 'Chart room', [-9.3, 0.92, 4.23], 2.6, '#F7F5EF', false);

  /* Engine room: consoles under the funnel, the engine, the gauges */
  wallAlongX(-6.7, 0.3, -3.6, 1.2);
  wallAlongZ(-6.7, -3.6, -1.9, 0.9);
  wallAlongZ(0.3, -3.6, -1.9, 0.9);
  s.post(scene, 0.6, 0.72, 3.1, p.white, [-3.0, D + 1.55, -2.75], 28);
  s.post(scene, 0.645, 0.665, 0.55, p.navy, [-3.0, D + 2.55, -2.75], 28);
  s.hoop(scene, 0.6, 0.05, p.iron, [-3.0, D + 3.1, -2.75]).rotation.x = Math.PI / 2;
  s.post(scene, 0.035, 0.035, 0.9, p.brass, [-2.25, D + 2.6, -2.75], 10);
  s.post(scene, 0.07, 0.04, 0.16, p.brass, [-2.25, D + 3.1, -2.75], 12);
  const puffs = [0, 1, 2].map(() => {
    const m = s.ball(scene, 0.3, bin.keep(p.smoke.clone()), [0, 0, 0]);
    m.userData.flat = true;
    return m;
  });
  const puff = (t: number) =>
    puffs.forEach((m, i) => {
      const k = (t * 0.22 + i / 3) % 1;
      m.position.set(-3.0 + k * 1.3, D + 3.35 + k * 1.7, -2.75 - k * 0.3);
      m.scale.setScalar(0.5 + k * 1.2);
      (m.material as THREE.MeshStandardMaterial).opacity = 0.75 * (1 - k);
    });
  puff(1.3);
  ticks.push((t) => puff(t));
  const engine = new THREE.Group();
  s.box(engine, [1.5, 0.7, 0.85], p.grey, [0, 0.35, 0], 0.06);
  for (const dx of [-0.45, 0, 0.45]) {
    s.post(engine, 0.16, 0.16, 0.3, p.iron, [dx, 0.85, 0], 16);
    s.post(engine, 0.1, 0.1, 0.06, p.brass, [dx, 1.03, 0], 14);
  }
  const flywheel = new THREE.Group();
  s.hoop(flywheel, 0.34, 0.05, p.iron, [0, 0, 0]);
  s.box(flywheel, [0.66, 0.05, 0.04], p.iron, [0, 0, 0], 0.01);
  s.box(flywheel, [0.05, 0.66, 0.04], p.iron, [0, 0, 0], 0.01);
  flywheel.position.set(0.82, 0.42, 0);
  flywheel.rotation.y = Math.PI / 2;
  engine.add(flywheel);
  engine.position.set(-5.4, D, -2.85);
  scene.add(engine);
  ticks.push((_t, dt) => void (flywheel.rotation.x += dt * 2.4));
  pipeRun(y, scene, [-0.9, D + 0.45, -3.47], 2.0);
  s.box(scene, [1.5, 0.56, 0.05], p.darkTeak, [-1.0, D + 0.86, -3.5], 0.02);
  for (const [x, v, label] of [[-1.45, 0.62, 'CTX'], [-1.0, 0.31, 'USD'], [-0.55, 0.78, 'RPM']] as const) {
    s.post(scene, 0.19, 0.19, 0.04, p.brass, [x, D + 0.86, -3.46], 24).rotation.x = Math.PI / 2;
    s.sign(scene, 0.33, 0.33, bin.keep(new THREE.MeshStandardMaterial({ map: dial(bin, v, label), roughness: 0.5, transparent: true, alphaTest: 0.5 })), [x, D + 0.86, -3.435]);
  }
  const engineOrder = telegraph(y, scene, [0.0, D, -2.95]);
  nameBoard(y, scene, 'Engine room', [-5.1, D + 1.52, -3.56], 2.3);

  /* Mess: a long table with benches, a stove */
  wallAlongZ(-6.7, 1.3, 3.75, 0.42);
  wallAlongZ(0.3, 1.3, 3.75, 0.42);
  s.box(scene, [3.7, 0.07, 0.72], p.teak, [-3.1, D + 0.6, 2.2]);
  for (const dx of [-1.5, 1.5]) s.box(scene, [0.1, 0.58, 0.6], p.darkTeak, [-3.1 + dx, D + 0.29, 2.2]);
  for (const dz of [-0.62, 0.62]) {
    s.box(scene, [3.7, 0.06, 0.3], p.teak, [-3.1, D + 0.36, 2.2 + dz], 0.02);
    for (const dx of [-1.5, 1.5]) s.box(scene, [0.08, 0.34, 0.26], p.darkTeak, [-3.1 + dx, D + 0.17, 2.2 + dz], 0.02);
  }
  for (const [x, z] of [[-4.2, 2.1], [-3.3, 2.3], [-2.2, 2.15], [-1.7, 2.32]]) s.post(scene, 0.045, 0.04, 0.09, p.white, [x, D + 0.68, z], 12);
  s.box(scene, [0.6, 0.7, 0.5], p.iron, [-6.15, D + 0.35, 1.75], 0.05);
  s.post(scene, 0.07, 0.07, 1.3, p.iron, [-6.3, D + 1.3, 1.6], 12);
  s.ball(scene, 0.13, p.brass, [-6.05, D + 0.8, 1.8]).scale.y = 0.75;
  barrel(y, scene, [-0.25, D, 3.2]);
  crate(y, scene, [-0.9, D, 3.3], 0.46);
  lettering(y, scene, 'Mess', [-3.4, 0.92, 4.23], 2.1, '#F7F5EF', false);

  /* Radio room: the mast with a turning radar, flags to the bow, the radio set */
  wallAlongX(0.9, 4.9, -3.6, 1.2);
  wallAlongZ(0.9, -3.6, -1.9, 0.9);
  wallAlongZ(4.9, -3.6, -1.9, 0.9);
  s.post(scene, 0.06, 0.09, 5.4, p.white, [4.35, D + 2.7, -3.0], 14);
  s.box(scene, [1.7, 0.05, 0.05], p.white, [4.35, D + 4.2, -3.0], 0.015);
  s.ball(scene, 0.08, p.glow, [4.35, D + 5.45, -3.0]);
  const radar = new THREE.Group();
  s.box(radar, [1.15, 0.14, 0.09], p.white, [0, 0, 0]);
  s.post(radar, 0.04, 0.04, 0.2, p.iron, [0, -0.14, 0], 8);
  radar.position.set(4.35, D + 4.75, -3.0);
  scene.add(radar);
  ticks.push((_t, dt) => void (radar.rotation.y += dt * 1.1));
  const mastTop: Vec = [4.35, D + 5.3, -3.0];
  const bowTip: Vec = [13.2, D + 0.5, 0];
  s.bar(scene, mastTop, bowTip, 0.01, p.rope);
  const flag = new THREE.Shape();
  flag.moveTo(-0.16, 0);
  flag.lineTo(0.16, 0);
  flag.lineTo(0, -0.42);
  const flagGeo = bin.keep(new THREE.ShapeGeometry(flag));
  const flagInks = [p.navy, p.white, p.buff, p.yellow].map((m) => bin.keep(new THREE.MeshStandardMaterial({ color: m.color, side: THREE.DoubleSide, roughness: 0.9 })));
  for (let i = 0; i < 9; i++) {
    const m = new THREE.Mesh(flagGeo, flagInks[i % 4]);
    const k = (i + 1) / 10.5;
    m.position.set(mastTop[0] + (bowTip[0] - mastTop[0]) * k, mastTop[1] + (bowTip[1] - mastTop[1]) * k, mastTop[2] + (bowTip[2] - mastTop[2]) * k);
    m.rotation.y = -0.33;
    scene.add(m);
  }
  s.box(scene, [1.5, 0.06, 0.6], p.teak, [2.3, D + 0.68, -3.15], 0.02);
  for (const dx of [-0.65, 0.65]) s.box(scene, [0.08, 0.66, 0.5], p.darkTeak, [2.3 + dx, D + 0.33, -3.15], 0.02);
  s.box(scene, [1.0, 0.46, 0.36], p.cream, [2.15, D + 0.94, -3.2], 0.05);
  for (const dx of [-0.3, -0.1, 0.1]) s.post(scene, 0.055, 0.055, 0.05, p.brass, [2.15 + dx, D + 0.88, -3.0], 14).rotation.x = Math.PI / 2;
  s.bar(scene, [2.6, D + 1.17, -3.2], [4.35, D + 4.2, -3.0], 0.008, p.iron);
  lifeRing(y, scene, [3.6, D + 0.72, -3.5]);
  crate(y, scene, [3.75, D, -1.6], 0.5);
  nameBoard(y, scene, 'Radio room', [2.2, D + 1.52, -3.56], 2.1);

  /* Rounds: the bell, the ship's clock and a bench */
  wallAlongZ(4.9, 1.3, 3.75, 0.42);
  for (const dx of [-0.3, 0.3]) s.post(scene, 0.04, 0.05, 1.15, p.darkTeak, [4.25 + dx, D + 0.575, 2.9], 10);
  s.box(scene, [0.8, 0.07, 0.1], p.darkTeak, [4.25, D + 1.16, 2.9], 0.02);
  const bellMetal = bin.keep(p.brass.clone());
  bellMetal.side = THREE.DoubleSide;
  s.lathe(scene, [[0.03, 0.34], [0.09, 0.3], [0.13, 0.16], [0.17, 0.05], [0.21, 0]], bellMetal, [4.25, D + 0.74, 2.9]);
  s.post(scene, 0.035, 0.045, 1.5, p.iron, [1.35, D + 0.75, 1.0], 10);
  s.post(scene, 0.34, 0.34, 0.07, p.brass, [1.35, D + 1.75, 1.0], 28).rotation.x = Math.PI / 2;
  const clockFace = painted(bin, 160, 160, drawClock(''));
  const face = new THREE.Mesh(bin.keep(new THREE.CircleGeometry(0.3, 28)), bin.keep(new THREE.MeshStandardMaterial({ map: clockFace.tex, roughness: 0.5 })));
  face.position.set(1.35, D + 1.75, 1.04);
  scene.add(face);
  s.box(scene, [2.0, 0.06, 0.32], p.teak, [2.9, D + 0.38, 1.35], 0.02);
  for (const dx of [-0.8, 0.8]) s.box(scene, [0.08, 0.36, 0.28], p.darkTeak, [2.9 + dx, D + 0.18, 1.35], 0.02);
  ropeCoil(y, scene, [3.3, D, 3.1]);
  lettering(y, scene, 'Rounds', [2.9, 0.92, 4.23], 1.9, '#F7F5EF', false);

  /* Lookout: a raised platform in the bow with a brass rail and a telescope */
  s.post(scene, 1.9, 1.9, 0.55, p.white, [8.8, D + 0.275, 0], 48);
  const top = new THREE.Mesh(bin.keep(new THREE.CircleGeometry(1.84, 48).rotateX(-Math.PI / 2)), teak(1.84, 1.84));
  top.position.set(8.8, UP + 0.004, 0);
  scene.add(top);
  s.hoop(scene, 1.86, 0.03, p.brass, [8.8, UP + 0.72, 0], Math.PI * 1.55).rotation.set(Math.PI / 2, 0, Math.PI * 0.72);
  for (let i = 0; i < 9; i++) {
    const a = -Math.PI * 0.72 + (i / 8) * Math.PI * 1.55 - Math.PI * 0.83;
    s.post(scene, 0.025, 0.025, 0.72, p.brass, [8.8 + 1.86 * Math.cos(a), UP + 0.36, 1.86 * Math.sin(a)], 8);
  }
  s.box(scene, [0.45, 0.19, 1.2], p.teak, [6.75, D + 0.095, 0.3]);
  s.box(scene, [0.45, 0.37, 1.2], p.teak, [7.1, D + 0.185, 0.3]);
  const scope = new THREE.Group();
  for (let i = 0; i < 3; i++) s.bar(scope, [0, 0.95, 0], [0.32 * Math.cos(i * 2.094), 0, 0.32 * Math.sin(i * 2.094)], 0.018, p.darkTeak);
  s.post(scope, 0.075, 0.05, 0.95, p.brass, [0.1, 1.02, 0], 16).rotation.z = -Math.PI / 2 + 0.12;
  scope.position.set(10.05, UP, 0.55);
  scene.add(scope);
  nameBoard(y, scene, 'Lookout', [8.8, D + 0.28, 1.93], 1.7);

  /* Deck furniture */
  for (const pos of [[-6.95, D, 1.05], [0.6, D, 0.0], [5.5, D, -0.2], [3.3, QY, 6.5]] as const) lantern(y, scene, pos);
  ropeCoil(y, scene, [11.6, D, 0.1]);
  lifeRing(y, scene, [-5.0, D + 0.62, -3.52]);
  crate(y, scene, [5.9, D, -2.5], 0.5);
  barrel(y, scene, [5.9, D, 2.9]);
  s.post(scene, 0.03, 0.04, 2.3, p.white, [-11.75, D + 1.15, 0], 10);
  s.sign(scene, 1.0, 0.6, bin.keep(new THREE.MeshStandardMaterial({ map: ensign(bin), side: THREE.DoubleSide, roughness: 0.9 })), [-12.27, D + 1.95, 0]);

  /* The quay alongside, in the buff of the place you sign, for whoever is waiting for you */
  s.box(scene, [9.4, 0.28, 3.1], p.teak, [-1.0, QY - 0.14, 7.25], 0.04);
  s.floor(scene, 9.3, 3.0, bin.keep(new THREE.MeshStandardMaterial({ map: planks(bin, 4.65, 1.5), color: '#FFF3CF', roughness: 0.85 })), [-1.0, QY + 0.004, 7.25]);
  for (const x of [-5.2, -2.4, 0.4, 3.2]) for (const z of [6.0, 8.5]) s.post(scene, 0.16, 0.18, QY - 0.2, p.darkTeak, [x, (QY - 0.2) / 2, z], 12);
  s.box(scene, [1.05, 0.07, 2.05], p.teak, [-1.0, (D + 0.4 + QY) / 2 + 0.03, 4.98], 0.02).rotation.x = Math.atan2(D + 0.4 - QY, 1.85);
  for (const side of [-1, 1]) {
    s.post(scene, 0.025, 0.025, 0.7, p.darkTeak, [-1.0 + side * 0.5, D + 0.75, 4.1], 8);
    s.post(scene, 0.025, 0.025, 0.7, p.darkTeak, [-1.0 + side * 0.5, QY + 0.35, 5.9], 8);
    s.bar(scene, [-1.0 + side * 0.5, D + 1.08, 4.1], [-1.0 + side * 0.5, QY + 0.68, 5.9], 0.018, p.rope);
  }
  for (const [x, toX] of [[-4.9, -6.6], [3.0, 5.2]]) {
    s.post(scene, 0.11, 0.13, 0.3, p.iron, [x, QY + 0.15, 6.05], 14);
    s.post(scene, 0.15, 0.15, 0.05, p.iron, [x, QY + 0.31, 6.05], 14);
    s.bar(scene, [x, QY + 0.2, 6.05], [toX, D + 0.38, 4.1], 0.022, p.rope);
  }
  crate(y, scene, [2.6, QY, 8.1], 0.6);
  crate(y, scene, [2.55, QY + 0.48, 8.1], 0.42);
  barrel(y, scene, [-4.9, QY, 8.2]);
  lettering(y, scene, 'Quay', [-1.0, QY, 8.35], 2.4, '#1B4F72', true);

  /* The berths, in the order each post fills them. The radio room seats the chart room's overflow, and the mess the
     engine room's (engineers between tasks). */
  const mess = [-4.45, -3.55, -2.65, -1.75].flatMap((x) => [at(x, D, 1.58, 0, 0.39), at(x + 0.2, D, 2.82, Math.PI, 0.39)]);
  const berths: Partial<Record<StationId, Berth[]>> = {
    bridge: stern.bridge,
    engine: [
      consoleBerth(-5.6, D, -1.0, Math.PI - 0.9),
      consoleBerth(-0.9, D, -1.15, Math.PI + 0.5),
      consoleBerth(-4.0, D, -1.2, Math.PI + 0.5),
      consoleBerth(-2.3, D, -0.95, Math.PI - 0.9),
      at(-3.0, D, -1.85, 0.2),
      at(-1.4, D, -2.75, -0.2),
      ...mess,
    ],
    lookout: [at(9.42, UP, 0.55, Math.PI / 2), consoleBerth(8.3, UP, -0.4, Math.PI + 0.6), at(9.7, UP, -0.85, 1.2)],
    chart: [...stern.chart, at(2.2, D, -2.25, 0.2), at(3.75, D, -1.6, -0.3, 0.4), at(1.5, D, -1.4, 0.6)],
    rounds: [at(2.45, D, 1.35, 0, 0.41), at(3.35, D, 1.35, -0.2, 0.41), at(1.9, D, 2.6, 0.3), at(3.9, D, 2.25, -0.4)],
  };
  // The flagship's label, clear of the funnel smoke and the bridge.
  const anchors: { flagship: Vec } = { flagship: [-7.5, D - 0.35, 4.3] };
  return { berths, anchors, screens, bridgeOrder: stern.order, engineOrder, clock: (next) => clockFace.paint(drawClock(next)), ticks };
}
