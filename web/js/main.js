// Entry point: loads the WASM simulation core, builds the scene and runs the loop.
// All game logic (flight model, bots, weapons, collisions) lives in WASM; this
// file only feeds input in and renders the state the core exposes.

import * as THREE from 'three';
import { AIRCRAFT, B2 } from './aircraft.js';
import { loadAircraftModels } from './models.js';
import { buildWorld } from './world.js';
import { Effects } from './effects.js';
import { Hud, COLORS } from './hud.js';
import { Sound } from './audio.js';
import { Sim, BASE } from './sim.js';
import { BOT, GROUND, EVENT, MISSION, MODE, BUILDING_HIT, groundCode } from './layout.js';
import { applySettings, bindSettingsUi, bindVolumeUi } from './settings.js';
import { Controls } from './input.js';
import { GForce } from './gforce.js';
import { CameraRig } from './camera.js';
import { Menu } from './menu.js';
import { PlayerAircraft, BotAircraft } from './actors.js';
import { Career, renderCareer } from './career.js';
import { GroundTargets } from './ground.js';
import { Replay } from './replay.js';

/**
 * Fixed simulation step: the core always advances by exactly this much, so the outcome
 * does not depend on the frame rate. Rendering interpolates between the last two steps.
 */
const FIXED_STEP = 1 / 60;
/** Largest per-frame camera/effects step. */
const MAX_STEP = 0.05;
/** Real time simulated per frame at most, so slow devices still fly at real speed. */
const MAX_FRAME = 0.25;
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

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
let player;
let bots;
let groundTargets;
let lastAmmo = 0;
let gunSoundCooldown = 0;
/** Unsimulated time carried to the next frame, and the state one step back for interpolation. */
let accumulator = 0;
let prevPlayer = null;
let prevBots = null;
const replay = new Replay(1 / FIXED_STEP);

const controls = new Controls({
  inGame: () => state === 'play' || state === 'pause',
  flying: () => state === 'play',
  onKey,
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
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
  switch (code) {
    case 'KeyX':
      controls.missileQueued = true;
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
  }
}

function setState(s) {
  state = s;
  sound.setPaused(s === 'pause');
  controls.touch.setVisible(s === 'play');
  $('menu').classList.toggle('hidden', s !== 'menu');
  $('pause').classList.toggle('hidden', s !== 'pause');
  $('loading').classList.toggle('hidden', s !== 'loading');
  if (s === 'menu') hud.clear();
  if (s === 'menu' || s === 'pause') renderCareer(career);
  rig.setMenuFraming(s === 'menu');
}

/** Reset the core with the selected aircraft and the saved enemy settings. */
function resetSim() {
  sim.init(selected);
  applySettings(sim);
  accumulator = 0;
  prevPlayer = prevBots = null;
  replay.clear();
}

function selectAircraft(i) {
  selected = i;
  resetSim();
  player.select(i);
  menu.show(i);
}

function startGame() {
  sound.start();
  resetSim();
  controls.reset();
  lastAmmo = 0;
  hud.messages = [];
  hud.message(`${AIRCRAFT[selected].name} · 1923 runway 36`, COLORS.PRIMARY, 4);
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
  if (state !== 'menu') return;
  const n = Number(e.key);
  if (n >= 1 && n <= AIRCRAFT.length) selectAircraft(n - 1);
  if (e.key === 'Enter' && !e.repeat && !(document.activeElement instanceof HTMLButtonElement)) startGame();
});
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) navigator.keyboard?.unlock?.();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'play') setState('pause');
});
addEventListener('beforeunload', (e) => {
  if (state === 'play' || state === 'pause') e.preventDefault();
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

/**
 * Sweep the player from `from` to where the step left it, in radius-sized hops so fast
 * aircraft can't skip through a building between steps, and report the first hit.
 */
function checkBuildings(from) {
  const p = sim.player();
  if (!p.alive) return;
  const r = AIRCRAFT[p.type].hitRadius;
  const dx = p.x - from.x;
  const dy = p.y - from.y;
  const dz = p.z - from.z;
  const hops = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / r));
  for (let i = 1; i <= hops; i++) {
    const t = i / hops;
    const x = from.x + dx * t;
    const y = from.y + dy * t;
    const z = from.z + dz * t;
    const hit = world.collide(x, y, z, r);
    if (!hit) continue;
    const result = sim.buildingHit(x, y, z, hit);
    if (result === BUILDING_HIT.CRASH) hud.message('CRASHED INTO A BUILDING', COLORS.DANGER, 3);
    else if (result === BUILDING_HIT.SCRAPE) hud.message('Scraped a building', COLORS.WARN, 2);
    return;
  }
}

