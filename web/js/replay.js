// Kill cam: a ring buffer of the last seconds of simulation state, replayed in slow
// motion after the player is shot down and the crash has been seen live.

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
    this.frames = [];
    this.head = 0;
    this.active = false;
  }

  clear() {
    this.frames = [];
    this.head = 0;
    this.active = false;
  }

  /**
   * Store one step. `player` is the decoded player state; the buffers are copied.
   * @param {number} t simulation time (s)
   */
  record(t, player, bots, missiles) {
    const frame = {
      t,
      player: { ...player, quat: [...player.quat] },
      bots: Float32Array.from(bots),
      missiles: Float32Array.from(missiles),
    };
    if (this.frames.length < this.capacity) this.frames.push(frame);
    else this.frames[this.head] = frame;
    this.head = (this.head + 1) % this.capacity;
  }

  /** Begin replaying around the death at simulation time `deathTime`, at `pos`. */
  start(deathTime, pos) {
    if (this.frames.length < 2) return;
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
   * `boom` once when playback reaches the moment of death.
   */
  advance(dt) {
    this.elapsed += dt;
    const t = this.deathTime - LEAD + this.elapsed * SPEED;
    // Newest frame at or before t (frames are in time order from the oldest slot).
    const n = this.frames.length;
    const oldest = n < this.capacity ? 0 : this.head;
    let best = this.frames[oldest];
    for (let k = 0; k < n; k++) {
      const f = this.frames[(oldest + k) % n];
      if (f.t > t) break;
      best = f;
    }
    let boom = false;
    if (!this.exploded && t >= this.deathTime) {
      this.exploded = true;
      boom = true;
    }
    return { frame: best, boom, dead: t >= this.deathTime };
  }
}
