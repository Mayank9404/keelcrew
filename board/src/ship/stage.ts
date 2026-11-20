/**
 * The stage the harbour stands on: renderer, camera and controls, the sea, the sky light for Day, Dusk and Night, and
 * the frame loop. With motion on, the loop runs at up to 30 frames a second while the ship is on screen in a visible tab
 * (the sea, smoke, radar and crew always move); under reduced motion it draws only when something changed. Themes change
 * the light and the water, not the paint: the sun drops and warms at Dusk, the moon comes up at Night, and lanterns,
 * portholes, screens and house windows take over. A soft sky, rendered once per theme into an environment map, lights
 * everything from all round and shows in the water.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Theme } from '../lib/theme';
import type { Glows } from './fittings';
import { Sea } from './sea';

interface Light {
  /** The environment sky: overhead, at the horizon, below. */
  zenith: string;
  horizon: string;
  under: string;
  env: number;
  windows: number;
  beam: number;
  sky: string;
  ground: string;
  hemi: number;
  sunColor: string;
  sun: number;
  pools: number;
  lamp: number;
  screen: number;
  lampLight: number;
  water: string;
}
const LIGHT: Record<Theme, Light> = {
  day: { zenith: '#6FA8D6', horizon: '#E8F2F8', under: '#9DB7A0', env: 0.9, windows: 0, beam: 0, sky: '#FFFFFF', ground: '#C4D8E4', hemi: 0.9, sunColor: '#FFF1DC', sun: 2.7, pools: 0, lamp: 0.35, screen: 0.45, lampLight: 0, water: '#3C8DB8' },
  dusk: { zenith: '#3E557A', horizon: '#F2A774', under: '#2C3A44', env: 0.65, windows: 1.0, beam: 0.1, sky: '#B7C9E0', ground: '#2A3F51', hemi: 0.5, sunColor: '#FFB27E', sun: 1.35, pools: 0.45, lamp: 1.5, screen: 0.95, lampLight: 1.6, water: '#2C4C68' },
  night: { zenith: '#0B1830', horizon: '#33507A', under: '#0A1218', env: 0.45, windows: 1.4, beam: 0.18, sky: '#6F8FB8', ground: '#0A1622', hemi: 0.3, sunColor: '#A9C6FF', sun: 0.55, pools: 0.75, lamp: 2.4, screen: 1.15, lampLight: 2.6, water: '#0F2A42' },
};

const CAMERA = { from: [-13, 33, 41] as const, look: [-0.8, 0.5, -0.5] as const, near: 9, far: 92 };
const SPAN = 38;
const FRAME_MS = 1000 / 30;

export interface StageHooks {
  /** Called every frame the loop runs, with seconds since start and since the last frame. */
  frame(t: number, dt: number): void;
  /** Called after each draw, to place the HTML tags over the scene. */
  drawn(): void;
}

export class Stage {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(28, 16 / 9, 0.1, 300);
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  private hemi = new THREE.HemisphereLight('#FFFFFF', '#C4D8E4', 1.5);
  private sun = new THREE.DirectionalLight('#FFFFFF', 2.5);
  private sea = new Sea();
  private raf = 0;
  private last = 0;
  private t0 = performance.now();
  private dirty = true;
  private gone = false;
  private seen = true;
  private stops: (() => void)[] = [];
  private pmrem: THREE.PMREMGenerator;
  private skies = new Map<Theme, THREE.WebGLRenderTarget>();

  constructor(
    private host: HTMLElement,
    readonly canvas: HTMLCanvasElement,
    private glows: Glows,
    readonly motion: boolean,
    private hooks: StageHooks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.background = new THREE.Color();
    this.camera.position.set(...CAMERA.from);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(...CAMERA.look);
    Object.assign(this.controls, { enablePan: false, enableDamping: motion, minDistance: CAMERA.near, maxDistance: CAMERA.far, minPolarAngle: 0.35, maxPolarAngle: 1.32 });
    this.controls.update();
    const [lx, , lz] = CAMERA.look;
    this.sun.position.set(lx - SPAN * 0.55, SPAN * 1.25, lz + SPAN * 0.8);
    this.sun.target.position.set(...CAMERA.look);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(3072, 3072);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 3;
    Object.assign(this.sun.shadow.camera, { left: -SPAN, right: SPAN, top: SPAN, bottom: -SPAN, near: 0.5, far: SPAN * 4 });
    // Clear over the whole harbour at the widest zoom; thick before the sea's edge (210 out) comes into view.
    this.scene.fog = new THREE.Fog('#D3E6F1', 95, 190);
    this.scene.add(this.hemi, this.sun, this.sun.target, this.sea.mesh);

    const redraw = () => this.invalidate();
    this.controls.addEventListener('change', redraw);
    this.stops.push(() => this.controls.removeEventListener('change', redraw));
    const resize = new ResizeObserver(() => this.resize());
    resize.observe(host);
    this.stops.push(() => resize.disconnect());
    const onScreen = new IntersectionObserver(([e]) => {
      this.seen = e.isIntersecting;
      this.invalidate();
    });
    onScreen.observe(host);
    this.stops.push(() => onScreen.disconnect());
    const onVisible = () => this.invalidate();
    document.addEventListener('visibilitychange', onVisible);
    this.stops.push(() => document.removeEventListener('visibilitychange', onVisible));
  }

