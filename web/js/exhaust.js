// Engine exhaust is a translucent gas volume, not a solid flame cone. Fighter
// engines show a plume from idle upwards; afterburner adds light
// and compression cells above the physical detent.
import * as THREE from 'three';
import { HAZE_GLSL } from './atmosphere.js';

// Keep the detent in sync with AFTERBURNER_DETENT in wasm/src/config.rs.
export function afterburnerShare(def, engine) {
  return def.afterburner ? Math.max(0, Math.min(1, (engine - 0.8) / 0.2)) : 0;
}

const VERTEX = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vLocal;
  varying vec3 vFogOffset;
  void main() {
    vLocal = position;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vFogOffset = world.xyz - cameraPosition;
    gl_Position = projectionMatrix * viewMatrix * world;
    #include <logdepthbuf_vertex>
  }
`;

const PLUME_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 eye;
  uniform float time;
  uniform float burn;
  uniform float heat;
  uniform float aspect;
  varying vec3 vLocal;
  varying vec3 vFogOffset;
  ${HAZE_GLSL}

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.13, 0.37, 0.73));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float noise(vec3 p) {
    vec3 cell = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(cell), hash(cell + vec3(1,0,0)), f.x),
                   mix(hash(cell + vec3(0,1,0)), hash(cell + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(cell + vec3(0,0,1)), hash(cell + vec3(1,0,1)), f.x),
                   mix(hash(cell + vec3(0,1,1)), hash(cell + vec3(1,1,1)), f.x), f.y), f.z);
  }
  void main() {
    #include <logdepthbuf_fragment>
    vec3 ray = normalize(vLocal - eye);
    // Avoid division by zero for a view exactly along the exhaust axis.
    vec3 safeRay = mix(vec3(-1.0), vec3(1.0), step(vec3(0.0), ray)) * max(abs(ray), vec3(1e-5));
    vec3 lo = (vec3(-1.0, -1.0, 0.0) - eye) / safeRay;
    vec3 hi = (vec3(1.0) - eye) / safeRay;
    vec3 nearT = min(lo, hi), farT = max(lo, hi);
    float entry = max(0.0, max(max(nearT.x, nearT.y), nearT.z));
    float exitT = min(min(farT.x, farT.y), farT.z);
    if (exitT <= entry) discard;
    float ds = (exitT - entry) / 32.0;
    // Account for the longer optical path when looking straight into the jet.
    float path = min(5.0, length(vec3(ray.xy, ray.z * aspect)));
    vec3 light = vec3(0.0);
    for (int i = 0; i < 32; i++) {
      vec3 p = eye + ray * (entry + (float(i) + 0.5) * ds);
      float t = clamp(p.z, 0.0, 1.0);
      // Compression cells stay attached to the nozzle. Turbulence convects aft.
      float cell = sin(t * aspect * 4.8 - 0.35);
      float radius = mix(0.78, 0.50, t) * (0.76 + 0.24 * abs(cell));
      radius *= 1.0 - 0.32 * smoothstep(0.55, 1.0, t);
      float n = noise(vec3(p.xy * 4.0, t * 11.0 - time * 12.0));
      vec2 bend = vec2(sin(t * 16.0 - time * 8.0), cos(t * 19.0 - time * 7.0));
      float r = length(p.xy + bend * t * t * 0.065);
      float edge = 1.0 - smoothstep(radius * (0.65 + n * 0.2), radius, r);
      float core = exp(-5.0 * r * r / max(radius * radius, 1e-3));
      float shock = pow(max(0.0, cell), 8.0) * core * (1.0 - 0.7 * t) * burn;
      float fade = (1.0 - smoothstep(0.60, 1.0, t)) * smoothstep(0.0, 0.025, t);
      float turbulence = mix(0.82, 0.3 + n, smoothstep(0.0, 0.8, t));
      vec3 violet = vec3(0.32, 0.36, 0.85) * core * 0.85;
      vec3 amber = vec3(1.0, 0.30, 0.065) * (0.24 + 0.25 * t) * (1.0 - core * 0.5);
      vec3 cells = vec3(1.0, 0.86, 1.0) * shock * 2.7;
      light += (violet + amber + cells) * edge * fade * turbulence * ds * path;
    }
    float pulse = 0.97 + 0.025 * sin(time * 37.0) + 0.015 * sin(time * 59.0);
    light *= (heat * 0.95 + burn * 1.4) * pulse;
    light *= (1.0 - hazeFactor(vFogOffset)) * smoothstep(0.7, 2.0, length(vFogOffset));
    gl_FragColor = vec4(light, 1.0);
  }
`;

