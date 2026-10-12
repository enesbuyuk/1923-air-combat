// Visual effects: tracers, missiles with smoke trails, explosions, debris.

import * as THREE from 'three';
import { BULLET, MISSILE, FLARE, OWNER_PLAYER } from './layout.js';

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

/** Fixed-size pool of camera-facing sprites (fire, smoke). */
class SpritePool {
  constructor(scene, tex, size, additive) {
    this.items = [];
    for (let i = 0; i < size; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, fog: true,
      });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      s.userData = { life: 0, max: 1, grow: 1, vel: new THREE.Vector3(), base: 1 };
      scene.add(s);
      this.items.push(s);
    }
    this.next = 0;
  }
  spawn(pos, scale, life, grow, vel, opacity = 1) {
    const s = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    s.position.copy(pos);
    s.scale.setScalar(scale);
    s.visible = true;
    s.material.opacity = opacity;
    s.material.rotation = Math.random() * Math.PI * 2;
    Object.assign(s.userData, { life, max: life, grow, base: opacity });
    s.userData.vel.copy(vel || new THREE.Vector3());
    return s;
  }
  update(dt) {
    for (const s of this.items) {
      if (!s.visible) continue;
      const u = s.userData;
      u.life -= dt;
      if (u.life <= 0) { s.visible = false; continue; }
      s.position.addScaledVector(u.vel, dt);
      s.scale.multiplyScalar(1 + u.grow * dt);
      s.material.opacity = u.base * (u.life / u.max);
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
      this.smoke.spawn(this._p, 2.5, 2.2 + Math.random(), 1.4, null, 0.55);
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
    const v = new THREE.Vector3();
    for (let i = 0; i < 14 * size; i++) {
      v.set(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).multiplyScalar(60 * size);
      this.fire.spawn(pos, (8 + Math.random() * 10) * size, 0.6 + Math.random() * 0.6, 1.6, v, 1);
    }
    for (let i = 0; i < 18 * size; i++) {
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
}
