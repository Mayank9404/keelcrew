/**
 * The harbour the fleet lies in, built once per mount: land shaped from a height field (a sand beach that runs on under
 * the water so the shallows show, grass, rocky slopes and wooded hills behind), a stone harbour wall on the left with a
 * row of houses (window boxes, awnings) and the harbour office, the quayside's gear (a crane, cargo, lobster pots, a net
 * on its rack, a café table), a rowing boat at the wall, a boardwalk out to the quay, a lighthouse on the point whose
 * beam sweeps after dark, channel buoys riding the swell, gulls overhead and dinghies sailing outside.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { barrel, crate, lantern, lettering, ropeCoil, type Yard } from './fittings';
import type { Vec } from './parts';
import { WATER } from './sea';

/* Small deterministic noise, so the harbour is the same on every visit. */
const hash = (x: number, z: number) => {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const smooth = (a: number, b: number, t: number) => {
  const k = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return k * k * (3 - 2 * k);
};
function noise(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash(xi, zi);
  const b = hash(xi + 1, zi);
  const c = hash(xi, zi + 1);
  const d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x: number, z: number) => noise(x, z) * 0.55 + noise(x * 2.1, z * 2.1) * 0.28 + noise(x * 4.3, z * 4.3) * 0.17;

/** The harbour wall's line and the flat quayside behind it. */
const WALL_X = -19.6;
const WALL_Z: [number, number] = [-9.5, 16];
const QUAYSIDE = 1.0;
export const LIGHTHOUSE: [number, number] = [33, -16.5];

/** How far inland a point is (negative out on the water). */
function inland(x: number, z: number): number {
  const back = -21 + 1.6 * Math.sin(0.13 * x) + 0.9 * Math.sin(0.31 * x + 1) - z;
  const along = smooth(WALL_Z[0] - 4, WALL_Z[0], z) * (1 - smooth(WALL_Z[1], WALL_Z[1] + 4, z));
  const edge = -18.8 + 0.8 * Math.sin(0.21 * z) + 0.5 * Math.sin(0.47 * z + 2);
  const left = edge + (WALL_X - edge) * along - x;
  const point = (7 - Math.hypot(x - LIGHTHOUSE[0], z - LIGHTHOUSE[1])) * 0.8;
  return Math.max(back, left, point);
}

/** Ground height at a point. */
export function groundAt(x: number, z: number): number {
  const d = inland(x, z);
  if (d < 0) return Math.max(-3.5, WATER - 0.14 + d * 0.2);
  const quay = x < WALL_X + 0.05 && z > WALL_Z[0] && z < WALL_Z[1] && x > -31;
  if (quay) return QUAYSIDE + smooth(-27, -31, x) * fbm(x * 0.08, z * 0.08) * 3;
  return WATER - 0.14 + smooth(0, 2.6, d) * 0.85 + smooth(3, 18, d) * (0.8 + fbm(x * 0.055 + 3, z * 0.055) * 7.5);
}

const SAND = new THREE.Color('#E4D4AC');
const WET = new THREE.Color('#BFAE86');
const GRASS = new THREE.Color('#87AA74');
const MEADOW = new THREE.Color('#A3B97E');
const WOOD = new THREE.Color('#6D9264');
const ROCK = new THREE.Color('#9B9A90');
const PAVING = new THREE.Color('#B9AE96');

function terrain(y: Yard, scene: THREE.Scene): void {
  const geo = new THREE.PlaneGeometry(240, 170, 240, 170).rotateX(-Math.PI / 2).translate(0, 0, -30);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setY(i, groundAt(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  const colors: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = pos.getY(i);
    const grain = noise(x * 0.4, z * 0.4) * 0.08 - 0.04;
    if (h < WATER - 0.02) c.copy(WET).lerp(SAND, smooth(-1.2, WATER, h));
    else if (x < WALL_X + 0.05 && z > WALL_Z[0] && z < WALL_Z[1] && x > -22.7) c.copy(PAVING);
    else if (h < WATER + 0.5) c.copy(SAND).lerp(MEADOW, smooth(WATER + 0.3, WATER + 0.5, h));
    else c.copy(MEADOW).lerp(GRASS, smooth(0.2, 0.7, fbm(x * 0.09, z * 0.09))).lerp(WOOD, smooth(2.5, 6, h));
    c.lerp(ROCK, smooth(0.86, 0.7, nrm.getY(i)));
    c.offsetHSL(0, 0, grain);
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const land = new THREE.Mesh(y.bin.keep(geo), y.bin.keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 })));
  land.receiveShadow = true;
  land.userData.ground = true;
  scene.add(land);
}