function handleEvent(e) {
  const pos = new THREE.Vector3(e.x, e.y, e.z);
  const distance = pos.distanceTo(camera.position);
  switch (e.type) {
    case EVENT.BOT_DESTROYED: {
      const b2 = e.extra === B2;
      effects.explosion(pos, b2 ? 2.6 : 1.4);
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
      // The kill cam replays the last seconds and plays the explosion at the right moment.
      replay.start(sim.stats().time, pos);
      if (!replay.active) {
        effects.explosion(pos, 1.8);
        sound.explosion(0);
      }
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
  controls.update(frameDt, gforce.unconscious);
  const input = controls.consume();
  sim.setInput(input);
  accumulator += frameDt;
  while (accumulator >= FIXED_STEP) {
    accumulator -= FIXED_STEP;
    const before = sim.player();
    prevPlayer = before;
    prevBots = Float32Array.from(sim.bots());
    sim.step(FIXED_STEP);
    if (before.alive) checkBuildings(before);
    // The core clears events on every step.
    sim.events().forEach(handleEvent);
    replay.record(sim.stats().time, sim.player(), sim.bots(), sim.missiles());
    // A queued missile is fired on the first step only.
    sim.setInput({ ...input, missile: false });
  }
}

/** The player pose `alpha` of the way from the previous step to the current one. */
function interpolatedPlayer(p, alpha) {
  const a = prevPlayer;
  if (!a || alpha >= 1 || Math.hypot(p.x - a.x, p.y - a.y, p.z - a.z) > TELEPORT) return p;
  hudQuat.set(...a.quat).slerp(lerpQuat.set(...p.quat), alpha);
  return {
    ...p,
    x: a.x + (p.x - a.x) * alpha,
    y: a.y + (p.y - a.y) * alpha,
    z: a.z + (p.z - a.z) * alpha,
    quat: [hudQuat.x, hudQuat.y, hudQuat.z, hudQuat.w],
  };
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

/** Screen position (CSS px) of an enemy; off-screen ones are pushed out so edge arrows point right. */
function targetOnScreen(worldPos) {
  toCamera.copy(worldPos).applyMatrix4(camera.matrixWorldInverse);
  const inFront = toCamera.z < 0;
  if (!inFront) {
    return { x: innerWidth / 2 + toCamera.x * 1000, y: innerHeight / 2 - toCamera.y * 1000, onScreen: false };
  }
  projected.copy(worldPos).project(camera);
  let x = (projected.x * 0.5 + 0.5) * innerWidth;
  let y = (-projected.y * 0.5 + 0.5) * innerHeight;
  const onScreen = Math.abs(projected.x) < 0.95 && Math.abs(projected.y) < 0.92;
  if (!onScreen) {
    x = innerWidth / 2 + (x - innerWidth / 2) * 10;
    y = innerHeight / 2 + (y - innerHeight / 2) * 10;
  }
  return { x, y, onScreen };
}

function hudData(p, stats, dt) {
  hudQuat.set(...p.quat);
  hudFwd.set(0, 0, -1).applyQuaternion(hudQuat);
  hudUp.set(0, 1, 0).applyQuaternion(hudQuat);
  hudRight.set(1, 0, 0).applyQuaternion(hudQuat);
  const deg = THREE.MathUtils.radToDeg;

  camera.updateMatrixWorld();
  const buf = sim.bots();
  const targets = [];
  const radar = [];
  for (let i = 0; i < sim.maxBots; i++) {
    const o = i * BOT.STRIDE;
    if (buf[o + BOT.ALIVE] <= 0) continue;
    botPos.fromArray(buf, o + BOT.POS);
    const locked = i === stats.lockTarget;
    const b2 = (buf[o + BOT.TYPE] | 0) === B2;
    const friendly = buf[o + BOT.FRIENDLY] > 0;
    const label = friendly ? 'ESCORT' : b2 ? 'B-2' : '';
    const dist = Math.hypot(botPos.x - p.x, botPos.y - p.y, botPos.z - p.z);
    radar.push({ dx: botPos.x - p.x, dz: botPos.z - p.z, locked, b2, friendly });
    targets.push({ ...targetOnScreen(botPos), dist, locked, b2, friendly, label });
  }
  const gbuf = sim.ground();
  for (let i = 0; i < sim.maxGround; i++) {
    const o = i * GROUND.STRIDE;
    if (gbuf[o + GROUND.ALIVE] <= 0) continue;
    botPos.fromArray(gbuf, o + GROUND.POS);
    const locked = stats.lockTarget === groundCode(i);
    const dist = Math.hypot(botPos.x - p.x, botPos.y - p.y, botPos.z - p.z);
    radar.push({ dx: botPos.x - p.x, dz: botPos.z - p.z, locked, ground: true });
    targets.push({ ...targetOnScreen(botPos), dist, locked, label: 'SAM' });
  }
  const def = AIRCRAFT[p.type];
  return {
    p, stats, dt, targets, radar,
    pitchDeg: deg(Math.asin(THREE.MathUtils.clamp(hudFwd.y, -1, 1))),
    bankDeg: deg(Math.atan2(-hudRight.y, hudUp.y)),
    headingDeg: (deg(Math.atan2(hudFwd.x, -hudFwd.z)) + 360) % 360,
    fovDeg: camera.fov,
    lockProgress: stats.lockProgress,
    cockpit: rig.cockpit,
    invert: controls.invertPitch,
    base: { dx: BASE.x - p.x, dz: BASE.z - p.z },
    maxMissiles: def.missiles,
    aircraftName: def.name,
    gearDown: player.gearDown,
    airbrake: controls.brake && !p.onGround,
    gStress: gforce.stress,
    rank: career.rank.short,
    careerKills: career.kills,
    killcam: replay.active,
  };
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

/** Per-frame feedback while flying: sounds, smoke, FOV, G effects and the HUD. */
function updateCockpit(p, stats, dt, frameDt, now) {
  if (!p.alive) controls.throttle = 0;
  sound.engine(p.engine, p.speed, p.alive, p.type);
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
  sound.pullUp(p.alive && !p.onGround && p.y < 300 && p.verticalSpeed < -15, now / 1000);
  if (p.alive && p.hp / p.maxHp < 0.5) effects.damageSmoke(player.group.position, 1 - p.hp / p.maxHp);
  // Wider FOV at speed for a sense of velocity.
  const fov = (rig.cockpit ? 72 : 65) + Math.min(10, p.speed / 40);
  camera.fov += (fov - camera.fov) * Math.min(1, dt * 2);
  camera.updateProjectionMatrix();
  gforce.update(p.gLoad, AIRCRAFT[p.type].gOnset, p.alive, frameDt);
  hud.draw(hudData(p, stats, frameDt));
}

/** Kill cam: show the recorded last seconds before the player went down, in slow motion. */
function renderKillcam(live, frameDt) {
  const { frame: f, boom, dead } = replay.advance(frameDt);
  if (boom) {
    effects.explosion(replay.deathPos, 1.8);
    sound.explosion(0);
  }
  player.update(dead ? { ...f.player, alive: false } : f.player, false);
  bots.update(f.bots, sim.maxBots);
  effects.updateTracers(sim.bullets(), 0);
  effects.updateMissiles(f.missiles, sim.maxMissiles);
  rig.killcamView(f.player, AIRCRAFT[f.player.type], dead ? replay.deathPos : null, frameDt);
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const frameDt = Math.min(MAX_FRAME, (now - last) / 1000);
  const dt = Math.min(MAX_STEP, frameDt);
  last = now;
  if (state === 'loading') return;

  if (state === 'play') simulate(frameDt);
  const live = sim.player();
  // Respawned: the kill cam is over.
  if (replay.active && live.alive) replay.stop();
  const alpha = state === 'play' ? accumulator / FIXED_STEP : 1;
  if (replay.active && state === 'play') {
    renderKillcam(live, frameDt);
  } else {
    const p = interpolatedPlayer(live, alpha);
    player.update(p, state === 'play' && rig.cockpit);
    if (state !== 'pause') {
      bots.update(sim.bots(), sim.maxBots, prevBots, alpha);
      effects.updateTracers(sim.bullets(), sim.maxBullets);
      effects.updateMissiles(sim.missiles(), sim.maxMissiles);
    }
    rig.update(p, AIRCRAFT[p.type], state === 'menu', dt);
  }
  if (state !== 'pause') {
    effects.updateFlares(sim.flares(), sim.maxFlares);
    groundTargets.update(sim.ground(), live, frameDt);
    effects.update(frameDt);
  }
  world.follow(player.group.position);

  if (state === 'play') updateCockpit(live, sim.stats(), dt, frameDt, now);
  else sound.pullUp(false);
  if (state !== 'play' && state !== 'pause') gforce.reset();
  renderer.render(scene, camera);
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
    progress(0.1, 'Loading WASM core…');
    sim = await Sim.load();
    progress(0.3, 'Preparing aircraft models…');
    const models = await loadAircraftModels((f, name) => progress(0.3 + f * 0.4, `Model: ${name}`));
    progress(0.75, 'Loading Istanbul satellite imagery…');
    world = buildWorld(scene, renderer);
    effects = new Effects(scene, sim.maxBullets, sim.maxMissiles);
    player = new PlayerAircraft(scene, models);
    bots = new BotAircraft(scene, models, effects);
    groundTargets = new GroundTargets(scene, sim.maxGround);
    menu = new Menu(models, selectAircraft, startGame);
    bindSettingsUi(sim);
    bindVolumeUi(sound);
    selectAircraft(selected);
    await waitForTiles(world.tiles);
    progress(1, 'Ready');
    window.__1923 = { sim, world, camera, scene, controls };
    setState('menu');
  } catch (e) {
    console.error(e);
    loadingText.textContent = `Load failed: ${e.message}. Serve the folder over HTTP (./build.sh serve) and reload.`;
  }
}

requestAnimationFrame(frame);
boot();
