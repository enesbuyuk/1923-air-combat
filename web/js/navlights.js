// Aircraft exterior lights: position lights (red on the left wingtip, green on the right,
// white on the tail), white anti-collision strobes on the wingtips that double-flash, a
// red beacon on the spine and, with the gear down, a landing light under the nose that
// shines forward. For the player they are also real lights (PlayerLights): the wingtips
// colour the airframe, the strobes flash it white and the landing light lights the ground.
//
// Each light is a glow sprite in linear HDR, brighter than white so it blooms (post.js).
// Sprites never shrink below a few pixels, so a distant aircraft still reads as points of
// light. They show at night only: by day the sun drowns them.

import * as THREE from 'three';
import { onTimeOfDay } from './atmosphere.js';

/** Smallest on-screen size of a light, as a share of the view height. */
const MIN_SCREEN = 0.012;
/** Strobe cycle (s): two short flashes, then dark. */
const STROBE_PERIOD = 1.2;
/** Beacon cycle (s). */
const BEACON_PERIOD = 1;

let night = false;
onTimeOfDay((on) => { night = on; });

let glowTex = null;
/**
 * A small hot core and a faint wide halo, both falling off smoothly to zero at the edge.
 * Lit far above white the core saturates into a crisp point while the halo stays soft;
 * a flat-topped gradient would saturate into a hard-edged disc instead.
 */
function glowTexture() {
  if (!glowTex) {
    const n = 128;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d');
    const img = g.createImageData(n, n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const r = Math.hypot(i + 0.5 - n / 2, j + 0.5 - n / 2) / (n / 2);
        const edge = Math.max(0, 1 - r * r) ** 2;
        const v = (Math.exp(-((r / 0.1) ** 2)) * 0.85 + Math.exp(-((r / 0.4) ** 2)) * 0.15) * edge;
        const o = (j * n + i) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
        img.data[o + 3] = Math.round(v * 255);
      }
    }
    g.putImageData(img, 0, 0);
    glowTex = new THREE.CanvasTexture(c);
  }
  return glowTex;
}

const RED = new THREE.Color(10, 0.5, 0.25);
const GREEN = new THREE.Color(0.4, 6, 1.4);
const WHITE = new THREE.Color(5, 5, 4.6);
const STROBE = new THREE.Color(24, 24, 27);
const BEACON = new THREE.Color(10, 0.7, 0.3);
const LANDING = new THREE.Color(18, 17, 15);

const pos = new THREE.Vector3();
const fwd = new THREE.Vector3();
const toCam = new THREE.Vector3();

function strobe(t) {
  const p = t % STROBE_PERIOD;
  return p < 0.05 || (p > 0.15 && p < 0.2) ? 1 : 0;
}

function beacon(t) {
  const p = (t % BEACON_PERIOD) / BEACON_PERIOD;
  return Math.max(0, Math.sin(p * Math.PI * 2)) ** 4;
}

/**
 * Keep the sprite at least MIN_SCREEN of the view tall and apply its blink / beam. Runs
 * after the world matrix is computed and before the renderer reads it, so it rescales
 * the matrix in place.
 */
function beforeRender(renderer, scene, camera) {
  const d = this.userData;
  const e = this.matrixWorld.elements;
  pos.set(e[12], e[13], e[14]);
  const dist = pos.distanceTo(camera.position);
  const fov = camera.isPerspectiveCamera ? Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * 2 : 1;
  const size = Math.max(d.size, dist * fov * MIN_SCREEN);
  for (let c = 0; c < 3; c++) {
    const len = Math.hypot(e[c * 4], e[c * 4 + 1], e[c * 4 + 2]) || 1;
    const k = size / len;
    e[c * 4] *= k;
    e[c * 4 + 1] *= k;
    e[c * 4 + 2] *= k;
  }
  const t = performance.now() / 1000 + d.phase;
  let level = d.blink ? d.blink(t) : 1;
  if (d.beam) {
    // Landing light: bright from ahead, faint from the side, gone from behind.
    const p = this.parent.matrixWorld.elements;
    fwd.set(-p[8], -p[9], -p[10]).normalize();
    toCam.subVectors(camera.position, pos).normalize();
    level *= 0.01 + 0.99 * Math.max(0, fwd.dot(toCam)) ** 6;
  }
  this.material.color.copy(d.color).multiplyScalar(level);
}