const GLOW_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float power;
  uniform float burn;
  varying vec3 vLocal;
  varying vec3 vFogOffset;
  ${HAZE_GLSL}
  void main() {
    #include <logdepthbuf_fragment>
    float r = length(vLocal.xy) * 2.0;
    float mask = (1.0 - smoothstep(0.55, 1.0, r)) * exp(-1.5 * r * r);
    vec3 dryColor = mix(vec3(0.70, 0.13, 0.025), vec3(0.65, 0.35, 0.95), smoothstep(0.12, 0.8, power));
    vec3 dry = dryColor * (0.25 + power * 1.35) * (1.0 - burn);
    vec3 wet = vec3(1.8, 1.25, 1.65) * burn;
    gl_FragColor = vec4((dry + wet) * mask * (1.0 - hazeFactor(vFogOffset)), 1.0);
  }
`;

const volumeGeometry = new THREE.BoxGeometry(2, 2, 1).translate(0, 0, 0.5);
const glowGeometry = new THREE.PlaneGeometry(1, 1);

export function createExhaust(group, def) {
  return def.nozzles.map(([x, y, z], i) => {
    const nozzle = new THREE.Group();
    nozzle.position.set(x, y, z);
    nozzle.visible = false;
    const uniforms = {
      eye: { value: new THREE.Vector3() }, time: { value: i * 1.73 },
      power: { value: 0 }, burn: { value: 0 }, heat: { value: 0 }, aspect: { value: 1 },
    };
    const material = (fragmentShader, side) => new THREE.ShaderMaterial({
      uniforms, vertexShader: VERTEX, fragmentShader,
      transparent: true, depthWrite: false, side, blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const volume = new THREE.Mesh(volumeGeometry, material(PLUME_FRAGMENT, THREE.BackSide));
    // Calculate the camera in volume coordinates after the aircraft/camera matrices
    // have been updated by the renderer, including scaled/rotated GLB instances.
    volume.onBeforeRender = (_renderer, _scene, camera) => {
      uniforms.eye.value.setFromMatrixPosition(camera.matrixWorld);
      volume.worldToLocal(uniforms.eye.value);
    };
    const glow = new THREE.Mesh(glowGeometry, material(GLOW_FRAGMENT, THREE.DoubleSide));
    const width = def.nozzleRadius * 2;
    const flatten = def.nozzleAspect ?? 1;
    glow.scale.set(width * 0.9, width * 0.9 * flatten, 1);
    glow.position.z = 0.025;
    nozzle.add(volume, glow);
    nozzle.userData.exhaust = { uniforms, volume, glow };
    group.add(nozzle);
    return nozzle;
  });
}

/** Player and bots share exactly the same power-to-exhaust mapping. */
export function updateExhaust(nozzles, def, engine, altitude, dt, running = true) {
  const power = Math.max(0, Math.min(1, engine));
  const burn = afterburnerShare(def, power);
  // Partial-power visibility is an art setting; it does not light the physical
  // afterburner or change fuel flow, thrust, or the HUD's AB indication.
  const heat = def.afterburner ? 0.45 + 0.55 * power : 0;
  // A modest expansion in thinner air, an artistic approximation rather than CFD.
  const expansion = 1 + 0.22 * Math.max(0, Math.min(1, altitude / 16000));
  const radius = def.nozzleRadius * 1.25 * expansion;
  const length = def.nozzleRadius * (2.5 + 8.5 * power) * expansion;
  for (const nozzle of nozzles) {
    const { uniforms, volume, glow } = nozzle.userData.exhaust;
    uniforms.time.value += dt;
    uniforms.power.value = power;
    uniforms.burn.value = burn;
    uniforms.heat.value = heat;
    uniforms.aspect.value = length / radius;
    nozzle.visible = running;
    volume.visible = def.afterburner;
    volume.scale.set(radius, radius * (def.nozzleAspect ?? 1), length);
    // The B-2's shielded, non-afterburning exhaust has no exposed glowing disc.
    glow.visible = def.afterburner;
  }
}

export function disposeExhaust(nozzles) {
  for (const nozzle of nozzles) {
    for (const child of nozzle.children) child.material.dispose();
    nozzle.removeFromParent();
  }
}
