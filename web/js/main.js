// Entry point: loads the WASM simulation core, builds the scene and runs the loop.
// All game logic (flight model, bots, weapons, collisions) lives in WASM; this
// file only feeds input in and renders the state the core exposes.

import * as THREE from 'three';
import { AIRCRAFT, B2 } from './aircraft.js';
import { loadAircraftModels, setModelRenderer } from './models.js';
import { buildWorld } from './world.js';
import { setTimeOfDay } from './atmosphere.js';
import { PlayerLights } from './navlights.js';
import { Effects } from './effects.js';
import { afterburnerShare } from './exhaust.js';
import { Wreckage } from './wreckage.js';
import { Hud, COLORS } from './hud.js';
import { Sound } from './audio.js';
import { Sim, BASE, createPlayerState } from './sim.js';
import { BOT, GROUND, EVENT, MISSION, MODE, groundCode } from './layout.js';
import { applySettings, bindSettingsUi, bindVolumeUi, bindGraphics, bindTimeOfDay } from './settings.js';
import { Controls } from './input.js';
import { GForce } from './gforce.js';
import { CameraRig } from './camera.js';
import { Menu } from './menu.js';
import { PlayerAircraft, BotAircraft } from './actors.js';
import { Career, renderCareer } from './career.js';
import { GroundTargets } from './ground.js';
import { Replay } from './replay.js';
import { Airflow } from './airflow.js';
import { Vortices } from './vortex.js';
import { WingVapor } from './vapor.js';
import { Clouds } from './clouds.js';
import { PostFx } from './post.js';
import { Flyby } from './flyby.js';
import { Quality } from './quality.js';
import { Online, SPAWN_SPACING } from './online.js';
import { Lobby } from './lobby.js';

/**
 * Fixed simulation step: the core always advances by exactly this much, so the outcome
 * does not depend on the frame rate. Rendering interpolates between the last two steps.
 */
const FIXED_STEP = 1 / 60;
/** Largest per-frame camera/effects step. */
const MAX_STEP = 0.05;
/** Real time simulated per frame at most, so slow devices still fly at real speed. */
const MAX_FRAME = 0.25;
/**
 * Fixed steps run per frame at most. A device too slow to keep up then runs the game
 * slower instead of spending ever longer frames catching up (the spiral of death).
 */
const MAX_STEPS = 5;
/** Interpolating across a jump this long (m) would sweep the aircraft across the map (respawn). */
const TELEPORT = 200;

const $ = (id) => document.getElementById(id);

const loadingText = $('loading-text');
const loadingBar = $('loading-bar');
function progress(fraction, text) {
  loadingBar.style.width = `${Math.round(fraction * 100)}%`;
  if (text) loadingText.textContent = text;
}

// ---------------------------------------------------------------------------
// Renderer and shared objects
// ---------------------------------------------------------------------------

