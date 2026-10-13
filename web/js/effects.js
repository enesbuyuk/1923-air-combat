// Visual effects: tracers, missiles with smoke trails, explosions, debris.

import * as THREE from 'three';
import { BULLET, MISSILE, FLARE, OWNER_PLAYER } from './layout.js';
import { HAZE_GLSL } from './atmosphere.js';

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
  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vFogOffset;
  void main() {
    vUv = uv;
    vAlpha = alpha;
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
  varying vec3 vFogOffset;
  ${HAZE_GLSL}
  void main() {
    #include <logdepthbuf_fragment>
    vec4 t = texture2D(map, vUv);
    gl_FragColor = vec4(mix(t.rgb, hazeTint(normalize(vFogOffset)), hazeFactor(vFogOffset)), t.a * vAlpha);
  }
`;

const ZERO = new THREE.Vector3();
const camPos = new THREE.Vector3();
const camFwd = new THREE.Vector3();

/**
 * Fixed-size pool of camera-facing sprites (fire, smoke), drawn as one instanced mesh.
 * The live puffs are packed into the instance buffers each frame; normally blended pools
 * are sorted back to front first, as separate sprites would be.
 */
class SpritePool {
  constructor(scene, tex, size, additive) {
    this.size = size;
    this.additive = additive;
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
    for (const [name, arr, n] of [['offset', this.aOffset, 3], ['size', this.aSize, 1], ['alpha', this.aAlpha, 1], ['spin', this.aSpin, 1]]) {
      geo.setAttribute(name, new THREE.InstancedBufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage));
    }
    geo.instanceCount = 0;
    this.attributes = [geo.attributes.offset, geo.attributes.size, geo.attributes.alpha, geo.attributes.spin];
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: { map: { value: tex } },
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
  }

  update(dt) {
    for (let i = 0; i < this.size; i++) {
      if (!this.live[i]) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.live[i] = 0; continue; }
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.scale[i] *= 1 + this.grow[i] * dt;
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
      if (!this.live[i]) continue;
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
      this.aAlpha[k] = this.base[i] * (this.life[i] / this.max[i]);
      this.aSpin[k] = this.rot[i];
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
    const flameMat = new THREE.MeshBasicMaterial({ color: 0xffd080, blending: THREE.AdditiveBlending, transparent: true });
    for (let i = 0; i < maxMissiles; i++) {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(body, bodyMat));
      const f = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), flameMat);
      f.position.z = 1.7;
      f.scale.set(1, 1, 3);
      g.add(f);
      g.visible = false;
      scene.add(g);
      this.missiles.push(g);
    }
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._fwd = new THREE.Vector3(0, 0, -1);
    this._playerTracerColor = new THREE.Color(0xffe27a);
    this._enemyTracerColor = new THREE.Color(0xff5a3c);
    this._e = new THREE.Vector3();
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
      if (buf[o + MISSILE.LIFE] <= 0) { g.visible = false; continue; }
      g.visible = true;
      g.position.fromArray(buf, o + MISSILE.POS);
      this._v.fromArray(buf, o + MISSILE.VEL).normalize();
      g.quaternion.setFromUnitVectors(this._fwd, this._v);
      const burning = buf[o + MISSILE.BURN] > 0;
      const enemy = buf[o + MISSILE.OWNER] !== OWNER_PLAYER;
      g.children[0].material = enemy ? this._enemyBodyMat : this._bodyMat;
      g.children[1].visible = burning;
      if (!burning) continue;
      // Smoke trail while the motor burns, offset behind the nozzle; a coasting missile leaves none.
      this._p.copy(g.position).addScaledVector(this._v, -2.5);
      if (this.density >= 1 || Math.random() < this.density) this.smoke.spawn(this._p, 2.5, 2.2 + Math.random(), 1.4, null, 0.55);
      if (Math.random() < 0.5) this.fire.spawn(this._p, 1.4, 0.08, 2, null, 0.9);
    }
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

  explosion(pos, size = 1) {
    const v = this._e;
    const k = this.density;
    for (let i = 0; i < 14 * size * k; i++) {
      v.set(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).multiplyScalar(60 * size);
      this.fire.spawn(pos, (8 + Math.random() * 10) * size, 0.6 + Math.random() * 0.6, 1.6, v, 1);
    }
    for (let i = 0; i < 18 * size * k; i++) {
      v.set(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).multiplyScalar(30 * size);
      this.smoke.spawn(pos, (10 + Math.random() * 12) * size, 3 + Math.random() * 3, 0.5, v, 0.75);
    }
  }

  spark(pos) {
    this.fire.spawn(pos, 4 + Math.random() * 3, 0.15, 3, null, 1);
  }

  /** Damaged aircraft trail smoke. */
  damageSmoke(pos, amount) {
    if (Math.random() < amount) this.smoke.spawn(pos, 3 + amount * 4, 1.8, 1.2, null, 0.35 + amount * 0.3);
  }

  update(dt) {
    this.fire.update(dt);
    this.smoke.update(dt);
  }

  /** Upload the live fire and smoke for this frame; call right before rendering. */
  draw(camera) {
    this.fire.draw(camera);
    this.smoke.draw(camera);
  }
}
