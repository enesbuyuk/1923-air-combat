// Camera rig: menu turntable, wreck orbit, cockpit view and smoothed chase view.

import * as THREE from 'three';

const pos = new THREE.Vector3();
const quat = new THREE.Quaternion();
const fwd = new THREE.Vector3();
const up = new THREE.Vector3();
const offset = new THREE.Vector3();

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.cockpit = false;
    this.orbitAngle = 0;
    this.chaseOffset = new THREE.Vector3();
    this.chaseZoom = 1;
    this.shake = 0;
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
    if (freeze) this.lookFrom(pos.x + freeze[0], pos.y + freeze[1], pos.z + freeze[2], pos);
    else if (inMenu) this.turntable(def, dt);
    else if (!p.alive) this.orbitWreck(dt);
    else if (this.cockpit) this.cockpitView(def);
    else this.chaseView(def, dt);
    if (!freeze && !inMenu && p.alive) this.shake = Math.max(0, this.shake - dt * 2);
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

  cockpitView(def) {
    const c = this.camera;
    c.position.copy(pos).add(offset.fromArray(def.eye).applyQuaternion(quat));
    c.quaternion.copy(quat);
    if (this.shake > 0) {
      c.position.x += (Math.random() - 0.5) * this.shake;
      c.position.y += (Math.random() - 0.5) * this.shake;
    }
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