// The scene is drawn into PostFx's own multisampled target and only a full-screen quad
// reaches the canvas, so the canvas needs no antialiasing, depth or stencil of its own
// (a multisampled canvas cost a full-screen resolve every frame for nothing).
const renderer = new THREE.WebGLRenderer({
  antialias: false, depth: false, stencil: false, powerPreference: 'high-performance', logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// The shadow map is re-rendered only when something in it moves (updateShadows).
renderer.shadowMap.autoUpdate = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.3, 300000);
const rig = new CameraRig(camera);
const hud = new Hud($('hud'));
const sound = new Sound();
const gforce = new GForce($('gfx'));
const career = new Career();

/** 'loading' | 'menu' | 'play' | 'pause' */
let state = 'loading';
let selected = 0;
let sim;
let world;
let effects;
let wreckage;
let airflow;
let vortices;
const vapor = new WingVapor();
const flyby = new Flyby();
let clouds;
let post;
/** Mach number last frame, to catch the moment the player goes supersonic. */
let lastMach = 0;
let player;
let bots;
let groundTargets;
let playerLights;
let lastAmmo = 0;
let gunSoundCooldown = 0;
/**
 * Unsimulated time carried to the next frame, and the state one step back for
 * interpolation: persistent copies refilled every step, valid once a step has run.
 */
let accumulator = 0;
const prevPlayer = createPlayerState();
let prevBots = null;
let prevValid = false;
/** The bot records one step back, or null before the first step. */
const previousBots = () => (prevValid ? prevBots : null);
/** Online room (online.js) and its screens (lobby.js), made at boot. */
let online;
let lobby;
/** Time of day last shown, so the room's setting is only applied when it changes. */
let nightShown = null;
const quality = new Quality(applyQuality);
const replay = new Replay(1 / FIXED_STEP);

const controls = new Controls({
  inGame: () => state === 'play' || state === 'pause',
  flying: () => state === 'play',
  onKey,
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  // A move to another screen can change devicePixelRatio.
  quality.resize();
  renderer.setSize(innerWidth, innerHeight);
  post?.setSize();
  rig.setMenuFraming(state === 'menu');
});
addEventListener('wheel', (e) => {
  if (state === 'play' && !rig.cockpit) rig.zoom(e.deltaY);
}, { passive: true });

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

function onKey(code) {
  if (code === 'Escape') {
    if (state === 'play') setState('pause');
    else if (state === 'pause') setState('play');
    return;
  }
  if (state !== 'play') return;
  if (code === 'KeyX' && online.active && online.room.gunsOnly) {
    hud.message('Guns only in this room', COLORS.WARN, 1.5);
    return;
  }
  if (gforce.incapacitated && (code === 'KeyX' || code === 'KeyG' || code === 'KeyZ')) return;
  switch (code) {
    case 'KeyX':
      controls.missileQueued = true;
      break;
    case 'KeyG':
      if (!sim.toggleGear()) hud.message('Gear retraction inhibited on the ground', COLORS.WARN, 2);
      break;
    case 'KeyZ':
      sim.cycleFlaps();
      hud.message(`Flaps commanded ${Math.round(sim.player().flapCommand * 100)}%`, COLORS.PRIMARY, 2);
      break;
    case 'KeyV':
      rig.cockpit = !rig.cockpit;
      break;
    case 'KeyH':
      hud.showKeys = !hud.showKeys;
      break;
    case 'KeyI':
      controls.invertPitch = !controls.invertPitch;
      hud.message(controls.invertPitch ? 'Pitch inverted: W pulls nose up' : 'Pitch normal: S pulls nose up');
      break;
    case 'KeyM':
      hud.message(sound.toggleMute() ? 'Sound off' : 'Sound on');
      break;
    case 'KeyN':
      hud.message(sound.toggleWarnings() ? 'Warning sounds off' : 'Warning sounds on');
      break;
  }
}

function setState(s) {
  state = s;
  // Loading, fullscreen and the like make the first frames of a new state unrepresentative.
  quality.restart();
  sound.setPaused(s === 'pause');
  controls.touch.setVisible(s === 'play');
  $('menu').classList.toggle('hidden', s !== 'menu');
  $('pause').classList.toggle('hidden', s !== 'pause');
  $('loading').classList.toggle('hidden', s !== 'loading');
  if (s === 'menu') hud.clear();
  if (s === 'menu' || s === 'pause') renderCareer(career);
  rig.setMenuFraming(s === 'menu');
  // The menu shows only our aircraft; the other pilots return with the next step.
  if (s === 'menu') online?.hideAll();
  if (s !== 'play') $('scoreboard').classList.add('hidden');
}

/** In a room the simulation keeps running while paused: the others are still flying. */
const running = () => state === 'play' || (state === 'pause' && online.active);

/** Day or night: the room's setting while online, else the player's own (settings.js). */
function showTimeOfDay(night) {
  if (online?.active) night = online.room.night;
  if (night === nightShown) return;
  nightShown = night;
  setTimeOfDay(night);
}

/** Reset the core with the selected aircraft and the saved enemy settings. */
function resetSim() {
  sim.init(selected, online.active ? online.room.seed : undefined);
  applySettings(sim);
  // A room is free-for-all among its pilots, each with their own spot on the runway.
  if (online.active) {
    sim.setMode(MODE.FREE);
    sim.setSpawnOffset(online.me.index * SPAWN_SPACING);
  }
  accumulator = 0;
  prevValid = false;
  replay.clear();
  gforce.reset();
}

function selectAircraft(i) {
  selected = i;
  resetSim();
  player.select(i);
  menu.show(i);
}

function startGame() {
  sound.start();
  sound.warningsMuted = false;
  resetSim();
  controls.reset();
  lastAmmo = 0;
  hud.messages = [];
  hud.message(`${AIRCRAFT[selected].name} · 1923 runway 36`, COLORS.PRIMARY, 4);
  if (online.active) {
    const n = online.pilots.size + 1;
    hud.message(`ONLINE · room ${online.room.id} · ${n} pilot${n === 1 ? '' : 's'} · Tab for scores`, COLORS.PRIMARY, 5);
  }
  hud.message('Shift for throttle, S to rotate · Left Ctrl cuts throttle', COLORS.WARN, 6);
  // The core announced the first objective during init, before anyone listened.
  const { mode } = sim.stats();
  if (mode === MODE.STRIKE) missionMessage(MISSION.STRIKE_STARTED);
  else if (mode === MODE.ESCORT) missionMessage(MISSION.ESCORT_STARTED);
  setState('play');
  lockKeyboard();
}

// Fullscreen + Keyboard Lock lets Ctrl+W reach the game instead of closing the tab
// (Chromium only). Elsewhere the beforeunload prompt below is the safety net.
async function lockKeyboard() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    await navigator.keyboard?.lock?.();
  } catch {
    hud.message('Fullscreen unavailable: Ctrl+W may close the tab, use F to cut throttle', COLORS.WARN, 6);
  }
}

// Number keys pick aircraft, Enter takes off while in the menu.
addEventListener('keydown', (e) => {
  // Hold Tab for the room's scoreboard while flying.
  if (e.code === 'Tab' && state === 'play' && online.active) {
    e.preventDefault();
    $('scoreboard').classList.remove('hidden');
  }
  if (state !== 'menu' || lobby?.isOpen) return;
  const n = Number(e.key);
  if (n >= 1 && n <= AIRCRAFT.length) selectAircraft(n - 1);
  if (e.key === 'Enter' && !e.repeat && !(document.activeElement instanceof HTMLButtonElement)) startGame();
});
addEventListener('keyup', (e) => {
  if (e.code === 'Tab') $('scoreboard').classList.add('hidden');
});
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) navigator.keyboard?.unlock?.();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'play') setState('pause');
  quality.restart();
});
addEventListener('beforeunload', (e) => {
  if (state === 'play' || state === 'pause' || online?.active) e.preventDefault();
});

