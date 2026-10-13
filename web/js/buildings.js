// Real buildings around 1923 from OpenStreetMap (see tools/fetch_osm_buildings.py):
// footprints are extruded to their height and merged into one mesh per grid cell, with a
// tiling window texture on the walls and per-type colours.
// Building data (c) OpenStreetMap contributors, ODbL.
import * as THREE from 'three';
import { footprint } from './collision.js';

const CELL = 750; // metres per merged mesh, so off-screen cells are frustum-culled
const FLOOR = 3.1; // metres per window row
const BAY = 3.6; // metres per window column

// [wall colours, roof colours] per kind: residential, industrial, commercial, religious, other.
const PALETTE = [
  [[0xeadfcb, 0xdccbb2, 0xf2e9da, 0xcdbb9f, 0xe6d3c3, 0xd8d2c4], [0xa85a42, 0x9a958c, 0xb36b4f, 0x8f8a82]],
  [[0xbcc0c4, 0xa9afb5, 0xc4beb2], [0x8d949b, 0x7f8790]],
  [[0xd2d8de, 0xa8bccd, 0xc9ccd0], [0x8a8f94, 0x7d8388]],
  [[0xf0ece4], [0x7e8a92]],
  [[0xc8c0b0, 0xb5ad9e], [0x8a8478, 0x96887a]],
];

/** White wall texture with one window per tile; the corner stays white for roofs. */
function windowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, 64, 64);
  x.fillStyle = '#4a5866';
  x.fillRect(16, 18, 32, 30);
  x.fillStyle = '#6d7f90';
  x.fillRect(16, 18, 32, 8);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function hash(i) {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

class CellBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.col = [];
    this.idx = [];
    this.count = 0;
  }
  /** Add a vertex; returns its index. Normals and colours are stored as normalized bytes. */
  vert(x, y, z, nx, ny, nz, u, v, c) {
    this.pos.push(x, y, z);
    this.nrm.push(Math.round(nx * 127), Math.round(ny * 127), Math.round(nz * 127));
    this.uv.push(u, v);
    this.col.push(Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255));
    return this.count++;
  }
  tri(a, b, c) {
    this.idx.push(a, b, c);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(this.nrm), 3, true));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(this.col), 3, true));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

function addBuilding(b, pts, h, wall, roof, base) {
  const n = pts.length;
  // Walls: outward normal of edge a->b is (-dz, 0, dx) when the outline is clockwise
  // in x/z (negative shoelace sum), so flip anything wound the other way.
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % n];
    area2 += x0 * z1 - x1 * z0;
  }
  if (area2 > 0) pts.reverse();
  const top = base + h;
  const vTop = h / FLOOR;
  let u = 0;
  for (let i = 0; i < n; i++) {
    const [x0, z0] = pts[i];
    const [x1, z1] = pts[(i + 1) % n];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const nx = -dz / len;
    const nz = dx / len;
    // Snap the window count per wall so windows don't get cut at corners.
    const u1 = u + Math.max(1, Math.round(len / BAY));
    const a0 = b.vert(x0, base, z0, nx, 0, nz, u, 0, wall);
    const b0 = b.vert(x1, base, z1, nx, 0, nz, u1, 0, wall);
    const b1 = b.vert(x1, top, z1, nx, 0, nz, u1, vTop, wall);
    const a1 = b.vert(x0, top, z0, nx, 0, nz, u, vTop, wall);
    b.tri(a0, b0, b1);
    b.tri(a0, b1, a1);
    u = u1;
  }
  // Flat roof.
  const ring = pts.map(([x, z]) => b.vert(x, top, z, 0, 1, 0, 0.02, 0.02, roof));
  const contour = pts.map(([x, z]) => new THREE.Vector2(x, z));
  for (const [i0, i1, i2] of THREE.ShapeUtils.triangulateShape(contour, [])) {
    const [a, c, d] = [pts[i0], pts[i1], pts[i2]];
    // Face up: y of (c - a) x (d - a) must be positive.
    const up = (c[1] - a[1]) * (d[0] - a[0]) - (c[0] - a[0]) * (d[1] - a[1]) > 0;
    if (up) b.tri(ring[i0], ring[i1], ring[i2]);
    else b.tri(ring[i0], ring[i2], ring[i1]);
  }
}

/**
 * Load data/buildings.json, add the meshes to `scene` and the footprints to `colliders`.
 * Resolves to the radius (m) the data covers, or 0 when it is missing.
 */
export async function loadBuildings(scene, colliders) {
  let data;
  try {
    const res = await fetch('data/buildings.json');
    if (!res.ok) return 0;
    data = await res.json();
  } catch {
    return 0;
  }
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: windowTexture() });
  const cells = new Map();
  const wall = new THREE.Color();
  const roof = new THREE.Color();
  let off = 0;
  let radius = data.radius || 0;
  for (let i = 0; i < data.count; i++) {
    const n = data.n[i];
    const pts = [];
    let cx = 0;
    let cz = 0;
    for (let k = 0; k < n; k++) {
      const x = data.p[(off + k) * 2] / 10;
      const z = data.p[(off + k) * 2 + 1] / 10;
      pts.push([x, z]);
      cx += x;
      cz += z;
    }
    off += n;
    cx /= n;
    cz /= n;
    if (!data.radius) radius = Math.max(radius, Math.hypot(cx, cz));
    const [walls, roofs] = PALETTE[data.kind[i]] || PALETTE[0];
    const r = hash(i);
    wall.setHex(walls[(r * walls.length) | 0]).multiplyScalar(0.9 + hash(i + 7919) * 0.15);
    roof.setHex(roofs[(hash(i + 104729) * roofs.length) | 0]);
    const key = `${Math.floor(cx / CELL)},${Math.floor(cz / CELL)}`;
    let b = cells.get(key);
    if (!b) cells.set(key, (b = new CellBuilder()));
    // Sink the base a little so it never floats over the lower imagery layers.
    addBuilding(b, pts, data.h[i] / 10, wall, roof, -1);
    colliders.add(footprint(pts, data.h[i] / 10 - 1));
  }
  const group = new THREE.Group();
  for (const b of cells.values()) {
    const m = new THREE.Mesh(b.geometry(), mat);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  }
  // Static: compute the matrices once instead of every frame.
  group.traverse((o) => {
    o.updateMatrix();
    o.matrixAutoUpdate = false;
  });
  scene.add(group);
  return radius;
}
