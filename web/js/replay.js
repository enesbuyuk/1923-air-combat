// Kill cam: a ring buffer of the last seconds of simulation state, replayed in slow
// motion after the player is shot down and the crash has been seen live.
//
// Every slot owns preallocated typed arrays that each step is copied into, so recording
// produces no garbage once the ring is full.

import { PLAYER } from './layout.js';
import { createPlayerState, decodePlayer } from './sim.js';

/** Seconds of history kept. */
const HISTORY = 6;
/** Replay starts this long before the moment of death... */
const LEAD = 3;
/** ...and runs at this share of real time. */
const SPEED = 0.8;
/** The crash is first shown live for this long (s); the replay follows. */
const DELAY = 2;

export class Replay {
  /** @param {number} stepsPerSecond fixed simulation rate (one snapshot per step) */
  constructor(stepsPerSecond) {
    this.capacity = Math.ceil(HISTORY * stepsPerSecond);
    /** Slot storage, grown up to `capacity` and then reused. */
    this.slots = [];
    /** Recorded slots in use (<= capacity). */
    this.length = 0;
    this.head = 0;
    this.active = false;
    this.deathPos = null;
    // What advance() hands out: the decoded player of the chosen slot and its buffers.
    this.frame = { t: 0, player: createPlayerState(), bots: null, missiles: null };
    this.result = { frame: this.frame, boom: false, dead: false };
  }

  clear() {
    this.length = 0;
    this.head = 0;
    this.active = false;
  }

  /**
   * Store one step. The raw player record and the buffers are copied into the slot.
   * @param {number} t simulation time (s)
   * @param {Float32Array} player raw player record (Sim.playerRaw())
   */
  record(t, player, bots, missiles) {
    let slot = this.slots[this.head];
    if (!slot || slot.bots.length !== bots.length || slot.missiles.length !== missiles.length) {
      slot = this.slots[this.head] = {
        t: 0,
        player: new Float32Array(PLAYER.STRIDE),
        bots: new Float32Array(bots.length),
        missiles: new Float32Array(missiles.length),
      };
    }
    slot.t = t;
    slot.player.set(player);
    slot.bots.set(bots);
    slot.missiles.set(missiles);
    if (this.length < this.capacity) this.length++;
    this.head = (this.head + 1) % this.capacity;
  }

  /** Begin replaying around the death at simulation time `deathTime`, at `pos` (kept). */
  start(deathTime, pos) {
    if (this.length < 2) return;
    this.active = true;
    this.deathTime = deathTime;
    this.deathPos = pos;
    this.elapsed = 0;
    this.exploded = false;
    this.delay = DELAY;
  }

  stop() {
    this.active = false;
  }

  /** Count down the live view of the crash before playback. */
  tick(dt) {
    this.delay -= dt;
  }

  /** The replay itself is on screen (past the live view of the crash). */
  get playing() {
    return this.active && this.delay <= 0;
  }

  /**
   * Advance the replay clock by real time `dt` and return the frame to show, plus
   * `boom` once when playback reaches the moment of death. The returned objects are
   * reused by the next call.
   */
  advance(dt) {
    this.elapsed += dt;
    const t = this.deathTime - LEAD + this.elapsed * SPEED;
    // Newest slot at or before t (slots are in time order from the oldest one).
    const n = this.length;
    const oldest = n < this.capacity ? 0 : this.head;
    let best = this.slots[oldest];
    for (let k = 0; k < n; k++) {
      const s = this.slots[(oldest + k) % n];
      if (s.t > t) break;
      best = s;
    }
    let boom = false;
    if (!this.exploded && t >= this.deathTime) {
      this.exploded = true;
      boom = true;
    }
    const f = this.frame;
    f.t = best.t;
    decodePlayer(best.player, f.player);
    f.bots = best.bots;
    f.missiles = best.missiles;
    this.result.boom = boom;
    this.result.dead = t >= this.deathTime;
    return this.result;
  }
}
