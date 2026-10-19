// Online rooms: friends fly together and shoot at each other.
//
// The room server (worker/room.js) only relays messages; every client flies its own
// aircraft in its own core. The other pilots are mirrored into bot slots of the core
// (game/remote.rs), posed from their latest state snapshot and carried along their
// velocity in between, with the jump to each new snapshot smoothed out. Hits:
// - cannon: the shooter's core decides, and the damage is sent to the pilot hit;
// - missiles: the target's core flies the missile it was sent, so flares and evasion
//   work against it, and its own hits count.
// Each pilot reports their own death, crediting whoever damaged them last.

import * as THREE from 'three';
import { PLAYER, REMOTE, EVENT } from './layout.js';

/** State snapshots per second. */
const SEND_RATE = 20;
/** A snapshot older than this (s) is no longer extrapolated: the pilot froze or left. */
const MAX_EXTRAPOLATION = 0.5;
/** A new snapshot further than this (m) from the shown pose is jumped to (respawn). */
const SNAP_DISTANCE = 150;
/** How fast (1/s) the gap to a new snapshot closes, and the attitude follows. */
const CORRECTION_RATE = 8;
const TURN_RATE = 14;
/** Seconds the last pilot to damage us is credited if we go down. */
const ATTACKER_MEMORY = 15;
/** Pilots start this far apart down the runway (m), by their index in the room. */
export const SPAWN_SPACING = 70;
const PING_INTERVAL = 15000;

const NAME_KEY = '1923.callsign';
const HOST_KEY = '1923.host.';

// `storage` names localStorage or sessionStorage: even reaching them can throw (private
// mode, blocked site data), and then nothing is remembered.
function load(storage, key) {
  try {
    return window[storage].getItem(key);
  } catch {
    return null;
  }
}

function store(storage, key, value) {
  try {
    window[storage].setItem(key, value);
  } catch {}
}

export const savedCallsign = () => load('localStorage', NAME_KEY) || '';
export const saveCallsign = (name) => store('localStorage', NAME_KEY, name);

/** Room code in the page address (?room=ABC123), or null. */
export function roomFromUrl() {
  const code = new URLSearchParams(location.search).get('room');
  return code && /^[A-Z0-9]{6}$/i.test(code) ? code.toUpperCase() : null;
}

/** Drop ?room= from the address bar without reloading. */
export function clearRoomFromUrl() {
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url);
}

export function inviteLink(code) {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set('room', code);
  return url.href;
}

async function api(path, init) {
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('No connection to the room server');
  }
  const body = await res.json().catch(() => ({}));
  // A plain static server (./build.sh serve) has no /api: 404, or 501 for the POST.
  if (!body.error && [404, 405, 501].includes(res.status)) {
    throw new Error('No room server here: run the game with ./build.sh online');
  }
  if (!res.ok) throw new Error(body.error || `Room server error ${res.status}`);
  return body;
}

/**
 * Create a room; this tab keeps the host token (per tab, so a friend's invite opened in
 * another tab of the same browser is not taken for the host).
 */
export async function createRoom({ name, night, gunsOnly }) {
  const room = await api('/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, night, gunsOnly }),
  });
  store('sessionStorage', HOST_KEY + room.id, room.hostToken);
  return room;
}

/** The settings and head count of room `code` (for an invitation). */
export const roomInfo = (code) => api(`/api/rooms/${code}`);

/** One other pilot in the room. */
class Pilot {
  constructor({ id, name, index, kills = 0, deaths = 0, host = false }) {
    this.id = id;
    this.name = name;
    this.index = index;
    this.kills = kills;
    this.deaths = deaths;
    this.host = host;
    /** Latest snapshot (REMOTE layout) and the local clock when it arrived; at < 0: none yet. */
    this.snap = new Float32Array(REMOTE.LEN);
    this.at = -1;
    /** Pose written to the core: extrapolated snapshot plus a decaying correction. */
    this.rec = new Float32Array(REMOTE.LEN);
    this.offset = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.shown = false;
    /** Cannon damage dealt to them, not yet sent. */
    this.damage = 0;
  }

  /** The core's bot slot: the room index is unique, stable and well below MAX_BOTS. */
  get slot() {
    return this.index;
  }

  get alive() {
    return this.at >= 0 && this.snap[REMOTE.ALIVE] > 0;
  }
}

const target = new THREE.Quaternion();
const fresh = new THREE.Vector3();
const shown = new THREE.Vector3();
const fwd = new THREE.Vector3();
const quat = new THREE.Quaternion();

export class Online {
  /**
   * @param {Sim} sim the core
   * @param {object} hooks onChange(), onJoin(pilot), onLeave(pilot),
   *   onDown(victim, killer) (either may be `online.me`), onClosed(reason)
   */
  constructor(sim, hooks) {
    this.sim = sim;
    this.hooks = hooks;
    this.ws = null;
    /** Room settings ({ id, night, gunsOnly, seed, hostName }) once in a room. */
    this.room = null;
    /** This client as the room knows it ({ id, name, index, kills, deaths, host }). */
    this.me = null;
    this.pilots = new Map();
    /** Simulation clock (s), advanced by beforeStep. */
    this.clock = 0;
    this.sendTimer = 0;
    this.lastAmmo = 0;
    this.attacker = null;
    this.attackerAt = -Infinity;
    this.ping = 0;
    this.pingTimer = 0;
  }

