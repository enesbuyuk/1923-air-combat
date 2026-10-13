// Post-processing: the scene is rendered to an HDR target, then
//   1. air: heat shimmer behind the engines and the whiteout inside a cloud,
//   2. bloom: anything brighter than white (the sun, its glint on metal, afterburners)
//      bleeds light into its surroundings the way it does in a camera or the eye,
//   3. output: ACES tone mapping and sRGB, as the renderer would do on its own.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/** Exhaust plumes distorted at most per frame. */
const MAX_PLUMES = 4;
/**
 * Linear HDR luminance above which pixels bloom. The sky itself reaches ~3 near the
 * horizon, so only the sun, its glints and the afterburners get past this.
 */
const BLOOM_THRESHOLD = 5;
const BLOOM_STRENGTH = 0.45;
const BLOOM_RADIUS = 0.5;

const AirShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    aspect: { value: 1 },
    whiteout: { value: 0 },
    // Per plume: start and end (uv), then start / end half-width (uv height) and strength.
    plumeA: { value: Array.from({ length: MAX_PLUMES }, () => new THREE.Vector4()) },
    plumeB: { value: Array.from({ length: MAX_PLUMES }, () => new THREE.Vector3()) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float aspect;
    uniform float whiteout;
    uniform vec4 plumeA[${MAX_PLUMES}];
    uniform vec3 plumeB[${MAX_PLUMES}];
    varying vec2 vUv;
    void main() {
      vec2 off = vec2(0.0);
      vec2 sq = vec2(aspect, 1.0);
      for (int i = 0; i < ${MAX_PLUMES}; i++) {
        float strength = plumeB[i].z;
        if (strength <= 0.0) continue;
        vec2 p = (vUv - plumeA[i].xy) * sq;
        vec2 ab = (plumeA[i].zw - plumeA[i].xy) * sq;
        float t = clamp(dot(p, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
        float d = length(p - ab * t);
        float w = mix(plumeB[i].x, plumeB[i].y, t);
        // Strongest just behind the nozzle, gone by the end of the plume.
        float mask = (1.0 - smoothstep(0.0, w, d)) * smoothstep(0.0, 0.06, t) * (1.0 - t);
        // Rising, swirling hot air: noise travelling down the plume.
        vec2 q = p / max(w, 1e-3) * 2.5;
        float along = t * 18.0 - time * 14.0;
        vec2 n = vec2(sin(along + q.x * 3.1 + sin(q.y * 2.3 + time * 7.0)),
                      cos(along * 1.3 + q.y * 2.7 - sin(q.x * 1.7 - time * 5.0)));
        off += n * mask * strength;
      }
      vec4 c = texture2D(tDiffuse, vUv + off);
      // Inside a cloud: diffuse white light from every side, the world all but gone.
      c.rgb = mix(c.rgb, vec3(1.25, 1.28, 1.32), whiteout);
      gl_FragColor = c;
    }
  `,
};

const a = new THREE.Vector3();
const b = new THREE.Vector3();
const view = new THREE.Vector3();

export class PostFx {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.camera = camera;
    this._size = new THREE.Vector2();
    const size = renderer.getDrawingBufferSize(this._size);
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.air = new ShaderPass(AirShader);
    this.composer.addPass(this.air);
    // Bloom at half resolution: it is a blur anyway.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.plumes = 0;
    this.time = 0;
  }

  /**
   * Match the renderer's size and pixel ratio (after a resize or a resolution change).
   * The targets take the canvas' own pixel size: with a fractional pixel ratio (dynamic
   * resolution, quality.js) CSS size times ratio is not a whole number of pixels.
   */
  setSize() {
    const size = this.renderer.getDrawingBufferSize(this._size);
    this.composer.setPixelRatio(1);
    this.composer.setSize(size.x, size.y);
  }

  /**
   * Quality hooks (quality.js): `bloom` on / off, `samples` MSAA samples of the scene
   * target. Changing the sample count re-creates the targets, so it is skipped when equal.
   */
  setQuality({ bloom, samples }) {
    this.bloom.enabled = bloom;
    for (const t of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (t.samples === samples) continue;
      t.samples = samples;
      t.dispose();
    }
  }

  /** Start a frame: clears the plume list. `whiteout` 0..1 (Clouds.inside). */
  begin(dt, whiteout) {
    this.time += dt;
    const u = this.air.uniforms;
    u.time.value = this.time;
    u.aspect.value = this.camera.aspect;
    u.whiteout.value = whiteout * 0.92;
    for (const v of u.plumeB.value) v.z = 0;
    this.plumes = 0;
  }

  /**
   * Heat shimmer along an exhaust plume from `start` to `end` (world), `radius` (m) at
   * the nozzle widening downstream, `strength` 0..1.
   */
  plume(start, end, radius, strength) {
    if (this.plumes >= MAX_PLUMES || strength <= 0) return;
    const cam = this.camera;
    // Skip plumes behind the camera or too far away to see the shimmer.
    view.copy(start).applyMatrix4(cam.matrixWorldInverse);
    const depth = -view.z;
    if (depth < 1 || depth > 600) return;
    a.copy(start).project(cam);
    b.copy(end).project(cam);
    if (b.z > 1) return;
    const scale = 1 / (2 * depth * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
    const u = this.air.uniforms;
    const i = this.plumes++;
    u.plumeA.value[i].set(a.x * 0.5 + 0.5, a.y * 0.5 + 0.5, b.x * 0.5 + 0.5, b.y * 0.5 + 0.5);
    // The shimmer fades with distance: fewer pixels of hot air.
    const fade = 1 - THREE.MathUtils.smoothstep(depth, 150, 600);
    u.plumeB.value[i].set(radius * 1.4 * scale, radius * 4 * scale, 0.0035 * strength * fade);
  }

  render() {
    // With no plume and no whiteout the air pass would copy the image unchanged: skip it.
    const u = this.air.uniforms;
    this.air.enabled = this.plumes > 0 || u.whiteout.value > 0;
    this.composer.render();
  }
}