/** Pines and round trees as two instanced meshes each (trunks and crowns), scattered over the hills. */
function woods(y: Yard, scene: THREE.Scene): void {
  const { bin } = y;
  const spots: [number, number, number, boolean][] = [];
  let tries = 0;
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  while (spots.length < 300 && tries++ < 6000) {
    const x = -70 + rnd() * 140;
    const z = -80 + rnd() * 112;
    const h = groundAt(x, z);
    if (h < 1.25) continue;
    if (x < -18 && x > -32 && z > -13 && z < 19) continue;
    if (Math.hypot(x - LIGHTHOUSE[0], z - LIGHTHOUSE[1]) < 6.5) continue;
    if (spots.some(([a, , b]) => Math.hypot(a - x, b - z) < 1.6)) continue;
    spots.push([x, h, z, rnd() < 0.62]);
  }
  const pineCrown = mergeGeometries([new THREE.ConeGeometry(1.0, 1.6, 9).translate(0, 1.4, 0), new THREE.ConeGeometry(0.8, 1.4, 9).translate(0, 2.2, 0), new THREE.ConeGeometry(0.55, 1.2, 9).translate(0, 2.95, 0)]);
  const roundCrown = mergeGeometries([new THREE.IcosahedronGeometry(1.0, 1).translate(0, 1.85, 0), new THREE.IcosahedronGeometry(0.7, 1).translate(0.55, 1.5, 0.3), new THREE.IcosahedronGeometry(0.65, 1).translate(-0.5, 1.55, -0.25)]);
  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.18, 1.2, 7).translate(0, 0.55, 0);
  for (const g of [pineCrown, roundCrown, trunkGeo]) bin.keep(g);
  const leaf = bin.keep(new THREE.MeshStandardMaterial({ color: '#FFFFFF', roughness: 0.85, flatShading: true }));
  const bark = bin.keep(new THREE.MeshStandardMaterial({ color: '#6B4F35', roughness: 0.95 }));
  const pines = spots.filter((s) => s[3]);
  const rounds = spots.filter((s) => !s[3]);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const c = new THREE.Color();
  const place = (list: typeof spots, crown: THREE.BufferGeometry, tints: string[]) => {
    const crowns = new THREE.InstancedMesh(crown, leaf, list.length);
    const trunks = new THREE.InstancedMesh(trunkGeo, bark, list.length);
    list.forEach(([x, h, z], i) => {
      const k = 0.75 + hash(x, z) * 0.75;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash(z, x) * Math.PI * 2);
      m.compose(new THREE.Vector3(x, h - 0.1, z), q, new THREE.Vector3(k, k * (0.9 + hash(x + 1, z) * 0.35), k));
      crowns.setMatrixAt(i, m);
      trunks.setMatrixAt(i, m);
      crowns.setColorAt(i, c.set(tints[Math.floor(hash(x * 3, z * 7) * tints.length)]));
    });
    for (const mesh of [crowns, trunks]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  };
  place(pines, pineCrown, ['#4E7A55', '#5A8660', '#466F4E']);
  place(rounds, roundCrown, ['#6F9A5A', '#7FA563', '#5F8A52', '#8DAA62']);
}

