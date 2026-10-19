// Post-processing: the scene is rendered to a multisampled HDR target, then
//   1. bloom: anything brighter than white (the sun, its glint on metal, afterburners)
//      bleeds light into its surroundings the way it does in a camera or the eye; it is
//      blurred at quarter resolution and kept in its own texture,
//   2. output, one full-screen pass to the canvas: heat shimmer behind the engines, the
//      whiteout inside a cloud, the bloom added on top, ACES tone mapping and sRGB.
//
// Only the scene render is multisampled. Every full-screen pass that writes into a
// multisampled target pays for all its samples and for another resolve afterwards (a
// bloom blended back into the scene target cost more than the scene itself), so nothing
// but the scene ever does, and the image is resolved exactly once.

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/** Exhaust plumes distorted at most per frame. */
const MAX_PLUMES = 4;
/**
 * Linear HDR luminance above which pixels bloom. The sky itself reaches ~3 near the
 * horizon, so only the sun, its glints and the afterburners get past this.
 */
const BLOOM_THRESHOLD = 5;
const BLOOM_STRENGTH = 0.45;
const BLOOM_RADIUS = 0.5;
/**
 * Above this pixel ratio a pixel is small enough that 2× MSAA looks as smooth as 4×,
 * at half the cost of the most expensive target in the frame.
 */
const DENSE_RATIO = 1.25;

// A raw shader: a plain ShaderMaterial would get the renderer's own tone mapping
// declarations prepended, clashing with the ones included here.
const OutputShader = {
  uniforms: {
    tDiffuse: { value: null },
    tBloom: { value: null },
    bloom: { value: 1 },
    toneMappingExposure: { value: 1 },
    time: { value: 0 },
    aspect: { value: 1 },
    whiteout: { value: 0 },
    plumes: { value: 0 },
    // Per plume: start and end (uv), then start / end half-width (uv height) and strength.
    plumeA: { value: Array.from({ length: MAX_PLUMES }, () => new THREE.Vector4()) },
    plumeB: { value: Array.from({ length: MAX_PLUMES }, () => new THREE.Vector3()) },
  },
  vertexShader: /* glsl */ `
    precision highp float;
    uniform mat4 modelViewMatrix;
    uniform mat4 projectionMatrix;
    attribute vec3 position;
    attribute vec2 uv;
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform sampler2D tBloom;
    uniform float bloom;
    uniform float time;
    uniform float aspect;
    uniform float whiteout;
    uniform int plumes;
    uniform vec4 plumeA[${MAX_PLUMES}];
    uniform vec3 plumeB[${MAX_PLUMES}];
    varying vec2 vUv;
    #include <tonemapping_pars_fragment>
    #include <colorspace_pars_fragment>
    void main() {
      vec2 off = vec2(0.0);
      vec2 sq = vec2(aspect, 1.0);
      for (int i = 0; i < ${MAX_PLUMES}; i++) {
        if (i >= plumes) break;
        float strength = plumeB[i].z;
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
      // Inside a cloud: diffuse white light from every side, the world all but gone,
      // and with it the glare of anything bright behind the cloud.
      c.rgb = mix(c.rgb, vec3(1.25, 1.28, 1.32), whiteout);
      c.rgb += texture2D(tBloom, vUv).rgb * (bloom * (1.0 - whiteout));
      c.rgb = ACESFilmicToneMapping(c.rgb);
      gl_FragColor = sRGBTransferOETF(vec4(c.rgb, 1.0));
    }
  `,
};

const a = new THREE.Vector3();
const b = new THREE.Vector3();
const view = new THREE.Vector3();

