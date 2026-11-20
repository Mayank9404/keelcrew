/**
 * The crew as wooden-toy sailors. What a sailor wears says who it is (the Mate's coat and cap, the engineers' striped
 * jerseys, the lookouts' oilskins, the rounds' boiler suits); its neckerchief colour, its pose and what it holds say how
 * it is doing. Each mood is a pose in a table; a change of mood eases from the old pose to the new one, and a little
 * movement of its own (typing, waving, nodding) plays on top unless the viewer asked for reduced motion.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { Mood, StationId } from '../lib/office';
import { scarves, type Bin, type Paints } from './parts';
import { stripes } from './paint';

type Outfit = 'stripe' | 'coat' | 'oilskin' | 'sweater' | 'boiler';
type Hat = 'beanie' | 'captain' | 'souwester' | 'cap';

const BY_AGENT: Record<string, [Outfit, Hat]> = {
  lead: ['coat', 'captain'],
  engineer: ['stripe', 'beanie'],
  contractor: ['stripe', 'cap'],
  reviewer: ['oilskin', 'souwester'],
  qa: ['oilskin', 'souwester'],
  scout: ['sweater', 'cap'],
};
const BY_STATION: Partial<Record<StationId, Outfit>> = { rounds: 'boiler', tug: 'boiler', chart: 'sweater', yacht: 'sweater', skiff: 'stripe', lifeboat: 'oilskin', launch: 'coat', lookout: 'oilskin', bridge: 'sweater' };

/** The outfit and hat for an agent: a few by name, the rest by the station they belong to, the hat varied by name. */
export function lookFor(agent: string, home: StationId): [Outfit, Hat] {
  if (BY_AGENT[agent]) return BY_AGENT[agent];
  const outfit = BY_STATION[home] ?? 'stripe';
  const hash = [...agent].reduce((a, c) => a + c.charCodeAt(0), 0);
  return [outfit, outfit === 'oilskin' ? 'souwester' : hash % 2 ? 'cap' : 'beanie'];
}

/** Joint angles, in radians, and the hip height. */
interface Pose {
  armLx: number;
  armLz: number;
  armRx: number;
  armRz: number;
  headX: number;
  headZ: number;
  lean: number;
  hip: number;
  legs: number;
}
type MoodPose = Omit<Pose, 'hip' | 'legs'>;
const POSES: Record<Mood, MoodPose> = {
  working: { armLx: -1.25, armLz: 0, armRx: -1.25, armRz: 0, headX: 0.16, headZ: 0, lean: 0.08 },
  thinking: { armLx: -0.5, armLz: -0.5, armRx: -2.25, armRz: -0.35, headX: -0.12, headZ: 0.16, lean: 0 },
  waiting: { armLx: -0.2, armLz: 0, armRx: 0, armRz: 2.55, headX: -0.1, headZ: 0, lean: 0 },
  stuck: { armLx: -0.35, armLz: 0, armRx: -0.35, armRz: 0, headX: 0.36, headZ: 0, lean: 0.2 },
  done: { armLx: -1.3, armLz: 0, armRx: -0.12, armRz: 0, headX: -0.06, headZ: 0, lean: 0 },
  idle: { armLx: -0.6, armLz: 0, armRx: -0.6, armRz: 0, headX: 0.32, headZ: 0, lean: 0 },
};
const KEYS = Object.keys({ ...POSES.idle, hip: 0, legs: 0 }) as (keyof Pose)[];
const STAND = 0.42;
const EASE_S = 0.6;

