/**
 * The ship's fittings: cargo, lanterns, the engine telegraph, the work consoles, pipes and painted lettering. Things
 * that glow (screens, lantern pools, lamp lights) are listed in `Glows` so the stage can brighten them at Dusk and Night.
 */
import * as THREE from 'three';
import { painted, dial, drawScreen, drawTelegraph, drawWords, type Painted } from './paint';
import type { Bin, Paints, Shapes, Vec } from './parts';

export interface Glows {
  screens: THREE.MeshStandardMaterial[];
  pools: THREE.MeshBasicMaterial[];
  lamps: THREE.PointLight[];
  /** Lamp glass and lit portholes. */
  glass: THREE.MeshStandardMaterial[];
  /** House windows, dark by day and lit at Dusk and Night. */
  windows: THREE.MeshStandardMaterial[];
  /** The lighthouse beam, seen only after dark. */
  beams: THREE.Mesh[];
}

/** What the fittings need from the mount. */
export interface Yard {
  bin: Bin;
  s: Shapes;
  p: Paints;
  glows: Glows;
  spot: THREE.Texture;
}

const group = (parent: THREE.Object3D, at: Vec, turn = 0) => {
  const g = new THREE.Group();
  g.position.set(...at);
  g.rotation.y = turn;
  parent.add(g);
  return g;
};

export function crate({ s, p }: Yard, parent: THREE.Object3D, at: Vec, size = 0.5): THREE.Group {
  const g = group(parent, at);
  s.box(g, [size, size * 0.8, size], p.teak, [0, size * 0.4, 0], 0.02);
  for (const side of [-1, 1]) {
    s.box(g, [0.05, size * 0.84, size + 0.03], p.darkTeak, [side * (size / 2 - 0.05), size * 0.4, 0], 0.012);
    s.box(g, [size + 0.03, size * 0.84, 0.05], p.darkTeak, [0, size * 0.4, side * (size / 2 - 0.05)], 0.012);
  }
  return g;
}

export function barrel({ s, p }: Yard, parent: THREE.Object3D, at: Vec): void {
  const g = group(parent, at);
  s.lathe(g, [[0.17, 0], [0.22, 0.14], [0.235, 0.28], [0.22, 0.42], [0.17, 0.56]], p.teak, [0, 0, 0]);
  s.post(g, 0.17, 0.17, 0.02, p.darkTeak, [0, 0.555, 0]);
  for (const h of [0.1, 0.46]) s.hoop(g, 0.212, 0.014, p.iron, [0, h, 0]).rotation.x = Math.PI / 2;
}

export function ropeCoil({ s, p }: Yard, parent: THREE.Object3D, at: Vec): void {
  const g = group(parent, at);
  for (let i = 0; i < 3; i++) s.hoop(g, 0.2 - i * 0.012, 0.038, p.rope, [0, 0.04 + i * 0.066, 0]).rotation.x = Math.PI / 2;
}

/** A white life ring with navy bands, hung on a bulkhead facing +z. */
export function lifeRing({ s, p }: Yard, parent: THREE.Object3D, at: Vec): void {
  const g = group(parent, at);
  s.hoop(g, 0.2, 0.055, p.white, [0, 0, 0]);
  for (let i = 0; i < 4; i++) s.hoop(g, 0.2, 0.058, p.navy, [0, 0, 0], 0.42).rotation.z = i * (Math.PI / 2) + 0.58;
}

/** A brass porthole on the hull, lit from inside. */
export function porthole({ bin, s, p }: Yard, parent: THREE.Object3D, at: Vec): void {
  const g = group(parent, at);
  s.hoop(g, 0.15, 0.03, p.brass, [0, 0, 0]);
  const pane = new THREE.Mesh(bin.keep(new THREE.CircleGeometry(0.15, 24)), p.glow);
  pane.position.z = 0.005;
  g.add(pane);
}

