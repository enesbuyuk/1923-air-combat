// Wingtip vortices: the condensation ropes that trail from the wingtips of a hard-working
// wing, for the player and every aircraft nearby.
//
// Strength is the circulation of the trailing vortex, Γ = L / (ρ · V · b): the same lift
// makes a stronger vortex the slower the aircraft and the thinner the air. The rope is
// visible only where that circulation can condense the air's moisture, so it shows in a
// hard pull, on a slow heavy approach, and more readily in the humid air down low.
// Once shed, each piece of rope drifts with the wind, the pair sinks under its own
// induced downwash, rolls up inboard toward π/4 of the span, splays outward near the
// ground, and widens and fades as its core diffuses (Lamb-Oseen growth).

import * as THREE from 'three';
import { AIRCRAFT } from './aircraft.js';
import { BOT } from './layout.js';
import { wingOf } from './wing.js';

const G = 9.81;
/** Points per rope; a new one is shed every 30 ms of flight, at least 2.5 m apart. */
const CAPACITY = 240;
const SPACING_TIME = 0.03;
const MIN_SPACING = 2.5;
/** Circulation (m²/s) where condensation starts and where the rope is at full strength. */
const GAMMA_ON = 150;
const GAMMA_FULL = 450;
/** Visual core radius (m) at the tip and the eddy-viscosity factor (ν_t = k · Γ). */
const CORE = 0.14;
const EDDY = 1.5e-4;
/** Ropes are only drawn for aircraft this close to the camera (m). */
const RANGE = 4000;
/** Texture repeat along the rope (m per repeat). */
const TEX_LENGTH = 22;

const smooth = THREE.MathUtils.smoothstep;

/** Air density (kg/m³) in a standard exponential atmosphere. */
export function density(y) {
  return 1.225 * Math.exp(-Math.max(0, y) / 8500);
}

/** Moisture available to condense: a humid layer near the ground, drier aloft, cold air near ice saturation high up. */
export function humidity(y) {
  return Math.min(1, 1 - 0.5 * smooth(y, 300, 2500) + 0.5 * smooth(y, 6000, 9000));
}