  /** Shadows on for everything solid; flat lettering, light pools and smoke neither cast nor catch them. */
  castShadows(): void {
    this.scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || o.userData.sea) return;
      const flat = Boolean(o.userData.flat);
      o.castShadow = !flat && !(o.material as THREE.Material).transparent;
      o.receiveShadow = !flat;
    });
  }

  setTheme(theme: Theme): void {
    const l = LIGHT[theme];
    const bg = getComputedStyle(this.host).getPropertyValue('--bg').trim();
    (this.scene.background as THREE.Color).set(bg || '#D3E6F1');
    (this.scene.fog as THREE.Fog).color.set(bg || '#D3E6F1');
    this.sea.setColor(l.water);
    this.hemi.color.set(l.sky);
    this.hemi.groundColor.set(l.ground);
    this.hemi.intensity = l.hemi;
    this.sun.color.set(l.sunColor);
    this.sun.intensity = l.sun;
    for (const m of this.glows.pools) m.opacity = l.pools;
    for (const m of this.glows.screens) m.emissiveIntensity = l.screen;
    for (const light of this.glows.lamps) light.intensity = l.lampLight;
    for (const m of this.glows.glass) m.emissiveIntensity = l.lamp;
    for (const m of this.glows.windows) m.emissiveIntensity = l.windows;
    for (const m of this.glows.beams) {
      (m.material as THREE.MeshBasicMaterial).opacity = l.beam;
      m.visible = l.beam > 0;
    }
    this.scene.environment = this.sky(theme, l);
    this.scene.environmentIntensity = l.env;
    this.invalidate();
  }

  /** The theme's sky as an environment map: a soft gradient dome with a glow where the sun is, made once per theme. */
  private sky(theme: Theme, l: Light): THREE.Texture {
    const have = this.skies.get(theme);
    if (have) return have.texture;
    const dome = new THREE.Scene();
    const geo = new THREE.SphereGeometry(50, 48, 24);
    const colors: number[] = [];
    const top = new THREE.Color(l.zenith);
    const mid = new THREE.Color(l.horizon);
    const low = new THREE.Color(l.under);
    const c = new THREE.Color();
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const k = pos.getY(i) / 50;
      if (k >= 0) c.copy(mid).lerp(top, Math.pow(k, 0.6));
      else c.copy(mid).lerp(low, Math.min(1, -k * 3));
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const domeMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
    dome.add(new THREE.Mesh(geo, domeMat));
    const glowGeo = new THREE.SphereGeometry(4, 16, 8);
    const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(l.sunColor).multiplyScalar(3) });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.position.copy(this.sun.position).sub(this.sun.target.position).normalize().multiplyScalar(44);
    dome.add(glow);
    const target = this.pmrem.fromScene(dome, 0.02);
    geo.dispose();
    domeMat.dispose();
    glowGeo.dispose();
    glowMat.dispose();
    this.skies.set(theme, target);
    return target.texture;
  }

  private resize(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  /** Ask for a draw; starts the loop if it is not running. */
  invalidate(): void {
    this.dirty = true;
    if (!this.raf && !this.gone) this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number): void => {
    this.raf = 0;
    if (this.gone || document.hidden || !this.seen) return;
    const live = this.motion;
    if (live && now - this.last < FRAME_MS && !this.dirty) {
      this.raf = requestAnimationFrame(this.tick);
      return;
    }
    const dt = Math.min(0.1, (now - (this.last || now)) / 1000);
    this.last = now;
    const t = (now - this.t0) / 1000;
    if (live) this.sea.swell(t);
    this.hooks.frame(t, dt);
    const damping = this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.hooks.drawn();
    this.dirty = false;
    // controls.update() may already have asked for the next frame through its change event: never start a second loop.
    if ((live || damping) && !this.raf) this.raf = requestAnimationFrame(this.tick);
  };

  /** Where a point in the scene lands on the canvas, in CSS pixels, or null when it is behind the camera. */
  project(v: THREE.Vector3): { x: number; y: number } | null {
    const q = v.clone().project(this.camera);
    if (q.z > 1) return null;
    return { x: (q.x * 0.5 + 0.5) * this.host.clientWidth, y: (-q.y * 0.5 + 0.5) * this.host.clientHeight };
  }

  start(): void {
    this.resize();
    this.invalidate();
  }

  dispose(): void {
    this.gone = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const stop of this.stops) stop();
    this.controls.dispose();
    this.sea.dispose();
    for (const t of this.skies.values()) t.dispose();
    this.pmrem.dispose();
    this.sun.shadow.map?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