$('start-btn').onclick = startGame;
$('restart-btn').onclick = startGame;
$('resume-btn').onclick = () => setState('play');
$('menu-btn').onclick = () => {
  resetSim();
  setState('menu');
};
$('fs-btn').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
};

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

const eventPos = new THREE.Vector3();

/** One core event; `e` is reused by Sim.forEachEvent, so nothing here keeps it. */
function handleEvent(e) {
  if (online.active) online.event(e);
  const pos = eventPos.set(e.x, e.y, e.z);
  const distance = pos.distanceTo(camera.position);
  switch (e.type) {
    case EVENT.BOT_DESTROYED: {
      const b2 = e.extra === B2;
      effects.explosion(pos, b2 ? 2.6 : 1.4);
      bots.breakup(pos, wreckage);
      sound.explosion(distance);
      hud.message(b2 ? 'B-2 DESTROYED  +500' : 'ENEMY DESTROYED  +100', COLORS.PRIMARY, 2.5);
      const promoted = career.addKill();
      if (promoted) {
        hud.message(`PROMOTED · ${promoted.name.toUpperCase()}`, COLORS.WARN, 4);
        sound.beep(880, 0.25, 0.14);
      }
      break;
    }
    case EVENT.BOT_HIT:
      effects.spark(pos);
      sound.hit();
      break;
    case EVENT.PLAYER_HIT:
      hud.hit(0.35);
      sound.damage();
      rig.addShake(0.4);
      break;
    case EVENT.PLAYER_DOWN:
      // The crash plays live first; the kill cam then replays the last seconds and
      // shows the explosion again at the right moment.
      effects.explosion(pos, 1.8);
      wreckage.breakup(player.group, sim.player().vel);
      sound.explosion(0);
      replay.start(sim.time(), pos.clone());
      break;
    case EVENT.MISSILE_LAUNCH:
      sound.missile();
      if (e.extra === -1) hud.message('Missile fired without lock', COLORS.WARN, 1.5);
      break;
    case EVENT.ENEMY_MISSILE:
      if (e.extra > 0) {
        sound.launchWarning();
        hud.message('MISSILE LAUNCH · break and drop flares (C)', COLORS.DANGER, 2.5);
      }
      break;
    case EVENT.DECOYED:
      hud.message('Missile decoyed', COLORS.PRIMARY, 1.5);
      break;
    case EVENT.FLARE:
      sound.flare();
      break;
    case EVENT.SYSTEM_DAMAGE:
      hud.message(['', 'ENGINE HIT', 'FLIGHT CONTROLS HIT', 'FUEL TANK HIT'][e.extra] ?? 'SYSTEM HIT', COLORS.DANGER, 2.5);
      break;
    case EVENT.REARMED:
      sound.serviced();
      hud.message('Rearmed, refuelled and repaired', COLORS.PRIMARY, 3);
      break;
    case EVENT.GROUND_HIT:
      effects.spark(pos);
      sound.hit();
      break;
    case EVENT.GROUND_DESTROYED:
      effects.explosion(pos, 2);
      sound.explosion(distance);
      hud.message('SAM SITE DESTROYED  +200', COLORS.PRIMARY, 2.5);
      break;
    case EVENT.MISSION:
      missionMessage(e.extra);
      break;
    case EVENT.WAVE:
      hud.message(`WAVE ${e.extra} · ${sim.stats().botsAlive} hostiles inbound`, COLORS.DANGER, 4);
      sound.beep(700, 0.15, 0.12);
      break;
    case EVENT.LANDED:
      if (e.extra > 0) hud.message(`Hard landing! Hull −${Math.round(e.extra)}`, COLORS.WARN, 3);
      else hud.message('Touchdown · landing successful', COLORS.PRIMARY, 3);
      break;
    case EVENT.GROUND_IMPACT:
      effects.explosion(pos, e.extra > 0 ? 1.8 : 0.8);
      sound.explosion(distance);
      break;
  }
}

function missionMessage(code) {
  const { stage } = sim.stats();
  switch (code) {
    case MISSION.STRIKE_STARTED:
      hud.message(`STRIKE · destroy the SAM sites of area ${stage}`, COLORS.WARN, 5);
      break;
    case MISSION.STRIKE_COMPLETE:
      hud.message('TARGET AREA CLEARED  +BONUS', COLORS.PRIMARY, 4);
      sound.serviced();
      break;
    case MISSION.ESCORT_STARTED:
      hud.message(`ESCORT · protect bomber ${stage} on its route`, COLORS.WARN, 5);
      break;
    case MISSION.ESCORT_COMPLETE:
      hud.message('ESCORT COMPLETE  +1500', COLORS.PRIMARY, 4);
      sound.serviced();
      break;
    case MISSION.ESCORT_FAILED:
      hud.message('BOMBER LOST · escort failed', COLORS.DANGER, 4);
      break;
  }
}

