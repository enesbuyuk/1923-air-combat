// Atmosphere: the sky dome, the sun, image-based lighting from the sky and an
// altitude-dependent haze (aerial perspective).
//
// Haze is a property of the air, not of the distance: it is densest near the ground and
// thins out exponentially with height. Looking along a ray from the camera, the amount of
// haze is the integral of that density along the ray, which has a closed form
// (density(h) = a·e^(-k·h)):
//
//   amount = a·e^(-k·h0) · (1 - e^(-k·dy·d)) / (k·dy)
//
// h0 the camera height, dy the ray's vertical direction, d the distance. So from the
// ground the horizon disappears in a bluish-grey murk while from high up the ground below
// stays clear and only the distant horizon washes out. Toward the sun the haze lights up
// (forward scattering by the aerosols).
//
// three.js' fog chunks are replaced for every built-in material (scene.fog is a FogExp2
// only to switch them on; its colour is the haze colour, so day and night can swap it).
//
// Time of day: the day sky is three.js' Sky; at night a dark dome with stars, a moon in
// the sun's place and the city's glow on the horizon replaces it, and the haze, the
// lights (world.js) and every unlit effect that depends on sunlight follow along
// (onTimeOfDay).

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

/** Sun direction: 38° above the horizon, south-south-west. */
export const SUN = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(52), THREE.MathUtils.degToRad(200));
/** Haze extinction at sea level (1/m): about 30 km visibility. */
const HAZE_DENSITY = 0.95e-4;
/** 1 / haze scale height (m): most of the haze sits in the lowest ~1.5 km. */
const HAZE_FALLOFF = 1 / 1500;
/** Haze colour away from the sun and the glow it takes on toward the sun. */
const HAZE_COLOR = 0xb4c4d6;
const HAZE_SUN = new THREE.Color(0xffe0b0);

/** Night haze: dark blue-grey, a little warmer than the sky above it (city light). */
const NIGHT_HAZE = new THREE.Color(0.03, 0.03, 0.04);
/** Moonlight relative to sunlight, for unlit shaders (clouds, smoke, vapour). */
const NIGHT_LIGHT = new THREE.Color(0.07, 0.085, 0.12);
const DAY_EXPOSURE = 0.9;
const NIGHT_EXPOSURE = 1.05;

const glsl = (v) => v.toFixed(6);
const HAZE_RGB = new THREE.Color(HAZE_COLOR);
// The glow toward the sun (moon) is a tint of the haze, so it follows the haze colour.
const HAZE_GLOW = [HAZE_SUN.r / HAZE_RGB.r, HAZE_SUN.g / HAZE_RGB.g, HAZE_SUN.b / HAZE_RGB.b];

const fog = new THREE.FogExp2(HAZE_COLOR, HAZE_DENSITY);

/**
 * Uniforms shared by the custom shaders: `fogColor` is the haze colour (the scene fog's
 * own colour object) and `sunlight` scales anything lit by the sun that is not a lit
 * material (white in daylight, dim blue under the moon).
 */
export const ATMOSPHERE = {
  fogColor: { value: fog.color },
  sunlight: { value: new THREE.Color(1, 1, 1) },
};

/**
 * GLSL helpers shared by the fog chunks and custom shaders (clouds): haze opacity for a
 * camera-to-point offset in world axes, and the haze colour seen in a direction.
 * Needs the `cameraPosition` uniform, and ATMOSPHERE.fogColor wherever hazeTint is used.
 */
export const HAZE_GLSL = /* glsl */ `
  uniform vec3 fogColor;
  float hazeFactor(vec3 offset) {
    const float k = ${glsl(HAZE_FALLOFF)};
    float dist = length(offset);
    float dy = offset.y / max(dist, 1e-3);
    float rise = k * dy * dist;
    float base = ${HAZE_DENSITY.toExponential(4)} * exp(-k * max(cameraPosition.y, 0.0));
    float amount = abs(rise) > 1e-4 ? base * (1.0 - exp(-rise)) / (k * dy) : base * dist;
    return 1.0 - exp(-amount);
  }
  vec3 hazeTint(vec3 dir) {
    float sun = pow(max(dot(dir, vec3(${glsl(SUN.x)}, ${glsl(SUN.y)}, ${glsl(SUN.z)})), 0.0), 6.0);
    return mix(fogColor, fogColor * vec3(${HAZE_GLOW.map(glsl).join(', ')}), sun * 0.55);
  }
`;

function installHaze() {
  const c = THREE.ShaderChunk;
  c.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vFogOffset;
#endif`;
  // mvPosition is in view space; its rotation is orthonormal, so v * viewMatrix rotates it back to world axes.
  c.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogOffset = (vec4(mvPosition.xyz, 0.0) * viewMatrix).xyz;
#endif`;
  // The FogExp2 uniforms are declared (three.js sets them); the haze takes its colour from
  // fogColor (declared in HAZE_GLSL) but its density from its own constants.
  c.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vFogOffset;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  ${HAZE_GLSL}
#endif`;
  c.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = hazeFactor(vFogOffset);
  #else
    float fogFactor = smoothstep(fogNear, fogFar, length(vFogOffset));
  #endif
  gl_FragColor.rgb = mix(gl_FragColor.rgb, hazeTint(normalize(vFogOffset)), fogFactor);
#endif`;
}

