/**
 * The boats around the flagship, one per department: Product & Design's yacht, Operations' tug (forever on its rounds),
 * Marketing's skiff, Support's lifeboat and the CEO office's launch. A boat whose department is on is out on the water,
 * rocking gently; one whose department is off lies moored at the boardwalk under a canvas cover. Sailors' berths ride
 * with their boat.
 */
import * as THREE from 'three';
import type { BoatId, StationId } from '../lib/office';
import { lantern, lettering, nameBoard, ropeCoil, workConsole, type Yard } from './fittings';
import type { Berth } from './hull';
import type { Vec } from './parts';
import { SWELL, WATER } from './sea';

export type SmallBoat = Exclude<BoatId, 'flagship'>;

export interface Fleet {
  berths: Partial<Record<StationId, Berth[]>>;
  /** Where each boat's label floats, in its own frame. */
  anchors: Record<SmallBoat, { at: Vec; ride: THREE.Object3D }>;
  /** Out on the water, or moored under its cover. */
  setOn: Record<SmallBoat, (on: boolean) => void>;
  ticks: ((t: number, dt: number) => void)[];
}

/** A hull outline, bow toward +x: a straight run, a rounded bow and a squared-off stern with rounded quarters. */
function outline(length: number, beam: number, fine: number): THREE.Shape {
  const a = -length / 2;
  const b = length / 2;
  const run = b - length * fine;
  const w = beam / 2;
  const s = new THREE.Shape();
  s.moveTo(a + 0.3, -w * 0.88);
  s.lineTo(run, -w);
  s.bezierCurveTo(run + (b - run) * 0.62, -w, b - 0.04, -w * 0.42, b, 0);
  s.bezierCurveTo(b - 0.04, w * 0.42, run + (b - run) * 0.62, w, run, w);
  s.lineTo(a + 0.3, w * 0.88);
  s.quadraticCurveTo(a - 0.12, w * 0.8, a - 0.15, 0);
  s.quadraticCurveTo(a - 0.12, -w * 0.8, a + 0.3, -w * 0.88);
  return s;
}

interface Hull {
  /** The boat; move or rock this. */
  g: THREE.Group;
  d: number;
  /** Things hidden under the cover when the boat is laid up. */
  kit: THREE.Group;
  cover: THREE.Group;
}

function hull(y: Yard, length: number, beam: number, d: number, stripe: string, fine = 0.36): Hull {
  const { s, p, bin } = y;
  const g = new THREE.Group();
  const shape = outline(length, beam, fine);
  const body = new THREE.Mesh(bin.keep(new THREE.ExtrudeGeometry(shape, { depth: d - 0.12, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.07, bevelSegments: 3, curveSegments: 28 }).rotateX(-Math.PI / 2)), p.navy);
  body.position.y = 0.06;
  g.add(body);
  s.slab(g, shape, 0.13, p.buff, 0).scale.set(1.012, 1, 1.03);
  const band = bin.keep(new THREE.MeshStandardMaterial({ color: stripe, roughness: 0.55 }));
  s.slab(g, shape, 0.12, band, d - 0.3).scale.set(1.014, 1, 1.034);
  s.slab(g, shape, 0, bin.keep(new THREE.MeshStandardMaterial({ map: teakFor(y, length, beam), roughness: 0.75 })), d + 0.005);
  const edge = shape.getPoints(24);
  const rim = new THREE.Shape(edge);
  rim.holes.push(new THREE.Path(edge.map((q) => new THREE.Vector2(q.x * (1 - 0.32 / length), q.y * (1 - 0.32 / beam)))));
  s.slab(g, rim, 0.26, p.white, d);
  s.slab(g, rim, 0.05, p.darkTeak, d + 0.26);
  const foam = new THREE.Shape(edge.map((q) => new THREE.Vector2(q.x * (1 + 0.9 / length), q.y * (1 + 0.8 / beam))));
  foam.holes.push(new THREE.Path(edge.map((q) => new THREE.Vector2(q.x * 1.01, q.y * 1.02))));
  s.slab(g, foam, 0, bin.keep(new THREE.MeshStandardMaterial({ color: '#FFFFFF', roughness: 0.9, transparent: true, opacity: 0.55, depthWrite: false })), WATER + SWELL + 0.02).userData.flat = true;
  const kit = new THREE.Group();
  const cover = new THREE.Group();
  g.add(kit, cover);
  const cloth = bin.keep(new THREE.MeshStandardMaterial({ color: '#CEC6AF', roughness: 0.95 }));
  s.box(cover, [length * 0.84, 0.55, beam * 0.82], cloth, [-length * 0.03, d + 0.42, 0], 0.26);
  for (let x = -length * 0.38; x <= length * 0.36; x += length / 5) s.box(cover, [0.05, 0.6, beam * 0.86], p.rope, [x, d + 0.42, 0], 0.02);
  cover.visible = false;
  return { g, d, kit, cover };
}

