// Flight controls from keyboard + mouse, a gamepad (standard mapping) and on-screen touch
// controls, smoothed into stick / throttle values.

import { TouchControls } from './touch.js';

const STICK_RESPONSE = 7; // 1/s; how fast the virtual stick follows the keys
const THROTTLE_RATE = 0.6; // full range per second
const SCROLL_KEYS = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

// Gamepad (W3C standard mapping).
const PAD_DEADZONE = 0.12;
/** Response curve exponent: fine control near the centre, full deflection at the edge. */
const PAD_EXPO = 1.6;
const PAD = {
  GUN: 0, // A / Cross
  MISSILE: 1, // B / Circle
  FLARE: 2, // X / Square
  CAMERA: 3, // Y / Triangle
  BRAKE: 4, // LB
  FLARE_ALT: 5, // RB
  THROTTLE_DOWN: 6, // LT (analog)
  THROTTLE_UP: 7, // RT (analog)
  PAUSE: 9, // Start / Options
};
/** Gamepad buttons that act like a one-shot key press. */
const PAD_KEYS = { [PAD.CAMERA]: 'KeyV', [PAD.PAUSE]: 'Escape' };

function shapeAxis(v) {
  const a = Math.abs(v);
  if (a < PAD_DEADZONE) return 0;
  return Math.sign(v) * ((a - PAD_DEADZONE) / (1 - PAD_DEADZONE)) ** PAD_EXPO;
}

export class Controls {
  /**
   * @param {object} hooks
   * @param {() => boolean} hooks.inGame   true while playing or paused (browser shortcuts blocked)
   * @param {() => boolean} hooks.flying   true while playing (mouse fires weapons)
   * @param {(code: string) => void} hooks.onKey  called once per key press (no repeats)
   */
  constructor({ inGame, flying, onKey }) {
    this.keys = new Set();
    this.pitch = 0;
    this.roll = 0;
    this.yaw = 0;
    this.throttle = 0;
    this.gun = false;
    this.flare = false;
    this.invertPitch = false;
    this.missileQueued = false;
    this.mouseGun = false;
    this.onKey = onKey;
    this.padButtons = [];
    this.padConnected = false;
    this.padBrake = false;
    this.touch = new TouchControls({ flying, onKey, controls: this });

    addEventListener('keydown', (e) => {
      if (SCROLL_KEYS.includes(e.code)) e.preventDefault();
      // Ctrl is the throttle-down key, so block browser shortcuts (Ctrl+S, Ctrl+D, …)
      // while flying. Ctrl+W can only be captured in fullscreen via keyboard lock.
      if (e.ctrlKey && inGame()) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      onKey(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousedown', (e) => {
      if (!flying()) return;
      if (e.button === 0) this.mouseGun = true;
      if (e.button === 2) this.missileQueued = true;
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseGun = false;
    });
    addEventListener('gamepadconnected', () => { this.padConnected = true; });
  }

  held(...codes) {
    return codes.some((c) => this.keys.has(c));
  }

  get brake() {
    return this.keys.has('KeyB') || this.padBrake || this.touch.brake;
  }

  /** Centre the stick and close the throttle (new flight). */
  reset() {
    this.pitch = this.roll = this.yaw = 0;
    this.throttle = 0;
    this.touch.reset();
  }

  /** First connected gamepad, if any. */
  gamepad() {
    if (!this.padConnected || !navigator.getGamepads) return null;
    for (const pad of navigator.getGamepads()) if (pad?.connected) return pad;
    return null;
  }

  /**
   * Read every input device; an `incapacitated` pilot (G-LOC) lets go of the stick.
   * Analog sticks (gamepad, touch) override the keys while deflected.
   */
  update(dt, incapacitated) {
    const axis = (plus, minus) => (this.held(...plus) ? 1 : 0) - (this.held(...minus) ? 1 : 0);
    let pitch = axis(['KeyS', 'ArrowDown'], ['KeyW', 'ArrowUp']);
    let roll = axis(['KeyD', 'ArrowRight'], ['KeyA', 'ArrowLeft']);
    let yaw = axis(['KeyE'], ['KeyQ']);
    let analog = false;
    let padGun = false;
    let padFlare = false;
    this.padBrake = false;

    const pad = this.gamepad();
    if (pad) {
      const [lx = 0, ly = 0, rx = 0] = pad.axes;
      const sx = shapeAxis(lx);
      // Stick back (toward the pilot, positive y) pulls the nose up.
      const sy = shapeAxis(ly);
      const sr = shapeAxis(rx);
      if (sx || sy || sr) {
        analog = true;
        roll = sx;
        pitch = sy;
        yaw = sr;
      }
      const pressed = (i) => !!pad.buttons[i]?.pressed;
      const value = (i) => pad.buttons[i]?.value ?? 0;
      padGun = pressed(PAD.GUN);
      padFlare = pressed(PAD.FLARE) || pressed(PAD.FLARE_ALT);
      this.padBrake = pressed(PAD.BRAKE);
      if (pressed(PAD.MISSILE) && !this.padButtons[PAD.MISSILE]) this.missileQueued = true;
      for (const [i, code] of Object.entries(PAD_KEYS)) {
        if (pressed(i) && !this.padButtons[i]) this.onKey(code);
      }
      this.throttle = Math.min(1, Math.max(0, this.throttle + (value(PAD.THROTTLE_UP) - value(PAD.THROTTLE_DOWN)) * dt * THROTTLE_RATE));
      this.padButtons = pad.buttons.map((b) => b.pressed);
    }

    const t = this.touch;
    if (t.active && (t.stickX || t.stickY)) {
      analog = true;
      roll = t.stickX;
      pitch = t.stickY;
    }
    if (this.invertPitch) pitch = -pitch;
    if (incapacitated) pitch = roll = yaw = 0;

    // Analog input already carries its own smoothness; keys go through the virtual stick.
    const k = analog ? 1 : 1 - Math.exp(-dt * STICK_RESPONSE);
    this.pitch += (pitch - this.pitch) * k;
    this.roll += (roll - this.roll) * k;
    this.yaw += (yaw - this.yaw) * k;
    if (this.held('ShiftLeft', 'ShiftRight', 'KeyR')) this.throttle = Math.min(1, this.throttle + dt * THROTTLE_RATE);
    if (this.held('KeyF', 'ControlLeft', 'ControlRight')) this.throttle = Math.max(0, this.throttle - dt * THROTTLE_RATE);
    if (t.throttleSet !== null) {
      this.throttle = t.throttleSet;
      t.throttleSet = null;
    }
    t.showThrottle(this.throttle);
    this.gun = this.keys.has('Space') || this.mouseGun || padGun || t.gun;
    this.flare = this.keys.has('KeyC') || padFlare || t.flare;
  }

  /** Snapshot for `Sim.setInput`; a queued missile is fired once and then cleared. */
  consume() {
    const input = {
      pitch: this.pitch, roll: this.roll, yaw: this.yaw, throttle: this.throttle,
      gun: this.gun, missile: this.missileQueued, brake: this.brake, flare: this.flare,
    };
    this.missileQueued = false;
    return input;
  }
}
