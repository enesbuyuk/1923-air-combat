// Thin wrapper around the WASM simulation core: loading, input, stepping and decoding
// the output buffers (see layout.js) into named fields.

import { PLAYER, BOT, BULLET, MISSILE, FLARE, GROUND, EVENT, STATS, MAX_EVENTS } from './layout.js';

const WASM_URL = '1923_air.wasm';

/** Ground clearance of the aircraft origin while on its wheels (GEAR_HEIGHT in the core). */
export const GEAR_HEIGHT = 2.2;
/** Centre of the main runway, the "base" shown on radar. */
export const BASE = { x: -40, z: 27.5 };

async function loadWasm() {
  try {
    return (await WebAssembly.instantiateStreaming(fetch(WASM_URL), {})).instance.exports;
  } catch {
    // Servers without the application/wasm MIME type need the slower path.
    const bytes = await (await fetch(WASM_URL)).arrayBuffer();
    return (await WebAssembly.instantiate(bytes, {})).instance.exports;
  }
}

export class Sim {
  static async load() {
    return new Sim(await loadWasm());
  }

  constructor(wasm) {
    this.wasm = wasm;
    this.maxBots = wasm.max_bots();
    this.maxBullets = wasm.max_bullets();
    this.maxMissiles = wasm.max_missiles();
    this.maxFlares = wasm.max_flares();
    this.maxGround = wasm.max_ground();
  }

  /** New game; density and difficulty reset in the core, so re-apply them afterwards. */
  init(aircraftType) {
    this.wasm.init(aircraftType, (Math.random() * 0xffffffff) >>> 0);
  }

  setInput({ pitch, roll, yaw, throttle, gun, missile, brake, flare }) {
    this.wasm.set_input(pitch, roll, yaw, throttle, gun ? 1 : 0, missile ? 1 : 0, brake ? 1 : 0, flare ? 1 : 0);
  }

  step(dt) {
    this.wasm.step(dt);
  }

  setEnemyDensity(value) {
    this.wasm.set_enemy_density(value);
  }

  setDifficulty(level) {
    this.wasm.set_difficulty(level);
  }

  /** Game mode (layout.js MODE); restarts the mission objectives. */
  setMode(mode) {
    this.wasm.set_mode(mode);
  }

  /** Reports a building contact to the core; returns a BUILDING_HIT code. */
  buildingHit(x, y, z, hit) {
    return this.wasm.building_hit(x, y, z, hit.nx, hit.nz, hit.depth);
  }

  // Views are created per call: memory.buffer is replaced when WASM memory grows.
  view(ptr, length) {
    return new Float32Array(this.wasm.memory.buffer, ptr, length);
  }

  bots() {
    return this.view(this.wasm.bots_ptr(), this.maxBots * BOT.STRIDE);
  }

  bullets() {
    return this.view(this.wasm.bullets_ptr(), this.maxBullets * BULLET.STRIDE);
  }

  missiles() {
    return this.view(this.wasm.missiles_ptr(), this.maxMissiles * MISSILE.STRIDE);
  }

  flares() {
    return this.view(this.wasm.flares_ptr(), this.maxFlares * FLARE.STRIDE);
  }

  ground() {
    return this.view(this.wasm.ground_ptr(), this.maxGround * GROUND.STRIDE);
  }

  player() {
    const p = this.view(this.wasm.player_ptr(), PLAYER.STRIDE);
    const q = PLAYER.QUAT;
    return {
      x: p[PLAYER.POS],
      y: p[PLAYER.POS + 1],
      z: p[PLAYER.POS + 2],
      quat: [p[q], p[q + 1], p[q + 2], p[q + 3]],
      speed: p[PLAYER.SPEED],
      throttle: p[PLAYER.THROTTLE],
      engine: p[PLAYER.ENGINE],
      hp: p[PLAYER.HP],
      maxHp: p[PLAYER.MAX_HP],
      alive: p[PLAYER.ALIVE] > 0,
      onGround: p[PLAYER.ON_GROUND] > 0,
      ammo: p[PLAYER.AMMO],
      missiles: p[PLAYER.MISSILES],
      verticalSpeed: p[PLAYER.VERTICAL_SPEED],
      gLoad: p[PLAYER.G_LOAD],
      type: p[PLAYER.TYPE] | 0,
      stall: p[PLAYER.STALL] > 0,
      respawn: p[PLAYER.RESPAWN],
      stallSpeed: p[PLAYER.STALL_SPEED],
      rotateSpeed: p[PLAYER.ROTATE_SPEED],
      outOfBounds: p[PLAYER.OUT_OF_BOUNDS] > 0,
      maxSpeed: p[PLAYER.MAX_SPEED],
      alpha: p[PLAYER.ALPHA],
      beta: p[PLAYER.BETA],
      mach: p[PLAYER.MACH],
      wind: [p[PLAYER.WIND], p[PLAYER.WIND + 1], p[PLAYER.WIND + 2]],
      vel: [p[PLAYER.VEL], p[PLAYER.VEL + 1], p[PLAYER.VEL + 2]],
      fuel: p[PLAYER.FUEL],
      flares: p[PLAYER.FLARES],
      maxFlares: p[PLAYER.MAX_FLARES],
      maxMissiles: p[PLAYER.MAX_MISSILES],
      engineHealth: p[PLAYER.ENGINE_HEALTH],
      controlHealth: p[PLAYER.CONTROL_HEALTH],
      fuelLeak: p[PLAYER.FUEL_LEAK],
      service: p[PLAYER.SERVICE],
    };
  }

  stats() {
    const s = this.view(this.wasm.stats_ptr(), STATS.LEN);
    return {
      score: s[STATS.SCORE],
      kills: s[STATS.KILLS],
      wave: s[STATS.WAVE],
      botsAlive: s[STATS.BOTS_ALIVE],
      lockTarget: s[STATS.LOCK_TARGET],
      lockProgress: s[STATS.LOCK_PROGRESS],
      eventCount: s[STATS.EVENT_COUNT] | 0,
      waveTimer: s[STATS.WAVE_TIMER],
      deaths: s[STATS.DEATHS],
      time: s[STATS.TIME],
      rwrLock: s[STATS.RWR_LOCK],
      missileWarn: s[STATS.MISSILE_WARN] | 0,
      missileDist: s[STATS.MISSILE_DIST],
      missileBearing: s[STATS.MISSILE_BEARING],
      mode: s[STATS.MODE] | 0,
      stage: s[STATS.STAGE] | 0,
      objectivesLeft: s[STATS.OBJECTIVES_LEFT] | 0,
      escortHp: s[STATS.ESCORT_HP],
      missionTimer: s[STATS.MISSION_TIMER],
    };
  }

  /** Events of the last step (the core clears them on every step). */
  events() {
    const count = this.stats().eventCount;
    const e = this.view(this.wasm.events_ptr(), MAX_EVENTS * EVENT.STRIDE);
    const out = [];
    for (let i = 0; i < count; i++) {
      const o = i * EVENT.STRIDE;
      out.push({
        type: e[o + EVENT.TYPE],
        x: e[o + EVENT.POS],
        y: e[o + EVENT.POS + 1],
        z: e[o + EVENT.POS + 2],
        extra: e[o + EVENT.EXTRA],
      });
    }
    return out;
  }
}
