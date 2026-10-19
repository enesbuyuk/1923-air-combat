// Representative pilot physiology, independent of the airframe's structural G limit.
// Protection/straining is implicit; individual tolerance varies. Calibration and sources:
// docs/simulator-review.tr.md, "G etkisi ve pilot fizyolojisi".
const POSITIVE_REFERENCE_MARGIN = 3; // G above the protected visual-stress threshold
const POSITIVE_REFERENCE_TIME = 15; // s to G-LOC at that margin, from fully rested
const RAPID_LOC_TIME = 9.1; // s: representative rapid-onset mean, not instant knockout
const BLACKOUT_DOSE = 0.8; // loss of vision precedes loss of consciousness in this model
const VISION_ONSET_DOSE = 0.2;
const ABSOLUTE_INCAPACITATION = 10.4; // s unconscious after unloading
const RELATIVE_INCAPACITATION = 12; // s disoriented after consciousness returns
const NEG_G_ONSET = -1; // facial congestion begins; severe redout around -2 to -3 G
const NEG_G_RANGE = 2.5;
const PUSH_PULL_PENALTY = 1.5; // G: temporary tolerance reduction after low/negative G

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export class GForce {
  constructor(overlay) {
    this.overlay = overlay;
    this.positive = 0; // +G visual impairment, 0 clear .. 1 black
    this.negative = 0; // -G stress; uses the same darkening overlay by visual preference
    this.dose = 0; // cumulative +G oxygen deficit, not the visible blackout level
    this.pushPull = 0;
    this.locRemaining = 0;
    this.recoveryRemaining = 0;
    this.unconscious = false;
    this.shownPositive = this.shownNegative = -1;
  }

  get stress() {
    return Math.max(this.positive, this.negative);
  }

  get incapacitated() {
    return this.unconscious || this.recoveryRemaining > 0;
  }

  reset() {
    this.positive = this.negative = this.dose = this.pushPull = 0;
    this.locRemaining = this.recoveryRemaining = 0;
    this.unconscious = false;
    if (this.shownPositive !== 0 || this.shownNegative !== 0) this.overlay.style.opacity = 0;
    this.shownPositive = this.shownNegative = 0;
  }

  /** Advance only with simulated time. `onset` is an effective protected stress threshold. */
  update(g, onset, alive, dt) {
    if (!alive) {
      this.reset();
      return;
    }
    if (!(dt > 0) || !Number.isFinite(dt) || !Number.isFinite(g)) return;

    // Low/negative G temporarily reduces subsequent +G tolerance (push-pull effect).
    const push = clamp01((1 - g) / 3);
    this.pushPull += (push - this.pushPull) * (1 - Math.exp(-dt / (push > this.pushPull ? 2 : 8)));
    const threshold = onset - PUSH_PULL_PENALTY * this.pushPull;
    const excess = Math.max(0, g - threshold);
    if (excess > 0) {
      const rate = Math.min(1 / RAPID_LOC_TIME, (excess / POSITIVE_REFERENCE_MARGIN) ** 1.5 / POSITIVE_REFERENCE_TIME);
      this.dose = Math.min(1, this.dose + rate * dt);
    } else {
      // Unloading restores perfusion; hovering just below the threshold recovers slowly.
      this.dose = Math.max(0, this.dose - dt / (g < threshold - 1 ? 6 : 18));
    }
    const redout = clamp01((NEG_G_ONSET - g) / NEG_G_RANGE);
    this.negative += (redout - this.negative) * (1 - Math.exp(-dt / (redout > this.negative ? 2 : 3)));

    if (this.unconscious) {
      // Continued high G cannot be cured by waiting for a countdown to expire.
      if (g < threshold - 1) this.locRemaining = Math.max(0, this.locRemaining - dt);
      if (this.locRemaining === 0 && this.dose < 0.35) {
        this.unconscious = false;
        this.recoveryRemaining = RELATIVE_INCAPACITATION;
      }
    } else if (this.dose >= 1 - 1e-9) {
      this.unconscious = true;
      this.locRemaining = ABSOLUTE_INCAPACITATION;
      this.recoveryRemaining = 0;
    } else {
      this.recoveryRemaining = Math.max(0, this.recoveryRemaining - dt);
    }
    const vision = clamp01((this.dose - VISION_ONSET_DOSE) / (BLACKOUT_DOSE - VISION_ONSET_DOSE));
    const recoveryVision = 0.8 * this.recoveryRemaining / RELATIVE_INCAPACITATION;
    this.positive = this.unconscious ? 1 : Math.max(vision, recoveryVision);
  }

  /** Draw once per frame; physiology itself advances with the fixed simulation steps. */
  render() {
    const a = this.stress;
    const n = this.negative;
    const style = this.overlay.style;
    if (Math.max(a, n) < 0.01) {
      // Style writes restyle the page even when nothing changes, so only write on change.
      if (this.shownPositive !== 0 || this.shownNegative !== 0) style.opacity = 0;
      this.shownPositive = this.shownNegative = 0;
      return;
    }
    // A steady level (or a change too small to see) needs no restyle.
    if (Math.abs(a - this.shownPositive) < 0.002 && Math.abs(n - this.shownNegative) < 0.002) return;
    this.shownPositive = a;
    this.shownNegative = n;
    // Peripheral vision closes toward the centre; the pilot's eyelids are not animated.
    const close = a * a * (3 - 2 * a); // smoothstep: slow start, fast at the end
    const ry = Math.max(0.1, 130 * (1 - close));
    const rx = Math.max(0.1, 150 * (1 - close));
    const dim = clamp01((a - 0.65) / 0.35);
    style.background = `radial-gradient(ellipse ${rx}% ${ry}% at 50% 50%, rgba(0,0,0,${dim}) 0%, rgba(0,0,0,${dim}) 40%, rgba(0,0,0,${a}) 100%)`;
    // Positive and negative G share the requested grey-out / blackout appearance.
    const filter = `grayscale(${Math.min(1, a * 1.5)}) brightness(${1 - a * 0.4}) blur(${a * 2}px)`;
    style.backdropFilter = filter;
    style.webkitBackdropFilter = filter;
    style.opacity = 1;
  }
}
