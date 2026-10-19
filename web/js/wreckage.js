// Break-up of a destroyed aircraft: its model is cut into pieces (nose, cockpit section,
// wings, tail) that tumble away from the blast, burning, and fall to the ground.

import * as THREE from 'three';

/** Pieces in the air or on the ground at once; the oldest go first. */
const MAX_PIECES = 60;
const GRAVITY = 9.81;
/** Air drag on a tumbling piece (1/s): about 35 m/s terminal velocity. */
const DRAG = 0.28;
/** Seconds a piece lasts, and on the ground after landing (the last SINK of it sinking in). */
const LIFE = 30;
const GROUND_LIFE = 7;
const SINK = 2;
/** Time between a burning piece's trail puffs (s). */
const TRAIL_STEP = 0.05;

/**
 * Where the airframe parts, as fractions of its bounds (x right, y up, z aft; the nose is
 * at -z): every triangle goes to the nearest of these, jittered per type, so the wings,
 * tailplanes and fin come away from a fuselage broken in three.
 */
const CUTS = [
  [0, 0, -0.4], [0, 0, -0.15], [0, 0, 0.12], [0, 0.2, 0.4],
  [-0.3, 0, 0.12], [0.3, 0, 0.12], [-0.45, 0, 0.2], [0.45, 0, 0.2],
  [-0.2, 0, 0.42], [0.2, 0, 0.42],
];

/** The fracture of each model, keyed by its first mesh's geometry (shared by all clones). */
const fractures = new WeakMap();

function flightMeshes(group) {
  const meshes = [];
  group.traverse((o) => {
    if (o.isMesh) meshes.push(o);
  });
  return meshes;
}

/** Visible below `root`, and not an additive effect (the afterburner flames). */
function isAirframe(o, root) {
  const m = Array.isArray(o.material) ? o.material[0] : o.material;
  if (!m || m.blending === THREE.AdditiveBlending) return false;
  for (let n = o; n && n !== root; n = n.parent) if (!n.visible) return false;
  return true;
}

/**
 * Cut the model into cells: for each, its centre in the model's frame and its share of
 * every mesh's triangles as a geometry around that centre.
 */
