// Wing vapor: the white sheet that forms over a fighter's wing in a hard pull, and the
// vapor cone around the fuselage near Mach 1.
//
// Air speeding over the top of the wing drops in pressure and cools; if it cools below
// its dew point the moisture condenses, and it clears again once the air has passed the
// wing. The cooling grows with the suction over the wing (dynamic pressure times how hard
// the wing is working, i.e. Mach² × angle of attack, sharpened toward Mach 1 by
// compressibility) and needs moist air, so the vapor shows in hard pulls, at speed, down
// low, and never in a cruise or on a takeoff roll. It forms along the leading edge first
// (the suction peak) and thins toward the tips.
//
// The puffs live in the aircraft frame: they stay put on the wing while the aircraft
// carries them, which is how the real sheet looks.

import * as THREE from 'three';
import { ATMOSPHERE } from './atmosphere.js';
import { humidity } from './vortex.js';

const POOL = 900;
/** Puffs spawned per second at full wing vapor / full vapor cone. */
const WING_RATE = 1400;
const CONE_RATE = 900;
/** Cooling index where condensation starts and where the sheet is fully formed. */
const COOL_ON = 0.08;
const COOL_FULL = 0.28;
/** Angle of attack (rad) the cooling index is normalised to. */
const ALPHA_REF = 0.45;

const smooth = THREE.MathUtils.smoothstep;

