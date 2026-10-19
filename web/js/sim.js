// Thin wrapper around the WASM simulation core: loading, input, stepping and decoding
// the output buffers (see layout.js) into named fields.
//
// Nothing here allocates per call once warmed up: the typed-array views over WASM memory
// are cached and only rebuilt when memory grows (memory.buffer is then a new object) or a
// buffer moves, and the decoded player / stats / event records are reused objects that the
// next call overwrites. Callers that need a value to outlive the next call copy it.

import { PLAYER, BOT, BULLET, MISSILE, FLARE, GROUND, EVENT, STATS, MAX_EVENTS, REMOTE } from './layout.js';

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

/** An empty decoded player record, for `Sim.player(out)` / `decodePlayer`. */
export function createPlayerState() {
  return {
    x: 0, y: 0, z: 0, quat: [0, 0, 0, 1], speed: 0, throttle: 0, engine: 0, hp: 0, maxHp: 1,
    alive: false, onGround: false, ammo: 0, missiles: 0, verticalSpeed: 0, gLoad: 1, type: 0,
    stall: false, respawn: 0, stallSpeed: 0, rotateSpeed: 0, outOfBounds: false, maxSpeed: 0,
    alpha: 0, beta: 0, mach: 0, wind: [0, 0, 0], vel: [0, 0, 0], fuel: 0, flares: 0, maxFlares: 0,
    maxMissiles: 0, engineHealth: 1, controlHealth: 1, fuelLeak: 0, service: 0, inHangar: false,
    overspeed: false, lostIn: -1,
    gear: 1, gearHealth: 1, flaps: 0, flapHealth: 1, agl: 0, surface: 0, gearCommand: true, flapCommand: 0,
    eas: 0, gearLimit: 155, flapLimit: 140,
  };
}

/**
 * Decode a raw player record (PLAYER.STRIDE floats: the live WASM view or a stored copy)
 * into `out`, in place. The quat / wind / vel arrays of `out` are reused.
 */