/** A gabled house facing the water (+x): walls, roof with eaves, a chimney, a door and two rows of windows. */
function house(y: Yard, scene: THREE.Scene, at: Vec, w: number, d: number, h: number, wall: THREE.Material, roof: THREE.Material, windows: THREE.Material): void {
  const { s, p, bin } = y;
  const g = new THREE.Group();
  g.position.set(...at);
  scene.add(g);
  s.box(g, [d, h, w], wall, [0, h / 2, 0], 0.05);
  const pitch = Math.min(1.6, w * 0.42);
  const gable = new THREE.Shape([new THREE.Vector2(-w / 2 - 0.25, 0), new THREE.Vector2(w / 2 + 0.25, 0), new THREE.Vector2(0, pitch)]);
  const roofMesh = new THREE.Mesh(bin.keep(new THREE.ExtrudeGeometry(gable, { depth: d + 0.5, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, bevelSegments: 1 })), roof);
  roofMesh.rotation.y = Math.PI / 2;
  roofMesh.position.set(-(d + 0.5) / 2, h - 0.02, 0);
  g.add(roofMesh);
  const fill = new THREE.Shape([new THREE.Vector2(-w / 2, 0), new THREE.Vector2(w / 2, 0), new THREE.Vector2(0, pitch * 0.92)]);
  for (const side of [-1, 1]) {
    const end = new THREE.Mesh(bin.keep(new THREE.ShapeGeometry(fill)), wall);
    end.rotation.y = Math.PI / 2;
    end.position.set((side * d) / 2, h, 0);
    g.add(end);
  }
  s.box(g, [0.45, 1.1, 0.45], p.white, [-d * 0.2, h + pitch * 0.7, w * 0.22], 0.03);
  s.box(g, [0.55, 0.12, 0.55], p.iron, [-d * 0.2, h + pitch * 0.7 + 0.58, w * 0.22], 0.02);
  const front = d / 2 + 0.02;
  s.box(g, [0.06, 1.15, 0.7], p.darkTeak, [front, 0.58, w / 2 - 0.75], 0.02);
  // A striped awning over the door, and the step below it.
  const awning = new THREE.Group();
  awning.position.set(front + 0.32, 1.42, w / 2 - 0.75);
  awning.rotation.z = -0.38;
  g.add(awning);
  for (let k = 0; k < 5; k++) s.box(awning, [0.7, 0.03, 0.2], k % 2 ? p.white : roof, [0, 0, -0.4 + k * 0.2], 0.005);
  s.box(g, [0.36, 0.1, 0.9], p.grey, [front + 0.18, 0.05, w / 2 - 0.75], 0.02);
  const cols = Math.max(1, Math.floor((w - 1.4) / 0.95));
  for (let row = 0; row < (h > 2.6 ? 2 : 1); row++) {
    for (let k = 0; k < cols; k++) {
      const z = -w / 2 + 0.6 + k * 0.95;
      const yy = row ? h - 0.8 : 1.15;
      if (!row && z > w / 2 - 1.3) continue;
      s.box(g, [0.06, 0.66, 0.52], p.white, [front, yy, z], 0.01);
      s.sign(g, 0.42, 0.54, windows, [front + 0.04, yy, z]).rotation.y = Math.PI / 2;
      // Window boxes of flowers on the upper floor.
      if (row) {
        s.box(g, [0.18, 0.14, 0.56], p.darkTeak, [front + 0.1, yy - 0.42, z], 0.02);
        for (let f = 0; f < 4; f++) s.ball(g, 0.07, flowers(y)[(f + k) % 5], [front + 0.12, yy - 0.3, z - 0.2 + f * 0.13]);
      }
    }
  }
}

const flowerMats = new WeakMap<Yard, THREE.Material[]>();
/** Window-box flowers, made once per mount. */
function flowers(y: Yard): THREE.Material[] {
  const have = flowerMats.get(y);
  if (have) return have;
  const list = ['#D9534F', '#F2C14E', '#F7F5EF', '#B4237F', '#6FA0D8'].map((c) => y.bin.keep(new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 })));
  flowerMats.set(y, list);
  return list;
}

