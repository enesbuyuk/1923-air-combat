// Camera rig: menu turntable, wreck orbit, cockpit view and smoothed chase view.

import * as THREE from 'three';

const pos = new THREE.Vector3();
const quat = new THREE.Quaternion();
const fwd = new THREE.Vector3();
const up = new THREE.Vector3();
const offset = new THREE.Vector3();
const jitter = new THREE.Euler();
const jitterQuat = new THREE.Quaternion();
const head = new THREE.Euler(0, 0, 0, 'YXZ');
const headQuat = new THREE.Quaternion();
const delta = new THREE.Quaternion();
const rate = new THREE.Vector3();

/** Near plane outside / inside the cockpit; inside, the panel sits a few dm from the eye. */
const NEAR = 0.3;
const NEAR_COCKPIT = 0.04;

/** Free look (middle mouse drag): radians per pixel, limits, and how fast it recentres. */
const LOOK_SPEED = 0.004;
const LOOK_YAW_MAX = 2.6;
const LOOK_PITCH_MIN = -0.7;
const LOOK_PITCH_MAX = 1.3;
const LOOK_RETURN = 4;
/**
 * The pilot's head is not bolted to the airframe: it lags the aircraft's rotation (seconds
 * of rate) and is pressed down in a pull (rad per G). Rotation only: moving the eye would
 * push it through the cockpit meshes.
 */
const HEAD_LAG = new THREE.Vector3(0.03, 0.04, 0.02);
const HEAD_LAG_MAX = 0.08;
const HEAD_G_PITCH = 0.004;

/** Smooth pseudo-random wobble in -1..1 (sum of incommensurate sines). */
function wobble(t, seed) {
  return (Math.sin(t * 7.3 + seed) * 0.5 + Math.sin(t * 13.1 + seed * 2.7) * 0.3 + Math.sin(t * 23.7 + seed * 5.1) * 0.2);
}

/** Head lag (rad) for a body rate `v` (rad/s) and lag time `k` (s). */
function lag(v, k) {
  return THREE.MathUtils.clamp(-v * k, -HEAD_LAG_MAX, HEAD_LAG_MAX);
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
    // Free look offset (rad) and whether the middle button is held.
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.looking = false;
    this.gLoad = 1;
    // Body-axis rotation rate (rad/s, filtered) for the head lag.
    this.rate = new THREE.Vector3();
    this.prevQuat = null;
    addEventListener('mousedown', (e) => {
      if (e.button !== 1) return;
      // Middle click would start the browser's autoscroll.
      e.preventDefault();
      this.looking = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 1) this.looking = false;
    });
    addEventListener('blur', () => { this.looking = false; });
    addEventListener('mousemove', (e) => {
      if (!this.looking) return;
      this.lookYaw = THREE.MathUtils.clamp(this.lookYaw - e.movementX * LOOK_SPEED, -LOOK_YAW_MAX, LOOK_YAW_MAX);
      this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - e.movementY * LOOK_SPEED, LOOK_PITCH_MIN, LOOK_PITCH_MAX);
    });
  }

  /** Airflow feedback for the camera: `buffet` 0..1 shakes the view, `gLoad` weighs on the head. */
  setAir(buffet, gLoad) {
    this.buffet = buffet;
    this.gLoad = gLoad;
  }

  /** Free look eases back to straight ahead once the button is released. */
  updateLook(dt) {
    if (this.looking) return;
    const k = 1 - Math.exp(-dt * LOOK_RETURN);
    this.lookYaw -= this.lookYaw * k;
    this.lookPitch -= this.lookPitch * k;
  }

  /** Filtered body-axis rotation rate from the change in attitude since the last frame. */
  updateRate(dt) {
    if (this.prevQuat && dt > 0) {
      delta.copy(this.prevQuat).invert().multiply(quat);
      if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
      rate.set(delta.x, delta.y, delta.z).multiplyScalar(2 / dt);
      this.rate.lerp(rate, 1 - Math.exp(-dt * 8));
    }
    this.prevQuat ??= new THREE.Quaternion();
    this.prevQuat.copy(quat);
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
    quat.fromArray(p.quat);
    fwd.set(0, 0, -1).applyQuaternion(quat);
    up.set(0, 1, 0).applyQuaternion(quat);

    // Debug hook: window.__1923.freeze = [dx, dy, dz] fixes the camera offset for model inspection.
    const freeze = window.__1923?.freeze;
    this.time += dt;
    const inside = !freeze && !inMenu && p.alive && this.cockpit;
    this.updateLook(dt);
    this.updateRate(dt);
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
    head.set(
      this.lookPitch + lag(this.rate.x, HEAD_LAG.x) - Math.min(0.04, Math.max(0, this.gLoad - 1) * HEAD_G_PITCH),
      this.lookYaw + lag(this.rate.y, HEAD_LAG.y),
      lag(this.rate.z, HEAD_LAG.z),
    );
    c.quaternion.copy(quat).multiply(headQuat.setFromEuler(head));
  }

  chaseView(def, dt) {
    const c = this.camera;
    // Smooth only the offset direction, not the position: lerping the position
    // makes the camera fall tens of metres behind at combat speeds.
    // Free look orbits the camera around the aircraft.
    head.set(-this.lookPitch * 0.8, this.lookYaw, 0);
    const back = offset.set(0, def.length * 0.16 + 1.5, def.length * 0.75 + 4)
      .multiplyScalar(this.chaseZoom)
      .applyEuler(head)
      .applyQuaternion(quat);
    const k = 1 - Math.exp(-dt * 6);
    if (this.chaseOffset.lengthSq() === 0) this.chaseOffset.copy(back);
    else this.chaseOffset.lerp(back, k);
    c.position.copy(pos).add(this.chaseOffset);
    c.up.lerp(up, k).normalize();
    // Ahead of the nose normally; at the aircraft itself while orbiting with free look.
    c.lookAt(pos.addScaledVector(fwd, def.length * Math.max(0, Math.cos(this.lookYaw)) ** 4));
  }
}