/** The parts every sailor of one mount shares: made once, freed with the mount. */
export function sailorParts(bin: Bin, p: Paints) {
  const g = <T extends THREE.BufferGeometry>(x: T) => bin.keep(x);
  const jersey = bin.keep(new THREE.MeshStandardMaterial({ color: '#FFFFFF', map: stripes(bin), roughness: 0.75 }));
  const flagCloth = bin.keep(new THREE.MeshStandardMaterial({ color: '#B4237F', emissive: '#B4237F', emissiveIntensity: 0.25, side: THREE.DoubleSide, roughness: 0.8 }));
  const pennant = new THREE.Shape();
  pennant.moveTo(0, 0);
  pennant.lineTo(0.46, -0.14);
  pennant.lineTo(0, -0.28);
  return {
    p,
    scarf: scarves(bin),
    cloth: { stripe: jersey, coat: p.navy, oilskin: p.yellow, sweater: p.cream, boiler: p.grey } satisfies Record<Outfit, THREE.Material>,
    flagCloth,
    torso: g(new THREE.CapsuleGeometry(0.2, 0.17, 6, 14)),
    arm: g(new THREE.CapsuleGeometry(0.062, 0.2, 6, 12)),
    leg: g(new THREE.CapsuleGeometry(0.085, 0.2, 6, 12)),
    boot: g(new RoundedBoxGeometry(0.15, 0.1, 0.24, 3, 0.045)),
    head: g(new THREE.SphereGeometry(0.225, 22, 16)),
    hand: g(new THREE.SphereGeometry(0.066, 12, 10)),
    dot: g(new THREE.SphereGeometry(0.027, 10, 8)),
    nose: g(new THREE.SphereGeometry(0.03, 10, 8)),
    button: g(new THREE.SphereGeometry(0.022, 8, 6)),
    knot: g(new THREE.TorusGeometry(0.135, 0.04, 10, 28).rotateX(Math.PI / 2)),
    tie: g(new THREE.ConeGeometry(0.06, 0.13, 4).rotateX(Math.PI)),
    dome: g(new THREE.SphereGeometry(0.235, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2)),
    rim: g(new THREE.TorusGeometry(0.225, 0.042, 8, 28).rotateX(Math.PI / 2)),
    capBand: g(new THREE.CylinderGeometry(0.19, 0.2, 0.06, 20)),
    capTop: g(new THREE.CylinderGeometry(0.27, 0.2, 0.09, 20)),
    visor: g(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 20, 1, false, -1.1, 2.2)),
    brim: g(new THREE.CylinderGeometry(0.24, 0.36, 0.05, 20)),
    dixie: g(new THREE.CylinderGeometry(0.18, 0.2, 0.11, 20)),
    dixieRoll: g(new THREE.TorusGeometry(0.2, 0.035, 8, 24).rotateX(Math.PI / 2)),
    badge: g(new RoundedBoxGeometry(0.16, 0.12, 0.03, 2, 0.01)),
    staff: g(new THREE.CylinderGeometry(0.014, 0.014, 0.7, 8)),
    flag: g(new THREE.ShapeGeometry(pennant)),
    mug: g(new THREE.CylinderGeometry(0.05, 0.045, 0.1, 14)),
    handle: g(new THREE.TorusGeometry(0.035, 0.012, 6, 14)),
  };
}
export type SailorParts = ReturnType<typeof sailorParts>;

const mesh = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
};
const mix = (a: number, b: number, k: number) => a + (b - a) * k;

/** One sailor on the ship. Facing +z before it is turned. */
export class SailorFigure {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private head = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private legs: THREE.Group[] = [];
  private scarf: THREE.Mesh[] = [];
  private flag = new THREE.Group();
  private pennant: THREE.Mesh;
  private mug = new THREE.Group();
  private from: Pose;
  private to: Pose;
  private since = -EASE_S;
  private clock = 0;
  private seed: number;
  mood: Mood;