/** The quayside's working gear: a crane with a crate on its hook, cargo and lobster pots, a net drying on its rack, a café table. */
function quayside(y: Yard, scene: THREE.Scene, ticks: ((t: number, dt: number) => void)[]): void {
  const { s, p, bin } = y;
  const base = QUAYSIDE;
  const yellow = bin.keep(new THREE.MeshStandardMaterial({ color: '#E3B23C', roughness: 0.55 }));
  /* A small dockside crane at the north end, its jib swinging slowly out over the water */
  const crane = new THREE.Group();
  crane.position.set(-21.2, base, 14.2);
  scene.add(crane);
  s.box(crane, [1.4, 0.3, 1.4], p.iron, [0, 0.15, 0], 0.04);
  s.post(crane, 0.16, 0.2, 3.4, yellow, [0, 2.0, 0], 12);
  s.box(crane, [1.1, 0.8, 0.9], yellow, [-0.2, 3.6, 0], 0.06);
  s.sign(crane, 0.45, 0.35, p.glow, [0.36, 3.7, 0.46]);
  const jib = new THREE.Group();
  jib.position.set(0, 3.9, 0);
  crane.add(jib);
  s.bar(jib, [0, 0, 0], [4.6, 1.0, 0], 0.09, yellow);
  s.bar(jib, [0, 0.9, 0], [4.6, 1.0, 0], 0.04, p.iron);
  s.bar(jib, [-1.0, 0.1, 0], [0, 0.9, 0], 0.04, p.iron);
  s.box(jib, [0.6, 0.5, 0.6], p.iron, [-1.1, -0.1, 0], 0.04);
  s.bar(jib, [4.5, 0.95, 0], [4.5, -2.1, 0], 0.02, p.iron);
  s.box(jib, [0.18, 0.22, 0.12], p.iron, [4.5, -2.15, 0], 0.03);
  crate(y, jib, [4.5, -2.95, 0], 0.66);
  ticks.push((t) => void (jib.rotation.y = 0.35 + Math.sin(t * 0.12) * 0.5));
  jib.rotation.y = 0.35;

  /* Cargo waiting on the quay: crates, barrels, lobster pots and coils of rope */
  for (const [x, z, k] of [[-21.4, -8.6, 0.62], [-20.8, -8.4, 0.5], [-21.1, -7.7, 0.55]] as const) crate(y, scene, [x, base, z], k);
  crate(y, scene, [-21.2, base + 0.5, -8.4], 0.44);
  barrel(y, scene, [-20.5, base, -6.9]);
  barrel(y, scene, [-20.9, base, -6.5]);
  ropeCoil(y, scene, [-20.4, base, 3.9]);
  const pot = bin.keep(new THREE.MeshStandardMaterial({ color: '#8A633A', roughness: 0.9, wireframe: true }));
  for (const [x, z, h] of [[-21.9, -3.4, 0], [-21.3, -3.3, 0], [-21.6, -3.35, 0.42], [-22.1, -2.7, 0]] as const) {
    const g = new THREE.Group();
    g.position.set(x, base + h, z);
    scene.add(g);
    s.box(g, [0.5, 0.06, 0.4], p.darkTeak, [0, 0.03, 0], 0.01);
    const cage = new THREE.Mesh(bin.keep(new THREE.CylinderGeometry(0.21, 0.21, 0.5, 8, 2, true, 0, Math.PI).rotateX(Math.PI / 2).rotateY(Math.PI / 2)), pot);
    cage.position.y = 0.06;
    g.add(cage);
  }

  /* A fishing net drying on its rack, with its floats */
  const rack = new THREE.Group();
  rack.position.set(-21.6, base, 0.1);
  scene.add(rack);
  for (const z of [-1.2, 1.2]) s.post(rack, 0.05, 0.06, 1.8, p.darkTeak, [0, 0.9, z], 8);
  s.bar(rack, [0, 1.78, -1.25], [0, 1.78, 1.25], 0.035, p.darkTeak);
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g2 = c.getContext('2d')!;
  g2.strokeStyle = '#3C5A5A';
  g2.lineWidth = 3;
  for (let i = 0; i <= 64; i += 16) {
    g2.beginPath();
    g2.moveTo(i, 0);
    g2.lineTo(i, 64);
    g2.moveTo(0, i);
    g2.lineTo(64, i);
    g2.stroke();
  }
  const netTex = bin.keep(new THREE.CanvasTexture(c));
  netTex.wrapS = netTex.wrapT = THREE.RepeatWrapping;
  netTex.repeat.set(6, 4);
  const netGeo = new THREE.PlaneGeometry(2.4, 1.5, 12, 6);
  const np = netGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < np.count; i++) np.setZ(i, Math.sin((np.getX(i) / 2.4) * Math.PI * 3) * 0.06 + (0.75 - np.getY(i)) * 0.18);
  const net = new THREE.Mesh(bin.keep(netGeo), bin.keep(new THREE.MeshStandardMaterial({ map: netTex, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.9 })));
  net.rotation.y = Math.PI / 2;
  net.position.set(0.02, 1.0, 0);
  net.userData.flat = true;
  rack.add(net);
  for (const [z, col] of [[-0.8, '#E35A2B'], [0.1, '#E3B23C'], [0.9, '#E35A2B']] as const) s.ball(rack, 0.09, bin.keep(new THREE.MeshStandardMaterial({ color: col, roughness: 0.6 })), [0.08, 1.7, z]);

  /* A café table under a parasol by the harbour office, two chairs, and a bench facing the water */
  const cafe = new THREE.Group();
  cafe.position.set(-21.3, base, 5.1);
  scene.add(cafe);
  s.post(cafe, 0.3, 0.3, 0.04, p.white, [0, 0.72, 0], 18);
  s.post(cafe, 0.03, 0.03, 0.72, p.iron, [0, 0.36, 0], 8);
  s.post(cafe, 0.03, 0.03, 2.2, p.white, [0, 1.1, 0], 8);
  const shade = bin.keep(new THREE.MeshStandardMaterial({ color: '#B4237F', roughness: 0.8, side: THREE.DoubleSide }));
  const parasol = new THREE.Mesh(bin.keep(new THREE.ConeGeometry(1.1, 0.45, 8, 1, true)), shade);
  parasol.position.y = 2.1;
  cafe.add(parasol);
  for (const dz of [-0.55, 0.55]) {
    s.box(cafe, [0.36, 0.05, 0.36], p.navy, [0, 0.45, dz], 0.02);
    s.box(cafe, [0.05, 0.4, 0.36], p.navy, [-0.17, 0.65, dz], 0.02);
  }
  s.box(scene, [0.4, 0.06, 1.6], p.teak, [-20.2, base + 0.44, -1.9], 0.02);
  for (const dz of [-0.6, 0.6]) s.box(scene, [0.32, 0.42, 0.07], p.iron, [-20.2, base + 0.21, -1.9 + dz], 0.01);
}

