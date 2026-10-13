// What the listener hears of the other aircraft: the nearest ones' engines with their
// Doppler shift and stereo position, and the sonic boom of a supersonic one passing by.
//
// The boom of a supersonic aircraft trails it as a cone (the Mach cone); a listener hears
// it when the cone sweeps over them, roughly when the aircraft has just passed its closest
// point. So a boom is played when a supersonic bot within range goes from approaching to
// receding.

import * as THREE from 'three';
import { BOT } from './layout.js';
import { B2 } from './aircraft.js';

/** Engines heard out to this distance (m). */
const HEAR_RANGE = 2500;
/** A supersonic pass this close (m) booms. */
const BOOM_RANGE = 3000;
const SOUND_SPEED = 340;

const rel = new THREE.Vector3();
const vel = new THREE.Vector3();
const right = new THREE.Vector3();
const byDistance = (a, b) => a.dist - b.dist;

export class Flyby {
  constructor() {
    // Per bot slot: was it approaching last frame.
    this.closingBefore = [];
    this.list = [];
    this.pool = [];
  }

  /**
   * @param {Float32Array} buf bot buffer, `prev` the one a step earlier (for velocity)
   * @param {THREE.Camera} camera listener (position and orientation for panning)
   * @param {number[]} listenerVel the player's velocity: the listener moves with them
   */
  update(buf, prev, count, step, camera, listenerVel, sound, inside) {
    const list = this.list;
    let heard = 0;
    right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    for (let i = 0; i < count; i++) {
      const o = i * BOT.STRIDE;
      if (buf[o + BOT.ALIVE] <= 0 || !prev) {
        this.closingBefore[i] = false;
        continue;
      }
      rel.fromArray(buf, o + BOT.POS).sub(camera.position);
      const dist = rel.length();
      if (dist > Math.max(HEAR_RANGE, BOOM_RANGE)) {
        this.closingBefore[i] = false;
        continue;
      }
      vel.set(
        (buf[o + BOT.POS] - prev[o + BOT.POS]) / step - listenerVel[0],
        (buf[o + BOT.POS + 1] - prev[o + BOT.POS + 1]) / step - listenerVel[1],
        (buf[o + BOT.POS + 2] - prev[o + BOT.POS + 2]) / step - listenerVel[2],
      );
      const closing = -rel.dot(vel) / Math.max(dist, 1);
      if (this.closingBefore[i] && closing < 0 && dist < BOOM_RANGE && buf[o + BOT.SPEED] > SOUND_SPEED) {
        sound.boom(dist, inside);
      }
      this.closingBefore[i] = closing > 0;
      if (dist < HEAR_RANGE) {
        // Entries are reused from frame to frame.
        const a = (this.pool[heard] ??= { dist: 0, closing: 0, pan: 0, power: 0, deep: false });
        a.dist = dist;
        a.closing = closing;
        a.pan = THREE.MathUtils.clamp(rel.dot(right) / Math.max(dist, 1), -1, 1) * 0.8;
        a.power = THREE.MathUtils.clamp(buf[o + BOT.ENGINE], 0, 1);
        a.deep = (buf[o + BOT.TYPE] | 0) === B2;
        list[heard++] = a;
      }
    }
    list.length = heard;
    list.sort(byDistance);
    sound.flyby(list, inside);
  }
}