export class PostFx {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this._size = new THREE.Vector2();
    const size = renderer.getDrawingBufferSize(this._size);
    /** The scene in linear HDR; precompile (main.js) compiles into it. */
    this.target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    // Only its passes and targets are used (render() is not): the bloom stays in its own
    // texture instead of being blended back into the scene.
    this.bloom = new UnrealBloomPass(size.clone().multiplyScalar(0.5), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
    this.bloomOn = true;
    this.output = new THREE.RawShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(OutputShader.uniforms),
      vertexShader: OutputShader.vertexShader,
      fragmentShader: OutputShader.fragmentShader,
      defines: { ACES_FILMIC_TONE_MAPPING: '', SRGB_TRANSFER: '' },
      depthTest: false,
      depthWrite: false,
    });
    this.output.uniforms.tDiffuse.value = this.target.texture;
    this.output.uniforms.tBloom.value = this.bloom.renderTargetsHorizontal[0].texture;
    this.quad = new FullScreenQuad(this.output);
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
    this.target.setSize(size.x, size.y);
    // Bloom at quarter resolution (it halves this again): it is a blur anyway.
    this.bloom.setSize(size.x / 2, size.y / 2);
  }

  /**
   * Quality hooks (quality.js): `bloom` on / off, `samples` MSAA samples of the scene
   * target (fewer on a dense screen, DENSE_RATIO). Changing the sample count re-creates
   * the target, so it is skipped when equal. Call after the pixel ratio is set.
   */
  setQuality({ bloom, samples }) {
    this.bloomOn = bloom;
    if (this.renderer.getPixelRatio() >= DENSE_RATIO) samples = Math.min(samples, 2);
    if (this.target.samples === samples) return;
    this.target.samples = samples;
    this.target.dispose();
  }

  /** Start a frame: clears the plume list. `whiteout` 0..1 (Clouds.inside). */
  begin(dt, whiteout) {
    this.time += dt;
    const u = this.output.uniforms;
    u.time.value = this.time;
    u.aspect.value = this.camera.aspect;
    u.whiteout.value = whiteout * 0.92;
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
    const u = this.output.uniforms;
    const i = this.plumes++;
    u.plumeA.value[i].set(a.x * 0.5 + 0.5, a.y * 0.5 + 0.5, b.x * 0.5 + 0.5, b.y * 0.5 + 0.5);
    // The shimmer fades with distance: fewer pixels of hot air.
    const fade = 1 - THREE.MathUtils.smoothstep(depth, 150, 600);
    u.plumeB.value[i].set(radius * 1.4 * scale, radius * 4 * scale, 0.0035 * strength * fade);
  }

  /**
   * The bright parts of the scene, blurred into a chain of ever smaller targets and
   * summed into bloom.renderTargetsHorizontal[0] (quarter resolution), as UnrealBloomPass
   * does up to the point where it would blend that back over the scene.
   */
  renderBloom() {
    const r = this.renderer;
    const p = this.bloom;
    const quad = p.fsQuad;
    p.highPassUniforms.tDiffuse.value = this.target.texture;
    p.highPassUniforms.luminosityThreshold.value = p.threshold;
    quad.material = p.materialHighPassFilter;
    r.setRenderTarget(p.renderTargetBright);
    quad.render(r);
    let input = p.renderTargetBright;
    for (let i = 0; i < p.nMips; i++) {
      const blur = p.separableBlurMaterials[i];
      quad.material = blur;
      blur.uniforms.colorTexture.value = input.texture;
      blur.uniforms.direction.value = UnrealBloomPass.BlurDirectionX;
      r.setRenderTarget(p.renderTargetsHorizontal[i]);
      quad.render(r);
      blur.uniforms.colorTexture.value = p.renderTargetsHorizontal[i].texture;
      blur.uniforms.direction.value = UnrealBloomPass.BlurDirectionY;
      r.setRenderTarget(p.renderTargetsVertical[i]);
      quad.render(r);
      input = p.renderTargetsVertical[i];
    }
    quad.material = p.compositeMaterial;
    p.compositeMaterial.uniforms.bloomStrength.value = p.strength;
    p.compositeMaterial.uniforms.bloomRadius.value = p.radius;
    r.setRenderTarget(p.renderTargetsHorizontal[0]);
    quad.render(r);
  }

  render() {
    const r = this.renderer;
    r.setRenderTarget(this.target);
    r.render(this.scene, this.camera);
    if (this.bloomOn) this.renderBloom();
    const u = this.output.uniforms;
    u.tDiffuse.value = this.target.texture;
    u.bloom.value = this.bloomOn ? 1 : 0;
    u.plumes.value = this.plumes;
    u.toneMappingExposure.value = r.toneMappingExposure;
    r.setRenderTarget(null);
    this.quad.render(r);
  }
}