/**
 * Advance the core in fixed steps for the real time that passed, checking buildings,
 * draining events and recording the kill-cam history per step. Leftover time is carried
 * to the next frame and used to interpolate the rendered poses.
 */
function simulate(frameDt) {
  controls.update(frameDt, gforce.incapacitated);
  const input = controls.consume();
  if (online.active && online.room.gunsOnly) input.missile = false;
  // Paused in a room: the aircraft flies on hands-off.
  if (state === 'pause') Object.assign(input, { pitch: 0, roll: 0, yaw: 0, gun: false, missile: false, flare: false });
  sim.setInput(input);
  accumulator += frameDt;
  let steps = 0;
  while (accumulator >= FIXED_STEP) {
    if (steps === MAX_STEPS) {
      // Too far behind: drop the backlog, keep only the fraction for interpolation.
      accumulator %= FIXED_STEP;
      break;
    }
    steps++;
    accumulator -= FIXED_STEP;
    // The state one step back, copied into persistent buffers (no per-step garbage).
    sim.player(prevPlayer);
    const botBuf = sim.bots();
    if (!prevBots || prevBots.length !== botBuf.length) prevBots = new Float32Array(botBuf.length);
    prevBots.set(botBuf);
    prevValid = true;
    if (online.active) online.beforeStep(FIXED_STEP);
    sim.step(FIXED_STEP);
    if (online.active) online.afterStep();
    const pilot = sim.player();
    gforce.update(pilot.gLoad, AIRCRAFT[pilot.type].gOnset, pilot.alive, FIXED_STEP);
    // The core clears events on every step.
    sim.forEachEvent(handleEvent);
    replay.record(sim.time(), sim.playerRaw(), sim.bots(), sim.missiles());
    // A queued missile is fired on the first step only.
    if (input.missile) {
      input.missile = false;
      sim.setInput(input);
    }
  }
  // No step this frame (high refresh rate): keep the missile queued for the next one.
  if (input.missile) controls.missileQueued = true;
}

/** Reused result of interpolatedPlayer(). */
const interpolated = createPlayerState();

/** The player pose `alpha` of the way from the previous step to the current one. */
function interpolatedPlayer(p, alpha) {
  const a = prevPlayer;
  if (!prevValid || alpha >= 1 || Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z) > TELEPORT) return p;
  hudQuat.fromArray(a.quat).slerp(lerpQuat.fromArray(p.quat), alpha);
  const out = sim.player(interpolated);
  out.x = a.x + (p.x - a.x) * alpha;
  out.y = a.y + (p.y - a.y) * alpha;
  out.z = a.z + (p.z - a.z) * alpha;
  hudQuat.toArray(out.quat);
  return out;
}

// ---------------------------------------------------------------------------
// HUD data
// ---------------------------------------------------------------------------

const hudQuat = new THREE.Quaternion();
const lerpQuat = new THREE.Quaternion();
const hudFwd = new THREE.Vector3();
const hudUp = new THREE.Vector3();
const hudRight = new THREE.Vector3();
const toCamera = new THREE.Vector3();
const botPos = new THREE.Vector3();
const projected = new THREE.Vector3();

/**
 * Screen position (CSS px) of an enemy into `out` (x, y, onScreen); off-screen ones are
 * pushed out so edge arrows point right.
 */
function targetOnScreen(worldPos, out) {
  toCamera.copy(worldPos).applyMatrix4(camera.matrixWorldInverse);
  const inFront = toCamera.z < 0;
  if (!inFront) {
    out.x = innerWidth / 2 + toCamera.x * 1000;
    out.y = innerHeight / 2 - toCamera.y * 1000;
    out.onScreen = false;
    return out;
  }
  projected.copy(worldPos).project(camera);
  let x = (projected.x * 0.5 + 0.5) * innerWidth;
  let y = (-projected.y * 0.5 + 0.5) * innerHeight;
  const onScreen = Math.abs(projected.x) < 0.95 && Math.abs(projected.y) < 0.92;
  if (!onScreen) {
    x = innerWidth / 2 + (x - innerWidth / 2) * 10;
    y = innerHeight / 2 + (y - innerHeight / 2) * 10;
  }
  out.x = x;
  out.y = y;
  out.onScreen = onScreen;
  return out;
}

// HUD input, rebuilt in place every frame: the target and radar entries are pooled.
const hudTargets = [];
const hudRadar = [];
const targetPool = [];
const radarPool = [];
const hudState = { base: { dx: 0, dz: 0 }, targets: hudTargets, radar: hudRadar };

function hudTarget(n) {
  return (targetPool[n] ??= { x: 0, y: 0, onScreen: false, dist: 0, locked: false, b2: false, friendly: false, label: '' });
}

function hudContact(n) {
  return (radarPool[n] ??= { dx: 0, dz: 0, locked: false, b2: false, friendly: false, ground: false });
}

