// On-screen controls for touch devices: a virtual stick (pitch / roll), a throttle slider
// and weapon buttons. Shown only on coarse-pointer devices while flying.

const STICK_RADIUS = 60; // CSS px of full deflection

export class TouchControls {
  /**
   * @param {object} hooks
   * @param {() => boolean} hooks.flying
   * @param {(code: string) => void} hooks.onKey  one-shot actions (camera, pause)
   * @param {object} hooks.controls  Controls instance (missile queue)
   */
  constructor({ flying, onKey, controls }) {
    this.flying = flying;
    this.active = matchMedia('(pointer: coarse)').matches;
    this.stickX = 0;
    this.stickY = 0;
    this.gun = false;
    this.flare = false;
    this.brake = false;
    /** Throttle chosen on the slider, consumed by Controls.update. */
    this.throttleSet = null;
    if (!this.active) return;

    const root = document.createElement('div');
    root.id = 'touch';
    root.className = 'hidden';
    root.innerHTML = `
      <div class="touch-stick"><div class="touch-knob"></div></div>
      <div class="touch-throttle"><div class="touch-throttle-fill"></div><span>THR</span></div>
      <div class="touch-buttons">
        <button data-hold="gun">GUN</button>
        <button data-tap="missile">MSL</button>
        <button data-hold="flare">FLR</button>
        <button data-hold="brake">BRK</button>
        <button data-key="KeyG">GEAR</button>
        <button data-key="KeyZ">FLAP</button>
        <button data-key="KeyV">CAM</button>
        <button data-key="Escape">II</button>
      </div>`;
    document.body.append(root);
    this.root = root;
    this.knob = root.querySelector('.touch-knob');
    this.fill = root.querySelector('.touch-throttle-fill');

    this.bindStick(root.querySelector('.touch-stick'));
    this.bindThrottle(root.querySelector('.touch-throttle'));
    for (const b of root.querySelectorAll('button')) {
      const down = (e) => {
        e.preventDefault();
        b.setPointerCapture?.(e.pointerId);
        b.classList.add('down');
        if (b.dataset.hold) this[b.dataset.hold] = true;
        if (b.dataset.tap === 'missile') controls.missileQueued = true;
        if (b.dataset.key) onKey(b.dataset.key);
      };
      const up = () => {
        b.classList.remove('down');
        if (b.dataset.hold) this[b.dataset.hold] = false;
      };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
    }
  }

  bindStick(el) {
    let id = null;
    let cx = 0;
    let cy = 0;
    const move = (e) => {
      if (e.pointerId !== id) return;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const d = Math.hypot(dx, dy);
      const s = d > STICK_RADIUS ? STICK_RADIUS / d : 1;
      this.stickX = (dx * s) / STICK_RADIUS;
      // Dragging down pulls the stick back: nose up.
      this.stickY = (dy * s) / STICK_RADIUS;
      this.knob.style.transform = `translate(${dx * s}px, ${dy * s}px)`;
    };
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      this.stickX = this.stickY = 0;
      this.knob.style.transform = '';
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      id = e.pointerId;
      el.setPointerCapture?.(id);
      const r = el.getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
      move(e);
    });
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  bindThrottle(el) {
    let id = null;
    const set = (e) => {
      if (e.pointerId !== id) return;
      const r = el.getBoundingClientRect();
      this.throttleSet = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      id = e.pointerId;
      el.setPointerCapture?.(id);
      set(e);
    });
    el.addEventListener('pointermove', set);
    const end = (e) => { if (e.pointerId === id) id = null; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  /** Mirror the current throttle on the slider (keyboard or gamepad may move it too). */
  showThrottle(t) {
    if (this.fill) this.fill.style.height = `${Math.round(t * 100)}%`;
  }

  /** Show the controls only while flying. */
  setVisible(visible) {
    this.root?.classList.toggle('hidden', !visible);
  }

  reset() {
    this.stickX = this.stickY = 0;
    this.gun = this.flare = this.brake = false;
    this.throttleSet = null;
  }
}