/** A rowing boat tied up at the harbour wall, oars shipped. */
function rowingBoat(y: Yard, scene: THREE.Scene, ticks: ((t: number, dt: number) => void)[]): void {
  const { s, p, bin } = y;
  const shape = new THREE.Shape();
  shape.moveTo(-1.4, -0.55);
  shape.quadraticCurveTo(0.9, -0.62, 1.55, 0);
  shape.quadraticCurveTo(0.9, 0.62, -1.4, 0.55);
  shape.quadraticCurveTo(-1.55, 0, -1.4, -0.55);
  const g = new THREE.Group();
  g.position.set(WALL_X + 1.0, 0, -4.6);
  g.rotation.y = Math.PI / 2 + 0.1;
  scene.add(g);
  const hullGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.42, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 2, curveSegments: 18 }).rotateX(-Math.PI / 2);
  const shell = new THREE.Mesh(bin.keep(hullGeo), bin.keep(new THREE.MeshStandardMaterial({ color: '#E8E3D6', roughness: 0.6 })));
  shell.position.y = 0.05;
  g.add(shell);
  s.slab(g, shape, 0.02, p.teak, 0.48).scale.set(0.92, 1, 0.86);
  for (const x of [-0.6, 0.4]) s.box(g, [0.24, 0.05, 1.0], p.darkTeak, [x, 0.56, 0], 0.01);
  for (const side of [-1, 1]) {
    s.bar(g, [-1.1, 0.62, side * 0.32], [1.1, 0.62, side * 0.18], 0.025, p.wood);
    s.box(g, [0.4, 0.02, 0.1], p.wood, [1.25, 0.62, side * 0.16], 0.005);
  }
  s.bar(scene, [WALL_X - 0.05, QUAYSIDE + 0.32, -4.0], [WALL_X + 1.1, 0.55, -3.2], 0.02, p.rope);
  ticks.push((t) => {
    g.position.y = Math.sin(t * 1.2 + 2) * 0.03;
    g.rotation.z = Math.sin(t * 0.9) * 0.03;
  });
}