const teaks = new WeakMap<Yard, Map<string, THREE.Texture>>();
/** The deck planking, one texture per boat size. */
function teakFor(y: Yard, length: number, beam: number): THREE.Texture {
  const key = `${length}x${beam}`;
  const map = teaks.get(y) ?? new Map<string, THREE.Texture>();
  teaks.set(y, map);
  if (!map.has(key)) {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const g = c.getContext('2d')!;
    g.fillStyle = '#B98B55';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 16; i++) {
      g.fillStyle = i % 2 ? '#B2844F' : '#BF925C';
      g.fillRect(0, i * 16, 256, 15);
      g.fillStyle = '#7A5733';
      g.fillRect(0, i * 16 + 15, 256, 1);
    }
    const tex = y.bin.keep(new THREE.CanvasTexture(c));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(length / 4, beam / 3);
    map.set(key, tex);
  }
  return map.get(key)!;
}

const at = (x: number, base: number, z: number, face = 0, seat = 0, ride?: THREE.Object3D, agent?: string): Berth => ({ at: [x, base, z], face, seat, ride, agent });

function bench(y: Yard, parent: THREE.Object3D, x: number, d: number, z: number, width: number, seat = 0.42): void {
  y.s.box(parent, [0.44, 0.07, width], y.p.teak, [x, d + seat - 0.035, z], 0.025);
  for (const dz of [-width / 2 + 0.14, width / 2 - 0.14]) y.s.box(parent, [0.34, seat - 0.07, 0.08], y.p.darkTeak, [x, d + (seat - 0.07) / 2, z + dz], 0.015);
}

function pennant(y: Yard, parent: THREE.Object3D, base: Vec, height: number, colour: string): void {
  const tri = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.95, -0.17), new THREE.Vector2(0, -0.4)]);
  const m = new THREE.Mesh(y.bin.keep(new THREE.ShapeGeometry(tri)), y.bin.keep(new THREE.MeshStandardMaterial({ color: colour, roughness: 0.8, side: THREE.DoubleSide })));
  m.position.set(base[0] + 0.04, base[1] + height, base[2]);
  parent.add(m);
}

/** A sail that bellies: a triangle of cloth, bowed out along its middle. */
function sail(y: Yard, foot: number, height: number, belly: number): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(1, 1, 10, 16);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i) + 0.5;
    const v = pos.getY(i) + 0.5;
    const w = u * (1 - v * 0.96);
    pos.setXYZ(i, -w * foot, v * height, Math.sin(Math.PI * (w / Math.max(0.001, 1 - v * 0.96))) * belly * (1 - v) * (1 - v * 0.5));
  }
  geo.computeVertexNormals();
  return new THREE.Mesh(y.bin.keep(geo), y.bin.keep(new THREE.MeshStandardMaterial({ color: '#FBF8EE', roughness: 0.92, side: THREE.DoubleSide })));
}

