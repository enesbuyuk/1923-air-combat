// Wing geometry measured from an aircraft model's mesh: where the wingtips really are
// (the outermost vertices, not a guess) and the root chord, for the wingtip vortices
// and the wing vapor. Results are in the aircraft frame (metres, nose toward -Z).

import * as THREE from 'three';

/** Sample at most this many vertices per mesh; the extremes survive the thinning. */
const MAX_SAMPLES = 40000;

const cache = new Map();

/**
 * @param {{template: THREE.Object3D, def: object, version: number}} entry models.js registry entry
 * @returns {{span: number, tip: number[], tipTop: number, rootX: number, rootTop: number, rootLE: number, rootTE: number, tail: number[], nose: number[], spine: number[]}}
 *   tip: wingtip centre; tipTop / rootTop: upper wing surface height at the tip and at the root slice;
 *   tail: rearmost point on the centre line; nose: foremost one; spine: highest point on the centre line
 */
export function wingOf(entry) {
  const key = `${entry.def.key}:${entry.version}`;
  let wing = cache.get(key);
  if (!wing) {
    wing = measure(entry.template, entry.def);
    cache.set(key, wing);
  }
  return wing;
}

function measure(template, def) {
  template.updateMatrixWorld(true);
  const inv = template.matrixWorld.clone().invert();
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const xs = [];
  const ys = [];
  const zs = [];
  template.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes.position) return;
    // Exhaust volumes and other additive effect geometry are not airframe.
    if (o.material?.blending === THREE.AdditiveBlending) return;
    m.multiplyMatrices(inv, o.matrixWorld);
    const pos = o.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / MAX_SAMPLES));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      xs.push(Math.abs(v.x));
      ys.push(v.y);
      zs.push(v.z);
    }
  });

  let half = 0;
  for (const x of xs) half = Math.max(half, x);
  // The tip: centre of the outermost 3 % of the half span.
  let ty = 0;
  let tz = 0;
  let tipTop = -Infinity;
  let n = 0;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < half * 0.97) continue;
    ty += ys[i];
    tz += zs[i];
    tipTop = Math.max(tipTop, ys[i]);
    n++;
  }
  ty /= n || 1;
  tz /= n || 1;

  // Centre line (fuselage and fins): the rearmost, foremost and highest point.
  const tail = [0, 0, -Infinity];
  const nose = [0, 0, Infinity];
  const spine = [0, -Infinity, 0];
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] > half * 0.08) continue;
    if (zs[i] > tail[2]) { tail[1] = ys[i]; tail[2] = zs[i]; }
    if (zs[i] < nose[2]) { nose[1] = ys[i]; nose[2] = zs[i]; }
    if (ys[i] > spine[1]) { spine[1] = ys[i]; spine[2] = zs[i]; }
  }
  if (!Number.isFinite(tail[2])) tail.splice(0, 3, 0, ty, def.length / 2);
  if (!Number.isFinite(nose[2])) nose.splice(0, 3, 0, ty, -def.length / 2);
  if (!Number.isFinite(spine[1])) spine.splice(0, 3, 0, tipTop, tz);

  // Root chord: a slice at 35 % of the half span, near the wing's own height.
  const rootX = half * 0.35;
  const band = 0.6 + half * 0.05;
  let le = Infinity;
  let te = -Infinity;
  const heights = [];
  for (let i = 0; i < xs.length; i++) {
    if (Math.abs(xs[i] - rootX) > half * 0.05 || Math.abs(ys[i] - ty) > band) continue;
    le = Math.min(le, zs[i]);
    te = Math.max(te, zs[i]);
    heights.push(ys[i]);
  }
  // Upper wing surface: a high percentile of the slice, so a canted fin in it doesn't count.
  heights.sort((a, b) => a - b);
  let rootTop = heights[Math.floor(heights.length * 0.8)];
  if (!heights.length) {
    le = tz - def.length * 0.15;
    te = tz + def.length * 0.1;
    rootTop = tipTop;
  }
  // A tailplane right behind the wing would stretch the slice; real root chords stay under ~40 % of the length.
  te = Math.min(te, le + def.length * 0.4);
  return { span: half * 2, tip: [half, ty, tz], tipTop, rootX, rootTop, rootLE: le, rootTE: te, tail, nose, spine };
}