/** Gulls wheeling over the harbour, and two dinghies sailing outside it. */
function life(y: Yard, scene: THREE.Scene, ticks: ((t: number, dt: number) => void)[]): void {
  const { s, p, bin } = y;
  const feather = bin.keep(new THREE.MeshStandardMaterial({ color: '#FBFBF8', roughness: 0.8 }));
  const tipMat = bin.keep(new THREE.MeshStandardMaterial({ color: '#4A5560', roughness: 0.8 }));
  for (let i = 0; i < 6; i++) {
    const g = new THREE.Group();
    scene.add(g);
    s.ball(g, 0.16, feather, [0, 0, 0]).scale.set(2.2, 0.8, 0.9);
    s.ball(g, 0.04, p.yellow, [0.38, 0.02, 0]).scale.set(1.6, 0.6, 0.6);
    const wings: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const w = new THREE.Group();
      g.add(w);
      s.box(w, [0.3, 0.025, 0.55], feather, [0, 0, side * 0.3], 0.01);
      s.box(w, [0.22, 0.026, 0.25], tipMat, [-0.02, 0, side * 0.68], 0.01);
      wings.push(w);
    }
    const cx = -4 + (i % 3) * 12;
    const cz = -6 + Math.floor(i / 3) * 14;
    const r = 5 + i;
    const h = 7 + (i % 3) * 1.6;
    const sp = 0.22 + (i % 2) * 0.08;
    ticks.push((t) => {
      const a = t * sp + i * 1.9;
      g.position.set(cx + Math.cos(a) * r, h + Math.sin(t * 0.7 + i) * 0.4, cz + Math.sin(a) * r);
      g.rotation.y = -a - Math.PI / 2;
      const flap = Math.sin(t * (i % 2 ? 6 : 4.5) + i) * 0.45;
      wings[0].rotation.x = flap;
      wings[1].rotation.x = -flap;
    });
  }
  for (const [i, colour] of [[0, '#C8321F'], [1, '#E3B23C']] as const) {
    const g = new THREE.Group();
    scene.add(g);
    const shape = new THREE.Shape();
    shape.moveTo(-1.1, -0.45);
    shape.quadraticCurveTo(0.7, -0.5, 1.2, 0);
    shape.quadraticCurveTo(0.7, 0.5, -1.1, 0.45);
    shape.lineTo(-1.1, -0.45);
    const shell = new THREE.Mesh(bin.keep(new THREE.ExtrudeGeometry(shape, { depth: 0.35, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, bevelSegments: 2 }).rotateX(-Math.PI / 2)), p.white);
    shell.position.y = 0.04;
    g.add(shell);
    s.post(g, 0.03, 0.035, 2.6, p.white, [0.2, 1.65, 0], 8);
    const tri = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(-1.4, 0), new THREE.Vector2(0, 2.3)]);
    const sail = new THREE.Mesh(bin.keep(new THREE.ShapeGeometry(tri)), bin.keep(new THREE.MeshStandardMaterial({ color: colour, roughness: 0.85, side: THREE.DoubleSide })));
    sail.position.set(0.18, 0.55, 0);
    sail.rotation.y = 0.35;
    g.add(sail);
    ticks.push((t) => {
      const a = t * 0.02 + i * Math.PI;
      g.position.set(40 + Math.cos(a) * 9, Math.sin(t * 1.3 + i) * 0.04, 12 + Math.sin(a) * 7);
      g.rotation.y = -a - Math.PI / 2;
      g.rotation.x = 0.06;
    });
  }
}

/** The harbour office, whose roof carries the harbourmaster's terrace. */
export const OFFICE: Vec = [-23.6, QUAYSIDE, 7.6];
export const OFFICE_ROOF = QUAYSIDE + 2.51;