function sprite(root, color, [x, y, z], size, phase, blink = null, beam = false) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color: color.clone(), blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }));
  s.position.set(x, y, z);
  s.frustumCulled = false;
  s.renderOrder = 3;
  s.userData = { color, size, phase, blink, beam };
  s.onBeforeRender = beforeRender;
  root.add(s);
  return s;
}

/**
 * Add the lights to an aircraft instance. `wing`: wing.js measurements of its model,
 * `def`: aircraft.js entry. Returns the handle for updateLights().
 */
export function createLights(group, wing, def) {
  const root = new THREE.Group();
  root.visible = false;
  const [x, y, z] = wing.tip;
  const phase = Math.random() * 10;
  sprite(root, RED, [-x, y, z], 0.5, phase);
  sprite(root, GREEN, [x, y, z], 0.5, phase);
  sprite(root, STROBE, [-x, y, z + 0.3], 0.9, phase, strobe);
  sprite(root, STROBE, [x, y, z + 0.3], 0.9, phase, strobe);
  sprite(root, WHITE, wing.tail, 0.4, phase);
  sprite(root, BEACON, [0, wing.spine[1] + 0.1, wing.spine[2]], 0.5, phase * 1.7, beacon);
  const nose = Math.min(wing.rootLE, 0) - def.length * 0.12;
  const landing = sprite(root, LANDING, [0, y - 0.6, nose], 0.9, 0, null, true);
  group.add(root);
  return { root, landing, tip: wing.tip, phase };
}

/** Per frame: lights on at night, the landing light with the gear down. */
export function updateLights(lights, gearDown) {
  lights.root.visible = night;
  lights.landing.visible = gearDown;
}

/**
 * The player's lights as real lights: red and green wingtip lights that colour the wings
 * and flash white with the strobes, and a landing light that lights the runway ahead of
 * the nose on a night approach. They live in the scene from the start (adding lights
 * later would recompile every lit material) and are off by day.
 */
export class PlayerLights {
  constructor(scene) {
    this.landing = new THREE.SpotLight(0xfff4e0, 0, 0, 0.42, 0.5, 2);
    this.left = new THREE.PointLight(0xff2010, 0, 5, 2);
    this.right = new THREE.PointLight(0x30c058, 0, 5, 2);
    for (const l of [this.landing, this.left, this.right]) l.castShadow = false;
    scene.add(this.landing, this.landing.target, this.left, this.right);
  }

  /**
   * Follow aircraft `group` (nose toward -Z) with `lights` (its createLights() handle);
   * the landing light needs `gearDown`, everything needs `alive`.
   */
  update(group, lights, gearDown, alive) {
    const on = night && alive;
    const l = this.landing;
    l.intensity = on && gearDown ? 80000 : 0;
    const flash = on ? strobe(performance.now() / 1000 + lights.phase) : 0;
    this.left.intensity = this.right.intensity = on ? 2 + flash * 60 : 0;
    this.left.color.set(flash ? 0xffffff : 0xff2010);
    this.right.color.set(flash ? 0xffffff : 0x30c058);
    if (!on) return;
    group.updateMatrixWorld();
    const [x, y, z] = lights.tip;
    // Just outboard of the tips and a little above, so the light falls on the wing.
    this.left.position.set(-x - 0.3, y + 0.4, z).applyMatrix4(group.matrixWorld);
    this.right.position.set(x + 0.3, y + 0.4, z).applyMatrix4(group.matrixWorld);
    if (!l.intensity) return;
    l.position.set(0, -0.5, -3).applyMatrix4(group.matrixWorld);
    // Aimed a few degrees below the nose, where the runway is on an approach.
    l.target.position.set(0, -12, -100).applyMatrix4(group.matrixWorld);
    l.target.updateMatrixWorld();
  }
}
