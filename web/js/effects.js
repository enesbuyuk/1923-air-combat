// Visual effects: tracers, missiles with smoke trails, explosions, debris.

import * as THREE from 'three';
import { BULLET, MISSILE, FLARE, OWNER_PLAYER } from './layout.js';
import { ATMOSPHERE, HAZE_GLSL } from './atmosphere.js';

function radialTexture(stops) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const FIRE_TEX = radialTexture([[0, 'rgba(255,255,230,1)'], [0.25, 'rgba(255,190,80,0.95)'], [0.6, 'rgba(230,80,20,0.5)'], [1, 'rgba(120,20,0,0)']]);
const SMOKE_TEX = radialTexture([[0, 'rgba(200,200,200,0.9)'], [0.5, 'rgba(140,140,140,0.5)'], [1, 'rgba(90,90,90,0)']]);

/**
 * White, lumpy puff: soft blobs scattered around the centre, faded out towards the edge
 * so the quad never shows. The explosion pools tint it per puff; `lighter` adds the blobs
 * up into a hot core (flame), otherwise they overlap like billows of smoke.
 */
function puffTexture(blobs, spread, lighter) {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.globalCompositeOperation = lighter ? 'lighter' : 'source-over';
  for (let i = 0; i < blobs; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = Math.sqrt(Math.random()) * spread * S;
    const x = S / 2 + Math.cos(a) * d;
    const y = S / 2 + Math.sin(a) * d;
    const r = (0.12 + Math.random() * 0.16) * S;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,255,255,${lighter ? 0.35 : 0.5})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
  }
  g.globalCompositeOperation = 'destination-in';
  const edge = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  edge.addColorStop(0, 'rgba(0,0,0,1)');
  edge.addColorStop(0.6, 'rgba(0,0,0,0.8)');
  edge.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = edge;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const FLAME_TEX = puffTexture(22, 0.22, true);
const BILLOW_TEX = puffTexture(30, 0.26, false);

/**
 * Colour of burning gas by age (0 new, 1 burnt out), in linear HDR: white-hot past the
 * bloom threshold (post.js) at first, then orange, dull red and nothing as it cools.
 */
const FLAME_RAMP = [
  [0, 9, 7.5, 5],
  [0.12, 5, 2.6, 0.8],
  [0.4, 2, 0.6, 0.1],
  [0.75, 0.6, 0.1, 0.02],
  [1, 0.1, 0.01, 0],
];

function flameRamp(age, out, o) {
  let k = 1;
  while (k < FLAME_RAMP.length - 1 && FLAME_RAMP[k][0] < age) k++;
  const a = FLAME_RAMP[k - 1];
  const b = FLAME_RAMP[k];
  const f = Math.min(1, Math.max(0, (age - a[0]) / (b[0] - a[0])));
  out[o] *= a[1] + (b[1] - a[1]) * f;
  out[o + 1] *= a[2] + (b[2] - a[2]) * f;
  out[o + 2] *= a[3] + (b[3] - a[3]) * f;
}

// Camera-facing quads for the sprite pools, all of a pool in one draw call. Same result
// as a THREE.Sprite with `fog: true`: the quad is rotated in view space, the map is
// multiplied by the per-puff opacity and the haze (atmosphere.js) is applied on top.
const SPRITE_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 offset;
  attribute float size;
  attribute float alpha;
  attribute float spin;
  attribute vec3 tint;
  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vTint;
  varying vec3 vFogOffset;
  void main() {
    vUv = uv;
    vAlpha = alpha;
    vTint = tint;
    vec4 mv = viewMatrix * vec4(offset, 1.0);
    vec2 corner = position.xy * size;
    float c = cos(spin), s = sin(spin);
    mv.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
    vFogOffset = (vec4(mv.xyz, 0.0) * viewMatrix).xyz;
  }