function puffTexture() {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const img = g.createImageData(s, s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = (x + 0.5) / s * 2 - 1;
      const dy = (y + 0.5) / s * 2 - 1;
      const r = Math.hypot(dx, dy);
      // Soft blob with a little wispy variation.
      const wisp = 0.85 + 0.15 * Math.sin(Math.atan2(dy, dx) * 5 + r * 9);
      const a = Math.max(0, 1 - r) ** 2 * wisp;
      // Grey, self-shadowed edges so the sheet reads against a bright sky.
      const shade = 255 * (0.66 + 0.34 * Math.max(0, 1 - r * 1.3));
      const i = (y * s + x) * 4;
      img.data[i] = img.data[i + 1] = shade;
      img.data[i + 2] = Math.min(255, shade * 1.04);
      img.data[i + 3] = a * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

// Camera-facing quads in one draw call. The renderer uses a logarithmic depth buffer,
// so the shader includes three.js' log-depth chunks.
const VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 offset;
  attribute float size;
  attribute float alpha;
  attribute float spin;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    float c = cos(spin), s = sin(spin);
    vUv = mat2(c, -s, s, c) * position.xy + 0.5;
    vAlpha = alpha;
    vec4 mv = modelViewMatrix * vec4(offset, 1.0);
    mv.xy += position.xy * size;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;
const FRAGMENT = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D map;
  uniform vec3 color;
  uniform vec3 sunlight;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    #include <logdepthbuf_fragment>
    vec4 t = texture2D(map, vUv);
    float a = t.a * vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(color * sunlight * t.rgb, a);
  }
`;

export class WingVapor {
  constructor() {
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    this.offset = new Float32Array(POOL * 3);
    this.size = new Float32Array(POOL);
    this.alpha = new Float32Array(POOL);
    this.spin = new Float32Array(POOL);
    for (const [name, arr, n] of [['offset', this.offset, 3], ['size', this.size, 1], ['alpha', this.alpha, 1], ['spin', this.spin, 1]]) {
      geo.setAttribute(name, new THREE.InstancedBufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage));
    }
    geo.instanceCount = 0;
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: { map: { value: puffTexture() }, color: { value: new THREE.Color(0xf4f6f9) }, sunlight: ATMOSPHERE.sunlight },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;

    // Per puff: life left / total (s), peak opacity, drift (m/s, aircraft frame), growth.
    this.life = new Float32Array(POOL);
    this.max = new Float32Array(POOL);
    this.peak = new Float32Array(POOL);
    this.vel = new Float32Array(POOL * 3);
    this.grow = new Float32Array(POOL);
    this.next = 0;
    this.carry = 0;
    this.carryCone = 0;
    this.wingLevel = 0;
    this.coneLevel = 0;
    this.frameDt = 0;
    /** Share of the full puff rate spawned (quality.js lowers it on slow devices). */
    this.density = 1;
    this.attributes = [geo.attributes.offset, geo.attributes.size, geo.attributes.alpha, geo.attributes.spin];
  }

  spawn(x, y, z, size, life, peak, vx, vy, vz, grow) {
    const i = this.next;
    this.next = (this.next + 1) % POOL;
    this.offset[i * 3] = x;
    this.offset[i * 3 + 1] = y;
    this.offset[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.size[i] = size;
    // On a slow frame a puff must still live a few frames, or it is never seen.
    this.life[i] = this.max[i] = Math.max(life, this.frameDt * 3);
    this.peak[i] = peak;
    this.grow[i] = grow;
    this.spin[i] = Math.random() * Math.PI * 2;
  }

  /** One puff on the upper surface of one wing, biased to the leading edge and the inboard wing. */
  wingPuff(wing, sign, level) {
    let s;
    // Thinner toward the tips.
    do s = Math.random(); while (Math.random() < s * 0.65);
    const chordFrac = Math.random() ** 2 * 0.65;
    const [tx, , tz] = wing.tip;
    const le = wing.rootLE + (tz - wing.rootLE) * s;
    const te = wing.rootTE + (tz + 0.4 - wing.rootTE) * s;
    const chord = Math.max(0.5, te - le);
    const x = (wing.rootX + (tx - wing.rootX) * s) * sign;
    const y = wing.rootTop + (wing.tipTop - wing.rootTop) * s + 0.1 + Math.random() * chord * 0.08;
    const z = le + chordFrac * chord;
    const size = chord * (0.35 + Math.random() * 0.3) * (1 - s * 0.4);
    this.spawn(x, y, z, size, 0.1 + Math.random() * 0.18, level * (0.35 + Math.random() * 0.25),
      0, 0.4, 6 + Math.random() * 6, 1.6);
  }

  /** One puff of the vapor cone: a ring around the fuselage just behind the cockpit. */
  conePuff(wing, level) {
    const a = Math.random() * Math.PI * 2;
    const r = wing.span * (0.07 + Math.random() * 0.05);
    const z = wing.rootLE + (wing.rootTE - wing.rootLE) * (0.2 + Math.random() * 0.5);
    this.spawn(Math.cos(a) * r, wing.rootTop + Math.sin(a) * r * 0.8, z, wing.span * (0.06 + Math.random() * 0.05),
      0.08 + Math.random() * 0.12, level * (0.3 + Math.random() * 0.2), Math.cos(a) * 2, Math.sin(a) * 2, 10, 2.2);
  }

  /**
   * @param {object} p decoded player state
   * @param {THREE.Object3D} group the player's aircraft model (puffs live in its frame)
   * @param {object} wing wing.js geometry of the flown aircraft
   * @param {boolean} active flying (not menu / kill cam)
   */
  update(p, group, wing, active, dt) {
    if (this.mesh.parent !== group) group.add(this.mesh);
    const moist = humidity(p.y);
    let wingTarget = 0;
    let coneTarget = 0;
    if (active && p.alive && !p.onGround && p.gLoad > 1.3) {
      const m = Math.min(p.mach, 0.95);
      // Suction over the wing: Mach² × lift coefficient, with Prandtl-Glauert compressibility.
      const cooling = p.mach * p.mach * (Math.max(0, p.alpha) / ALPHA_REF) / Math.sqrt(1 - m * m);
      wingTarget = smooth(cooling, COOL_ON, COOL_FULL) * moist;
    }
    if (active && p.alive && !p.onGround) {
      // The cone stands in the transonic band, strongest just below Mach 1.
      coneTarget = smooth(p.mach, 0.9, 0.97) * (1 - smooth(p.mach, 1.0, 1.06)) * moist;
    }
    // A little lag so the sheet swells and collapses rather than blinking.
    this.wingLevel += (wingTarget - this.wingLevel) * Math.min(1, dt * 10);
    this.coneLevel += (coneTarget - this.coneLevel) * Math.min(1, dt * 6);

    this.frameDt = dt;
    if (dt > 0) {
      // A long frame must not recycle puffs that are still alive.
      this.carry = Math.min(POOL * 0.3, this.carry + WING_RATE * this.density * this.wingLevel * dt);
      while (this.carry >= 1) {
        this.carry--;
        this.wingPuff(wing, Math.random() < 0.5 ? -1 : 1, this.wingLevel);
      }
      this.carryCone = Math.min(POOL * 0.2, this.carryCone + CONE_RATE * this.density * this.coneLevel * dt);
      while (this.carryCone >= 1) {
        this.carryCone--;
        this.conePuff(wing, this.coneLevel);
      }
    }

    let n = 0;
    for (let i = 0; i < POOL; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const t = 1 - Math.max(0, this.life[i]) / this.max[i];
      this.offset[i * 3] += this.vel[i * 3] * dt;
      this.offset[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.offset[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] *= 1 + this.grow[i] * dt;
      // Quick fade in, slower fade out.
      this.alpha[i] = this.peak[i] * Math.min(1, t * 6) * (1 - t);
      n = i + 1;
    }
    const geo = this.mesh.geometry;
    geo.instanceCount = n;
    this.mesh.visible = n > 0;
    for (const a of this.attributes) a.needsUpdate = true;
  }
}
