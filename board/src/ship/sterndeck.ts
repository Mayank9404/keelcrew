/**
 * The flagship's stern deckhouse, two storeys in a modern finish: a wraparound band of dark glass, a hardtop with a
 * glass skylight over a lounge, glass balustrades and a screen helm on the roof, warm light along the deck edge after dark.
 */
import * as THREE from 'three';
import type { Berth } from './hull';
import { telegraph, type Yard, nameBoard } from './fittings';

export interface Stern {
  bridge: Berth[];
  chart: Berth[];
  order: (order: number) => void;
}

/** A rounded rectangle in plan, aft corners `ra`, forward corners `rf`, as a shape the extruders lift into the world. */
function plan(xa: number, xb: number, za: number, zb: number, ra: number, rf: number): THREE.Shape {
  const [ya, yb] = [-zb, -za];
  const s = new THREE.Shape();
  s.moveTo(xa + ra, ya);
  s.lineTo(xb - rf, ya);
  s.absarc(xb - rf, ya + rf, rf, -Math.PI / 2, 0, false);
  s.lineTo(xb, yb - rf);
  s.absarc(xb - rf, yb - rf, rf, 0, Math.PI / 2, false);
  s.lineTo(xa + ra, yb);
  s.absarc(xa + ra, yb - ra, ra, Math.PI / 2, Math.PI, false);
  s.lineTo(xa, ya + ra);
  s.absarc(xa + ra, ya + ra, ra, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** Points around a plan, in world x and z. */
const around = (shape: THREE.Shape, n: number): [number, number][] => shape.getSpacedPoints(n).slice(0, n).map((v) => [v.x, -v.y]);

export function buildStern(y: Yard, scene: THREE.Scene, D: number, teak: THREE.Material): Stern {
  const { s, bin, glows } = y;
  const keep = <T extends THREE.Material>(m: T) => bin.keep(m);
  const gloss = keep(new THREE.MeshPhysicalMaterial({ color: '#F7F5F0', roughness: 0.32, clearcoat: 0.7, clearcoatRoughness: 0.18 }));
  const navy = keep(new THREE.MeshPhysicalMaterial({ color: '#163A56', roughness: 0.3, clearcoat: 0.9, clearcoatRoughness: 0.15 }));
  const mahogany = keep(new THREE.MeshPhysicalMaterial({ color: '#6E3519', roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.12 }));
  const steel = keep(new THREE.MeshStandardMaterial({ color: '#DCE2E8', metalness: 1, roughness: 0.16 }));
  // Dark tinted glass that mirrors the sky by day and glows warm from inside after dark.
  const glass = keep(new THREE.MeshPhysicalMaterial({ color: '#1A2E40', roughness: 0.05, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05, emissive: '#FFC56B', emissiveIntensity: 0 }));
  glows.windows.push(glass);
  const clear = keep(new THREE.MeshPhysicalMaterial({ color: '#BFDCEB', roughness: 0.04, metalness: 0.1, transparent: true, opacity: 0.28, clearcoat: 1, depthWrite: false, side: THREE.DoubleSide }));
  const strip = keep(new THREE.MeshStandardMaterial({ color: '#F4E6BC', emissive: '#FFC56B', emissiveIntensity: 0 }));
  glows.windows.push(strip);
  const cushion = keep(new THREE.MeshStandardMaterial({ color: '#ECE5D5', roughness: 0.95 }));
  const accent = keep(new THREE.MeshStandardMaterial({ color: '#4A7BD0', roughness: 0.9 }));
  const screen = keep(new THREE.MeshStandardMaterial({ color: '#0E2233', roughness: 0.2, emissive: '#5B9BE0', emissiveIntensity: 0.55 }));
  glows.screens.push(screen);
  const leaf = [keep(new THREE.MeshStandardMaterial({ color: '#3F7D45', roughness: 0.9 })), keep(new THREE.MeshStandardMaterial({ color: '#66A35A', roughness: 0.9 }))];

  const prism = (shape: THREE.Shape, y0: number, h: number, mat: THREE.Material, bevel = 0.03) => {
    const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.002, h - 2 * bevel), bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 28 });
    const m = new THREE.Mesh(bin.keep(geo.rotateX(-Math.PI / 2)), mat);
    m.position.y = y0 + bevel;
    scene.add(m);
    return m;
  };
  const ring = (outer: THREE.Shape, inner: THREE.Shape, y0: number, h: number, mat: THREE.Material) => {
    const o = new THREE.Shape(outer.getPoints(28));
    o.holes.push(new THREE.Path(inner.getPoints(28)));
    // The hole's winding can turn the outer wall inward, so draw both faces.
    mat.side = THREE.DoubleSide;
    return prism(o, y0, h, mat, 0);
  };
  const deck = (shape: THREE.Shape, y0: number, mat: THREE.Material) => {
    const geo = new THREE.ShapeGeometry(shape, 28);
    geo.computeBoundingBox();
    const b = geo.boundingBox!;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (pos.getX(i) - b.min.x) / (b.max.x - b.min.x), (pos.getY(i) - b.min.y) / (b.max.y - b.min.y));
    const m = new THREE.Mesh(bin.keep(geo.rotateX(-Math.PI / 2)), mat);
    m.position.y = y0;
    scene.add(m);
    return m;
  };
  /** Glass balustrade panels under a stainless rail, along the parts of a plan's edge that `allow` lets through. */
  const rails = (shape: THREE.Shape, base: number, allow: (x: number, z: number) => boolean) => {
    const pts = around(shape, 72);
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      if (!allow(...a) || !allow(...b)) continue;
      s.bar(scene, [a[0], base + 0.92, a[1]], [b[0], base + 0.92, b[1]], 0.03, steel);
      const pane = s.box(scene, [Math.hypot(b[0] - a[0], b[1] - a[1]), 0.78, 0.02], clear, [(a[0] + b[0]) / 2, base + 0.48, (a[1] + b[1]) / 2], 0);
      pane.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
      if (i % 2 === 0) s.post(scene, 0.022, 0.026, 0.92, steel, [a[0], base + 0.46, a[1]], 10);
    }
  };
  const planter = (x: number, base: number, z: number) => {
    s.box(scene, [0.5, 0.42, 0.5], gloss, [x, base + 0.21, z], 0.08);
    for (let k = 0; k < 6; k++) s.ball(scene, 0.16 - (k % 3) * 0.02, leaf[k % 2], [x + Math.cos(k * 1.1) * 0.12, base + 0.52 + (k % 3) * 0.1, z + Math.sin(k * 1.1) * 0.12]);
  };
  /** A built-in sofa along z, facing +x, with cushions and two throw pillows. */
  const sofa = (x: number, base: number, z0: number, z1: number) => {
    const len = z1 - z0;
    const zc = (z0 + z1) / 2;
    s.box(scene, [0.7, 0.32, len], gloss, [x, base + 0.16, zc], 0.06);
    s.box(scene, [0.62, 0.12, len - 0.06], cushion, [x + 0.03, base + 0.38, zc], 0.06);
    s.box(scene, [0.18, 0.46, len - 0.06], cushion, [x - 0.25, base + 0.62, zc], 0.08);
    for (const dz of [-len / 2 + 0.35, len / 2 - 0.35]) s.box(scene, [0.12, 0.3, 0.3], accent, [x - 0.12, base + 0.6, zc + dz], 0.06).rotation.x = 0.3;
  };
  const glassTable = (x: number, base: number, z: number, r: number) => {
    s.post(scene, 0.05, 0.12, 0.62, steel, [x, base + 0.31, z], 16);
    s.post(scene, r, r, 0.03, clear, [x, base + 0.64, z], 32);
    s.post(scene, r + 0.01, r + 0.01, 0.01, steel, [x, base + 0.625, z], 32);
  };
  const stool = (x: number, base: number, z: number) => {
    s.post(scene, 0.19, 0.19, 0.08, mahogany, [x, base + 0.5, z], 20);
    s.post(scene, 0.03, 0.03, 0.46, steel, [x, base + 0.24, z], 10);
    s.post(scene, 0.2, 0.2, 0.02, steel, [x, base + 0.01, z], 20);
  };

  /* The lower deckhouse: a rounded block in gloss white, a navy boot stripe, a mahogany cap, and a deck that overhangs it
     with warm light tucked under the lip. */
  const T = D + 1.6;
  const [x0, x1, z0, z1] = [-11.2, -7.3, -3.6, 3.6];
  const body = plan(x0, x1, z0, z1, 0.5, 1.1);
  // The bevel grows a prism outward by its size, so the walls are drawn from a plan inset by that much.
  prism(plan(x0 + 0.04, x1 - 0.04, z0 + 0.04, z1 - 0.04, 0.46, 1.06), D, 1.6, gloss, 0.04);
  ring(plan(x0 - 0.02, x1 + 0.02, z0 - 0.02, z1 + 0.02, 0.52, 1.12), body, D + 0.06, 0.16, navy);
  const lip = plan(x0 - 0.12, x1 + 0.12, z0 - 0.12, z1 + 0.12, 0.62, 1.22);
  prism(lip, T - 0.12, 0.12, mahogany, 0.03);
  ring(plan(x0 - 0.04, x1 + 0.04, z0 - 0.04, z1 + 0.04, 0.54, 1.14), body, T - 0.17, 0.035, strip);
  deck(plan(x0 - 0.08, x1 + 0.08, z0 - 0.08, z1 + 0.08, 0.58, 1.18), T + 0.004, teak);

  // A continuous band of dark glass all the way round, with slim stainless mullions.
  ring(plan(x0 - 0.025, x1 + 0.025, z0 - 0.025, z1 + 0.025, 0.525, 1.125), body, D + 0.55, 0.62, glass);
  for (const [x, z] of around(plan(x0 - 0.035, x1 + 0.035, z0 - 0.035, z1 + 0.035, 0.535, 1.135), 18)) s.post(scene, 0.018, 0.018, 0.64, steel, [x, D + 0.86, z], 8);
  nameBoard(y, scene, 'Bridge', [(x0 + x1) / 2, D + 1.36, z1 + 0.05], 1.4);

  /* The stairs up from the main deck: teak treads between stainless stringers. */
  const foot = -5.75;
  const steps = 7;
  for (let i = 0; i < steps; i++) s.box(scene, [(x1 - foot) / -steps + 0.06, 0.06, 1.0], mahogany, [foot + ((x1 - foot) * (i + 0.5)) / steps, D + (1.6 * (i + 1)) / steps - 0.03, 0.3], 0.02);
  for (const side of [-1, 1]) {
    const z = 0.3 + side * 0.53;
    s.bar(scene, [foot, D, z], [x1, T, z], 0.035, steel);
    s.bar(scene, [foot, D + 0.9, z], [x1, T + 0.9, z], 0.025, steel);
    s.post(scene, 0.022, 0.022, 0.9, steel, [foot, D + 0.45, z], 10);
  }

  const inner = plan(x0 + 0.02, x1 - 0.02, z0 + 0.02, z1 - 0.02, 0.48, 1.08);
  const notStairs = (x: number, z: number) => !(x > x1 - 0.6 && z > -0.3 && z < 0.9);

  /* On the roof: a thin hardtop over the aft half, a lounge sofa beneath it with glass wind screens at its sides;
     forward in the open, the helm console with screens and a glass-topped chart table. The hardtop is a white rim round
     a tinted glass skylight, so the lounge below stays in view. */
  const top = plan(x0 - 0.15, -9.5, z0 - 0.15, z1 + 0.15, 0.6, 1.3);
  const sky = plan(x0 + 0.25, -9.9, z0 + 0.25, z1 - 0.25, 0.3, 0.95);
  ring(top, sky, T + 1.95, 0.12, gloss);
  ring(plan(x0 - 0.17, -9.48, z0 - 0.17, z1 + 0.17, 0.62, 1.32), top, T + 1.9, 0.08, navy);
  prism(sky, T + 2.0, 0.03, clear, 0);
  for (const z of [z0 + 0.25, z1 - 0.25]) s.bar(scene, [x0 + 0.2, T, z], [x0 + 0.55, T + 1.95, z], 0.05, steel);
  for (let k = 0; k < 5; k++) s.post(scene, 0.06, 0.06, 0.02, strip, [-10.2, T + 1.92, -2.6 + k * 1.3], 16);
  sofa(x0 + 0.5, T, -2.6, 2.6);
  glassTable(x0 + 1.45, T, 0, 0.45);
  for (const z of [z0 + 0.12, z1 - 0.12]) s.box(scene, [1.6, 1.3, 0.03], clear, [x0 + 1.0, T + 0.95, z], 0);
  // The helm: a curved console with two screens and a small wheel.
  s.box(scene, [0.55, 0.95, 1.6], gloss, [-7.95, T + 0.48, -1.6], 0.12);
  for (const dz of [-0.4, 0.4]) {
    const sc = s.box(scene, [0.04, 0.4, 0.62], screen, [-8.2, T + 1.1, -1.6 + dz], 0.02);
    sc.rotation.z = -0.35;
  }
  s.hoop(scene, 0.2, 0.025, steel, [-8.32, T + 0.95, -1.6]).rotation.y = Math.PI / 2;
  s.post(scene, 0.2, 0.25, 0.5, gloss, [-8.75, T + 0.25, -1.6], 20);
  s.post(scene, 0.22, 0.22, 0.08, cushion, [-8.75, T + 0.54, -1.6], 20);
  glassTable(-8.6, T, 2.0, 0.55);
  for (const [x, z] of [[-9.35, 2.0], [-8.6, 2.75]]) stool(x, T, z);
  planter(x1 - 0.5, T, 3.1);
  rails(inner, T, (x, z) => x > -9.4 && notStairs(x, z));
  return {
    bridge: [{ at: [-8.75, T, -1.6], face: Math.PI / 2, seat: 0.58 }, { at: [-9.0, T, -2.7], face: 0.6, seat: 0 }, { at: [-9.1, T, -0.55], face: 0.4, seat: 0 }],
    chart: [{ at: [-9.35, T, 2.0], face: Math.PI / 2, seat: 0.52 }, { at: [-8.6, T, 2.75], face: Math.PI, seat: 0.52 }, { at: [-7.95, T, 1.55], face: -Math.PI / 2 - 0.4, seat: 0 }],
    order: telegraph(y, scene, [-7.75, T, -2.75]),
  };
}
