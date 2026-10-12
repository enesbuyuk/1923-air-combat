// Camera rig: menu turntable, wreck orbit, cockpit view and smoothed chase view.

import * as THREE from 'three';

const pos = new THREE.Vector3();
const quat = new THREE.Quaternion();
const fwd = new THREE.Vector3();
const up = new THREE.Vector3();
const offset = new THREE.Vector3();
const jitter = new THREE.Euler();
const jitterQuat = new THREE.Quaternion();

/** Near plane outside / inside the cockpit; inside, the panel sits a few dm from the eye. */
const NEAR = 0.3;
const NEAR_COCKPIT = 0.04;

/** Smooth pseudo-random wobble in -1..1 (sum of incommensurate sines). */
function wobble(t, seed) {
  return (Math.sin(t * 7.3 + seed) * 0.5 + Math.sin(t * 13.1 + seed * 2.7) * 0.3 + Math.sin(t * 23.7 + seed * 5.1) * 0.2);
}

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.cockpit = false;
    this.orbitAngle = 0;
    this.chaseOffset = new THREE.Vector3();
    this.chaseZoom = 1;
    this.shake = 0;
    // Aerodynamic buffet 0..1, fed each frame by setAir().
    this.buffet = 0;
    this.time = 0;
  }

  /** Airflow feedback for the camera: `buffet` 0..1 shakes the view. */
  setAir(buffet) {
    this.buffet = buffet;
  }

  zoom(direction) {
    this.chaseZoom = THREE.MathUtils.clamp(this.chaseZoom * (direction > 0 ? 1.1 : 0.9), 0.5, 3);
  }

  addShake(amount, max = 1.2) {
    this.shake = Math.min(max, this.shake + amount);
  }

  /** Keep at least `amount` of shake (continuous sources such as the cannon). */
  holdShake(amount) {
    this.shake = Math.max(this.shake, amount);
  }

  /** In the menu, nudge the projection so the aircraft sits between the roster and spec panels. */
  setMenuFraming(inMenu) {
    const c = this.camera;
    if (inMenu && innerWidth > 1000) c.setViewOffset(innerWidth, innerHeight, -innerWidth * 0.02, innerHeight * 0.04, innerWidth, innerHeight);
    else if (inMenu) c.setViewOffset(innerWidth, innerHeight, 0, innerHeight * 0.22, innerWidth, innerHeight);
    else c.clearViewOffset();
  }

  /**
   * @param {object} p      decoded player state (Sim.player())
   * @param {object} def    aircraft definition (aircraft.js)
   * @param {boolean} inMenu
   */
  update(p, def, inMenu, dt) {
    pos.set(p.x, p.y, p.z);
    quat.set(...p.quat);
    fwd.set(0, 0, -1).applyQuaternion(quat);
    up.set(0, 1, 0).applyQuaternion(quat);

    // Debug hook: window.__1923.freeze = [dx, dy, dz] fixes the camera offset for model inspection.
    const freeze = window.__1923?.freeze;
    this.time += dt;
    const inside = !freeze && !inMenu && p.alive && this.cockpit;
    if (freeze) this.lookFrom(pos.x + freeze[0], pos.y + freeze[1], pos.z + freeze[2], pos);
    else if (inMenu) this.turntable(def, dt);
    else if (!p.alive) this.orbitWreck(dt);
    else if (this.cockpit) this.cockpitView(def);
    else this.chaseView(def, dt);
    if (!freeze && !inMenu && p.alive) {
      this.applyJitter(inside);
      this.shake = Math.max(0, this.shake - dt * 2);
    }
    const near = inside ? NEAR_COCKPIT : NEAR;
    if (this.camera.near !== near) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Hits, cannon and buffet as a small rotation of the view: moving the eye would push
   * it through the cockpit walls. Buffet is a smooth wobble, shake a random jolt.
   */
  applyJitter(inside) {
    const t = this.time;
    const b = this.buffet * (inside ? 0.006 : 0.004);
    const s = this.shake * (inside ? 0.012 : 0.006);
    jitter.set(
      wobble(t, 0) * b + (Math.random() - 0.5) * s,
      wobble(t, 11) * b * 0.6 + (Math.random() - 0.5) * s,
      wobble(t, 23) * b * 0.8,
    );
    this.camera.quaternion.multiply(jitterQuat.setFromEuler(jitter));
  }

  lookFrom(x, y, z, target) {
    this.camera.up.set(0, 1, 0);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(target);
  }

  turntable(def, dt) {
    this.orbitAngle += dt * 0.15;
    const r = def.length * 1.6 + 10;
    const a = this.orbitAngle;
    this.lookFrom(pos.x + Math.cos(a) * r, pos.y + def.length * 0.25 + 2, pos.z + Math.sin(a) * r, offset.set(pos.x, pos.y + 1, pos.z));
  }

  /**
   * Kill cam: a slowly circling side view of the replayed aircraft (`p`, decoded player
   * state from the replay); after the moment of death it frames the explosion at `wreck`.
   */
  killcamView(p, def, wreck, dt) {
    this.orbitAngle += dt * 0.25;
    const target = wreck ?? offset.set(p.x, p.y, p.z);
    const r = wreck ? 160 : def.length * 3 + 30;
    const a = this.orbitAngle;
    pos.copy(target);
    this.lookFrom(pos.x + Math.cos(a) * r, Math.max(pos.y + r * 0.3, 5), pos.z + Math.sin(a) * r, pos);
  }

  /** Circle the wreck while waiting for respawn. */
  orbitWreck(dt) {
    this.orbitAngle += dt * 0.3;
    const a = this.orbitAngle;
    const ground = Math.max(pos.y, 0);
    this.lookFrom(pos.x + Math.cos(a) * 120, ground + 60, pos.z + Math.sin(a) * 120, offset.set(pos.x, ground, pos.z));
  }

  /** The eye stays fixed in the airframe: any head travel pushes it through the cockpit meshes. */
  cockpitView(def) {
    const c = this.camera;
    offset.fromArray(def.eye);
    c.position.copy(pos).add(offset.applyQuaternion(quat));
    c.up.copy(up);
    c.quaternion.copy(quat);
  }

  chaseView(def, dt) {
    const c = this.camera;
    // Smooth only the offset direction, not the position: lerping the position
    // makes the camera fall tens of metres behind at combat speeds.
    const back = offset.set(0, def.length * 0.16 + 1.5, def.length * 0.75 + 4)
      .multiplyScalar(this.chaseZoom)
      .applyQuaternion(quat);
    const k = 1 - Math.exp(-dt * 6);
    if (this.chaseOffset.lengthSq() === 0) this.chaseOffset.copy(back);
    else this.chaseOffset.lerp(back, k);
    c.position.copy(pos).add(this.chaseOffset);
    c.up.lerp(up, k).normalize();
    c.lookAt(pos.addScaledVector(fwd, def.length));
  }
}
