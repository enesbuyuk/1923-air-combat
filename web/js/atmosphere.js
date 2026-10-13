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
// only to switch them on).

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

const glsl = (v) => v.toFixed(6);
const HAZE_RGB = new THREE.Color(HAZE_COLOR);

/**
 * GLSL helpers shared by the fog chunks and custom shaders (clouds): haze opacity for a
 * camera-to-point offset in world axes, and the haze colour seen in a direction.
 * Needs the `cameraPosition` uniform.
 */
export const HAZE_GLSL = /* glsl */ `
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
    return mix(vec3(${glsl(HAZE_RGB.r)}, ${glsl(HAZE_RGB.g)}, ${glsl(HAZE_RGB.b)}), vec3(${glsl(HAZE_SUN.r)}, ${glsl(HAZE_SUN.g)}, ${glsl(HAZE_SUN.b)}), sun * 0.55);
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
  // The FogExp2 uniforms are declared (three.js sets them) but the haze uses its own constants.
  c.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
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
  scene.fog = new THREE.FogExp2(HAZE_COLOR, HAZE_DENSITY);

  // Image-based lighting: metal and glass reflect the actual sky (and its sun glow)
  // instead of a flat ambient colour. The lower hemisphere gets an earth tone.
  const envScene = new THREE.Scene();
  const envSky = new THREE.Mesh(sky.geometry, sky.material);
  envSky.scale.copy(sky.scale);
  envScene.add(envSky);
  const ground = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, Math.PI / 2 + 0.02, Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x4a4a3c, side: THREE.BackSide }),
  );
  // Inside the sky box (half size 225 km), so the box does not hide it.
  ground.scale.setScalar(200000);
  envScene.add(ground);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, 0, 1, 500000).texture;
  pmrem.dispose();
  ground.geometry.dispose();
  ground.material.dispose();
  return { sky, sun: SUN };
}
