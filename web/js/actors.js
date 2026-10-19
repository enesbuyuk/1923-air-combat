// Scene objects for the player and enemy aircraft, driven by the core's state each frame.

import * as THREE from 'three';
import { AIRCRAFT } from './aircraft.js';
import { instantiate, setGear } from './models.js';
import { createExhaust, updateExhaust, disposeExhaust } from './exhaust.js';
import { BOT } from './layout.js';
import { wingOf } from './wing.js';
import { createLights, updateLights } from './navlights.js';

/** Bots this badly damaged trail smoke. */
const BOT_SMOKE_HP = 25;

/** One model per aircraft type, built when first shown; only the flown one is visible. */
export class PlayerAircraft {
  constructor(scene, models) {
    this.scene = scene;
    this.models = models;
    this.variants = [];
    this.gearDown = true;
  }

  /** Model for `type`, rebuilt when its GLB arrives (models.js swaps the template). */
  variant(type) {
    const def = AIRCRAFT[type];
    const entry = this.models.request(def.key);
    const old = this.variants[type];
    if (old?.version === entry.version) return old;
    if (old) {
      disposeExhaust(old.exhaust);
      this.scene.remove(old.group);
    }
    const group = instantiate(entry.template, false);
    const exhaust = createExhaust(group, def);
    const lights = createLights(group, wingOf(entry), def);
    this.scene.add(group);
    const glass = [];
    if (def.cockpitHide) {
      group.traverse((o) => {
        if (o.isMesh && def.cockpitHide.test(o.material?.name || '')) glass.push(o);
      });
    }
    return (this.variants[type] = { group, exhaust, lights, glass, interior: !!def.cockpitHide, version: entry.version });
  }

  /** Whether the flown aircraft has a modelled cockpit to sit in. */
  get interior() {
    return this.current.interior;
  }

  get group() {
    return this.current.group;
  }

  /** Show only aircraft `type` (menu preview). */
  select(type) {
    const v = this.variant(type);
    // Called every frame: only touch the other variants when the shown one changes.
    if (v === this.current) return;
    this.current = v;
    for (let i = 0; i < this.variants.length; i++) {
      const other = this.variants[i];
      if (other) other.group.visible = i === type;
    }
  }

  /**
   * @param {object} p decoded player state
   * @param {boolean} cockpit cockpit view: models with an interior stay visible minus the
   *   canopy glass, the others are hidden (the HUD draws a canopy frame instead)
   */
  update(p, cockpit, dt = 0) {
    this.select(p.type);
    const v = this.current;
    this.group.visible = p.alive && (!cockpit || v.interior);
    for (let i = 0; i < v.glass.length; i++) v.glass[i].visible = !cockpit;
    this.group.position.set(p.x, p.y, p.z);
    this.group.quaternion.fromArray(p.quat);
    this.updateGear(p);
    updateExhaust(v.exhaust, AIRCRAFT[p.type], p.engine, p.y, dt, p.fuel > 0 || p.engine > 0.01);
  }

  /** Gear indication follows the actuator in the core, including a jammed leg. */
  updateGear(p) {
    this.gearDown = p.gear > 0.97;
    setGear(this.group, p.gear > 0.05);
    updateLights(this.current.lights, this.gearDown);
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
    this._v = new THREE.Vector3();
  }

  /**
   * Break up the shown aircraft nearest `pos` (where the core reported a kill; its model
   * still holds its last pose) through `wreckage`.
   */
  breakup(pos, wreckage) {
    let best = null;
    let bestD = 60 * 60;
    for (const variants of this.slots) {
      if (!variants) continue;
      for (const m of variants) {
        if (!m?.visible) continue;
        const d = m.position.distanceToSquared(pos);
        if (d < bestD) { bestD = d; best = m; }
      }
    }
    if (!best) return;
    const v = this._v.set(0, 0, -1).applyQuaternion(best.quaternion).multiplyScalar(best.userData.speed || 0);
    wreckage.breakup(best, [v.x, v.y, v.z]);
  }

  model(slot, type, friendly) {
    const variants = (this.slots[slot] ??= []);
    const key = type * 2 + (friendly ? 1 : 0);
    const def = AIRCRAFT[type];
    const entry = this.models.request(def.key);
    const old = variants[key];
    if (old?.userData.version !== entry.version) {
      if (old) {
        disposeExhaust(old.userData.exhaust);
        this.scene.remove(old);
      }
      const g = instantiate(entry.template, !friendly);
      g.userData.exhaust = createExhaust(g, def);
      g.userData.lights = createLights(g, wingOf(entry), def);
      g.userData.version = entry.version;
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
  update(buf, count, prev = null, alpha = 1, dt = 0) {
    for (let i = 0; i < count; i++) {
      const o = i * BOT.STRIDE;
      const alive = buf[o + BOT.ALIVE] > 0;
      const type = buf[o + BOT.TYPE] | 0;
      const friendly = buf[o + BOT.FRIENDLY] > 0;
      const key = type * 2 + (friendly ? 1 : 0);
      const variants = this.slots[i];
      if (variants) {
        for (let k = 0; k < variants.length; k++) if (variants[k]) variants[k].visible = alive && k === key;
      }
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
      setGear(m, buf[o + BOT.GEAR] > 0.05);
      updateLights(m.userData.lights, buf[o + BOT.GEAR] > 0.97);
      m.userData.speed = buf[o + BOT.SPEED];
      const engine = buf[o + BOT.ENGINE];
      updateExhaust(m.userData.exhaust, AIRCRAFT[type], engine, m.position.y, dt, buf[o + BOT.FUEL] > 0 || engine > 0.01);
      const hp = buf[o + BOT.HP] / buf[o + BOT.MAX_HP];
      if (buf[o + BOT.HP] < BOT_SMOKE_HP || hp < 0.35) this.effects.damageSmoke(m.position, 0.6);
    }
  }
}
