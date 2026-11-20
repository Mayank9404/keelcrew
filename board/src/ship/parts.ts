/**
 * The ship's building blocks: a bin that owns every GPU resource one mount creates (so leaving the Deck frees them
 * all), the materials, and a few shape makers. Everything is drawn in code; there are no model files.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { SCARF, type Mood } from '../lib/office';

type Owned = THREE.BufferGeometry | THREE.Material | THREE.Texture;

/** Everything one mount made, freed together on dispose. */
export class Bin {
  private items = new Set<Owned>();
  keep<T extends Owned>(x: T): T {
    this.items.add(x);
    return x;
  }
  dispose(): void {
    for (const x of this.items) x.dispose();
    this.items.clear();
  }
}

export type Vec = readonly [number, number, number];

/** Makes meshes from tuples, so a station reads as a list of parts. Every geometry it makes goes in the bin. */
export class Shapes {
  constructor(readonly bin: Bin) {}
  private put(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, at: Vec): THREE.Mesh {
    const m = new THREE.Mesh(this.bin.keep(geo), mat);
    m.position.set(at[0], at[1], at[2]);
    parent.add(m);
    return m;
  }
  /** A box with softened edges; `round` 0 gives a sharp one. */
  box(parent: THREE.Object3D, size: Vec, mat: THREE.Material, at: Vec, round = 0.03): THREE.Mesh {
    const r = Math.min(round, size[0] / 2 - 0.001, size[1] / 2 - 0.001, size[2] / 2 - 0.001);
    return this.put(parent, r > 0 ? new RoundedBoxGeometry(size[0], size[1], size[2], 3, r) : new THREE.BoxGeometry(...size), mat, at);
  }
  /** An upright cylinder or cone section: top radius, bottom radius, height. */
  post(parent: THREE.Object3D, top: number, bottom: number, height: number, mat: THREE.Material, at: Vec, sides = 20): THREE.Mesh {
    return this.put(parent, new THREE.CylinderGeometry(top, bottom, height, sides), mat, at);
  }
  ball(parent: THREE.Object3D, r: number, mat: THREE.Material, at: Vec): THREE.Mesh {
    return this.put(parent, new THREE.SphereGeometry(r, 20, 14), mat, at);
  }
  /** A torus standing in the xy plane; `arc` below 2π gives part of one. */
  hoop(parent: THREE.Object3D, r: number, tube: number, mat: THREE.Material, at: Vec, arc = Math.PI * 2): THREE.Mesh {
    return this.put(parent, new THREE.TorusGeometry(r, tube, 10, 32, arc), mat, at);
  }
  /** A thin round bar from one point to another: rails, stays, mooring lines. */
  bar(parent: THREE.Object3D, from: Vec, to: Vec, r: number, mat: THREE.Material): THREE.Mesh {
    const a = new THREE.Vector3(...from);
    const d = new THREE.Vector3(...to).sub(a);
    const m = this.put(parent, new THREE.CylinderGeometry(r, r, d.length(), 8), mat, [0, 0, 0]);
    m.position.copy(a).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    return m;
  }
  /** A flat rectangle lying on the floor, facing up. */
  floor(parent: THREE.Object3D, w: number, d: number, mat: THREE.Material, at: Vec): THREE.Mesh {
    return this.put(parent, new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), mat, at);
  }
  /** A flat rectangle standing up, facing +z. */
  sign(parent: THREE.Object3D, w: number, h: number, mat: THREE.Material, at: Vec): THREE.Mesh {
    return this.put(parent, new THREE.PlaneGeometry(w, h), mat, at);
  }
  /** A turned shape from a profile of [radius, height] pairs: barrels, bells. */
  lathe(parent: THREE.Object3D, profile: [number, number][], mat: THREE.Material, at: Vec): THREE.Mesh {
    return this.put(parent, new THREE.LatheGeometry(profile.map(([r, h]) => new THREE.Vector2(r, h)), 20), mat, at);
  }
  /** A flat shape lifted into the floor plane and given thickness: the hull, the deck, the bulwark. */
  slab(parent: THREE.Object3D, shape: THREE.Shape, depth: number, mat: THREE.Material, y: number): THREE.Mesh {
    const geo = depth > 0 ? new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 32 }) : new THREE.ShapeGeometry(shape, 32);
    return this.put(parent, geo.rotateX(-Math.PI / 2), mat, [0, y, 0]);
  }
}

const solid = (bin: Bin, color: string, rough = 0.75, more: THREE.MeshStandardMaterialParameters = {}) => bin.keep(new THREE.MeshStandardMaterial({ color, roughness: rough, ...more }));

/** The ship's paints. Lamp glass and screens glow more at Dusk and Night; the stage sets how much. */
export function paints(bin: Bin) {
  return {
    navy: solid(bin, '#1B4F72', 0.7),
    white: solid(bin, '#F7F5EF', 0.65),
    cream: solid(bin, '#EFE3C2'),
    teak: solid(bin, '#B98B55', 0.7),
    darkTeak: solid(bin, '#8A633A', 0.7),
    brass: solid(bin, '#C9A24B', 0.35, { metalness: 0.65 }),
    iron: solid(bin, '#2B333B', 0.55, { metalness: 0.3 }),
    black: solid(bin, '#17181C', 0.6),
    wood: solid(bin, '#E2C39A', 0.6),
    yellow: solid(bin, '#E3B23C', 0.45),
    grey: solid(bin, '#7E93A3'),
    rope: solid(bin, '#CDB38A', 0.95),
    paper: solid(bin, '#FBF8EE'),
    buff: solid(bin, '#F4E6BC'),
    glow: solid(bin, '#FFE2A8', 0.75, { emissive: '#FFC56B', emissiveIntensity: 0.4 }),
    smoke: solid(bin, '#FFFFFF', 1, { transparent: true, opacity: 0.7 }),
  };
}
export type Paints = ReturnType<typeof paints>;

/** The neckerchief paint for each mood; the busy ones glow a little so they read in the dark. */
export function scarves(bin: Bin): Record<Mood, THREE.MeshStandardMaterial> {
  const make = (m: Mood, glow: number) => solid(bin, SCARF[m], 0.8, { emissive: SCARF[m], emissiveIntensity: glow });
  return { waiting: make('waiting', 0.35), stuck: make('stuck', 0.35), working: make('working', 0.3), thinking: make('thinking', 0.3), done: make('done', 0.12), idle: make('idle', 0.04) };
}