  constructor(private parts: SailorParts, id: string, agent: string, home: StationId, mood: Mood) {
    const { p } = parts;
    const [outfit, hat] = lookFor(agent, home);
    const cloth = parts.cloth[outfit];
    this.seed = [...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 17;
    this.mood = mood;
    this.root.add(this.body);
    this.root.userData.sailorId = id;
    for (const side of [-1, 1]) {
      const hipJoint = new THREE.Group();
      hipJoint.position.x = side * 0.105;
      this.body.add(hipJoint);
      mesh(hipJoint, parts.leg, outfit === 'oilskin' || outfit === 'boiler' ? cloth : p.navy, 0, -0.19);
      mesh(hipJoint, parts.boot, p.black, 0, -0.37, 0.035);
      this.legs.push(hipJoint);
    }
    mesh(this.body, parts.torso, cloth, 0, 0.24).scale.set(1.06, 1, 0.9);
    if (outfit === 'coat') for (const y of [0.33, 0.22, 0.11]) for (const side of [-1, 1]) mesh(this.body, parts.button, p.brass, side * 0.06, y, 0.178);
    if (outfit === 'boiler') mesh(this.body, parts.badge, p.navy, 0, 0.26, 0.175);
    this.scarf.push(mesh(this.body, parts.knot, parts.scarf[mood], 0, 0.47), mesh(this.body, parts.tie, parts.scarf[mood], 0, 0.4, 0.17));
    this.head.position.y = 0.7;
    this.body.add(this.head);
    mesh(this.head, parts.head, p.wood);
    for (const side of [-1, 1]) mesh(this.head, parts.dot, p.black, side * 0.08, 0.015, 0.205);
    mesh(this.head, parts.nose, p.wood, 0, -0.035, 0.225);
    this.wearHat(hat);
    for (const [arm, side] of [[this.armL, -1], [this.armR, 1]] as const) {
      arm.position.set(side * 0.245, 0.4, 0);
      this.body.add(arm);
      mesh(arm, parts.arm, cloth, 0, -0.15);
      mesh(arm, parts.hand, p.wood, 0, -0.33);
    }
    // A hand flag for whoever waits for you: the staff runs on past the raised hand, the pennant flies from its top.
    mesh(this.flag, parts.staff, p.darkTeak, 0, -0.3);
    const fly = new THREE.Group();
    fly.position.y = -0.64;
    fly.rotation.z = -2.55;
    this.pennant = mesh(fly, parts.flag, parts.flagCloth);
    this.flag.add(fly);
    this.flag.position.y = -0.3;
    this.armR.add(this.flag);
    // A mug of tea for whoever has just finished.
    mesh(this.mug, parts.mug, p.white);
    mesh(this.mug, parts.handle, p.white, 0.055);
    this.mug.position.set(0, -0.36, 0.06);
    this.mug.rotation.x = 1.1;
    this.armL.add(this.mug);
    this.to = this.from = { ...POSES[mood], hip: STAND, legs: 0 };
    this.showHeld();
  }

  private wearHat(hat: Hat): void {
    const { p } = this.parts;
    const h = this.head;
    const parts = this.parts;
    if (hat === 'beanie') {
      mesh(h, parts.dome, p.navy, 0, 0.05);
      mesh(h, parts.rim, p.navy, 0, 0.06);
    } else if (hat === 'captain') {
      mesh(h, parts.capBand, p.navy, 0, 0.15);
      mesh(h, parts.capTop, p.white, 0, 0.22);
      mesh(h, parts.visor, p.black, 0, 0.125, 0.09).rotation.x = 0.18;
      mesh(h, parts.button, p.brass, 0, 0.165, 0.195).scale.setScalar(1.4);
    } else if (hat === 'souwester') {
      mesh(h, parts.dome, p.yellow, 0, 0.04);
      mesh(h, parts.brim, p.yellow, 0, 0.05, -0.03).rotation.x = -0.22;
    } else {
      mesh(h, parts.dixie, p.white, 0, 0.19);
      mesh(h, parts.dixieRoll, p.white, 0, 0.14);
    }
  }

  private showHeld(): void {
    this.flag.visible = this.mood === 'waiting';
    this.mug.visible = this.mood === 'done';
  }

  /** The pose this sailor is in right now, part way through any change. */
  private current(): Pose {
    const k = Math.min(1, (this.clock - this.since) / EASE_S);
    const e = k * k * (3 - 2 * k);
    const out = { ...this.to };
    for (const key of KEYS) out[key] = mix(this.from[key], this.to[key], e);
    return out;
  }

  private aim(next: Pose): void {
    this.from = this.current();
    this.to = next;
    this.since = this.clock;
  }

  setMood(mood: Mood): void {
    if (mood === this.mood) return;
    this.mood = mood;
    for (const m of this.scarf) m.material = this.parts.scarf[mood];
    this.showHeld();
    this.aim({ ...this.to, ...POSES[mood] });
  }

  /** Stand, or sit on something `seat` high. */
  setSeat(seat: number): void {
    const hip = seat ? seat + 0.11 : STAND;
    if (hip !== this.to.hip) this.aim({ ...this.to, hip, legs: seat ? -1.35 : 0 });
  }

  /** Jump straight to the target pose, for a sailor just placed. */
  settle(): void {
    this.since = this.clock - EASE_S;
  }

  /** Pose the sailor for time `t` (seconds). `motion` is 0 under reduced motion: poses, but no idle movement. */
  tick(t: number, motion: number): void {
    this.clock = t;
    const q = this.current();
    const s = this.seed;
    let bob = 0.008;
    if (motion) {
      if (this.mood === 'working') {
        q.armLx += Math.sin(t * 13 + s) * 0.12;
        q.armRx += Math.sin(t * 13 + s + 1.9) * 0.12;
      } else if (this.mood === 'thinking') q.headZ += Math.sin(t * 0.9 + s) * 0.05;
      else if (this.mood === 'waiting') {
        q.armRz += Math.sin(t * 6 + s) * 0.3;
        bob = 0.05;
      } else if (this.mood === 'idle') q.headX += Math.sin(t * 1.1 + s) * 0.07;
      this.pennant.parent!.rotation.y = this.mood === 'waiting' ? Math.sin(t * 5 + s) * 0.5 : 0;
    }
    this.armL.rotation.set(q.armLx, 0, q.armLz);
    this.armR.rotation.set(q.armRx, 0, q.armRz);
    this.head.rotation.set(q.headX, 0, q.headZ);
    this.body.rotation.x = q.lean;
    this.body.position.y = q.hip + Math.abs(Math.sin(t * (this.mood === 'waiting' ? 3 : 2) + s)) * bob * motion;
    for (const leg of this.legs) leg.rotation.x = q.legs;
  }
}
