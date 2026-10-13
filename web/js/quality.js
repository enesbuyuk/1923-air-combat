// Adaptive quality: watches the frame time and, when the device cannot keep up, first
// renders at a lower resolution (pixel ratio) and then switches to cheaper effects; when
// there is headroom again it climbs back. A manual tier (settings.js "Graphics") fixes
// the level instead.
//
// The frame time is smoothed (EMA) with hitches left out, the thresholds for going down
// and up are apart (hysteresis), every change is followed by a pause to let the new level
// settle, and a step up that has to be undone soon after makes the next attempt wait
// longer, so the level does not oscillate.

/** What each tier costs. `shadowSize` 0 turns shadows off; the shares scale effect density. */
export const TIERS = [
  { name: 'Low', shadowSize: 0, bloom: false, samples: 2, clouds: 0.5, effects: 0.5, vortexRange: 1500 },
  { name: 'Medium', shadowSize: 1024, bloom: true, samples: 4, clouds: 0.75, effects: 0.75, vortexRange: 2500 },
  { name: 'High', shadowSize: 2048, bloom: true, samples: 4, clouds: 1, effects: 1, vortexRange: 4000 },
];
/** Graphics setting value for adaptive quality. */
export const AUTO = -1;

/** Lowest pixel ratio dynamic resolution goes to, and the factor per step. */
const MIN_PIXEL_RATIO = 0.6;
const RATIO_STEP = 0.85;
/** Smoothed frame time (ms) above which quality goes down, and below which it may go up. */
const SLOW_MS = 1000 / 50;
const FAST_MS = 1000 / 58;
/** Smoothing of the frame time per frame. */
const EMA = 0.05;
/** Frames (or seconds, on a very slow device) averaged after settling before the average is trusted. */
const MIN_SAMPLES = 40;
const MIN_WATCH = 2;
/**
 * A frame this many times the average is a hitch, not a trend, unless HITCH_RUN of them
 * come in a row (the load really went up). Frame times are counted up to HITCH_MS.
 */
const HITCH = 2.5;
const HITCH_RUN = 8;
const HITCH_MS = 250;
/** Seconds to wait after a change (or a pause) before judging the frame time again. */
const SETTLE = 1;
/** Seconds between steps down, and the initial / longest wait before a step up. */
const DOWN_COOLDOWN = 1.5;
const UP_COOLDOWN = 5;
const UP_COOLDOWN_MAX = 60;
/** A step down this soon (s) after a step up means the step up failed. */
const FAILED_UP = 8;

/** Device pixel ratio cap: more than 2 costs a lot of fill rate for little visible gain. */
function ratioCap() {
  return Math.min(globalThis.devicePixelRatio || 1, 2);
}

/** Fixed pixel ratio of a manual tier. */
function manualRatio(tier, cap) {
  if (tier === 2) return cap;
  if (tier === 1) return Math.max(Math.min(cap, 1), cap * 0.75);
  return Math.max(MIN_PIXEL_RATIO, cap * 0.5);
}

/**
 * The adaptive ladder, best first: a little resolution goes first, then the effects tier,
 * then more resolution down to MIN_PIXEL_RATIO.
 */
function ladder(cap) {
  const levels = [];
  let ratio = cap;
  levels.push({ tier: 2, ratio });
  ratio *= RATIO_STEP;
  levels.push({ tier: 2, ratio });
  levels.push({ tier: 1, ratio });
  ratio *= RATIO_STEP;
  levels.push({ tier: 1, ratio });
  levels.push({ tier: 0, ratio });
  while (ratio * RATIO_STEP >= MIN_PIXEL_RATIO) {
    ratio *= RATIO_STEP;
    levels.push({ tier: 0, ratio });
  }
  if (ratio > MIN_PIXEL_RATIO) levels.push({ tier: 0, ratio: MIN_PIXEL_RATIO });
  return levels;
}

export class Quality {
  /**
   * @param {(level: {tier: number, ratio: number, settings: object}) => void} apply
   *   called whenever the tier or the pixel ratio changes (and once from setMode)
   */
  constructor(apply) {
    this.apply = apply;
    this.mode = null;
    this.cap = ratioCap();
    this.levels = ladder(this.cap);
    this.index = 0;
    this.applied = null;
    this.ema = 0;
    this.count = 0;
    this.watched = 0;
    this.hitches = 0;
    this.settle = SETTLE;
    // Seconds until any change, and until a step up, is allowed.
    this.cooldown = 0;
    this.upWait = 0;
    this.upCooldown = UP_COOLDOWN;
    this.sinceUp = Infinity;
  }

  /** Current tier (index into TIERS) and pixel ratio. */
  get level() {
    if (this.mode === AUTO) return this.levels[this.index];
    return { tier: this.mode, ratio: manualRatio(this.mode, this.cap) };
  }

  /** AUTO, or a fixed tier index. Auto starts from the best level and only steps down when needed. */
  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.index = 0;
    this.upCooldown = UP_COOLDOWN;
    this.restart();
    this.push();
  }

  /** The device pixel ratio may have changed (window moved to another screen). */
  resize() {
    const cap = ratioCap();
    if (cap === this.cap) return;
    const tier = this.mode === null ? 2 : this.level.tier;
    this.cap = cap;
    this.levels = ladder(cap);
    // Keep the tier, at its best resolution on the new screen.
    this.index = Math.max(0, this.levels.findIndex((l) => l.tier === tier));
    // Before setMode() (still loading) nothing has been applied yet.
    if (this.mode === null) return;
    this.restart();
    this.push();
  }

  /** Ignore the frame time for a while (tab hidden, pause, loading): it says nothing about load. */
  restart() {
    this.ema = 0;
    this.count = 0;
    this.watched = 0;
    this.hitches = 0;
    this.settle = SETTLE;
  }

  /**
   * Feed one frame. `ms` is the real time since the last frame; `active` false (menu,
   * pause) keeps watching without changing anything.
   */
  sample(ms, active) {
    if (this.mode !== AUTO) return;
    const dt = Math.min(ms, HITCH_MS) / 1000;
    this.cooldown -= dt;
    this.upWait -= dt;
    this.sinceUp += dt;
    if (this.settle > 0) {
      this.settle -= dt;
      this.ema = 0;
      return;
    }
    this.watched += dt;
    if (this.ema > 0 && ms > this.ema * HITCH && ++this.hitches < HITCH_RUN) return;
    this.hitches = 0;
    const v = Math.min(ms, HITCH_MS);
    this.ema = this.ema > 0 ? this.ema + (v - this.ema) * EMA : v;
    // Judge only an average over enough frames.
    if ((++this.count < MIN_SAMPLES && this.watched < MIN_WATCH) || !active || this.cooldown > 0) return;
    if (this.ema > SLOW_MS && this.index < this.levels.length - 1) {
      if (this.sinceUp < FAILED_UP) this.upCooldown = Math.min(UP_COOLDOWN_MAX, this.upCooldown * 2);
      this.index++;
      this.cooldown = DOWN_COOLDOWN;
      this.upWait = this.upCooldown;
      this.restart();
      this.push();
    } else if (this.ema < FAST_MS && this.index > 0 && this.upWait <= 0) {
      this.index--;
      this.sinceUp = 0;
      this.cooldown = DOWN_COOLDOWN;
      this.upWait = this.upCooldown;
      this.restart();
      this.push();
    }
  }

  push() {
    const { tier, ratio } = this.level;
    const last = this.applied;
    if (last && last.tier === tier && last.ratio === ratio) return;
    this.applied = { tier, ratio };
    this.apply({ tier, ratio, settings: TIERS[tier] });
  }
}