  get active() {
    return !!this.room && this.ws?.readyState === WebSocket.OPEN;
  }

  get isHost() {
    return !!this.me?.host;
  }

  /** Everyone in the room, this client included, best score first. */
  scoreboard() {
    const all = [...this.pilots.values()];
    if (this.me) all.push(this.me);
    return all.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.index - b.index);
  }

  bySlot(slot) {
    for (const p of this.pilots.values()) if (p.slot === slot) return p;
    return null;
  }

  /** Name of the pilot in bot slot `slot`, for the HUD. */
  nameOf(slot) {
    return this.bySlot(slot)?.name ?? '';
  }

  /** Join room `code` as `name`; resolves once the room has welcomed us. */
  connect(code, name) {
    this.leave();
    const params = new URLSearchParams({ name });
    const token = load('sessionStorage', HOST_KEY + code);
    if (token) params.set('host', token);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/rooms/${code}/ws?${params}`);
    this.ws = ws;
    return new Promise((resolve, reject) => {
      let welcomed = false;
      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.t === 'error') {
          reject(new Error(msg.reason === 'full' ? 'The room is full' : 'Could not join the room'));
          return;
        }
        if (msg.t === 'welcome') {
          welcomed = true;
          this.welcome(msg);
          resolve(this.room);
          return;
        }
        if (welcomed) this.receive(msg);
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        if (!welcomed) reject(new Error('Could not reach the room'));
        const was = !!this.room;
        this.reset();
        if (was) this.hooks.onClosed?.('Disconnected from the room');
      };
    });
  }

  leave() {
    const ws = this.ws;
    this.ws = null;
    this.reset();
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, 'Bye');
  }

  reset() {
    this.hideAll();
    this.pilots.clear();
    this.room = null;
    this.me = null;
    this.attacker = null;
    this.hooks.onChange?.();
  }

  /** Take every other pilot out of the core (the menu shows only our aircraft). */
  hideAll() {
    for (const p of this.pilots.values()) {
      this.sim.clearRemote(p.slot);
      p.shown = false;
    }
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  welcome(msg) {
    this.room = msg.room;
    this.me = msg.me;
    for (const p of msg.pilots) this.pilots.set(p.id, new Pilot(p));
    this.hooks.onChange?.();
  }

  receive(msg) {
    switch (msg.t) {
      case 's': {
        const p = this.pilots.get(msg.id);
        if (p) this.snapshot(p, msg.d);
        break;
      }
      case 'join': {
        const p = new Pilot(msg.pilot);
        this.pilots.set(p.id, p);
        this.hooks.onJoin?.(p);
        this.hooks.onChange?.();
        break;
      }
      case 'leave': {
        const p = this.pilots.get(msg.id);
        if (!p) break;
        this.sim.clearRemote(p.slot);
        this.pilots.delete(msg.id);
        this.hooks.onLeave?.(p);
        this.hooks.onChange?.();
        break;
      }
      case 'hit':
        this.sim.remoteHit(msg.dmg);
        this.blame(msg.from);
        break;
      case 'missile': {
        const from = this.pilots.get(msg.from);
        if (!from) break;
        const atMe = msg.target === this.me.id;
        const target = atMe ? -2 : (this.pilots.get(msg.target)?.slot ?? -1);
        this.sim.remoteMissile(msg.d, target);
        if (atMe) this.blame(from.id);
        break;
      }
      case 'flare': {
        const p = this.pilots.get(msg.from);
        if (p?.shown) this.sim.remoteFlare(p.slot);
        break;
      }
      case 'down': {
        for (const s of msg.pilots) {
          const p = s.id === this.me.id ? this.me : this.pilots.get(s.id);
          if (p) Object.assign(p, { kills: s.kills, deaths: s.deaths, host: s.host, name: s.name });
        }
        const victim = msg.id === this.me.id ? this.me : this.pilots.get(msg.id);
        const killer = !msg.by ? null : msg.by === this.me.id ? this.me : this.pilots.get(msg.by);
        if (victim) this.hooks.onDown?.(victim, killer ?? null);
        this.hooks.onChange?.();
        break;
      }
      case 'pong':
        this.ping = performance.now() - msg.c;
        break;
    }
  }

  blame(id) {
    this.attacker = id;
    this.attackerAt = this.clock;
  }

  /** A new state snapshot of `p`: keep the shown pose and let the gap close over time. */
  snapshot(p, d) {
    if (d.length !== REMOTE.LEN) return;
    const had = p.shown && p.alive;
    if (had) shown.fromArray(p.rec, REMOTE.POS);
    p.snap.set(d);
    p.at = this.clock;
    fresh.fromArray(p.snap, REMOTE.POS);
    if (had && p.alive && shown.distanceTo(fresh) < SNAP_DISTANCE) p.offset.copy(shown).sub(fresh);
    else {
      p.offset.set(0, 0, 0);
      p.quat.fromArray(p.snap, REMOTE.QUAT);
    }
  }

  // ------------------------------------------------------------------ per step

  /** Pose every other pilot in the core for the coming fixed step. */
  beforeStep(dt) {
    this.clock += dt;
    const decay = Math.exp(-CORRECTION_RATE * dt);
    const turn = 1 - Math.exp(-TURN_RATE * dt);
    for (const p of this.pilots.values()) {
      if (p.at < 0) continue;
      const age = Math.min(this.clock - p.at, MAX_EXTRAPOLATION);
      const rec = p.rec;
      rec.set(p.snap);
      p.offset.multiplyScalar(decay);
      for (let k = 0; k < 3; k++) {
        rec[REMOTE.POS + k] += p.snap[REMOTE.VEL + k] * age + p.offset.getComponent(k);
      }
      // Frozen (no news) pilots stop firing too.
      if (this.clock - p.at > MAX_EXTRAPOLATION) rec[REMOTE.GUN] = 0;
      p.quat.slerp(target.fromArray(p.snap, REMOTE.QUAT), turn);
      p.quat.toArray(rec, REMOTE.QUAT);
      this.sim.setRemote(p.slot, rec, p.alive);
      p.shown = true;
    }
  }

  /** Collect the cannon damage our rounds did to other pilots this step. */
  afterStep() {
    for (const p of this.pilots.values()) {
      if (p.shown) p.damage += this.sim.takeRemoteDamage(p.slot);
    }
  }

  /** Core events that the room needs to hear about. `e` is reused: read it now. */
  event(e) {
    switch (e.type) {
      case EVENT.MISSILE_LAUNCH: {
        const p = this.sim.player();
        quat.fromArray(p.quat);
        fwd.set(0, 0, -1).applyQuaternion(quat);
        // Same launch velocity as the core gives it (game/flight.rs fire_missile).
        const d = [e.x, e.y, e.z, p.vel[0] + fwd.x * 40, p.vel[1] + fwd.y * 40, p.vel[2] + fwd.z * 40].map(round2);
        const at = e.extra >= 0 ? this.bySlot(e.extra) : null;
        this.send({ t: 'missile', d, target: at?.id ?? null });
        break;
      }
      case EVENT.FLARE:
        this.send({ t: 'flare' });
        break;
      case EVENT.PLAYER_DOWN: {
        const recent = this.attacker && this.clock - this.attackerAt < ATTACKER_MEMORY;
        this.send({ t: 'down', by: recent ? this.attacker : null });
        this.attacker = null;
        break;
      }
    }
  }

  // ------------------------------------------------------------------ per frame

  /**
   * Send our state SEND_RATE times a second, with the damage dealt since. `present` is
   * false outside a flight (menu), which hides our aircraft from the others.
   */
  tick(frameDt, present) {
    if (!this.active) return;
    this.pingTimer -= frameDt * 1000;
    if (this.pingTimer <= 0) {
      this.pingTimer = PING_INTERVAL;
      this.send({ t: 'ping', c: performance.now() });
    }
    this.sendTimer -= frameDt;
    if (this.sendTimer > 0) return;
    this.sendTimer += 1 / SEND_RATE;
    if (this.sendTimer < 0) this.sendTimer = 0;
    const raw = this.sim.playerRaw();
    const ammo = raw[PLAYER.AMMO];
    const firing = ammo < this.lastAmmo;
    this.lastAmmo = ammo;
    this.send({
      t: 's',
      d: [
        raw[PLAYER.TYPE],
        round2(raw[PLAYER.POS]), round2(raw[PLAYER.POS + 1]), round2(raw[PLAYER.POS + 2]),
        round4(raw[PLAYER.QUAT]), round4(raw[PLAYER.QUAT + 1]), round4(raw[PLAYER.QUAT + 2]), round4(raw[PLAYER.QUAT + 3]),
        round2(raw[PLAYER.VEL]), round2(raw[PLAYER.VEL + 1]), round2(raw[PLAYER.VEL + 2]),
        round2(raw[PLAYER.ENGINE]), round2(raw[PLAYER.GEAR]), round2(raw[PLAYER.FLAPS]),
        Math.round(raw[PLAYER.HP]), Math.round(raw[PLAYER.MAX_HP]),
        present && raw[PLAYER.ALIVE] > 0 ? 1 : 0,
        present && firing ? 1 : 0,
      ],
    });
    for (const p of this.pilots.values()) {
      if (p.damage <= 0) continue;
      this.send({ t: 'hit', to: p.id, dmg: round2(p.damage) });
      p.damage = 0;
    }
  }
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}