function fracture(group, meshes) {
  group.updateMatrixWorld(true);
  const inv = group.matrixWorld.clone().invert();
  const rel = new THREE.Matrix4();
  const nrm = new THREE.Matrix3();
  const box = new THREE.Box3();
  const a = new THREE.Vector3();
  const tri = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  // Every airframe triangle in the model's frame.
  const soup = [];
  meshes.forEach((mesh, index) => {
    if (!isAirframe(mesh, group) || mesh.isInstancedMesh || mesh.isSkinnedMesh) return;
    const g = mesh.geometry;
    const pos = g.attributes.position;
    if (!pos) return;
    const normal = g.attributes.normal;
    const uv = g.attributes.uv;
    rel.multiplyMatrices(inv, mesh.matrixWorld);
    nrm.getNormalMatrix(rel);
    const count = g.index ? g.index.count : pos.count;
    const p = new Float32Array(count * 3);
    const n = normal ? new Float32Array(count * 3) : null;
    const t = uv ? new Float32Array(count * 2) : null;
    for (let k = 0; k < count; k++) {
      const v = g.index ? g.index.getX(k) : k;
      a.fromBufferAttribute(pos, v).applyMatrix4(rel);
      a.toArray(p, k * 3);
      box.expandByPoint(a);
      if (n) a.fromBufferAttribute(normal, v).applyMatrix3(nrm).normalize().toArray(n, k * 3);
      if (t) { t[k * 2] = uv.getX(v); t[k * 2 + 1] = uv.getY(v); }
    }
    soup.push({ index, p, n, t, count: count - (count % 3) });
  });
  if (box.isEmpty()) return [];

  const size = box.getSize(new THREE.Vector3());
  const mid = box.getCenter(new THREE.Vector3());
  const seeds = CUTS.map(([x, y, z]) => new THREE.Vector3(
    mid.x + (x + (Math.random() - 0.5) * 0.08) * size.x,
    mid.y + y * size.y,
    mid.z + (z + (Math.random() - 0.5) * 0.08) * size.z,
  ));

  const cells = seeds.map(() => ({ center: new THREE.Vector3(), parts: [], radius: 0 }));
  const cellBox = seeds.map(() => new THREE.Box3());
  // Per mesh: which cell each triangle goes to.
  for (const s of soup) {
    s.cell = new Uint8Array(s.count / 3);
    for (let f = 0; f < s.count / 3; f++) {
      a.set(0, 0, 0);
      for (let c = 0; c < 3; c++) a.add(tri[c].fromArray(s.p, (f * 3 + c) * 3));
      a.multiplyScalar(1 / 3);
      let best = 0;
      let bestD = Infinity;
      for (let k = 0; k < seeds.length; k++) {
        const d = a.distanceToSquared(seeds[k]);
        if (d < bestD) { bestD = d; best = k; }
      }
      s.cell[f] = best;
      for (let c = 0; c < 3; c++) cellBox[best].expandByPoint(tri[c]);
    }
  }
  cells.forEach((cell, k) => {
    if (cellBox[k].isEmpty()) return;
    cellBox[k].getCenter(cell.center);
    cell.radius = cellBox[k].getSize(a).length() / 2;
  });

  // One geometry per (cell, mesh), its vertices around the cell's centre.
  for (const s of soup) {
    for (let k = 0; k < cells.length; k++) {
      let faces = 0;
      for (let f = 0; f < s.cell.length; f++) if (s.cell[f] === k) faces++;
      if (!faces) continue;
      const c = cells[k].center;
      const p = new Float32Array(faces * 9);
      const n = s.n && new Float32Array(faces * 9);
      const t = s.t && new Float32Array(faces * 6);
      let w = 0;
      for (let f = 0; f < s.cell.length; f++) {
        if (s.cell[f] !== k) continue;
        for (let v = f * 3; v < f * 3 + 3; v++, w++) {
          p[w * 3] = s.p[v * 3] - c.x;
          p[w * 3 + 1] = s.p[v * 3 + 1] - c.y;
          p[w * 3 + 2] = s.p[v * 3 + 2] - c.z;
          if (n) n.set(s.n.subarray(v * 3, v * 3 + 3), w * 3);
          if (t) t.set(s.t.subarray(v * 2, v * 2 + 2), w * 2);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      if (n) g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
      else g.computeVertexNormals();
      if (t) g.setAttribute('uv', new THREE.BufferAttribute(t, 2));
      cells[k].parts.push({ index: s.index, geometry: g });
    }
  }
  return cells.filter((c) => c.parts.length);
}

export class Wreckage {
  constructor(scene, effects, terrain = null) {
    this.scene = scene;
    this.effects = effects;
    this.terrain = terrain;
    this.pieces = [];
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this._p = new THREE.Vector3();
  }

  /**
   * Break `group` (an aircraft model in its last pose) apart; `vel` is its velocity
   * (m/s), which the pieces keep on top of what the blast gives them.
   */
  breakup(group, vel) {
    const meshes = flightMeshes(group);
    if (!meshes.length) return;
    const key = meshes[0].geometry;
    let cells = fractures.get(key);
    if (!cells) fractures.set(key, (cells = fracture(group, meshes)));
    group.updateMatrixWorld(true);
    group.getWorldQuaternion(this._q);
    for (const cell of cells) {
      const obj = new THREE.Group();
      for (const { index, geometry } of cell.parts) {
        const m = meshes[index].material;
        obj.add(new THREE.Mesh(geometry, Array.isArray(m) ? m[0] : m));
      }
      obj.position.copy(cell.center).applyMatrix4(group.matrixWorld);
      obj.quaternion.copy(this._q);
      this.scene.add(obj);
      // Thrown out from the blast at the centre, heavier (bigger) pieces less so.
      const out = this._v.subVectors(obj.position, group.position);
      const d = out.length();
      if (d > 1e-3) out.multiplyScalar(1 / d);
      else out.set(Math.random() - 0.5, Math.random(), Math.random() - 0.5).normalize();
      const kick = (12 + Math.random() * 22) / Math.sqrt(Math.max(1, cell.radius / 3));
      const v = new THREE.Vector3(vel[0], vel[1], vel[2]).addScaledVector(out, kick);
      v.x += (Math.random() - 0.5) * 8;
      v.y += Math.random() * 10;
      v.z += (Math.random() - 0.5) * 8;
      // Wings and tail flutter; the fuselage rolls slowly.
      const spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
        .normalize().multiplyScalar((0.6 + Math.random() * 2.5) / Math.sqrt(Math.max(1, cell.radius / 4)));
      this.pieces.push({
        obj, vel: v, spin, life: LIFE * (0.8 + Math.random() * 0.4), grounded: false,
        burn: 0.6 + Math.random() * 0.4, emit: 0, size: cell.radius,
      });
    }
    while (this.pieces.length > MAX_PIECES) this.remove(0);
  }

  remove(i) {
    this.scene.remove(this.pieces[i].obj);
    this.pieces.splice(i, 1);
  }

  clear() {
    while (this.pieces.length) this.remove(0);
  }

  update(dt) {
    const drag = Math.exp(-DRAG * dt);
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const s = this.pieces[i];
      s.life -= dt;
      if (s.life <= 0) { this.remove(i); continue; }
      const o = s.obj;
      if (!s.grounded) {
        s.vel.multiplyScalar(drag);
        s.vel.y -= GRAVITY * dt;
        o.position.addScaledVector(s.vel, dt);
        const len = s.spin.length();
        o.quaternion.premultiply(this._q.setFromAxisAngle(this._w.copy(s.spin).divideScalar(len), len * dt));
        const ground = (this.terrain?.terrainHeight(o.position.x, o.position.z) ?? 0) + 0.5;
        if (o.position.y < ground) {
          o.position.y = ground;
          if (this.terrain?.terrainSurface(o.position.x, o.position.z) === 2) {
            s.grounded = true;
            s.wet = true;
            s.life = Math.min(s.life, SINK);
          }
          else if (s.vel.y < -6) {
            s.vel.set(s.vel.x * 0.4, -s.vel.y * 0.2, s.vel.z * 0.4);
            s.spin.multiplyScalar(0.5);
            this.effects.explosion(o.position, 0.3);
          } else {
            s.grounded = true;
            s.life = Math.min(s.life, GROUND_LIFE);
          }
        }
      } else if (s.life < SINK) {
        o.position.y -= (s.size + 1) * dt / SINK;
      }
      // Burns fiercely at first, then smoulders.
      s.burn = Math.max(0.15, s.burn - dt * 0.07);
      s.emit -= dt;
      if (s.emit <= 0 && !s.wet) {
        s.emit = TRAIL_STEP * (s.burn > 0.3 ? 1 : 2.5) / Math.max(0.25, this.effects.density);
        this.effects.burn(o.position, s.burn, Math.min(2.5, 0.6 + s.size / 4));
      }
    }
  }
}