/** A ship's lantern on a post. At Dusk and Night it lights a pool of the deck around it. */
export function lantern(y: Yard, parent: THREE.Object3D, at: Vec): void {
  const { s, p, glows, bin, spot } = y;
  const g = group(parent, at);
  s.post(g, 0.025, 0.035, 1.5, p.iron, [0, 0.75, 0], 10);
  s.box(g, [0.3, 0.03, 0.03], p.iron, [0.14, 1.5, 0], 0.01);
  s.post(g, 0.06, 0.06, 0.03, p.brass, [0.27, 1.43, 0], 12);
  s.post(g, 0.055, 0.055, 0.14, p.glow, [0.27, 1.34, 0], 12);
  s.post(g, 0.065, 0.065, 0.03, p.brass, [0.27, 1.255, 0], 12);
  const pool = bin.keep(new THREE.MeshBasicMaterial({ map: spot, color: '#FFD08A', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  const disc = s.floor(g, 3.4, 3.4, pool, [0.27, 0.02, 0]);
  disc.userData.flat = true;
  glows.pools.push(pool);
  const light = new THREE.PointLight('#FFC56B', 0, 6, 1.7);
  light.position.set(0.27, 1.25, 0);
  g.add(light);
  glows.lamps.push(light);
}

/** The engine-order telegraph. Returns a setter for which order it shows (see ORDER in paint.ts). */
export function telegraph(y: Yard, parent: THREE.Object3D, at: Vec, turn = 0): (order: number) => void {
  const { s, p, bin } = y;
  const g = group(parent, at, turn);
  s.post(g, 0.045, 0.085, 0.72, p.brass, [0, 0.36, 0], 14);
  s.post(g, 0.11, 0.11, 0.025, p.brass, [0, 0.012, 0], 16);
  const head = group(g, [0, 0.86, 0]);
  s.post(head, 0.19, 0.19, 0.1, p.brass, [0, 0, 0], 28).rotation.x = Math.PI / 2;
  const face = painted(bin, 160, 160, drawTelegraph(3));
  const disc = new THREE.Mesh(bin.keep(new THREE.CircleGeometry(0.165, 28)), bin.keep(new THREE.MeshStandardMaterial({ map: face.tex, roughness: 0.6 })));
  disc.position.z = 0.052;
  head.add(disc);
  const handle = group(head, [0, 0, 0.06]);
  s.box(handle, [0.03, 0.26, 0.02], p.iron, [0, 0.13, 0], 0.008);
  s.ball(handle, 0.035, p.darkTeak, [0, 0.27, 0]);
  let shown = -1;
  return (order) => {
    if (order === shown) return;
    shown = order;
    face.paint(drawTelegraph(order));
    // The face's four orders run from left to right across its top half.
    handle.rotation.z = Math.PI / 2 - (order + 0.5) * (Math.PI / 4);
  };
}

/** A work console: a desk with a lit screen and a gauge, a note pad and a mug. Returns a setter for its screen. */
export function workConsole(y: Yard, parent: THREE.Object3D, at: Vec, turn: number): (key: string | null) => void {
  const { s, p, bin, glows } = y;
  const g = group(parent, at, turn);
  s.box(g, [1.1, 0.62, 0.5], p.navy, [0, 0.31, 0], 0.05);
  s.box(g, [1.16, 0.05, 0.6], p.teak, [0, 0.645, 0.02], 0.02);
  const screen: Painted = painted(bin, 320, 200, drawScreen(null));
  const glass = bin.keep(new THREE.MeshStandardMaterial({ map: screen.tex, emissive: '#FFFFFF', emissiveMap: screen.tex, emissiveIntensity: 0.5, roughness: 0.35 }));
  glows.screens.push(glass);
  const monitor = group(g, [-0.12, 0.98, -0.12]);
  monitor.rotation.x = -0.12;
  s.box(monitor, [0.66, 0.44, 0.04], p.iron, [0, 0, 0], 0.02);
  s.sign(monitor, 0.6, 0.375, glass, [0, 0, 0.022]);
  s.post(g, 0.03, 0.03, 0.14, p.iron, [-0.12, 0.72, -0.14], 10);
  const gauge = group(g, [0.34, 0.93, -0.14]);
  gauge.rotation.x = -0.12;
  s.post(gauge, 0.115, 0.115, 0.05, p.brass, [0, 0, 0], 24).rotation.x = Math.PI / 2;
  const face = new THREE.Mesh(bin.keep(new THREE.CircleGeometry(0.098, 24)), bin.keep(new THREE.MeshStandardMaterial({ map: dial(bin, 0.45, 'CTX'), roughness: 0.5 })));
  face.position.z = 0.027;
  gauge.add(face);
  s.post(g, 0.02, 0.02, 0.16, p.brass, [0.34, 0.75, -0.14], 8);
  s.box(g, [0.42, 0.02, 0.15], p.cream, [-0.12, 0.682, 0.16], 0.008);
  s.post(g, 0.045, 0.04, 0.09, p.white, [0.36, 0.715, 0.18], 14);
  let shown: string | null | undefined;
  return (key) => {
    if (key === shown) return;
    shown = key;
    screen.paint(drawScreen(key));
  };
}

/** A pipe along a bulkhead with a brass valve wheel. */
export function pipeRun({ s, p }: Yard, parent: THREE.Object3D, at: Vec, length: number): void {
  const g = group(parent, at);
  s.post(g, 0.045, 0.045, length, p.cream, [0, 0, 0], 12).rotation.z = Math.PI / 2;
  for (const dx of [-length / 2 + 0.1, length / 2 - 0.1]) s.post(g, 0.06, 0.06, 0.05, p.iron, [dx, 0, 0], 12).rotation.z = Math.PI / 2;
  const wheel = group(g, [0, 0, 0.1]);
  s.hoop(wheel, 0.1, 0.016, p.brass, [0, 0, 0]);
  s.box(wheel, [0.2, 0.014, 0.014], p.brass, [0, 0, 0], 0);
  s.box(wheel, [0.014, 0.2, 0.014], p.brass, [0, 0, 0], 0);
}

/**
 * Words painted on the ship: lying on a deck (`flat`), or standing on a wall or the hull. Lettering is 1/5.3 as tall as
 * it is wide.
 */
export function lettering({ s, bin }: Yard, parent: THREE.Object3D, text: string, at: Vec, width: number, ink: string, flat: boolean): THREE.Mesh {
  const words = painted(bin, 512, 96, drawWords(text, ink));
  const mat = bin.keep(new THREE.MeshBasicMaterial({ map: words.tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  const h = width * (96 / 512);
  const m = flat ? s.floor(parent, width, h, mat, [at[0], at[1] + 0.012, at[2]]) : s.sign(parent, width, h, mat, at);
  m.userData.flat = true;
  return m;
}

/** A carved teak name board with buff letters, on a bulkhead facing +z. */
export function nameBoard(y: Yard, parent: THREE.Object3D, text: string, at: Vec, width: number): void {
  y.s.box(parent, [width + 0.16, width * 0.1875 + 0.1, 0.07], y.p.darkTeak, at, 0.03);
  lettering(y, parent, text, [at[0], at[1], at[2] + 0.04], width, '#F4E6BC', false);
}
