// Fair-weather cumulus: scattered clouds with flat bases around 1.8 km, built from soft
// camera-facing puffs. The field tiles the world (it wraps around the camera), so there
// are always clouds to fly toward, past and through.
//
// Shading is what makes a billboard read as a cloud: puffs on the sun side and on top
// are bright, the base and the side away from the sun are blue-grey, and distant clouds
// sink into the same haze as the ground (atmosphere.js). Inside a cloud the view goes
// white (post.js reads `inside`).

import * as THREE from 'three';
import { HAZE_GLSL, SUN } from './atmosphere.js';

/** The field repeats every TILE metres in x and z. */
const TILE = 36000;
const CLUSTERS = 64;
/** Cloud base altitude (m) and its spread. */
const BASE = 1800;
const BASE_SPREAD = 350;

function rand(min, max) {
  return min + Math.random() * (max - min);
}

/** `v` moved by whole tiles to within half a tile of `cam` (as the vertex shader does). */
function wrap(v, cam) {
  return cam + ((((v - cam + TILE / 2) % TILE) + TILE) % TILE) - TILE / 2;
}

/** Soft, lumpy puff: a few overlapping blobs, alpha only (shading is per puff). */
function puffTexture() {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const blob = (x, y, r, a) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,255,255,${a})`);
    grad.addColorStop(0.6, `rgba(255,255,255,${a * 0.5})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  };
  blob(s / 2, s / 2, s * 0.48, 0.75);
  for (let i = 0; i < 14; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * s * 0.22;
    blob(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r, s * rand(0.12, 0.26), 0.35);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

const VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 center;
  attribute vec3 offset;
  attribute float size;
  attribute float light;
  attribute float spin;
  uniform float tile;
  varying vec2 vUv;
  varying float vLight;
  varying float vFade;
  varying vec3 vOffset;
  void main() {
    // Wrap the cluster into the tile centred on the camera.
    vec3 c = center;
    c.xz = cameraPosition.xz + mod(center.xz - cameraPosition.xz + tile * 0.5, tile) - tile * 0.5;
    vec3 world = c + offset;
    vec4 mv = viewMatrix * vec4(world, 1.0);
    float cs = cos(spin), sn = sin(spin);
    vUv = mat2(cs, -sn, sn, cs) * position.xy + 0.5;
    mv.xy += position.xy * size;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
    vOffset = world - cameraPosition;
    float dist = length(vOffset);
    // A puff the camera is inside would fill the screen with one flat quad: fade it, the
    // whiteout takes over.
    vFade = smoothstep(size * 0.25, size * 0.9, dist) * (1.0 - smoothstep(tile * 0.4, tile * 0.5, length(vOffset.xz)));
    vLight = light;
  }
`;

const FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D map;
  varying vec2 vUv;
  varying float vLight;
  varying float vFade;
  varying vec3 vOffset;
  ${HAZE_GLSL}
  void main() {
    #include <logdepthbuf_fragment>
    float a = texture2D(map, vUv).a * vFade;
    if (a < 0.01) discard;
    vec3 shadow = vec3(0.40, 0.46, 0.57);
    vec3 lit = vec3(1.0, 0.98, 0.94);
    vec3 col = mix(shadow, lit, vLight);
    col = mix(col, hazeTint(normalize(vOffset)), hazeFactor(vOffset));
    gl_FragColor = vec4(col, a);
  }
`;

export class Clouds {
  constructor(scene) {
    const centers = [];
    const offsets = [];
    const sizes = [];
    const lights = [];
    const spins = [];
    // Puff count at the end of each cluster, so whole clusters can be left out.
    const ends = [];
    const n = new THREE.Vector3();
    for (let i = 0; i < CLUSTERS; i++) {
      const cx = rand(-TILE / 2, TILE / 2);
      const cz = rand(-TILE / 2, TILE / 2);
      const base = BASE + rand(-BASE_SPREAD, BASE_SPREAD);
      const width = rand(600, 1800);
      const height = width * rand(0.35, 0.6);
      const puffs = Math.round(10 + width / 70);
      for (let j = 0; j < puffs; j++) {
        // Dome: wide at the bottom, narrowing upward; the base stays flat.
        const up = Math.random() ** 0.8;
        const spread = width * 0.5 * (1 - up * 0.55);
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * spread;
        const size = width * rand(0.22, 0.38) * (1 - up * 0.3);
        const ox = Math.cos(a) * r;
        const oz = Math.sin(a) * r * rand(0.6, 1);
        const oy = size * 0.35 + up * height;
        centers.push(cx, base, cz);
        offsets.push(ox, oy, oz);
        sizes.push(size);
        // Lit from the top and the sun side, dark underneath.
        n.set(ox, oy - height * 0.35, oz).normalize();
        const sunSide = n.dot(SUN) * 0.5 + 0.5;
        lights.push(THREE.MathUtils.clamp(0.2 + up * 0.55 + sunSide * 0.35, 0, 1));
        spins.push(Math.random() * Math.PI * 2);
      }
      ends.push(sizes.length);
    }
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    geo.setAttribute('center', new THREE.InstancedBufferAttribute(new Float32Array(centers), 3));
    geo.setAttribute('offset', new THREE.InstancedBufferAttribute(new Float32Array(offsets), 3));
    geo.setAttribute('size', new THREE.InstancedBufferAttribute(new Float32Array(sizes), 1));
    geo.setAttribute('light', new THREE.InstancedBufferAttribute(new Float32Array(lights), 1));
    geo.setAttribute('spin', new THREE.InstancedBufferAttribute(new Float32Array(spins), 1));
    geo.instanceCount = sizes.length;
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: { map: { value: puffTexture() }, tile: { value: TILE } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);

    this.centers = centers;
    this.offsets = offsets;
    this.sizes = sizes;
    this.ends = ends;
    /** Puffs drawn (and tested for the whiteout), see setDensity(). */
    this.drawn = sizes.length;
    /** 0..1: how deep inside a cloud the camera is (for the whiteout). */
    this.inside = 0;
  }

  /**
   * Share 0..1 of the cloud clusters drawn (quality.js thins the field on slow devices).
   * The clusters are scattered at random, so dropping the last ones thins it evenly.
   */
  setDensity(share) {
    const clusters = Math.max(1, Math.round(this.ends.length * Math.min(1, share)));
    this.drawn = this.ends[clusters - 1];
    this.mesh.geometry.instanceCount = this.drawn;
  }

  /** Whiteout depth for a camera at `pos`, eased so a cloud edge does not flicker. */
  update(pos, dt) {
    let depth = 0;
    // Quick reject: nowhere near the cloud layer.
    if (pos.y > BASE - BASE_SPREAD - 100 && pos.y < BASE + BASE_SPREAD + 1200) {
      const { centers, offsets, sizes } = this;
      for (let i = 0; i < this.drawn; i++) {
        const x = wrap(centers[i * 3], pos.x) + offsets[i * 3] - pos.x;
        const y = centers[i * 3 + 1] + offsets[i * 3 + 1] - pos.y;
        const z = wrap(centers[i * 3 + 2], pos.z) + offsets[i * 3 + 2] - pos.z;
        const r = sizes[i] * 0.42;
        const d2 = x * x + y * y + z * z;
        if (d2 < r * r) depth = Math.max(depth, 1 - Math.sqrt(d2) / r);
      }
    }
    const target = Math.min(1, depth * 2.5);
    this.inside += (target - this.inside) * Math.min(1, dt * 5);
  }
}