`;
const SPRITE_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D map;
  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vTint;
  varying vec3 vFogOffset;
  uniform vec3 sunlight;
  ${HAZE_GLSL}
  void main() {
    #include <logdepthbuf_fragment>
    vec4 t = texture2D(map, vUv);
    vec3 dir = vFogOffset / max(length(vFogOffset), 1e-4);
    gl_FragColor = vec4(mix(t.rgb * vTint * sunlight, hazeTint(dir), hazeFactor(vFogOffset)), t.a * vAlpha);
  }
`;

// Rocket motor plume: an open cone behind the nozzle, added on top of the scene in linear
// HDR. It is brightest where the surface faces the camera and fades along its length, so
// it reads as glowing gas rather than a solid; scrolling bands make it flicker and a few
// shock diamonds sit in the first part. Seen straight from behind the cone vanishes,
// which the nozzle glow sprite (updateMissiles) covers.
const PLUME_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying float vT;
  varying float vAround;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vFogOffset;
  void main() {
    vT = uv.y;
    vAround = uv.x;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = -mv.xyz;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
    vFogOffset = (vec4(mv.xyz, 0.0) * viewMatrix).xyz;
  }
`;
const PLUME_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 hot;
  uniform vec3 cool;
  uniform float falloff;
  uniform float intensity;
  uniform float diamonds;
  uniform float time;
  varying float vT;
  varying float vAround;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vFogOffset;
  ${HAZE_GLSL}
  void main() {
    #include <logdepthbuf_fragment>
    // Every term is kept finite: one NaN pixel added into the HDR target would spread
    // through the bloom blur and black out the whole frame. vT can overshoot 1 slightly
    // at the plume's tail (pow of a negative base is NaN), and a plume reaching the eye
    // has no view direction to normalize.
    float dist = length(vView);
    vec3 view = vView / max(dist, 1e-4);
    float facing = pow(abs(dot(normalize(vNormal), view)), 1.5);
    float along = pow(clamp(1.0 - vT, 0.0, 1.0), falloff);
    float flicker = 0.7 + 0.3 * (0.5 + 0.5 * sin(vT * 22.0 - time * 47.0)) * (0.5 + 0.5 * sin(vAround * 18.85 + vT * 9.0 + time * 31.0));
    float shock = 1.0 + diamonds * smoothstep(0.55, 1.0, sin(vT * 38.0)) * (1.0 - smoothstep(0.1, 0.45, vT));
    vec3 col = mix(hot, cool, smoothstep(0.0, 0.75, vT));
    // Fades out right at the eye instead of filling the view with glare.
    float a = along * mix(0.2, 1.0, facing) * flicker * shock * intensity * smoothstep(0.5, 3.0, dist);
    // Additive: haze dims the glow instead of tinting it.
    gl_FragColor = vec4(col * a * (1.0 - hazeFactor(vFogOffset)), 1.0);
  }
`;

/** Open cone from the nozzle (z = 0, radius r0) back to z = len (radius r1); uv.y runs 0 → 1 along it. */
function plumeGeometry(r0, r1, len) {
  return new THREE.CylinderGeometry(r0, r1, len, 14, 1, true).rotateX(-Math.PI / 2).translate(0, 0, len / 2);
}

