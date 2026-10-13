// Sense of air: streaks of moisture and dust rushing past the camera, and the buffet
// level (gusts, low-level turbulence, high angle of attack, transonic) that drives the
// camera wobble and the wind sound.

import * as THREE from 'three';

const STREAKS = 140;
/** Streaks live in a sphere of this radius (m) around the camera. */
const RADIUS = 70;
/** No streak spawns closer than this (m) to the flight path, so none passes through the eye. */
const CLEAR = 4;
/** Streak length is the distance the air travels in this long (s), up to MAX_LENGTH m. */
const TRAIL_TIME = 0.03;
const MAX_LENGTH = 12;
/** Airspeeds (m/s) over which the streaks fade in. */
const FADE_IN = [40, 180];
/** Altitudes (m) over which the streaks thin out: the air up high is clean. */
const THIN_OUT = [600, 3000];
/** Bluish-grey haze, not pure white. */
const TINT = [0.82, 0.87, 0.94];

const rel = new THREE.Vector3();
const dir = new THREE.Vector3();
const side = new THREE.Vector3();
const lift = new THREE.Vector3();
const d = new THREE.Vector3();

export class Airflow {
  constructor(scene) {
    this.pos = new Float32Array(STREAKS * 3);
    this.seeded = false;
    const geo = new THREE.BufferGeometry();
    this.vertices = new Float32Array(STREAKS * 6);
    // Head alpha per streak (faded by distance each frame), tail transparent; alpha is
    // scaled by the material's opacity. Uneven strength keeps the field from looking uniform.
    this.colors = new Float32Array(STREAKS * 8);
    this.strength = new Float32Array(STREAKS);
    for (let i = 0; i < STREAKS; i++) {
      this.strength[i] = 0.15 + Math.random() ** 2 * 0.85;
      this.colors.set([...TINT, 0, ...TINT, 0], i * 8);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(this.vertices, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0, depthWrite: false,
    }));
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    scene.add(this.lines);

    this.smoothWind = new THREE.Vector3();
    // False until smoothWind has been seeded with the wind at the aircraft.
    this.calm = false;
    this.gust = 0;
    this.buffet = 0;
  }

  /** Place streak `i` somewhere ahead along the airflow `dir` (unit, pointing at the camera). */
  respawn(i, cam, anywhere) {
    // A point on a disc across the flow, then pushed upstream.
    side.set(dir.y, -dir.x, 0);
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize();
    lift.crossVectors(dir, side);
    const a = Math.random() * Math.PI * 2;
    const r = CLEAR + Math.sqrt(Math.random()) * (RADIUS * 0.6 - CLEAR);
    const along = anywhere ? (Math.random() * 2 - 1) * RADIUS : -RADIUS * (0.5 + Math.random() * 0.25);
    d.copy(side).multiplyScalar(Math.cos(a) * r).addScaledVector(lift, Math.sin(a) * r).addScaledVector(dir, along);
    this.pos[i * 3] = cam.x + d.x;
    this.pos[i * 3 + 1] = cam.y + d.y;
    this.pos[i * 3 + 2] = cam.z + d.z;
  }

  /**
   * @param {object} p decoded player state (Sim.player())
   * @param {THREE.Vector3} cam camera position
   * @param {boolean} active flying (not in the menu, paused or dead)
   * @returns {number} buffet 0..1
   */
  update(p, cam, active, dt) {
    if (!active || !p.alive) {
      this.lines.visible = false;
      this.buffet = this.gust = 0;
      this.seeded = this.calm = false;
      return 0;
    }

    // Gusts: how far the air at the aircraft departs from its recent average.
    const wx = p.wind[0];
    const wy = p.wind[1];
    const wz = p.wind[2];
    d.set(wx, wy, wz);
    if (!this.calm) {
      this.smoothWind.copy(d);
      this.calm = true;
    }
    this.smoothWind.lerp(d, Math.min(1, dt * 0.8));
    const gustNow = Math.min(1, d.distanceTo(this.smoothWind) / 2.5);
    this.gust += (gustNow - this.gust) * Math.min(1, dt * 4);

    const speed = p.onGround ? p.speed * 0.4 : p.speed;
    const fast = THREE.MathUtils.smoothstep(speed, 60, 380);
    const lowLevel = 1 - THREE.MathUtils.smoothstep(p.y, 80, 600);
    const highAlpha = p.onGround ? 0 : THREE.MathUtils.smoothstep(Math.abs(p.alpha), 0.2, 0.45);
    const transonic = Math.max(0, 1 - Math.abs(p.mach - 1) / 0.08);
    const target = Math.min(1,
      fast * (0.12 + lowLevel * 0.25 + this.gust * 0.5) + highAlpha * 0.8 + transonic * 0.35 + (p.stall ? 0.5 : 0));
    this.buffet += (target - this.buffet) * Math.min(1, dt * 5);

    // Air relative to the aircraft: the wind minus our own velocity.
    rel.set(wx - p.vel[0], wy - p.vel[1], wz - p.vel[2]);
    const airspeed = rel.length();
    const fade = THREE.MathUtils.smoothstep(airspeed, FADE_IN[0], FADE_IN[1]);
    this.lines.visible = fade > 0.01;
    if (!this.lines.visible) return this.buffet;
    dir.copy(rel).divideScalar(airspeed);

    if (!this.seeded) {
      for (let i = 0; i < STREAKS; i++) this.respawn(i, cam, true);
      this.seeded = true;
    }
    const len = Math.min(MAX_LENGTH, airspeed * TRAIL_TIME);
    const v = this.vertices;
    for (let i = 0; i < STREAKS; i++) {
      const o = i * 3;
      // Streaks are fixed in the air; the camera flies through them.
      this.pos[o] += wx * dt;
      this.pos[o + 1] += wy * dt;
      this.pos[o + 2] += wz * dt;
      d.set(this.pos[o] - cam.x, this.pos[o + 1] - cam.y, this.pos[o + 2] - cam.z);
      // Passed the camera, or left behind after a hard turn: bring it back upstream.
      if (d.dot(dir) > RADIUS * 0.3 || d.lengthSq() > RADIUS * RADIUS) {
        this.respawn(i, cam, false);
        d.set(this.pos[o] - cam.x, this.pos[o + 1] - cam.y, this.pos[o + 2] - cam.z);
      }
      // Fade in from the edge of the field and out right at the eye, so none pops.
      const dist = d.length();
      this.colors[i * 8 + 3] = this.strength[i]
        * (1 - THREE.MathUtils.smoothstep(dist, RADIUS * 0.45, RADIUS * 0.75))
        * THREE.MathUtils.smoothstep(dist, CLEAR, CLEAR * 3);
      v[i * 6] = this.pos[o];
      v[i * 6 + 1] = this.pos[o + 1];
      v[i * 6 + 2] = this.pos[o + 2];
      v[i * 6 + 3] = this.pos[o] - dir.x * len;
      v[i * 6 + 4] = this.pos[o + 1] - dir.y * len;
      v[i * 6 + 5] = this.pos[o + 2] - dir.z * len;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
    // Faint: a hint of moisture and dust, stronger down low and in gusty air.
    const thin = 1 - THREE.MathUtils.smoothstep(p.y, THIN_OUT[0], THIN_OUT[1]) * 0.7;
    this.lines.material.opacity = fade * thin * (0.1 + lowLevel * 0.12 + this.gust * 0.1);
    return this.buffet;
  }
}
