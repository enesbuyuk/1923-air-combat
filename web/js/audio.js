// Synthesised audio: jet engine, cannon, missiles, explosions, warnings. The only recorded
// sound is the "Pull up, pull up" voice warning (web/audio/pull_up.mp3).

import { B2 } from './aircraft.js';

const MASTER_VOLUME = 0.6;
const PULL_UP_URL = 'audio/pull_up.mp3';
/** Pause (s) between repeats of the voice clip while the warning stays active. */
const PULL_UP_GAP = 0.3;

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    // User volume 0..1 on top of MASTER_VOLUME (see setVolume).
    this.volume = 1;
    this.pullUpBuffer = null;
    this.pullUpSource = null;
    this.pullUpActive = false;
    this.lastPullUp = -Infinity;
  }

  /** Must be called from a user gesture. */
  start() {
    if (this.ctx) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.masterGain();
    this.master.connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // Engine: low rumble (filtered noise) + turbine whine.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 300;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    src.connect(this.engFilter).connect(this.engGain).connect(this.master);
    src.start();

    this.whine = ctx.createOscillator();
    this.whine.type = 'sawtooth';
    this.whine.frequency.value = 400;
    const wf = ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.Q.value = 8;
    wf.frequency.value = 1500;
    this.whineFilter = wf;
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whine.connect(wf).connect(this.whineGain).connect(this.master);
    this.whine.start();

    this.wind = ctx.createBufferSource();
    this.wind.buffer = this.noise;
    this.wind.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 800;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.wind.connect(this.windFilter).connect(this.windGain).connect(this.master);
    this.wind.start();
    this.lastBeep = 0;
    this.loadPullUp();
  }

  /** Fetch and decode the voice clip; without it the warning falls back to a warble tone. */
  async loadPullUp() {
    try {
      const res = await fetch(PULL_UP_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.pullUpBuffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
    } catch (e) {
      console.warn('Pull-up voice unavailable, using a warning tone instead:', e);
    }
  }

  masterGain() {
    return this.muted ? 0 : MASTER_VOLUME * this.volume;
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.masterGain();
    return this.muted;
  }

  /** Freeze all audio while the game is paused (separate from mute); resume picks up where it left off. */
  setPaused(paused) {
    if (!this.ctx) return;
    if (paused && this.ctx.state === 'running') this.ctx.suspend();
    else if (!paused && this.ctx.state === 'suspended') this.ctx.resume();
  }

  /** `v`: 0..1. Choosing a volume also lifts a mute. */
  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    this.muted = false;
    if (this.master) this.master.gain.value = this.masterGain();
  }

  engine(throttle, speed, alive, aircraftType) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const base = aircraftType === B2 ? 0.7 : 1; // the B-2 sounds deeper
    this.engGain.gain.setTargetAtTime(alive ? 0.25 + throttle * 0.55 : 0, t, 0.1);
    this.engFilter.frequency.setTargetAtTime((180 + throttle * 900) * base, t, 0.1);
    this.whine.frequency.setTargetAtTime((300 + throttle * 900) * base, t, 0.2);
    this.whineFilter.frequency.setTargetAtTime((1200 + throttle * 2500) * base, t, 0.2);
    this.whineGain.gain.setTargetAtTime(alive ? 0.02 + throttle * 0.05 : 0, t, 0.1);
    this.windGain.gain.setTargetAtTime(alive ? Math.min(speed / 400, 1) * 0.25 : 0, t, 0.2);
    this.windFilter.frequency.setTargetAtTime(400 + speed * 3, t, 0.2);
  }

  burst(duration, freq, gain, type = 'lowpass', when = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.2), t + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random());
    s.stop(t + duration + 0.05);
  }

  gun() { this.burst(0.07, 2500, 0.35, 'bandpass'); }
  hit() { this.burst(0.12, 3500, 0.25, 'highpass'); }
  missile() { this.burst(1.6, 1800, 0.5, 'bandpass'); }
  explosion(dist) {
    const v = Math.max(0.05, 1 - dist / 6000);
    this.burst(2.2, 700, 1.2 * v);
    this.burst(0.5, 3000, 0.4 * v, 'lowpass', 0.02);
  }
  damage() { this.burst(0.25, 1200, 0.6, 'bandpass'); }

  beep(freq, dur = 0.08, gain = 0.15) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.setValueAtTime(0, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** Lock tone: slow growl while seeking, steady high tone when locked. */
  lockTone(progress, locked, now) {
    if (!this.ctx || progress <= 0) return;
    const interval = locked ? 0.09 : 0.35 - progress * 0.2;
    if (now - this.lastBeep > interval) {
      this.lastBeep = now;
      this.beep(locked ? 1400 : 900, locked ? 0.07 : 0.05, 0.06);
    }
  }

  /**
   * Radar warning receiver: a slow two-tone chirp while an enemy radar builds a lock,
   * steady fast beeps once locked, and a rapid high warble while a missile tracks us
   * (faster as it closes).
   */
  rwr(lock, missiles, missileDist, now) {
    if (!this.ctx) return;
    this.lastRwr ??= 0;
    this.rwrPhase ??= 0;
    if (missiles > 0) {
      const interval = Math.max(0.06, Math.min(0.25, missileDist / 12000));
      if (now - this.lastRwr > interval) {
        this.lastRwr = now;
        this.rwrPhase ^= 1;
        this.beep(this.rwrPhase ? 1700 : 1250, interval * 0.6, 0.09);
      }
    } else if (lock > 0) {
      const locked = lock >= 0.999;
      const interval = locked ? 0.18 : 0.9 - lock * 0.5;
      if (now - this.lastRwr > interval) {
        this.lastRwr = now;
        this.rwrPhase ^= 1;
        this.beep(locked ? 1000 : this.rwrPhase ? 600 : 800, locked ? 0.1 : 0.06, 0.06);
      }
    }
  }

  /** Enemy launch: three quick descending tones. */
  launchWarning() {
    [0, 0.09, 0.18].forEach((when, i) => setTimeout(() => this.beep(1600 - i * 250, 0.07, 0.1), when * 1000));
  }

  flare() { this.burst(0.18, 5000, 0.25, 'highpass'); }

  /** Ground crew done: two rising tones. */
  serviced() {
    [0, 0.15].forEach((when, i) => setTimeout(() => this.beep(700 + i * 350, 0.12, 0.1), when * 1000));
  }

  /** GPWS-style "Pull up, pull up" voice, repeated while `active` and cut off once it clears. */
  pullUp(active, now) {
    if (!active) {
      this.pullUpSource?.stop();
      this.pullUpSource = null;
      this.pullUpActive = false;
      return;
    }
    if (!this.ctx) return;
    // Play at once when the warning starts, then again each time the clip finishes.
    const interval = this.pullUpBuffer ? this.pullUpBuffer.duration + PULL_UP_GAP : 1.2;
    if (this.pullUpActive && now - this.lastPullUp < interval) return;
    this.pullUpActive = true;
    this.lastPullUp = now;
    if (this.pullUpBuffer) {
      const s = this.ctx.createBufferSource();
      s.buffer = this.pullUpBuffer;
      s.connect(this.master);
      s.start();
      this.pullUpSource = s;
    } else {
      [0, 0.25, 0.5, 0.75].forEach((when, i) => setTimeout(() => this.beep(i % 2 ? 600 : 900, 0.2, 0.12), when * 1000));
    }
  }
}