/** Soft rope cross-section with streaky noise along its length. */
function ropeTexture() {
  const w = 256;
  const h = 32;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  // A few octaves of smooth 1D noise along u, varied a little across v.
  const octaves = [[4, 0.5], [9, 0.3], [23, 0.2]].map(([f, a]) => ({ f, a, p: Math.random() * 6.28, q: Math.random() * 6.28 }));
  for (let y = 0; y < h; y++) {
    const across = (y + 0.5) / h * 2 - 1;
    const profile = Math.exp(-across * across * 4.5);
    for (let x = 0; x < w; x++) {
      const u = (x / w) * Math.PI * 2;
      let n = 0;
      for (const o of octaves) n += o.a * Math.sin(u * o.f + o.p + across * 1.7 * Math.sin(u * 3 + o.q));
      const a = profile * (0.62 + 0.38 * n);
      // Self-shadowed edges: a pure white rope would vanish against a pale sky.
      const shade = 255 * (0.62 + 0.38 * profile * profile);
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = shade;
      img.data[i + 2] = Math.min(255, shade * 1.04);
      img.data[i + 3] = Math.max(0, Math.min(255, a * 255));
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const tmp = new THREE.Vector3();
const tangent = new THREE.Vector3();
const side = new THREE.Vector3();
const toCam = new THREE.Vector3();
const tipWorld = new THREE.Vector3();
const outward = new THREE.Vector3();

/** One rope trailing from one wingtip: a ring buffer of shed points, drawn as a camera-facing ribbon. */
class Rope {
  constructor(scene, material) {
    this.pos = new Float32Array(CAPACITY * 3);
    // Per point: age (s), visibility 0..1, circulation (m²/s), sink speed (m/s),
    // inboard roll-up left (m), life (s), odometer (m).
    this.age = new Float32Array(CAPACITY);
    this.vis = new Float32Array(CAPACITY);
    this.gamma = new Float32Array(CAPACITY);
    this.sink = new Float32Array(CAPACITY);
    this.rollup = new Float32Array(CAPACITY);
    this.life = new Float32Array(CAPACITY);
    this.odo = new Float32Array(CAPACITY);
    // Outward (away from the fuselage) direction at the moment each point was shed.
    this.out = new Float32Array(CAPACITY * 3);
    this.head = 0;
    this.count = 0;
    this.odometer = 0;
    this.attached = false;

    const geo = new THREE.BufferGeometry();
    this.vertices = new Float32Array(CAPACITY * 2 * 3);
    this.colors = new Float32Array(CAPACITY * 2 * 4);
    this.uvs = new Float32Array(CAPACITY * 2 * 2);
    geo.setAttribute('position', new THREE.BufferAttribute(this.vertices, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2).setUsage(THREE.DynamicDrawUsage));
    const index = [];
    for (let i = 0; i < CAPACITY - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(index);
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** Index of the k-th newest point. */
  at(k) {
    return (this.head - k + CAPACITY) % CAPACITY;
  }

  /**
   * Track the wingtip at `tip`. The newest point rides on the tip; once it is `spacing`
   * metres from the one before, it is left behind in the air and a new one starts.
   */
  feed(tip, out, spacing, vis, gamma, sink, rollup) {
    // Re-attaching after a gap (respawn, back in range): the old rope would be joined
    // to the new one across the gap, so it goes.
    if (!this.attached) this.count = 0;
    if (this.count > 0) {
      const h = this.head * 3;
      const prev = this.count > 1 ? this.at(1) * 3 : h;
      const moved = Math.hypot(tip.x - this.pos[prev], tip.y - this.pos[prev + 1], tip.z - this.pos[prev + 2]);
      this.odometer += Math.hypot(tip.x - this.pos[h], tip.y - this.pos[h + 1], tip.z - this.pos[h + 2]);
      if (moved < spacing && this.count > 1) {
        this.set(this.head, tip, out, vis, gamma, sink, rollup);
        return;
      }
    }
    this.head = (this.head + 1) % CAPACITY;
    this.count = Math.min(CAPACITY, this.count + 1);
    this.age[this.head] = 0;
    this.set(this.head, tip, out, vis, gamma, sink, rollup);
    this.attached = true;
  }

  set(i, tip, out, vis, gamma, sink, rollup) {
    this.pos.set([tip.x, tip.y, tip.z], i * 3);
    this.out.set([out.x, out.y, out.z], i * 3);
    this.vis[i] = vis;
    this.gamma[i] = gamma;
    this.sink[i] = sink;
    this.rollup[i] = rollup;
    this.life[i] = 2.5 + vis * 5;
    this.odo[i] = this.odometer;
  }

  /** Stop feeding: the rope stays in the air and ages out. */
  detach() {
    this.attached = false;
  }

  /** Move shed points with the air and drop the ones that have faded. */
  advance(dt, wind, span) {
    const b = span * Math.PI / 4;
    for (let k = this.attached ? 1 : 0; k < this.count; k++) {
      const i = this.at(k);
      this.age[i] += dt;
      const o = i * 3;
      // Mutual induction sinks the pair; near the ground its mirror image stops the
      // sink and pushes each rope outboard instead.
      const h = Math.max(0, this.pos[o + 1]);
      const ground = Math.min(1, h / Math.max(b, 1));
      const sink = this.sink[i] * ground;
      let lateral = this.sink[i] * (1 - ground);
      // Roll-up: the sheet gathers inboard toward π/4 of the span over the first second.
      if (this.rollup[i] > 0) {
        const step = Math.min(this.rollup[i], span * 0.11 * dt);
        this.rollup[i] -= step;
        lateral -= step / Math.max(dt, 1e-4);
      }
      this.pos[o] += (wind[0] + this.out[o] * lateral) * dt;
      this.pos[o + 1] += (wind[1] - sink) * dt;
      this.pos[o + 2] += (wind[2] + this.out[o + 2] * lateral) * dt;
    }
    // Oldest points sit at the end of the ring.
    while (this.count > 0) {
      const i = this.at(this.count - 1);
      if (this.age[i] < this.life[i]) break;
      this.count--;
    }
  }

  /** Rebuild the ribbon facing `cam`. */
  draw(cam) {
    const n = this.count;
    this.mesh.visible = false;
    if (n < 2) return;
    let shown = 0;
    const v = this.vertices;
    const c = this.colors;
    const uv = this.uvs;
    for (let k = 0; k < n; k++) {
      const i = this.at(k);
      const o = i * 3;
      const a = this.at(Math.max(0, k - 1)) * 3;
      const z = this.at(Math.min(n - 1, k + 1)) * 3;
      tangent.set(this.pos[z] - this.pos[a], this.pos[z + 1] - this.pos[a + 1], this.pos[z + 2] - this.pos[a + 2]);
      tmp.set(this.pos[o], this.pos[o + 1], this.pos[o + 2]);
      toCam.copy(cam).sub(tmp);
      side.crossVectors(tangent, toCam);
      const len = side.length();
      if (len < 1e-6) side.set(0, 1, 0);
      else side.divideScalar(len);

      // Lamb-Oseen: r² = r0² + 4 ν_t t, with eddy viscosity proportional to Γ.
      const age = this.age[i];
      const r = Math.sqrt(CORE * CORE + 4 * EDDY * this.gamma[i] * age);
      // The rope is born as a thin faint thread and rolls up to full strength.
      const build = smooth(age, 0, 0.35);
      const width = r * (0.35 + 0.65 * build) * 1.8;
      const fade = 1 - smooth(age, this.life[i] * 0.55, this.life[i]);
      // Circulation is conserved, so a wider core is a dimmer one.
      const alpha = this.vis[i] * (0.3 + 0.7 * build) * fade * Math.min(1, (CORE * 2.5) / r) * 0.9;
      shown = Math.max(shown, alpha);

      const q = k * 2;
      v[q * 3] = tmp.x - side.x * width;
      v[q * 3 + 1] = tmp.y - side.y * width;
      v[q * 3 + 2] = tmp.z - side.z * width;
      v[q * 3 + 3] = tmp.x + side.x * width;
      v[q * 3 + 4] = tmp.y + side.y * width;
      v[q * 3 + 5] = tmp.z + side.z * width;
      c.set([1, 1, 1, alpha, 1, 1, 1, alpha], q * 4);
      const u = this.odo[i] / TEX_LENGTH;
      uv.set([u, 0, u, 1], q * 2);
    }
    // Ropes too weak to condense are kept (they may strengthen) but not drawn.
    this.mesh.visible = shown > 0.003;
    const geo = this.mesh.geometry;
    geo.setDrawRange(0, (n - 1) * 6);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.attributes.uv.needsUpdate = true;
  }
}

/** A left/right rope pair for one aircraft, plus what it needs to estimate its lift. */
class Wake {
  constructor(scene, material) {
    this.ropes = [new Rope(scene, material), new Rope(scene, material)];
    this.gLoad = 1;
    this.span = 10;
    this.prevFwd = null;
  }

  detach() {
    this.ropes.forEach((r) => r.detach());
    this.prevFwd = null;
  }

  /**
   * @param {THREE.Vector3} pos aircraft position
   * @param {THREE.Quaternion} quat aircraft attitude
   * @param {object} wing wing.js geometry
   * @param {object} def aircraft definition
   */
  feed(pos, quat, wing, def, speed, gLoad, y) {
    this.span = wing.span;
    const b = wing.span;
    // Γ = L / (ρ V b), with L the lift the wing is actually making.
    const lift = Math.max(0, gLoad) * (def.mass ?? 15000) * G;
    const gamma = lift / (density(y) * Math.max(speed, 20) * b);
    const vis = smooth(gamma, GAMMA_ON, GAMMA_FULL) * humidity(y);
    // Pair descent speed w = Γ / (2π b'), b' = π/4 b.
    const sink = gamma / (2 * Math.PI * b * Math.PI / 4);
    const rollup = b * 0.5 * (1 - Math.PI / 4);
    const spacing = Math.max(MIN_SPACING, speed * SPACING_TIME);
    for (let s = 0; s < 2; s++) {
      const sign = s ? 1 : -1;
      tipWorld.set(wing.tip[0] * sign, wing.tip[1], wing.tip[2]).applyQuaternion(quat).add(pos);
      outward.set(sign, 0, 0).applyQuaternion(quat);
      this.ropes[s].feed(tipWorld, outward, spacing, vis, gamma, sink, rollup);
    }
  }

  update(dt, wind, cam) {
    for (const r of this.ropes) {
      r.advance(dt, wind, this.span);
      r.draw(cam);
    }
  }

  get active() {
    return this.ropes.some((r) => r.count > 0);
  }
}

const pos = new THREE.Vector3();
const quat = new THREE.Quaternion();
const qPrev = new THREE.Quaternion();
const fwd = new THREE.Vector3();
const up = new THREE.Vector3();
const accel = new THREE.Vector3();

export class Vortices {
  /** @param {import('./models.js').AircraftModels} models */
  constructor(scene, models) {
    this.scene = scene;
    this.models = models;
    this.material = new THREE.MeshBasicMaterial({
      map: ropeTexture(), vertexColors: true, transparent: true, depthWrite: false,
      side: THREE.DoubleSide, color: 0xf1f4f8,
    });
    this.player = new Wake(scene, this.material);
    this.bots = [];
  }

  wing(type) {
    return wingOf(this.models.request(AIRCRAFT[type].key));
  }

  /** Drop every rope (new game, back to the menu). */
  clear() {
    for (const w of [this.player, ...this.bots]) {
      w.detach();
      w.ropes.forEach((r) => { r.count = 0; r.mesh.visible = false; });
    }
  }

  /**
   * @param {object} p        decoded player state (interpolated pose)
   * @param {Float32Array} buf bot records (layout.js BOT)
   * @param {Float32Array|null} prev bot records one fixed step earlier
   * @param {number} alpha    interpolation factor between prev and buf
   * @param {number} step     fixed simulation step (s), the time between prev and buf
   * @param {THREE.Vector3} cam camera position
   */
  update(p, buf, prev, alpha, step, count, cam, dt) {
    const wind = p.wind;
    if (dt <= 0) return;

    // Player: the core reports its G load.
    if (p.alive && !p.onGround) {
      const def = AIRCRAFT[p.type];
      pos.set(p.x, p.y, p.z);
      quat.set(...p.quat);
      this.player.feed(pos, quat, this.wing(p.type), def, p.speed, p.gLoad, p.y);
    } else {
      this.player.detach();
    }
    this.player.update(dt, wind, cam);

    for (let i = 0; i < count; i++) {
      const wake = (this.bots[i] ??= new Wake(this.scene, this.material));
      const o = i * BOT.STRIDE;
      const alive = buf[o + BOT.ALIVE] > 0;
      const type = buf[o + BOT.TYPE] | 0;
      pos.fromArray(buf, o + BOT.POS);
      if (!alive || pos.distanceTo(cam) > RANGE) {
        wake.detach();
        if (wake.active) wake.update(dt, wind, cam);
        continue;
      }
      quat.fromArray(buf, o + BOT.QUAT);
      const speed = buf[o + BOT.SPEED];
      // Bots don't report G: estimate it from how fast the nose swings, which is the
      // flight path turning, plus the 1 g the wing holds against gravity.
      if (prev && prev[o + BOT.ALIVE] > 0 && (prev[o + BOT.TYPE] | 0) === type) {
        qPrev.fromArray(prev, o + BOT.QUAT);
        fwd.set(0, 0, -1).applyQuaternion(quat);
        accel.set(0, 0, -1).applyQuaternion(qPrev);
        accel.subVectors(fwd, accel).multiplyScalar(speed / step);
        accel.y += G;
        up.set(0, 1, 0).applyQuaternion(quat);
        const n = accel.dot(up) / G;
        wake.gLoad += (THREE.MathUtils.clamp(n, -3, 10) - wake.gLoad) * 0.15;
        // Render on the interpolated pose, like the aircraft model.
        tmp.fromArray(prev, o + BOT.POS);
        pos.lerpVectors(tmp, pos, alpha);
        quat.copy(qPrev.slerp(quat, alpha));
      }
      wake.feed(pos, quat, this.wing(type), AIRCRAFT[type], speed, wake.gLoad, pos.y);
      wake.update(dt, wind, cam);
    }
  }
}