export function buildFleet(y: Yard, scene: THREE.Scene, colour: (dept: string) => string): Fleet {
  const { s, p, bin } = y;
  const berths: Fleet['berths'] = {};
  const ticks: Fleet['ticks'] = [];
  const anchors = {} as Fleet['anchors'];
  const setOn = {} as Fleet['setOn'];

  /** Put a boat in the harbour: out at `sea`, or moored at `berth`, rocking when out. */
  const launch = (id: SmallBoat, h: Hull, sea: { at: Vec; turn: number } | null, moor: { at: Vec; turn: number }, rock: number) => {
    const holder = new THREE.Group();
    scene.add(holder);
    holder.add(h.g);
    let out = true;
    setOn[id] = (on) => {
      out = on;
      const where = on && sea ? sea : moor;
      holder.position.set(...where.at);
      holder.rotation.y = where.turn;
      h.cover.visible = !on;
      h.kit.visible = on;
    };
    setOn[id](true);
    const k = id.length;
    ticks.push((t) => {
      const amp = out ? rock : rock * 0.3;
      h.g.rotation.x = Math.sin(t * 0.9 + k) * 0.022 * amp;
      h.g.rotation.z = Math.sin(t * 0.7 + k * 2) * 0.012 * amp;
      h.g.position.y = Math.sin(t * 1.1 + k) * 0.03 * amp;
    });
  };

  /* Product & Design: a yacht astern of the flagship, sails set */
  {
    const h = hull(y, 11, 4.4, 1.0, colour('product'), 0.4);
    const { g, d, kit } = h;
    s.box(kit, [3.6, 0.95, 2.7], p.white, [-2.4, d + 0.47, -0.25], 0.18);
    s.box(kit, [3.8, 0.1, 2.9], p.darkTeak, [-2.4, d + 0.99, -0.25], 0.04);
    for (const x of [-3.6, -2.4, -1.2]) {
      s.hoop(kit, 0.13, 0.035, p.brass, [x, d + 0.55, 1.12]);
      s.sign(kit, 0.2, 0.2, p.glow, [x, d + 0.55, 1.115]);
    }
    nameBoard(y, kit, 'Product & Design', [-2.4, d + 0.62, 1.13], 2.4);
    s.post(kit, 0.08, 0.12, 8.6, p.white, [1.3, d + 4.3, 0], 14);
    s.bar(kit, [1.3, d + 1.05, 0], [-3.9, d + 1.05, 0], 0.07, p.darkTeak);
    const main = sail(y, 5.1, 7.2, 0.55);
    main.position.set(1.2, d + 1.12, 0);
    kit.add(main);
    const jib = sail(y, 3.6, 6.0, 0.4);
    jib.rotation.y = Math.PI;
    jib.position.set(1.4, d + 0.5, 0.02);
    kit.add(jib);
    for (const to of [[5.4, d + 0.3, 0], [-5.3, d + 0.3, 0], [1.3, d + 0.3, 2.1], [1.3, d + 0.3, -2.1]] as Vec[]) s.bar(kit, [1.3, d + 8.5, 0], to, 0.012, p.iron);
    pennant(y, kit, [1.3, d + 8.6, 0], 0.05, colour('product'));
    const wheel = new THREE.Group();
    s.hoop(wheel, 0.32, 0.03, p.darkTeak, [0, 0, 0]);
    for (let i = 0; i < 4; i++) s.box(wheel, [0.03, 0.8, 0.03], p.darkTeak, [0, 0, 0], 0.01).rotation.z = (i * Math.PI) / 4;
    wheel.position.set(-4.6, d + 0.95, 0);
    wheel.rotation.y = Math.PI / 2;
    kit.add(wheel);
    bench(y, kit, 3.4, d, 0, 3.0);
    workConsole(y, kit, [-0.2, d, 1.55], Math.PI)('');
    s.box(kit, [1.0, 0.72, 0.6], p.teak, [-4.3, d + 0.36, -1.3], 0.04);
    lantern(y, kit, [3.9, d + 0.3, -1.6]);
    berths.yacht = [
      at(3.4, d, -0.75, -Math.PI / 2, 0.42, g, 'pm'),
      at(3.4, d, 0.75, -Math.PI / 2, 0.42, g, 'designer'),
      at(-0.32, d, 0.95, Math.PI, 0, g, 'analyst'),
      at(-4.3, d, -0.6, Math.PI, 0, g, 'writer'),
      at(-4.2, d, 1.1, -0.4, 0, g),
      at(0.9, d, -1.5, 0.3, 0, g),
    ];
    anchors.yacht = { at: [-2.4, d + 2.4, 0.2], ride: g };
    launch('yacht', h, { at: [-2.5, 0, -12.6], turn: 0 }, { at: [-12.8, 0, 10.4], turn: 0 }, 1);
  }

  /* Operations: the tug, circling the fleet with the watches aboard */
  {
    const h = hull(y, 7.4, 3.4, 1.05, colour('operations'), 0.42);
    const { g, d, kit } = h;
    s.box(kit, [2.2, 1.55, 2.1], p.white, [-0.5, d + 0.78, 0], 0.1);
    s.box(kit, [2.5, 0.14, 2.4], p.navy, [-0.5, d + 1.62, 0], 0.04);
    for (const z of [-1.06, 1.06]) {
      const w = s.sign(kit, 1.6, 0.5, p.glow, [-0.5, d + 1.1, z]);
      if (z < 0) w.rotation.y = Math.PI;
    }
    s.sign(kit, 1.5, 0.48, p.glow, [0.62, d + 1.1, 0]).rotation.y = Math.PI / 2;
    nameBoard(y, kit, 'Operations', [-0.5, d + 0.55, 1.07], 1.5);
    s.post(kit, 0.32, 0.36, 1.3, p.navy, [-1.35, d + 2.25, 0], 20);
    s.post(kit, 0.37, 0.37, 0.24, p.white, [-1.35, d + 2.62, 0], 20);
    s.post(kit, 0.04, 0.05, 2.0, p.white, [-0.1, d + 2.6, 0], 8);
    s.ball(kit, 0.09, p.glow, [-0.1, d + 3.6, 0]);
    for (const [x, z] of [[-2.9, 1.72], [-1.1, 1.78], [0.7, 1.78], [2.4, 1.6], [-2.9, -1.72], [-1.1, -1.78], [0.7, -1.78], [2.4, -1.6]]) {
      s.hoop(kit, 0.22, 0.09, p.black, [x, d - 0.28, z]);
    }
    s.post(kit, 0.16, 0.2, 0.45, p.iron, [-3.0, d + 0.22, 0], 14);
    ropeCoil(y, kit, [2.6, d, 0.2]);
    const churn = bin.keep(new THREE.MeshStandardMaterial({ color: '#FFFFFF', roughness: 0.9, transparent: true, opacity: 0.32, depthWrite: false }));
    for (const side of [-1, 1]) s.slab(g, new THREE.Shape([new THREE.Vector2(-3.8, side * 1.0), new THREE.Vector2(-10.5, side * 3.4), new THREE.Vector2(-4.0, side * 0.78)]), 0, churn, WATER + SWELL + 0.015).userData.flat = true;
    s.slab(g, new THREE.Shape(Array.from({ length: 18 }, (_, i) => new THREE.Vector2(-4.6 + Math.cos((i / 18) * Math.PI * 2) * 1.3, Math.sin((i / 18) * Math.PI * 2) * 1.0))), 0, churn, WATER + SWELL + 0.016).userData.flat = true;
    berths.tug = [at(1.4, d, -0.9, Math.PI / 2, 0, g), at(1.9, d, 0.7, Math.PI / 2 + 0.4, 0, g), at(2.7, d, -0.3, Math.PI / 2 - 0.3, 0, g), at(-2.4, d, 0.75, -Math.PI / 2, 0, g), at(-2.5, d, -0.75, -Math.PI / 2 + 0.3, 0, g), at(-3.1, d, 0.0, -Math.PI / 2, 0, g)];
    anchors.tug = { at: [-0.5, d + 4.1, 0], ride: g };
    const ring = new THREE.Group();
    ring.position.set(20.5, 0, 1.0);
    scene.add(ring);
    const holder = new THREE.Group();
    holder.position.set(0, 0, 4.4);
    ring.add(holder);
    holder.add(g);
    let out = true;
    setOn.tug = (on) => {
      out = on;
      h.cover.visible = !on;
      h.kit.visible = on;
    };
    ticks.push((t) => {
      if (out) ring.rotation.y = t * 0.055;
      g.rotation.z = Math.sin(t * 0.8) * 0.02;
      g.rotation.x = Math.sin(t * 1.0 + 1) * 0.015;
    });
  }

  /* Marketing: a skiff with a loud-hailer and bunting */
  {
    const h = hull(y, 5.8, 2.5, 0.78, colour('marketing'), 0.45);
    const { g, d, kit } = h;
    bench(y, kit, -1.2, d, 0, 2.0);
    bench(y, kit, 0.9, d, 0, 2.0);
    s.box(kit, [0.5, 0.75, 0.42], p.black, [-3.05, d + 0.25, 0], 0.08);
    s.box(kit, [0.12, 0.7, 0.12], p.iron, [-3.18, d - 0.3, 0], 0.03);
    s.post(kit, 0.05, 0.05, 1.1, p.white, [2.2, d + 0.55, 0], 10);
    const horn = s.post(kit, 0.34, 0.08, 0.62, p.brass, [2.5, d + 1.15, 0], 20);
    horn.rotation.z = -Math.PI / 2;
    s.post(kit, 0.03, 0.03, 2.1, p.white, [-2.6, d + 1.05, 0.8], 8);
    s.post(kit, 0.03, 0.03, 1.5, p.white, [2.2, d + 0.75, -0.8], 8);
    const flags = [colour('marketing'), '#E3B23C', '#F7F5EF'];
    for (let i = 0; i < 9; i++) {
      const u = i / 8;
      const f = s.box(kit, [0.16, 0.2, 0.015], bin.keep(new THREE.MeshStandardMaterial({ color: flags[i % 3], roughness: 0.8 })), [-2.6 + u * 4.8, d + 2.0 - u * 0.55 - Math.sin(u * Math.PI) * 0.35, 0.8 - u * 1.6], 0);
      f.rotation.z = Math.PI / 4;
    }
    lettering(y, kit, 'Marketing', [0.2, d - 0.4, 1.28], 1.9, '#F7F5EF', false);
    berths.skiff = [at(-1.2, d, 0.45, Math.PI / 2, 0.42, g), at(0.9, d, -0.45, Math.PI / 2, 0.42, g)];
    anchors.skiff = { at: [0, d + 2.8, 0], ride: g };
    launch('skiff', h, { at: [10.8, 0, 10.8], turn: -0.35 }, { at: [8.2, 0, 9.4], turn: 0 }, 1.6);
  }

  /* Support: a lifeboat; and the CEO office: a launch with a canopy */
  {
    const h = hull(y, 5.0, 2.2, 0.75, colour('support'), 0.45);
    const { g, d, kit } = h;
    bench(y, kit, -1.0, d, 0, 1.8);
    bench(y, kit, 0.8, d, 0, 1.8);
    s.post(kit, 0.04, 0.04, 1.6, p.white, [1.8, d + 0.8, 0], 8);
    s.hoop(kit, 0.28, 0.07, bin.keep(new THREE.MeshStandardMaterial({ color: '#E35A2B', roughness: 0.7 })), [-2.0, d + 0.45, 0.95]);
    lettering(y, kit, 'Support', [0.0, d - 0.38, 1.13], 1.6, '#F7F5EF', false);
    berths.lifeboat = [at(-1.0, d, 0.4, Math.PI / 2, 0.42, g), at(0.8, d, -0.4, Math.PI / 2, 0.42, g)];
    anchors.lifeboat = { at: [0, d + 1.9, 0], ride: g };
    launch('lifeboat', h, { at: [25.5, 0, -9.5], turn: 0.5 }, { at: [1.9, 0, 10.6], turn: 0 }, 1.3);
  }
  {
    const h = hull(y, 5.4, 2.3, 0.8, colour('ceo'), 0.42);
    const { g, d, kit } = h;
    s.box(kit, [1.6, 0.9, 1.9], p.white, [1.0, d + 0.45, 0], 0.12);
    s.box(kit, [1.7, 0.08, 2.0], p.darkTeak, [1.0, d + 0.92, 0], 0.03);
    const canopy = bin.keep(new THREE.MeshStandardMaterial({ color: '#F4E6BC', roughness: 0.9 }));
    s.box(kit, [2.0, 0.06, 2.0], canopy, [-1.1, d + 1.6, 0], 0.03);
    for (const [x, z] of [[-2.0, 0.9], [-2.0, -0.9], [-0.2, 0.9], [-0.2, -0.9]]) s.post(kit, 0.025, 0.025, 1.6, p.brass, [x, d + 0.8, z], 8);
    bench(y, kit, -1.6, d, 0, 1.9);
    lettering(y, kit, 'CEO office', [-0.4, d - 0.4, 1.18], 1.8, '#F7F5EF', false);
    berths.launch = [at(-1.6, d, 0.45, Math.PI / 2, 0.42, g), at(-0.7, d, -0.5, Math.PI / 2, 0, g)];
    anchors.launch = { at: [0, d + 2.2, 0], ride: g };
    launch('launch', h, { at: [-16.1, 0, -5.8], turn: Math.PI / 2 }, { at: [-3.6, 0, 10.6], turn: 0 }, 1.2);
  }
  return { berths, anchors, setOn, ticks };
}