export function decodePlayer(p, out) {
  const q = PLAYER.QUAT;
  out.x = p[PLAYER.POS];
  out.y = p[PLAYER.POS + 1];
  out.z = p[PLAYER.POS + 2];
  out.quat[0] = p[q];
  out.quat[1] = p[q + 1];
  out.quat[2] = p[q + 2];
  out.quat[3] = p[q + 3];
  out.speed = p[PLAYER.SPEED];
  out.throttle = p[PLAYER.THROTTLE];
  out.engine = p[PLAYER.ENGINE];
  out.hp = p[PLAYER.HP];
  out.maxHp = p[PLAYER.MAX_HP];
  out.alive = p[PLAYER.ALIVE] > 0;
  out.onGround = p[PLAYER.ON_GROUND] > 0;
  out.ammo = p[PLAYER.AMMO];
  out.missiles = p[PLAYER.MISSILES];
  out.verticalSpeed = p[PLAYER.VERTICAL_SPEED];
  out.gLoad = p[PLAYER.G_LOAD];
  out.type = p[PLAYER.TYPE] | 0;
  out.stall = p[PLAYER.STALL] > 0;
  out.respawn = p[PLAYER.RESPAWN];
  out.stallSpeed = p[PLAYER.STALL_SPEED];
  out.rotateSpeed = p[PLAYER.ROTATE_SPEED];
  out.outOfBounds = p[PLAYER.OUT_OF_BOUNDS] > 0;
  out.maxSpeed = p[PLAYER.MAX_SPEED];
  out.alpha = p[PLAYER.ALPHA];
  out.beta = p[PLAYER.BETA];
  out.mach = p[PLAYER.MACH];
  out.wind[0] = p[PLAYER.WIND];
  out.wind[1] = p[PLAYER.WIND + 1];
  out.wind[2] = p[PLAYER.WIND + 2];
  out.vel[0] = p[PLAYER.VEL];
  out.vel[1] = p[PLAYER.VEL + 1];
  out.vel[2] = p[PLAYER.VEL + 2];
  out.fuel = p[PLAYER.FUEL];
  out.flares = p[PLAYER.FLARES];
  out.maxFlares = p[PLAYER.MAX_FLARES];
  out.maxMissiles = p[PLAYER.MAX_MISSILES];
  out.engineHealth = p[PLAYER.ENGINE_HEALTH];
  out.controlHealth = p[PLAYER.CONTROL_HEALTH];
  out.fuelLeak = p[PLAYER.FUEL_LEAK];
  out.service = p[PLAYER.SERVICE];
  out.inHangar = p[PLAYER.IN_HANGAR] > 0.5;
  out.overspeed = p[PLAYER.OVERSPEED] > 0;
  out.lostIn = p[PLAYER.LOST_IN];
  out.gear = p[PLAYER.GEAR];
  out.gearHealth = p[PLAYER.GEAR_HEALTH];
  out.flaps = p[PLAYER.FLAPS];
  out.flapHealth = p[PLAYER.FLAP_HEALTH];
  out.agl = p[PLAYER.AGL];
  out.surface = p[PLAYER.SURFACE];
  out.gearCommand = p[PLAYER.GEAR_COMMAND] > 0;
  out.flapCommand = p[PLAYER.FLAP_COMMAND];
  out.eas = p[PLAYER.EAS];
  out.gearLimit = p[PLAYER.GEAR_LIMIT];
  out.flapLimit = p[PLAYER.FLAP_LIMIT];
  return out;
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
    // Cached views over WASM memory, see view().
    this._player = null;
    this._bots = null;
    this._bullets = null;
    this._missiles = null;
    this._flares = null;
    this._ground = null;
    this._events = null;
    this._stats = null;
    // Reused decoded records.
    this._playerState = createPlayerState();
    this._statsState = {
      score: 0, kills: 0, wave: 0, botsAlive: 0, lockTarget: -1, lockProgress: 0, eventCount: 0,
      waveTimer: 0, deaths: 0, time: 0, rwrLock: 0, missileWarn: 0, missileDist: 0, missileBearing: 0,
      mode: 0, stage: 0, objectivesLeft: 0, escortHp: -1, missionTimer: 0,
    };
    this._event = { type: 0, x: 0, y: 0, z: 0, extra: 0 };
  }

  /**
   * New game; density and difficulty reset in the core, so re-apply them afterwards. Online
   * rooms pass their `seed` so every pilot flies in the same weather.
   */
  init(aircraftType, seed = (Math.random() * 0xffffffff) >>> 0) {
    this.wasm.init(aircraftType, seed);
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

  toggleGear() { return this.wasm.toggle_gear() > 0; }
  cycleFlaps() { this.wasm.cycle_flaps(); }
  terrainHeight(x, z) { return this.wasm.terrain_height(x, z); }
  terrainSurface(x, z) { return this.wasm.terrain_surface(x, z); }
  clearDynamicObstacles() { this.wasm.clear_obstacles(1); }
  addObstacle(f, dynamic = false) {
    const count = f.xz.length / 2;
    if (count < 3 || count > 512) return;
    const buf = this._obstacleImport = this.view(this._obstacleImport, this.wasm.obstacle_buffer_ptr(), 1027);
    buf[0] = count; buf[1] = f.bottom ?? 0; buf[2] = f.top;
    buf.set(f.xz, 3);
    this.wasm.add_obstacle(dynamic ? 1 : 0);
  }

  /** Metres down the runway the player spawns (online pilots each get their own spot). */
  setSpawnOffset(metres) { this.wasm.set_spawn_offset(metres); }

  // Other pilots of an online room live in bot slots the AI leaves alone (game/remote.rs).

  /** Pose bot slot `slot` as another pilot from `rec` (REMOTE.LEN floats); `live` false hides it. */
  setRemote(slot, rec, live = true) {
    const buf = this._remoteImport = this.view(this._remoteImport, this.wasm.remote_buffer_ptr(), REMOTE.LEN);
    buf.set(rec);
    this.wasm.set_remote(slot, live ? 1 : 0);
  }
  clearRemote(slot) { this.wasm.clear_remote(slot); }
  /** Cannon damage dealt to the pilot in `slot` since the last call. */
  takeRemoteDamage(slot) { return this.wasm.take_remote_damage(slot); }
  /** Damage another pilot reports having dealt to the player. */
  remoteHit(damage) { this.wasm.remote_hit(damage); }
  /** Another pilot's missile; `target` -2 the player, a bot slot, or -1. */
  remoteMissile(d, target) { this.wasm.remote_missile(d[0], d[1], d[2], d[3], d[4], d[5], target); }
  remoteFlare(slot) { this.wasm.remote_flare(slot); }

  /** Game mode (layout.js MODE); restarts the mission objectives. */
  setMode(mode) {
    this.wasm.set_mode(mode);
  }

  /** Reports a building contact to the core; returns a BUILDING_HIT code. */
  buildingHit(x, y, z, hit) {
    return this.wasm.building_hit(x, y, z, hit.nx, hit.nz, hit.depth);
  }

  /**
   * `cached` if it still covers (ptr, length) of the current memory, else a new view.
   * memory.buffer is replaced (and the old one detached) when WASM memory grows, and a
   * new game may move a buffer, so both are checked; neither check allocates.
   */
  view(cached, ptr, length) {
    const buffer = this.wasm.memory.buffer;
    if (cached && cached.buffer === buffer && cached.byteOffset === ptr && cached.length === length) return cached;
    return new Float32Array(buffer, ptr, length);
  }

  // The returned views are live: they change on the next step. Copy (`.set`) to keep a snapshot.

  bots() {
    return (this._bots = this.view(this._bots, this.wasm.bots_ptr(), this.maxBots * BOT.STRIDE));
  }

  bullets() {
    return (this._bullets = this.view(this._bullets, this.wasm.bullets_ptr(), this.maxBullets * BULLET.STRIDE));
  }

  missiles() {
    return (this._missiles = this.view(this._missiles, this.wasm.missiles_ptr(), this.maxMissiles * MISSILE.STRIDE));
  }

  flares() {
    return (this._flares = this.view(this._flares, this.wasm.flares_ptr(), this.maxFlares * FLARE.STRIDE));
  }

  ground() {
    return (this._ground = this.view(this._ground, this.wasm.ground_ptr(), this.maxGround * GROUND.STRIDE));
  }

  /** The raw player record (PLAYER.STRIDE floats), live. */
  playerRaw() {
    return (this._player = this.view(this._player, this.wasm.player_ptr(), PLAYER.STRIDE));
  }

  /**
   * Decoded player state. Without `out` the same shared object is returned (and
   * overwritten) on every call; pass your own (createPlayerState()) to keep a copy.
   */
  player(out = this._playerState) {
    return decodePlayer(this.playerRaw(), out);
  }

  /** Decoded statistics; a shared object overwritten on every call. */
  stats() {
    const s = (this._stats = this.view(this._stats, this.wasm.stats_ptr(), STATS.LEN));
    const o = this._statsState;
    o.score = s[STATS.SCORE];
    o.kills = s[STATS.KILLS];
    o.wave = s[STATS.WAVE];
    o.botsAlive = s[STATS.BOTS_ALIVE];
    o.lockTarget = s[STATS.LOCK_TARGET];
    o.lockProgress = s[STATS.LOCK_PROGRESS];
    o.eventCount = s[STATS.EVENT_COUNT] | 0;
    o.waveTimer = s[STATS.WAVE_TIMER];
    o.deaths = s[STATS.DEATHS];
    o.time = s[STATS.TIME];
    o.rwrLock = s[STATS.RWR_LOCK];
    o.missileWarn = s[STATS.MISSILE_WARN] | 0;
    o.missileDist = s[STATS.MISSILE_DIST];
    o.missileBearing = s[STATS.MISSILE_BEARING];
    o.mode = s[STATS.MODE] | 0;
    o.stage = s[STATS.STAGE] | 0;
    o.objectivesLeft = s[STATS.OBJECTIVES_LEFT] | 0;
    o.escortHp = s[STATS.ESCORT_HP];
    o.missionTimer = s[STATS.MISSION_TIMER];
    return o;
  }

  /** Simulation time (s), without decoding the rest of the statistics. */
  time() {
    this._stats = this.view(this._stats, this.wasm.stats_ptr(), STATS.LEN);
    return this._stats[STATS.TIME];
  }

  /**
   * Call `fn(event)` for each event of the last step (the core clears them on every
   * step). The event object is reused between calls: read it, don't keep it.
   */
  forEachEvent(fn) {
    this._stats = this.view(this._stats, this.wasm.stats_ptr(), STATS.LEN);
    const count = Math.min(MAX_EVENTS, this._stats[STATS.EVENT_COUNT] | 0);
    if (count === 0) return;
    const e = (this._events = this.view(this._events, this.wasm.events_ptr(), MAX_EVENTS * EVENT.STRIDE));
    const ev = this._event;
    for (let i = 0; i < count; i++) {
      const o = i * EVENT.STRIDE;
      ev.type = e[o + EVENT.TYPE];
      ev.x = e[o + EVENT.POS];
      ev.y = e[o + EVENT.POS + 1];
      ev.z = e[o + EVENT.POS + 2];
      ev.extra = e[o + EVENT.EXTRA];
      fn(ev);
    }
  }

  /** Events of the last step as new objects (allocates; the game loop uses forEachEvent). */
  events() {
    const out = [];
    this.forEachEvent((e) => out.push({ ...e }));
    return out;
  }
}