function harbour(y: Yard, scene: THREE.Scene, ticks: ((t: number, dt: number) => void)[]): THREE.MeshStandardMaterial {
  const { s, p, bin, glows } = y;
  const mat = (color: string, rough = 0.85) => bin.keep(new THREE.MeshStandardMaterial({ color, roughness: rough }));
  const stone = mat('#BDB5A2', 0.95);
  const window_ = bin.keep(new THREE.MeshStandardMaterial({ color: '#34495C', roughness: 0.3, emissive: '#FFC56B', emissiveIntensity: 0 }));
  glows.windows.push(window_);

  /* The harbour wall: dressed stone with a coping, bollards and lamps along it */
  const len = WALL_Z[1] - WALL_Z[0];
  s.box(scene, [1.0, 3.2, len], stone, [WALL_X - 0.2, QUAYSIDE - 1.6, (WALL_Z[0] + WALL_Z[1]) / 2], 0.05);
  s.box(scene, [1.2, 0.16, len + 0.2], mat('#D8D1C0'), [WALL_X - 0.15, QUAYSIDE + 0.06, (WALL_Z[0] + WALL_Z[1]) / 2], 0.04);
  for (let z = WALL_Z[0] + 1.5; z < WALL_Z[1]; z += 3.5) {
    s.post(scene, 0.13, 0.16, 0.36, p.iron, [WALL_X - 0.05, QUAYSIDE + 0.32, z], 14);
    s.post(scene, 0.19, 0.19, 0.06, p.iron, [WALL_X - 0.05, QUAYSIDE + 0.52, z], 14);
  }
  for (const z of [-6, 1, 11.5]) lantern(y, scene, [WALL_X - 0.6, QUAYSIDE, z]);

  /* Houses along the quayside, and the harbour office by the boardwalk */
  const walls = ['#F7F5EF', '#F1E2BC', '#D7E5EE', '#E9D3C4', '#DCE3D1', '#F7F5EF'].map((c) => mat(c, 0.9));
  const roofs = ['#1B4F72', '#A0503E', '#5B6670', '#8A633A', '#A0503E', '#1B4F72'].map((c) => mat(c, 0.75));
  const row: [number, number, number][] = [[-8, 3.0, 2.6], [-4.6, 3.6, 3.3], [-1.0, 3.0, 2.4], [2.6, 3.4, 3.0], [12.2, 3.2, 2.7], [15.5, 2.8, 2.4]];
  row.forEach(([z, w, h], i) => house(y, scene, [-24.2 + (i % 2) * 0.4, QUAYSIDE, z], w, 3.2, h, walls[i], roofs[i], window_));
  const office = new THREE.Group();
  office.position.set(...OFFICE);
  scene.add(office);
  s.box(office, [3.4, 2.3, 4.6], p.white, [0, 1.15, 0], 0.05);
  s.box(office, [3.9, 0.22, 5.1], p.navy, [0, 2.4, 0], 0.04);
  s.box(office, [0.06, 1.2, 0.8], p.navy, [1.72, 0.6, 1.3], 0.02);
  for (const z of [-1.4, -0.3]) s.sign(office, 0.7, 0.7, window_, [1.73, 1.3, z]).rotation.y = Math.PI / 2;
  lettering(y, office, 'Harbour office', [1.74, 2.0, 0], 3.6, '#1B4F72', false).rotation.y = Math.PI / 2;

  /* The boardwalk from the harbour wall out to the quay */
  const QY = 0.9;
  const x0 = WALL_X - 0.2;
  const x1 = -5.7;
  s.box(scene, [x1 - x0, 0.22, 1.8], p.teak, [(x0 + x1) / 2, QY - 0.11, 7.25], 0.03);
  for (let x = x0 + 1; x < x1; x += 2.2) for (const z of [6.4, 8.1]) s.post(scene, 0.12, 0.14, 2.2, p.darkTeak, [x, QY - 1.1, z], 10);
  for (const z of [6.35, 8.15]) {
    for (let x = x0 + 1; x < x1; x += 2.2) s.post(scene, 0.04, 0.04, 0.6, p.darkTeak, [x, QY + 0.3, z], 8);
    s.bar(scene, [x0 + 1, QY + 0.58, z], [x1, QY + 0.58, z], 0.028, p.rope);
  }

  /* The lighthouse on the point, with the keeper's cottage */
  const [LX, LZ] = LIGHTHOUSE;
  const base = groundAt(LX, LZ);
  const white = mat('#F7F5EF', 0.7);
  const navy = mat('#1B4F72', 0.7);
  s.post(scene, 1.25, 1.35, 0.5, stone, [LX, base + 0.25, LZ], 28);
  for (let i = 0; i < 6; i++) s.post(scene, 1.0 - (i + 1) * 0.07, 1.0 - i * 0.07, 1.25, i % 2 ? navy : white, [LX, base + 0.5 + 0.625 + i * 1.25, LZ], 28);
  const top = base + 0.5 + 7.5;
  s.post(scene, 0.86, 0.86, 0.12, p.iron, [LX, top + 0.06, LZ], 28);
  s.hoop(scene, 0.8, 0.025, p.iron, [LX, top + 0.5, LZ]).rotation.x = Math.PI / 2;
  const lamp = bin.keep(new THREE.MeshStandardMaterial({ color: '#FFE2A8', roughness: 0.3, emissive: '#FFC56B', emissiveIntensity: 0.4 }));
  glows.glass.push(lamp);
  s.post(scene, 0.45, 0.45, 0.9, lamp, [LX, top + 0.57, LZ], 20);
  s.post(scene, 0, 0.62, 0.62, mat('#A0503E', 0.6), [LX, top + 1.33, LZ], 20);
  s.ball(scene, 0.08, p.brass, [LX, top + 1.68, LZ]);
  const beamGeo = bin.keep(new THREE.ConeGeometry(2.2, 30, 24, 1, true).translate(0, -15, 0).rotateZ(Math.PI / 2));
  const beamMat = bin.keep(new THREE.MeshBasicMaterial({ color: '#FFE7B0', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.userData.flat = true;
  const pivot = new THREE.Group();
  pivot.position.set(LX, top + 0.57, LZ);
  pivot.add(beam);
  scene.add(pivot);
  glows.beams.push(beam);
  ticks.push((t) => void (pivot.rotation.y = t * 0.45));
  house(y, scene, [LX - 3.1, groundAt(LX - 3.1, LZ + 1), LZ + 1], 2.6, 2.4, 1.9, white, mat('#A0503E', 0.75), window_);

  /* Rocks round the point */
  const rock = mat('#8F948F', 0.95);
  (rock as THREE.MeshStandardMaterial).flatShading = true;
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2;
    const r = 6.6 + hash(i, 3) * 1.6;
    const x = LX + Math.cos(a) * r;
    const z = LZ + Math.sin(a) * r * 0.9;
    if (z < LZ - 2) continue;
    const m = new THREE.Mesh(bin.keep(new THREE.DodecahedronGeometry(0.35 + hash(i, 9) * 0.6, 0)), rock);
    m.position.set(x, WATER - 0.1 + hash(i, 5) * 0.2, z);
    m.rotation.set(hash(i, 1) * 3, hash(i, 2) * 3, 0);
    scene.add(m);
  }
  return lamp;
}

/** Channel buoys, red to port and green to starboard of the way in, riding the swell. */
function buoys(y: Yard, scene: THREE.Scene, ticks: ((t: number, dt: number) => void)[]): void {
  const { s, p, bin } = y;
  const red = bin.keep(new THREE.MeshStandardMaterial({ color: '#C8321F', roughness: 0.5 }));
  const green = bin.keep(new THREE.MeshStandardMaterial({ color: '#2F8F6A', roughness: 0.5 }));
  ([[14.5, 15.5, true], [23.5, 12.5, false], [-12.5, 15, true], [29, 5.5, false]] as const).forEach(([x, z, isRed], k) => {
    const g = new THREE.Group();
    g.position.set(x, WATER, z);
    scene.add(g);
    const c = isRed ? red : green;
    s.post(g, 0.34, 0.46, 0.55, c, [0, 0.18, 0], 18);
    s.post(g, 0.07, 0.16, 0.9, c, [0, 0.85, 0], 12);
    s.ball(g, 0.11, p.glow, [0, 1.36, 0]);
    ticks.push((t) => {
      g.position.y = WATER + Math.sin(t * 1.3 + k * 1.7) * 0.06;
      g.rotation.z = Math.sin(t * 1.05 + k) * 0.09;
      g.rotation.x = Math.sin(t * 0.8 + k * 2) * 0.06;
    });
  });
}

export interface Coast {
  ticks: ((t: number, dt: number) => void)[];
  /** The lighthouse shows the Mac helper: its usual warm light, amber when out of date, red when not reachable. */
  setHelper(state: 'ok' | 'old' | 'down'): void;
}

export function buildCoast(y: Yard, scene: THREE.Scene): Coast {
  const ticks: ((t: number, dt: number) => void)[] = [];
  terrain(y, scene);
  woods(y, scene);
  const lamp = harbour(y, scene, ticks);
  quayside(y, scene, ticks);
  rowingBoat(y, scene, ticks);
  life(y, scene, ticks);
  buoys(y, scene, ticks);
  const LAMP = { ok: ['#FFE2A8', '#FFC56B'], old: ['#FFC870', '#FF9A2A'], down: ['#FF8A7A', '#FF3A2A'] } as const;
  return {
    ticks,
    setHelper(state) {
      lamp.color.set(LAMP[state][0]);
      lamp.emissive.set(LAMP[state][1]);
    },
  };
}
