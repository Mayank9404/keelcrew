/**
 * The harbour water: a smooth surface that reflects the sky, with two layers of ripples drifting across it, a slow
 * breathing swell, and just enough clarity that the sand of the shallows shows through near the shore. Its colour is
 * set by the theme. Under reduced motion it lies still.
 */
import * as THREE from 'three';

/** The calm water line, on the hulls' buff boot stripe; the swell lifts it at most SWELL. */
export const WATER = 0.1;
export const SWELL = 0.04;
/** Wide enough that the fog has hidden the edge before the camera can see it. */
const SIZE = 420;

/** A tileable ripple normal map, painted from a handful of crossing waves with whole-number frequencies. */
function rippleNormals(n: number): THREE.DataTexture {
  const waves = [
    [3, 1, 0.0, 1.0],
    [-2, 5, 1.3, 0.8],
    [5, -3, 2.1, 0.55],
    [1, 8, 0.6, 0.42],
    [-7, 4, 4.0, 0.33],
    [9, 7, 2.7, 0.24],
    [-12, -5, 5.1, 0.18],
    [14, -9, 0.9, 0.13],
    [-4, 15, 3.3, 0.1],
  ];
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let dx = 0;
      let dy = 0;
      for (const [a, b, ph, amp] of waves) {
        const c = Math.cos(2 * Math.PI * ((a * x) / n + (b * y) / n) + ph) * amp;
        dx += c * a;
        dy += c * b;
      }
      const k = 0.07;
      const v = new THREE.Vector3(-dx * k, -dy * k, 1).normalize();
      const i = (y * n + x) * 4;
      data[i] = (v.x * 0.5 + 0.5) * 255;
      data[i + 1] = (v.y * 0.5 + 0.5) * 255;
      data[i + 2] = (v.z * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, n, n);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

export class Sea {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2);
  private near: THREE.DataTexture;
  private far: THREE.Texture;
  private mat: THREE.MeshPhysicalMaterial;

  constructor() {
    this.near = rippleNormals(256);
    this.near.repeat.set(SIZE / 11, SIZE / 11);
    this.far = this.near.clone();
    this.far.repeat.set(SIZE / 37, SIZE / 37);
    this.far.rotation = 0.7;
    this.mat = new THREE.MeshPhysicalMaterial({
      color: '#3E8DB5',
      roughness: 0.16,
      metalness: 0,
      normalMap: this.near,
      normalScale: new THREE.Vector2(0.2, 0.2),
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      clearcoatNormalMap: this.far,
      clearcoatNormalScale: new THREE.Vector2(0.3, 0.3),
      transparent: true,
      opacity: 0.84,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.position.y = WATER;
    this.mesh.receiveShadow = true;
    this.mesh.userData.sea = true;
  }

  setColor(color: string): void {
    this.mat.color.set(color);
  }

  /** Ripples drift two ways and the water breathes a little. */
  swell(t: number): void {
    this.near.offset.set(t * 0.011, t * 0.006);
    this.far.offset.set(-t * 0.004, t * 0.009);
    this.mesh.position.y = WATER + Math.sin(t * 0.55) * SWELL * 0.5;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.near.dispose();
    this.far.dispose();
  }
}