function hudData(p, stats, dt) {
  hudQuat.fromArray(p.quat);
  hudFwd.set(0, 0, -1).applyQuaternion(hudQuat);
  hudUp.set(0, 1, 0).applyQuaternion(hudQuat);
  hudRight.set(1, 0, 0).applyQuaternion(hudQuat);
  const deg = THREE.MathUtils.radToDeg;

  camera.updateMatrixWorld();
  const buf = sim.bots();
  let n = 0;
  for (let i = 0; i < sim.maxBots; i++) {
    const o = i * BOT.STRIDE;
    if (buf[o + BOT.ALIVE] <= 0 || buf[o + BOT.DETECTED] === 0) continue;
    botPos.fromArray(buf, o + BOT.CONTACT_POS);
    const locked = i === stats.lockTarget;
    const b2 = (buf[o + BOT.TYPE] | 0) === B2;
    const friendly = buf[o + BOT.FRIENDLY] > 0;
    const r = hudContact(n);
    r.dx = botPos.x - p.x;
    r.dz = botPos.z - p.z;
    r.locked = locked;
    r.b2 = b2;
    r.friendly = friendly;
    r.ground = false;
    const t = targetOnScreen(botPos, hudTarget(n));
    t.dist = Math.hypot(botPos.x - p.x, botPos.y - p.y, botPos.z - p.z);
    t.locked = locked;
    t.b2 = b2;
    t.friendly = friendly;
    const remote = buf[o + BOT.REMOTE] > 0;
    t.label = buf[o + BOT.DETECTED] < 0 ? 'MEM' : remote ? online.nameOf(i) : friendly ? 'ESCORT' : b2 ? 'B-2' : '';
    hudRadar[n] = r;
    hudTargets[n++] = t;
  }
  const gbuf = sim.ground();
  for (let i = 0; i < sim.maxGround; i++) {
    const o = i * GROUND.STRIDE;
    if (gbuf[o + GROUND.ALIVE] <= 0 || gbuf[o + GROUND.DETECTED] === 0) continue;
    botPos.fromArray(gbuf, o + GROUND.CONTACT_POS);
    const locked = stats.lockTarget === groundCode(i);
    const r = hudContact(n);
    r.dx = botPos.x - p.x;
    r.dz = botPos.z - p.z;
    r.locked = locked;
    r.b2 = r.friendly = false;
    r.ground = true;
    const t = targetOnScreen(botPos, hudTarget(n));
    t.dist = Math.hypot(botPos.x - p.x, botPos.y - p.y, botPos.z - p.z);
    t.locked = locked;
    t.b2 = t.friendly = false;
    t.label = gbuf[o + GROUND.DETECTED] < 0 ? 'MEM' : 'SAM';
    hudRadar[n] = r;
    hudTargets[n++] = t;
  }
  hudTargets.length = hudRadar.length = n;
  const def = AIRCRAFT[p.type];
  const s = hudState;
  s.p = p;
  s.stats = stats;
  s.dt = dt;
  s.pitchDeg = deg(Math.asin(THREE.MathUtils.clamp(hudFwd.y, -1, 1)));
  s.bankDeg = deg(Math.atan2(-hudRight.y, hudUp.y));
  s.headingDeg = (deg(Math.atan2(hudFwd.x, -hudFwd.z)) + 360) % 360;
  s.fovDeg = camera.fov;
  s.lockProgress = stats.lockProgress;
  s.cockpit = rig.cockpit;
  // Aircraft without a modelled cockpit get a drawn canopy frame instead.
  s.canopyFrame = rig.cockpit && !player.interior;
  s.invert = controls.invertPitch;
  s.base.dx = BASE.x - p.x;
  s.base.dz = BASE.z - p.z;
  s.maxMissiles = def.missiles;
  s.aircraftName = def.name;
  s.gearDown = player.gearDown;
  s.airbrake = controls.brake && !p.onGround;
  s.gStress = gforce.stress;
  s.gNegative = gforce.negative > gforce.positive;
  s.gUnconscious = gforce.unconscious;
  s.gRecovering = gforce.recoveryRemaining > 0;
  s.rank = career.rank.short;
  s.careerKills = career.kills;
  s.killcam = replay.playing;
  return s;
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

/** Per-frame feedback while flying: sounds, smoke, FOV, G effects and the HUD. */
function updateCockpit(p, stats, dt, frameDt, now) {
  if (!p.alive) controls.throttle = 0;
  sound.engine(p.engine, p.alive, p.type, rig.cockpit);
  flyby.update(sim.bots(), previousBots(), sim.maxBots, FIXED_STEP, camera, p.vel, sound, rig.cockpit);
  // Going supersonic: the shock passing over the airframe, a dull thump in the cockpit.
  if (p.alive && lastMach < 1 && p.mach >= 1) sound.boom(0, rig.cockpit);
  lastMach = p.mach;
  sound.airflow(p.speed, airflow.gust, airflow.buffet, rig.cockpit, p.alive);
  // Cannon sound follows actual rounds fired.
  if (p.ammo < lastAmmo) {
    gunSoundCooldown -= dt;
    if (gunSoundCooldown <= 0) {
      sound.gun();
      gunSoundCooldown = 0.06;
    }
    rig.holdShake(0.12);
  }
  lastAmmo = p.ammo;
  if (stats.lockTarget !== -1) sound.lockTone(stats.lockProgress, stats.lockProgress >= 1, now / 1000);
  if (p.alive) sound.rwr(stats.rwrLock, stats.missileWarn, stats.missileDist, now / 1000);
  // Same condition as the HUD's PULL UP warning: low and sinking fast.
  sound.pullUp(p.alive && !p.onGround && p.agl < 300 && p.verticalSpeed < -15, now / 1000);
  if (p.alive && p.hp / p.maxHp < 0.5) effects.damageSmoke(player.group.position, 1 - p.hp / p.maxHp);
  // Wider FOV at speed for a sense of velocity.
  const fov = (rig.cockpit ? 72 : 65) + Math.min(10, p.speed / 40);
  camera.fov += (fov - camera.fov) * Math.min(1, dt * 2);
  camera.updateProjectionMatrix();
  gforce.render();
  hud.draw(hudData(p, stats, frameDt));
}

/** Kill cam: show the recorded last seconds before the player went down, in slow motion. */
function renderKillcam(live, frameDt) {
  // The live crash's wreckage would be lying there before the replayed one is made.
  if (replay.elapsed === 0) wreckage.clear();
  const { frame: f, boom, dead } = replay.advance(frameDt);
  if (boom) {
    effects.explosion(replay.deathPos, 1.8);
    wreckage.breakup(player.group, f.player.vel);
    sound.explosion(0);
  }
  // f.player is the replay's own copy, decoded afresh on every advance(): safe to edit.
  if (dead) f.player.alive = false;
  player.update(f.player, false, frameDt);
  bots.update(f.bots, sim.maxBots, null, 1, frameDt);
  effects.updateTracers(sim.bullets(), 0);
  effects.updateMissiles(f.missiles, sim.maxMissiles);
  rig.killcamView(f.player, AIRCRAFT[f.player.type], dead ? replay.deathPos : null, frameDt);
}

/** Nothing to hear (menu): one shared empty list instead of a new one per frame. */
const NO_FLYBYS = [];

// ---------------------------------------------------------------------------
// Shadows and quality
// ---------------------------------------------------------------------------

/**
 * The shadow map is only re-rendered when it can have changed: the light moved with the
 * player, the player's aircraft moved, changed or was hidden, or something that moves is
 * near enough to cast into it. A slow refresh catches scenery that streams in (hangars,
 * city chunks). Flying, it still updates every frame; parked, in the menu or paused it
 * mostly does not.
 */
const SHADOW_REFRESH = 0.5;
/** Bots and SAM sites this close (m) to the player may cast into the shadow map. */
const SHADOW_MOVERS = 300;
const shadowPos = new THREE.Vector3();
const shadowQuat = new THREE.Quaternion();
let shadowGroup = null;
let shadowVisible = false;
let shadowGear = false;
let shadowAge = Infinity;
let shadowDirty = true;

function moversNear(pos) {
  const r2 = SHADOW_MOVERS * SHADOW_MOVERS;
  const buf = sim.bots();
  for (let i = 0; i < sim.maxBots; i++) {
    const o = i * BOT.STRIDE;
    if (buf[o + BOT.ALIVE] <= 0) continue;
    const dx = buf[o + BOT.POS] - pos.x;
    const dy = buf[o + BOT.POS + 1] - pos.y;
    const dz = buf[o + BOT.POS + 2] - pos.z;
    if (dx * dx + dy * dy + dz * dz < r2) return true;
  }
  const gbuf = sim.ground();
  for (let i = 0; i < sim.maxGround; i++) {
    const o = i * GROUND.STRIDE;
    if (gbuf[o + GROUND.ALIVE] <= 0) continue;
    const dx = gbuf[o + GROUND.POS] - pos.x;
    const dz = gbuf[o + GROUND.POS + 2] - pos.z;
    if (dx * dx + dz * dz < r2) return true;
  }
  return false;
}

function updateShadows(lightMoved, dt) {
  const g = player.group;
  shadowAge += dt;
  const dirty = shadowDirty || lightMoved || shadowAge >= SHADOW_REFRESH
    || g !== shadowGroup || g.visible !== shadowVisible || player.gearDown !== shadowGear
    || !g.position.equals(shadowPos) || !g.quaternion.equals(shadowQuat)
    || moversNear(g.position);
  if (!dirty) return;
  renderer.shadowMap.needsUpdate = true;
  shadowDirty = false;
  shadowAge = 0;
  shadowGroup = g;
  shadowVisible = g.visible;
  shadowGear = player.gearDown;
  shadowPos.copy(g.position);
  shadowQuat.copy(g.quaternion);
}

/** Quality hook (quality.js): resolution, shadows, post-processing and effect density. */
function applyQuality({ ratio, settings }) {
  if (renderer.getPixelRatio() !== ratio) {
    renderer.setPixelRatio(ratio);
    post?.setSize();
  }
  if (!world) return;
  world.setShadowQuality(settings.shadowSize);
  post.setQuality(settings);
  clouds.setDensity(settings.clouds);
  vapor.density = settings.effects;
  effects.density = settings.effects;
  vortices.range = settings.vortexRange;
  shadowDirty = true;
}

/**
 * Compile every material in the scene now (missiles, explosions, tracers, vapor and the
 * rest that are hidden in the menu), so their first appearance in a fight does not stall
 * a frame. The scene is compiled into the post-processing target, as PostFx renders
 * it, so the programs match the ones used later.
 */
async function precompile() {
  let ready = null;
  // compile() only walks visible objects; show the hidden ones (the missiles and their
  // plumes wait hidden in a pool) for the synchronous part of it.
  const hidden = [];
  scene.traverse((o) => {
    if (o.visible) return;
    hidden.push(o);
    o.visible = true;
  });
  renderer.setRenderTarget(post.target);
  try {
    // Without parallel compilation compileAsync only adds polling (and a console warning).
    const parallel = renderer.compileAsync && renderer.extensions.has('KHR_parallel_shader_compile');
    ready = parallel ? renderer.compileAsync(scene, camera) : renderer.compile(scene, camera);
    // The vapor joins the aircraft model on its first update.
    renderer.compile(vapor.mesh, camera, scene);
  } finally {
    for (const o of hidden) o.visible = false;
    renderer.setRenderTarget(null);
  }
  await ready;
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const elapsed = now - last;
  const frameDt = Math.min(MAX_FRAME, elapsed / 1000);
  const dt = Math.min(MAX_STEP, frameDt);
  last = now;
  // Browsers mostly stop animation frames in hidden tabs; where they do not, skip the work.
  if (state === 'loading' || document.hidden) return;
  quality.sample(elapsed, state === 'play' || state === 'menu');

  const run = running();
  /** Paused offline: the world stands still. */
  const frozen = state === 'pause' && !run;
  if (run) simulate(frameDt);
  online.tick(frameDt, state === 'play' || state === 'pause');
  const live = sim.player();
  // Respawned: the kill cam is over.
  if (replay.active && live.alive) replay.stop();
  // Shot down: the crash is shown live (wreck orbit) before the replay starts.
  if (replay.active && run) replay.tick(frameDt);
  const alpha = run ? accumulator / FIXED_STEP : 1;
  if (replay.playing && state === 'play') {
    vortices.clear();
    renderKillcam(live, frameDt);
  } else {
    const p = interpolatedPlayer(live, alpha);
    player.update(p, state === 'play' && rig.cockpit, frozen ? 0 : frameDt);
    playerLights.update(player.group, player.current.lights, player.gearDown, p.alive);
    if (!frozen) {
      bots.update(sim.bots(), sim.maxBots, previousBots(), alpha, frameDt);
      effects.updateTracers(sim.bullets(), sim.maxBullets);
      effects.updateMissiles(sim.missiles(), sim.maxMissiles);
    }
    rig.setAir(state === 'play' ? airflow.buffet : 0, p.gLoad);
    rig.update(p, AIRCRAFT[p.type], state === 'menu', dt);
    // Wingtip vortices and wing vapor freeze while paused.
    const wakeDt = run ? frameDt : 0;
    if (state === 'menu') vortices.clear();
    else vortices.update(p, sim.bots(), previousBots(), alpha, FIXED_STEP, sim.maxBots, camera.position, wakeDt);
    vapor.update(p, player.group, vortices.wing(p.type), state === 'play', wakeDt);
    clouds.update(camera.position, frozen ? 0 : frameDt);
    post.begin(frozen ? 0 : frameDt, clouds.inside);
    if (!rig.cockpit || state !== 'play') exhaustShimmer(p);
  }
  const flying = (state === 'play' || state === 'pause') && !replay.active;
  airflow.update(live, camera.position, flying, frozen ? 0 : frameDt);
  if (!frozen) {
    effects.updateFlares(sim.flares(), sim.maxFlares);
    groundTargets.update(sim.ground(), live, frameDt);
    effects.update(frameDt);
    wreckage.update(frameDt);
  }
  const lightMoved = world.follow(player.group.position);

  if (state === 'play') updateCockpit(live, sim.stats(), dt, frameDt, now);
  else sound.pullUp(false);
  if (state !== 'play' && state !== 'pause') {
    gforce.reset();
    sound.flyby(NO_FLYBYS, false);
  }
  updateShadows(lightMoved, frameDt);
  effects.draw(camera);
  post.render();
}

// ---------------------------------------------------------------------------
// Online
// ---------------------------------------------------------------------------

/**
 * Joined or left a room: back to the aircraft selection with the room's (or the player's
 * own) settings applied, so the next take-off starts from the right runway spot.
 */
function roomChanged() {
  lobby.render();
  // Also switches to the room's time of day, or back to the player's own.
  resetSim();
  if (state === 'play' || state === 'pause') setState('menu');
}

/** A pilot in the room went down; `victim` / `killer` may be online.me. */
function onlineDown(victim, killer) {
  const me = online.me;
  if (victim !== me) {
    // Their own client decided it; show the kill where we last saw them.
    const buf = sim.bots();
    const o = victim.slot * BOT.STRIDE;
    if (buf[o + BOT.ALIVE] > 0) {
      const pos = eventPos.set(buf[o + BOT.POS], buf[o + BOT.POS + 1], buf[o + BOT.POS + 2]);
      effects.explosion(pos, 1.4);
      bots.breakup(pos, wreckage);
      sound.explosion(pos.distanceTo(camera.position));
    }
  }
  if (killer === me && victim !== me) {
    hud.message(`YOU SHOT DOWN ${victim.name.toUpperCase()}`, COLORS.PRIMARY, 3);
    const promoted = career.addKill();
    if (promoted) hud.message(`PROMOTED · ${promoted.name.toUpperCase()}`, COLORS.WARN, 4);
  } else if (victim === me) {
    hud.message(killer ? `SHOT DOWN BY ${killer.name.toUpperCase()}` : 'YOU WENT DOWN', COLORS.DANGER, 4);
  } else {
    hud.message(killer ? `${killer.name} shot down ${victim.name}` : `${victim.name} went down`, COLORS.WARN, 3);
  }
}

const nozzleStart = new THREE.Vector3();
const nozzleEnd = new THREE.Vector3();

/** Heat shimmer behind the player's nozzles, longer and stronger with engine power. */
function exhaustShimmer(p) {
  if (!p.alive || p.engine < 0.1) return;
  const def = AIRCRAFT[p.type];
  const burn = afterburnerShare(def, p.engine);
  const length = 6 + p.engine * 12 + burn * 10;
  const strength = THREE.MathUtils.smoothstep(p.engine, 0.1, 0.8) * (0.15 + p.engine * 0.25 + burn * 0.6);
  player.group.updateMatrixWorld();
  camera.updateMatrixWorld();
  for (let i = 0; i < def.nozzles.length; i++) {
    const n = def.nozzles[i];
    player.group.localToWorld(nozzleStart.set(n[0], n[1], n[2]));
    player.group.localToWorld(nozzleEnd.set(n[0], n[1], n[2] + length));
    post.plume(nozzleStart, nozzleEnd, def.nozzleRadius, strength);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let menu;

/** Give the satellite tiles a moment (up to 6 s) so the menu backdrop is not blank. */
async function waitForTiles(tiles) {
  const t0 = performance.now();
  const done = () => tiles.loaded + tiles.failed;
  while (done() < tiles.total * 0.6 && performance.now() - t0 < 6000) {
    progress(0.75 + 0.25 * (done() / tiles.total));
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function boot() {
  try {
    progress(0.1, 'Loading WASM core and aircraft models…');
    setModelRenderer(renderer);
    // Independent downloads: fetch the core and the model catalogue in parallel.
    const [loadedSim, models] = await Promise.all([Sim.load(), loadAircraftModels()]);
    sim = loadedSim;
    rig.terrainHeight = (x, z) => sim.terrainHeight(x, z);
    models.onProgress = (key, loaded, total) => progress(0.4 + 0.35 * loaded / (total || 1));
    // Only the preselected aircraft's GLB now; the rest download when picked or met in the air.
    progress(0.4, `Model: ${AIRCRAFT[selected].name}`);
    await models.load(AIRCRAFT[selected].key);
    models.onChange = (key) => {
      if (menu && key === AIRCRAFT[selected].key) menu.show(selected);
    };
    progress(0.75, 'Loading Istanbul satellite imagery…');
    world = buildWorld(scene, renderer, sim);
    effects = new Effects(scene, sim.maxBullets, sim.maxMissiles);
    wreckage = new Wreckage(scene, effects, sim);
    airflow = new Airflow(scene);
    clouds = new Clouds(scene);
    post = new PostFx(renderer, scene, camera);
    vortices = new Vortices(scene, models);
    player = new PlayerAircraft(scene, models);
    playerLights = new PlayerLights(scene);
    bots = new BotAircraft(scene, models, effects);
    groundTargets = new GroundTargets(scene, sim.maxGround);
    menu = new Menu(models, selectAircraft, startGame);
    online = new Online(sim, {
      onChange: () => lobby?.render(),
      onJoin: (p) => hud.message(`${p.name} joined the room`, COLORS.PRIMARY, 3),
      onLeave: (p) => hud.message(`${p.name} left the room`, COLORS.WARN, 3),
      onDown: onlineDown,
      onClosed: (reason) => {
        hud.message(reason, COLORS.DANGER, 5);
        roomChanged();
      },
    });
    lobby = new Lobby(online, { onRoom: roomChanged });
    bindSettingsUi(sim);
    bindVolumeUi(sound);
    bindGraphics((mode) => quality.setMode(mode));
    bindTimeOfDay(showTimeOfDay);
    selectAircraft(selected);
    await Promise.all([waitForTiles(world.tiles), world.ready]);
    try {
      await precompile();
    } catch (e) {
      // Only a head start: anything left compiles on first use as before.
      console.warn('Shader precompile failed', e);
    }
    progress(1, 'Ready');
    window.__1923 = { sim, world, camera, scene, controls, airflow, vortices, vapor, clouds, post, rig, quality, renderer, effects, online };
    setState('menu');
    lobby.checkInvite();
    // Remaining aircraft download one by one while the player sits in the menu.
    models.prefetchIdle();
  } catch (e) {
    console.error(e);
    loadingText.textContent = `Load failed: ${e.message}. Serve the folder over HTTP (./build.sh serve) and reload.`;
  }
}

requestAnimationFrame(frame);
boot();