function plumeMaterial(hot, cool, falloff, intensity, diamonds, time) {
  return new THREE.ShaderMaterial({
    uniforms: { hot: { value: hot }, cool: { value: cool }, falloff: { value: falloff }, intensity: { value: intensity }, diamonds: { value: diamonds }, time },
    vertexShader: PLUME_VERTEX,
    fragmentShader: PLUME_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

/** Missile nozzle, metres behind its centre. */
const NOZZLE = 1.5;
/** Missile smoke trail: spacing between puffs (m) and the most laid per missile per frame. */
const TRAIL_STEP = 3.5;
const TRAIL_MAX_PER_FRAME = 16;
/** A nozzle further than this from the last puff is a new missile in the slot: restart its trail. */
const TRAIL_RESET = 120;

const ZERO = new THREE.Vector3();
/** Burning wreckage pieces in flight at once, and the time between their trail puffs (s). */
const MAX_DEBRIS = 40;
const DEBRIS_TRAIL_STEP = 0.06;

/** Set `v` to a uniformly random unit vector. */
function randomDirection(v) {
  do v.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
  while (v.lengthSq() > 1 || v.lengthSq() < 1e-4);
  return v.normalize();
}
const camPos = new THREE.Vector3();
const camFwd = new THREE.Vector3();

/**
 * Fixed-size pool of camera-facing sprites (fire, smoke), drawn as one instanced mesh.
 * The live puffs are packed into the instance buffers each frame; normally blended pools
 * are sorted back to front first, as separate sprites would be.
 *
 * `ramp(age, out, o)`, if given, colours each puff by its age (0..1), multiplying the
 * colour already in `out` at `o` (its start colour); otherwise a puff's colour goes
 * linearly from its start to its end colour.
 */
class SpritePool {
  constructor(scene, tex, size, additive, ramp = null) {
    this.size = size;
    this.additive = additive;
    this.ramp = ramp;
    // Per puff: position, drift (m/s), scale (m), life left / total (s), growth (1/s),
    // starting opacity, rotation, and whether it is live.
    this.pos = new Float32Array(size * 3);
    this.vel = new Float32Array(size * 3);
    this.scale = new Float32Array(size);
    this.life = new Float32Array(size);
    this.max = new Float32Array(size);
    this.grow = new Float32Array(size);
    this.base = new Float32Array(size);
    this.rot = new Float32Array(size);
    this.live = new Uint8Array(size);
    // Optional per puff, set after spawn() through its index (reset to these defaults):
    // air drag (1/s), vertical acceleration (m/s², buoyancy or gravity), delay before
    // it shows and ages (s; it still moves), spin rate (rad/s), fade-in time (s), the
    // exponent of the fade-out, a size it grows towards at rate `grow` (0: grows
    // exponentially), and its start and end colours.
    this.drag = new Float32Array(size);
    this.lift = new Float32Array(size);
    this.delay = new Float32Array(size);
    this.spinRate = new Float32Array(size);
    this.fadeIn = new Float32Array(size);
    this.fadePow = new Float32Array(size).fill(1);
    this.target = new Float32Array(size);
    this.colA = new Float32Array(size * 3).fill(1);
    this.colB = new Float32Array(size * 3).fill(1);
    this.next = 0;
    // Draw order scratch.
    this.order = new Uint16Array(size);
    this.depth = new Float32Array(size);
    this.byDepth = (a, b) => this.depth[b] - this.depth[a];

    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    geo.setAttribute('uv', quad.attributes.uv);
    this.aOffset = new Float32Array(size * 3);
    this.aSize = new Float32Array(size);
    this.aAlpha = new Float32Array(size);
    this.aSpin = new Float32Array(size);
    this.aTint = new Float32Array(size * 3);
    for (const [name, arr, n] of [['offset', this.aOffset, 3], ['size', this.aSize, 1], ['alpha', this.aAlpha, 1], ['spin', this.aSpin, 1], ['tint', this.aTint, 3]]) {
      geo.setAttribute(name, new THREE.InstancedBufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage));
    }
    geo.instanceCount = 0;
    this.attributes = [geo.attributes.offset, geo.attributes.size, geo.attributes.alpha, geo.attributes.spin, geo.attributes.tint];
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      // Smoke is lit by the sun (dim at night); fire and flame give their own light.
      uniforms: { map: { value: tex }, fogColor: ATMOSPHERE.fogColor, sunlight: additive ? { value: new THREE.Color(1, 1, 1) } : ATMOSPHERE.sunlight },
      vertexShader: SPRITE_VERTEX,
      fragmentShader: SPRITE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.matrixAutoUpdate = false;
    scene.add(this.mesh);
  }

  spawn(pos, scale, life, grow, vel, opacity = 1) {
    const i = this.next;
    this.next = (this.next + 1) % this.size;
    const v = vel || ZERO;
    this.pos[i * 3] = pos.x;
    this.pos[i * 3 + 1] = pos.y;
    this.pos[i * 3 + 2] = pos.z;
    this.vel[i * 3] = v.x;
    this.vel[i * 3 + 1] = v.y;
    this.vel[i * 3 + 2] = v.z;
    this.scale[i] = scale;
    this.life[i] = this.max[i] = life;
    this.grow[i] = grow;
    this.base[i] = opacity;
    this.rot[i] = Math.random() * Math.PI * 2;
    this.live[i] = 1;
    this.drag[i] = this.lift[i] = this.delay[i] = this.spinRate[i] = this.fadeIn[i] = this.target[i] = 0;
    this.fadePow[i] = 1;
    this.colA.fill(1, i * 3, i * 3 + 3);
    this.colB.fill(1, i * 3, i * 3 + 3);
    return i;
  }

  /** Start (`a`) and end (`b`) colour of puff `i`; with a ramp, `a` scales the ramp. */
  color(i, ar, ag, ab, br = ar, bg = ag, bb = ab) {
    const o = i * 3;
    this.colA[o] = ar; this.colA[o + 1] = ag; this.colA[o + 2] = ab;
    this.colB[o] = br; this.colB[o + 1] = bg; this.colB[o + 2] = bb;
  }

  update(dt) {
    for (let i = 0; i < this.size; i++) {
      if (!this.live[i]) continue;
      if (this.delay[i] > 0) this.delay[i] -= dt;
      else {
        this.life[i] -= dt;
        if (this.life[i] <= 0) { this.live[i] = 0; continue; }
      }
      const o = i * 3;
      if (this.drag[i] > 0) {
        const f = Math.exp(-this.drag[i] * dt);
        this.vel[o] *= f;
        this.vel[o + 1] *= f;
        this.vel[o + 2] *= f;
      }
      this.vel[o + 1] += this.lift[i] * dt;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      if (this.target[i] > 0) this.scale[i] += (this.target[i] - this.scale[i]) * (1 - Math.exp(-this.grow[i] * dt));
      else this.scale[i] *= 1 + this.grow[i] * dt;
      this.rot[i] += this.spinRate[i] * dt;
    }
  }

  /** Pack the live puffs into the instance buffers, farthest first unless additive. */
  draw(camera) {
    let n = 0;
    const order = this.order;
    camera.updateMatrixWorld();
    camPos.setFromMatrixPosition(camera.matrixWorld);
    const e = camera.matrixWorld.elements;
    camFwd.set(-e[8], -e[9], -e[10]);
    for (let i = 0; i < this.size; i++) {
      if (!this.live[i] || this.delay[i] > 0) continue;
      order[n++] = i;
      if (!this.additive) {
        this.depth[i] = (this.pos[i * 3] - camPos.x) * camFwd.x
          + (this.pos[i * 3 + 1] - camPos.y) * camFwd.y
          + (this.pos[i * 3 + 2] - camPos.z) * camFwd.z;
      }
    }
    if (!this.additive && n > 1) order.subarray(0, n).sort(this.byDepth);
    for (let k = 0; k < n; k++) {
      const i = order[k];
      this.aOffset[k * 3] = this.pos[i * 3];
      this.aOffset[k * 3 + 1] = this.pos[i * 3 + 1];
      this.aOffset[k * 3 + 2] = this.pos[i * 3 + 2];
      this.aSize[k] = this.scale[i];
      const t = this.life[i] / this.max[i];
      const age = this.max[i] - this.life[i];
      let a = this.base[i] * (this.fadePow[i] === 1 ? t : t ** this.fadePow[i]);
      if (age < this.fadeIn[i]) a *= age / this.fadeIn[i];
      this.aAlpha[k] = a;
      this.aSpin[k] = this.rot[i];
      const o = k * 3;
      const c = i * 3;
      if (this.ramp) {
        this.aTint[o] = this.colA[c];
        this.aTint[o + 1] = this.colA[c + 1];
        this.aTint[o + 2] = this.colA[c + 2];
        this.ramp(1 - t, this.aTint, o);
      } else {
        this.aTint[o] = this.colB[c] + (this.colA[c] - this.colB[c]) * t;
        this.aTint[o + 1] = this.colB[c + 1] + (this.colA[c + 1] - this.colB[c + 1]) * t;
        this.aTint[o + 2] = this.colB[c + 2] + (this.colA[c + 2] - this.colB[c + 2]) * t;
      }
    }
    const geo = this.mesh.geometry;
    geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    for (const a of this.attributes) {
      a.clearUpdateRanges?.();
      a.addUpdateRange?.(0, n * a.itemSize);
      a.needsUpdate = true;
    }
  }
}

export class Effects {
  constructor(scene, maxBullets, maxMissiles) {
    this.scene = scene;
    this.fire = new SpritePool(scene, FIRE_TEX, 420, true);
    this.smoke = new SpritePool(scene, SMOKE_TEX, 700, false);
    // Missile motor smoke, laid at even spacing along the path so it reads as one trail.
    this.trail = new SpritePool(scene, BILLOW_TEX, 3000, false);
    // Explosions: the smoke pool first so the flame, drawn after it, glows through.
    this.billow = new SpritePool(scene, BILLOW_TEX, 1600, false);
    this.flame = new SpritePool(scene, FLAME_TEX, 900, true, flameRamp);
    // Burning wreckage thrown out by an explosion: position, velocity, life left / total
    // and time to its next trail puff.
    this.debrisPos = new Float32Array(MAX_DEBRIS * 3);
    this.debrisVel = new Float32Array(MAX_DEBRIS * 3);
    this.debrisLife = new Float32Array(MAX_DEBRIS);
    this.debrisMax = new Float32Array(MAX_DEBRIS);
    this.debrisEmit = new Float32Array(MAX_DEBRIS);
    this.debrisNext = 0;

    // Tracers: instanced stretched boxes aligned with velocity.
    const tg = new THREE.BoxGeometry(0.35, 0.35, 1);
    this.tracers = new THREE.InstancedMesh(tg, new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
    }), maxBullets);
    this.tracers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracers.frustumCulled = false;
    this.tracers.setColorAt(0, new THREE.Color());
    scene.add(this.tracers);

    // Missiles
    this.missiles = [];
    const body = new THREE.CylinderGeometry(0.11, 0.11, 3, 8).rotateX(Math.PI / 2);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, metalness: 0.3, roughness: 0.5 });
    this._bodyMat = bodyMat;
    this._enemyBodyMat = new THREE.MeshStandardMaterial({ color: 0x9a3a30, metalness: 0.3, roughness: 0.5 });
    // Plume: a short white-hot core inside a longer orange flame, both shared by every missile.
    this._plumeTime = { value: 0 };
    const coreGeo = plumeGeometry(0.1, 0.05, 1.8);
    const coreMat = plumeMaterial(new THREE.Vector3(9, 8, 6.5), new THREE.Vector3(7, 4, 1.5), 1.1, 1, 0, this._plumeTime);
    const flameGeo = plumeGeometry(0.15, 0.45, 7);
    const flameMat = plumeMaterial(new THREE.Vector3(5, 3, 1.2), new THREE.Vector3(2, 0.5, 0.08), 1.7, 0.55, 0.8, this._plumeTime);
    // Nozzle glow: a hot, blooming disc that also shows the flame when seen from behind.
    const glowMat = new THREE.SpriteMaterial({ map: FIRE_TEX, color: new THREE.Color(3.5, 2.6, 1.6), blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < maxMissiles; i++) {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(body, bodyMat));
      const plume = new THREE.Group();
      plume.position.z = NOZZLE;
      plume.add(new THREE.Mesh(coreGeo, coreMat), new THREE.Mesh(flameGeo, flameMat));
      for (const m of plume.children) m.frustumCulled = false;
      const glow = new THREE.Sprite(glowMat);
      glow.position.z = NOZZLE + 0.2;
      g.add(plume, glow);
      g.visible = false;
      scene.add(g);
      this.missiles.push(g);
    }
    // Per missile: where its trail's last puff was laid, and whether it has one.
    this.trailLast = new Float32Array(maxMissiles * 3);
    this.trailOn = new Uint8Array(maxMissiles);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._fwd = new THREE.Vector3(0, 0, -1);
    this._playerTracerColor = new THREE.Color(0xffe27a);
    this._enemyTracerColor = new THREE.Color(0xff5a3c);
    this._e = new THREE.Vector3();
    this._drift = new THREE.Vector3();
    /** Share of trail smoke and explosion puffs spawned (quality.js lowers it on slow devices). */
    this.density = 1;
  }

  /** `buf`: bullet records from the core (layout.js BULLET). */
  updateTracers(buf, count) {
    let n = 0;
    for (let i = 0; i < count; i++) {
      const o = i * BULLET.STRIDE;
      if (buf[o + BULLET.LIFE] <= 0) continue;
      this._p.fromArray(buf, o + BULLET.POS);
      this._v.fromArray(buf, o + BULLET.VEL);
      const speed = this._v.length();
      this._q.setFromUnitVectors(this._fwd, this._v.multiplyScalar(1 / speed));
      this._s.set(1, 1, Math.min(speed * 0.022, 24));
      this._m.compose(this._p, this._q, this._s);
      this.tracers.setMatrixAt(n, this._m);
      this.tracers.setColorAt(n, buf[o + BULLET.OWNER] === OWNER_PLAYER ? this._playerTracerColor : this._enemyTracerColor);
      n++;
    }
    this.tracers.count = n;
    this.tracers.instanceMatrix.needsUpdate = true;
    if (this.tracers.instanceColor) this.tracers.instanceColor.needsUpdate = true;
  }

  /** `buf`: missile records from the core (layout.js MISSILE). */
  updateMissiles(buf, count) {
    for (let i = 0; i < count; i++) {
      const o = i * MISSILE.STRIDE;
      const g = this.missiles[i];
      if (buf[o + MISSILE.LIFE] <= 0) { g.visible = false; this.trailOn[i] = 0; continue; }
      g.visible = true;
      g.position.fromArray(buf, o + MISSILE.POS);
      this._v.fromArray(buf, o + MISSILE.VEL).normalize();
      g.quaternion.setFromUnitVectors(this._fwd, this._v);
      const burning = buf[o + MISSILE.BURN] > 0;
      const enemy = buf[o + MISSILE.OWNER] !== OWNER_PLAYER;
      g.children[0].material = enemy ? this._enemyBodyMat : this._bodyMat;
      const plume = g.children[1];
      const glow = g.children[2];
      plume.visible = glow.visible = burning;
      if (!burning) { this.trailOn[i] = 0; continue; }
      // Flicker: the flame's length and the glow's size waver frame to frame.
      plume.scale.set(1, 1, 0.8 + Math.random() * 0.4);
      glow.scale.setScalar(1.6 + Math.random() * 0.6);
      this._p.copy(g.position).addScaledVector(this._v, -NOZZLE - 0.2);
      this.layTrail(i, this._p);
    }
    this._plumeTime.value = performance.now() / 1000 % 1000;
  }

  /**
   * Smoke along missile `i`'s path up to its nozzle `p`, one puff every TRAIL_STEP metres
   * (wider on low effects settings), so a fast missile leaves a continuous trail.
   */
  layTrail(i, p) {
    const o = i * 3;
    const last = this._e;
    if (this.trailOn[i]) last.fromArray(this.trailLast, o);
    if (!this.trailOn[i] || last.distanceToSquared(p) > TRAIL_RESET * TRAIL_RESET) {
      this.trailOn[i] = 1;
      p.toArray(this.trailLast, o);
      return;
    }
    const dist = last.distanceTo(p);
    const step = Math.max(TRAIL_STEP / Math.max(this.density, 0.25), dist / TRAIL_MAX_PER_FRAME);
    const n = Math.floor(dist / step);
    if (n === 0) return;
    const pos = this._s;
    const drift = this._drift;
    for (let j = 1; j <= n; j++) {
      pos.lerpVectors(last, p, (j * step) / dist);
      randomDirection(drift).multiplyScalar(0.6 + Math.random() * 1.2);
      const t = this.trail.spawn(pos, 0.7 + Math.random() * 0.3, 2.8 + Math.random() * 1.4, 1.1, drift, 0.6);
      this.trail.target[t] = 3.2 + Math.random() * 1.6;
      this.trail.drag[t] = 0.4;
      this.trail.lift[t] = 0.25;
      this.trail.spinRate[t] = (Math.random() - 0.5) * 0.6;
      this.trail.fadeIn[t] = 0.04;
      this.trail.fadePow[t] = 1.6;
      // Bright white where the motor lights it, settling to a sunlit grey.
      this.trail.color(t, 1.25, 1.2, 1.12, 0.8, 0.8, 0.83);
    }
    last.lerpVectors(last, p, (n * step) / dist).toArray(this.trailLast, o);
  }

  /** `buf`: flare records from the core (layout.js FLARE): a white-hot core and a smoke trail. */
  updateFlares(buf, count) {
    for (let i = 0; i < count; i++) {
      const o = i * FLARE.STRIDE;
      const life = buf[o + FLARE.LIFE];
      if (life <= 0) continue;
      this._p.fromArray(buf, o + FLARE.POS);
      this.fire.spawn(this._p, 3 + life, 0.06, 0, null, 1);
      if (Math.random() < 0.6) this.smoke.spawn(this._p, 1.5, 1.4, 1.6, null, 0.35);
    }
  }

  /**
   * A fuel-air fireball: a white flash, burning gas thrown out and quickly stopped by the
   * air, cooling from white through orange to red as it rises, the black smoke it leaves
   * behind billowing up and greying, and embers and burning wreckage falling out of it.
   */
  explosion(pos, size = 1) {
    const k = this.density;
    const R = 9 * size;
    const v = this._e;
    const p = this._p;
    const { flame, billow } = this;

    // Flash: brief and far brighter than the bloom threshold.
    let i = flame.spawn(pos, R * 3, 0.14, 4, null, 1);
    flame.color(i, 4, 4, 4);
    i = flame.spawn(pos, R * 1.6, 0.45, 2, null, 0.8);
    flame.color(i, 1.5, 1.4, 1.2);

    // Fireball and the smoke that takes its place.
    const puffs = Math.max(4, Math.round(16 * size * k));
    for (let n = 0; n < puffs; n++) {
      randomDirection(v).multiplyScalar(R * (2 + Math.random() * 5));
      p.copy(pos).addScaledVector(v, 0.04 / size);
      i = flame.spawn(p, R * (0.3 + Math.random() * 0.3), (0.7 + Math.random() * 0.7) * Math.sqrt(size), 5, v, 0.9);
      flame.drag[i] = 5;
      flame.lift[i] = 8;
      flame.target[i] = R * (0.9 + Math.random() * 0.6);
      flame.spinRate[i] = (Math.random() - 0.5) * 2;
      flame.fadeIn[i] = 0.03;
      flame.fadePow[i] = 1.4;

      v.multiplyScalar(0.8);
      i = billow.spawn(p, R * 0.6, 7 + Math.random() * 5 * Math.sqrt(size), 0.9, v, 0.85);
      billow.drag[i] = 3;
      billow.lift[i] = 5;
      billow.delay[i] = 0.2 + Math.random() * 0.4;
      billow.target[i] = R * (1.4 + Math.random() * 0.8);
      billow.spinRate[i] = (Math.random() - 0.5) * 0.5;
      billow.fadeIn[i] = 0.5;
      billow.fadePow[i] = 0.7;
      const shade = 0.06 + Math.random() * 0.05;
      billow.color(i, shade * 1.6, shade * 1.1, shade, 0.36, 0.35, 0.34);
    }

    // Embers: small, fast and falling.
    const embers = Math.round(22 * size * k);
    for (let n = 0; n < embers; n++) {
      randomDirection(v).multiplyScalar(50 + Math.random() * 90);
      v.y += 20;
      i = flame.spawn(pos, 0.8 + Math.random() * 1.2, 0.6 + Math.random() * 1.2, 0, v, 1);
      flame.drag[i] = 1.5;
      flame.lift[i] = -9.81;
      flame.color(i, 0.6, 0.6, 0.6);
    }

    // Burning wreckage, each piece trailing fire and smoke (see updateDebris).
    const pieces = Math.min(10, Math.round(4 + 3 * size * k));
    for (let n = 0; n < pieces; n++) {
      const d = this.debrisNext;
      this.debrisNext = (d + 1) % MAX_DEBRIS;
      randomDirection(v).multiplyScalar(25 + Math.random() * 45);
      v.y = Math.abs(v.y) * 0.8 + 10;
      pos.toArray(this.debrisPos, d * 3);
      v.toArray(this.debrisVel, d * 3);
      this.debrisLife[d] = this.debrisMax[d] = 1.4 + Math.random() * 1.6;
      this.debrisEmit[d] = 0;
    }
  }

  /** Fly the wreckage ballistically and lay its trail. */
  updateDebris(dt) {
    const p = this._p;
    const drag = Math.exp(-0.4 * dt);
    for (let d = 0; d < MAX_DEBRIS; d++) {
      if (this.debrisLife[d] <= 0) continue;
      this.debrisLife[d] -= dt;
      const o = d * 3;
      const vel = this.debrisVel;
      vel[o] *= drag;
      vel[o + 1] = vel[o + 1] * drag - 9.81 * dt;
      vel[o + 2] *= drag;
      this.debrisPos[o] += vel[o] * dt;
      this.debrisPos[o + 1] += vel[o + 1] * dt;
      this.debrisPos[o + 2] += vel[o + 2] * dt;
      this.debrisEmit[d] -= dt;
      if (this.debrisEmit[d] > 0) continue;
      this.debrisEmit[d] = DEBRIS_TRAIL_STEP / Math.max(0.25, this.density);
      // Burns out over its flight: the flame shrinks, the smoke thins.
      p.fromArray(this.debrisPos, o);
      this.burn(p, this.debrisLife[d] / this.debrisMax[d], 1);
    }
  }

  /** One trail puff of something burning: `heat` 1 ablaze .. 0 smouldering, `scale` its size. */
  burn(pos, heat, scale) {
    if (heat > 0.2) {
      const i = this.flame.spawn(pos, (1.5 + 2.5 * heat) * scale, 0.25, 2, null, heat);
      this.flame.color(i, 0.8, 0.8, 0.8);
    }
    const i = this.billow.spawn(pos, 2 * scale, 1.6 + Math.random() + 2 * scale * (1 - heat), 1.5, null, 0.6 * heat + 0.15);
    this.billow.target[i] = (6 + 4 * heat) * scale;
    this.billow.lift[i] = 1.5;
    this.billow.drag[i] = 1;
    this.billow.fadeIn[i] = 0.1;
    this.billow.color(i, 0.1, 0.09, 0.08, 0.4, 0.4, 0.4);
  }

  spark(pos) {
    this.fire.spawn(pos, 4 + Math.random() * 3, 0.15, 3, null, 1);
  }

  /** Damaged aircraft trail smoke. */
  damageSmoke(pos, amount) {
    if (Math.random() < amount) this.smoke.spawn(pos, 3 + amount * 4, 1.8, 1.2, null, 0.35 + amount * 0.3);
  }

  update(dt) {
    this.updateDebris(dt);
    this.fire.update(dt);
    this.smoke.update(dt);
    this.trail.update(dt);
    this.billow.update(dt);
    this.flame.update(dt);
  }

  /** Upload the live fire and smoke for this frame; call right before rendering. */
  draw(camera) {
    this.fire.draw(camera);
    this.smoke.draw(camera);
    this.trail.draw(camera);
    this.billow.draw(camera);
    this.flame.draw(camera);
  }
}
