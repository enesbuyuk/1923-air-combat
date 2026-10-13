// G-force effects: sustained high +G or strong -G greys out the view, then the
// "eyelids" close until the screen is black and the pilot briefly passes out (G-LOC).

/** Just past the core's -5 G limiter, so a sustained push alone never knocks the pilot out. */
const NEG_G_ONSET = -5.5;
/** Vision level (0 clear .. 1 black) at which the pilot wakes up again after G-LOC. */
const WAKE_LEVEL = 0.6;

export class GForce {
  constructor(overlay) {
    this.overlay = overlay;
    this.positive = 0; // +G stress: 0 = clear vision, 1 = full blackout
    this.negative = 0; // -G stress, same scale
    this.unconscious = false;
    /** Stress level the overlay currently shows (0 hidden), -1 before the first render. */
    this.shown = -1;
  }

  get stress() {
    return Math.max(this.positive, this.negative);
  }

  reset() {
    this.positive = this.negative = 0;
    this.unconscious = false;
    if (this.shown !== 0) this.overlay.style.opacity = 0;
    this.shown = 0;
  }

  /** `g`: current load factor, `onset`: +G the crew tolerates indefinitely. */
  update(g, onset, alive, dt) {
    if (!alive) {
      this.positive = 0;
    } else if (g > onset) {
      // ~4 s to black out at 3 G over the limit, ~1.5 s when far over it.
      this.positive = Math.min(1, this.positive + (g - onset) * 0.08 * dt);
    } else {
      this.positive = Math.max(0, this.positive - (g < onset - 2 ? 0.6 : 0.35) * dt);
    }
    if (alive && g < NEG_G_ONSET) this.negative = Math.min(1, this.negative + (NEG_G_ONSET - g) * 0.15 * dt);
    else this.negative = alive ? Math.max(0, this.negative - 0.5 * dt) : 0;

    const a = this.stress;
    if (a >= 1) this.unconscious = true;
    else if (a < WAKE_LEVEL) this.unconscious = false;
    this.render(a);
  }

  render(a) {
    const style = this.overlay.style;
    if (a < 0.01) {
      // Style writes restyle the page even when nothing changes, so only write on change.
      if (this.shown !== 0) style.opacity = 0;
      this.shown = 0;
      return;
    }
    // A steady level (or a change too small to see) needs no restyle.
    if (Math.abs(a - this.shown) < 0.002) return;
    this.shown = a;
    // Eyes closing: a soft-edged elliptical opening that narrows into a
    // horizontal slit, while the whole view dims toward black.
    const close = a * a * (3 - 2 * a); // smoothstep: slow start, fast at the end
    const ry = 140 * (1 - close); // vertical opening (% of screen height)
    const rx = 160 - 90 * close; // horizontal opening (% of screen width)
    const dim = Math.max(0, (a - 0.5) / 0.5) * 0.85;
    style.background = `radial-gradient(ellipse ${rx}% ${ry}% at 50% 50%, rgba(0,0,0,${dim}) 0%, rgba(0,0,0,${dim}) 45%, rgba(0,0,0,1) 100%)`;
    // Grey-out and blur drain colour and focus before the blackout.
    style.backdropFilter = `grayscale(${Math.min(1, a * 1.5)}) brightness(${1 - a * 0.4}) blur(${a * 3}px)`;
    style.opacity = 1;
  }
}
