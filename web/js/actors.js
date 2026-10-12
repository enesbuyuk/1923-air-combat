// Scene objects for the player and enemy aircraft, driven by the core's state each frame.

import * as THREE from 'three';
import { AIRCRAFT, B2 } from './aircraft.js';
import { instantiate, addFlames, setGear } from './models.js';
import { BOT } from './layout.js';

// Exhaust colours: faint red-orange with a dim blue core at low throttle, bright
// orange with a faintly violet white-hot core at full afterburner.
const FLAME_LOW = new THREE.Color(0x8a3a14);
const FLAME_HIGH = new THREE.Color(0xf6844a);
const CORE_LOW = new THREE.Color(0x3a5a9a);
const CORE_HIGH = new THREE.Color(0xeedcff);
// Full-afterburner core: violet-white, blended in only near 100 % throttle.
const CORE_MAX = new THREE.Color(0xd8b0ff);

/** Bots this badly damaged trail smoke. */
const BOT_SMOKE_HP = 25;

/** One model per aircraft type; only the flown one is shown. */
export class PlayerAircraft {
  constructor(scene, models) {
    this.variants = AIRCRAFT.map((def) => {
      const group = instantiate(models[def.key].template, false);
      const flames = addFlames(group, def);
      scene.add(group);
      return { group, flames };
    });
    this.gearDown = true;
  }

  get group() {
    return this.current.group;
  }

  /** Show only aircraft `type` (menu preview). */
  select(type) {
    this.current = this.variants[type];
    this.variants.forEach((v, i) => { v.group.visible = i === type; });
  }

  /** @param {object} p decoded player state; `hidden` hides the model (cockpit view). */
  update(p, hidden) {
    this.select(p.type);
    this.group.visible = p.alive && !hidden;
    this.group.position.set(p.x, p.y, p.z);
    this.group.quaternion.set(...p.quat);
    this.updateGear(p);
    this.updateFlames(p);
  }

  /** Automatic gear: down on the ground and when low and slow, up otherwise (with hysteresis). */
  updateGear(p) {
    if (p.onGround || (p.y < 200 && p.speed < 105)) this.gearDown = true;
    else if (p.y > 300 || p.speed > 130) this.gearDown = false;
    setGear(this.group, this.gearDown);
  }

  updateFlames(p) {
    // Flames follow the spooling engine, not the throttle lever.
    const th = p.engine;
    const heat = THREE.MathUtils.smoothstep(th, 0.3, 1);
    // Purple only shows at (near) full throttle.
    const max = THREE.MathUtils.smoothstep(th, 0.85, 1);
    const stretch = p.type === B2 ? 2 : 7;
    for (const f of this.current.flames) {
      const [core, tail] = f.children;
      f.visible = p.alive && th > 0.05;
      f.material.color.lerpColors(FLAME_LOW, FLAME_HIGH, heat);
      core.material.color.lerpColors(CORE_LOW, CORE_HIGH, heat).lerp(CORE_MAX, max);
      tail.material.opacity = max;
      f.scale.set(0.7 + th * 0.4, 0.6 + th * th * stretch * (0.9 + Math.random() * 0.2), 0.7 + th * 0.4);
    }
  }
}

/** Other aircraft: a lazily built model per (bot slot, aircraft type, side); enemies are red-tinted. */
export class BotAircraft {
  constructor(scene, models, effects) {
    this.scene = scene;
    this.models = models;
    this.effects = effects;
    this.slots = [];
    this._q = new THREE.Quaternion();
  }

  model(slot, type, friendly) {
    const variants = (this.slots[slot] ??= []);
    const key = type * 2 + (friendly ? 1 : 0);
    if (!variants[key]) {
      const def = AIRCRAFT[type];
      const g = instantiate(this.models[def.key].template, !friendly);
      g.userData.flames = addFlames(g, def);
      g.visible = false;
      this.scene.add(g);
      variants[key] = g;
    }
    return variants[key];
  }

  /**
   * `buf`: bot records from the core (layout.js BOT). With `prev` (the records one
   * simulation step earlier) the pose is interpolated by `alpha` for smooth motion
   * between fixed steps.
   */
  update(buf, count, prev = null, alpha = 1) {
    for (let i = 0; i < count; i++) {
      const o = i * BOT.STRIDE;
      const alive = buf[o + BOT.ALIVE] > 0;
      const type = buf[o + BOT.TYPE] | 0;
      const friendly = buf[o + BOT.FRIENDLY] > 0;
      const key = type * 2 + (friendly ? 1 : 0);
      this.slots[i]?.forEach((m, k) => { if (m) m.visible = alive && k === key; });
      if (!alive) continue;
      const m = this.model(i, type, friendly);
      m.visible = true;
      m.position.fromArray(buf, o + BOT.POS);
      m.quaternion.fromArray(buf, o + BOT.QUAT);
      // Interpolate only when the previous step had the same live aircraft in this slot.
      if (prev && alpha < 1 && prev[o + BOT.ALIVE] > 0 && (prev[o + BOT.TYPE] | 0) === type) {
        const px = prev[o + BOT.POS];
        const py = prev[o + BOT.POS + 1];
        const pz = prev[o + BOT.POS + 2];
        m.position.set(px + (m.position.x - px) * alpha, py + (m.position.y - py) * alpha, pz + (m.position.z - pz) * alpha);
        this._q.fromArray(prev, o + BOT.QUAT);
        m.quaternion.copy(this._q.slerp(m.quaternion, alpha));
      }
      setGear(m, false);
      const engine = buf[o + BOT.ENGINE];
      for (const f of m.userData.flames) {
        f.visible = engine > 0.05;
        f.scale.set(0.8 + engine * 0.3, 0.6 + engine * engine * 3, 0.8 + engine * 0.3);
      }
      const hp = buf[o + BOT.HP] / buf[o + BOT.MAX_HP];
      if (buf[o + BOT.HP] < BOT_SMOKE_HP || hp < 0.35) this.effects.damageSmoke(m.position, 0.6);
    }
  }
}