// Night sky, in linear HDR like the day sky. Stars sit in a 3D grid of cells around the
// view direction (at most one per cell, most cells empty) and fade out near the horizon;
// the moon takes the sun's place, so shadows and the haze glow need no second direction.
const NIGHT_VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
    #include <logdepthbuf_vertex>
  }
`;
const NIGHT_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 moon;
  varying vec3 vWorld;
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  void main() {
    #include <logdepthbuf_fragment>
    vec3 dir = normalize(vWorld - cameraPosition);
    float h = dir.y;
    vec3 zenith = vec3(0.0012, 0.002, 0.005);
    vec3 horizon = vec3(0.012, 0.017, 0.03);
    vec3 col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.45));
    // Light pollution: the city lights the haze low over the horizon.
    col += vec3(0.022, 0.014, 0.008) * exp(-max(h, 0.0) * 12.0);
    vec3 p = dir * 420.0;
    vec3 cell = floor(p);
    float pick = hash13(cell);
    if (pick > 0.975) {
      vec3 star = cell + vec3(hash13(cell + 17.0), hash13(cell + 43.0), hash13(cell + 71.0));
      float d = length(p - star);
      float bright = pow((pick - 0.975) / 0.025, 6.0) * 4.0 + 0.1;
      col += vec3(0.85, 0.9, 1.0) * bright * smoothstep(0.55, 0.0, d) * smoothstep(0.0, 0.2, h);
    }
    float m = dot(dir, moon);
    // Disc (about four times the real angular size, so it reads on screen) and halo.
    col += vec3(5.5, 5.3, 4.8) * smoothstep(0.99990, 0.99993, m);
    col += vec3(0.03, 0.04, 0.06) * pow(max(m, 0.0), 400.0) + vec3(0.006, 0.008, 0.012) * pow(max(m, 0.0), 12.0);
    gl_FragColor = vec4(col, 1.0);
  }
`;

let state = null;
let night = false;
const listeners = [];

/** Call `fn(night)` now and whenever the time of day changes. */
export function onTimeOfDay(fn) {
  listeners.push(fn);
  fn(night);
}

/** Switch between day (false) and night (true). Before buildAtmosphere it only sets the start. */
export function setTimeOfDay(on) {
  night = on;
  if (!state) return;
  const { scene, renderer, sky, nightSky } = state;
  sky.visible = !on;
  nightSky.visible = on;
  fog.color.copy(on ? NIGHT_HAZE : HAZE_RGB);
  ATMOSPHERE.sunlight.value.set(on ? NIGHT_LIGHT : 0xffffff);
  renderer.toneMappingExposure = on ? NIGHT_EXPOSURE : DAY_EXPOSURE;
  if (on && !state.nightEnv) state.nightEnv = environment(renderer, nightSky, 0x0a0a0c);
  scene.environment = on ? state.nightEnv : state.dayEnv;
  for (const fn of listeners) fn(on);
}

/**
 * Image-based lighting: metal and glass reflect the actual sky (and its sun glow)
 * instead of a flat ambient colour. The lower hemisphere gets an earth tone.
 */
function environment(renderer, sky, groundColor) {
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(sky.geometry, sky.material);
  envSky.scale.copy(sky.scale);
  envScene.add(envSky);
  const ground = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, Math.PI / 2 + 0.02, Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: groundColor, side: THREE.BackSide }),
  );
  // Inside the sky box (half size 225 km), so the box does not hide it.
  ground.scale.setScalar(200000);
  envScene.add(ground);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(envScene, 0, 1, 500000).texture;
  pmrem.dispose();
  ground.geometry.dispose();
  ground.material.dispose();
  return texture;
}

/**
 * Sky dome, haze and image-based lighting. Call before anything is rendered: the haze
 * replaces shader chunks, which only affects programs compiled afterwards.
 */
export function buildAtmosphere(scene, renderer) {
  installHaze();
  const sky = new Sky();
  sky.scale.setScalar(450000);
  const u = sky.material.uniforms;
  u.turbidity.value = 6;
  u.rayleigh.value = 1.6;
  u.mieCoefficient.value = 0.005;
  u.mieDirectionalG.value = 0.8;
  u.sunPosition.value.copy(SUN);
  scene.add(sky);
  scene.fog = fog;

  // Inside the day sky box, like the environment's ground.
  const nightSky = new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 24),
    new THREE.ShaderMaterial({
      uniforms: { moon: { value: SUN } },
      vertexShader: NIGHT_VERTEX,
      fragmentShader: NIGHT_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  nightSky.scale.setScalar(210000);
  nightSky.visible = false;
  scene.add(nightSky);

  state = { scene, renderer, sky, nightSky, dayEnv: environment(renderer, sky, 0x4a4a3c), nightEnv: null };
  scene.environment = state.dayEnv;
  if (night) setTimeOfDay(true);
  return { sky, nightSky, sun: SUN };
}
