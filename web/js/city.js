// Streaming city: the ground around the player (outside the real OSM buildings, see
// buildings.js) is split into chunks, and each chunk is
// filled from a seeded random generator (offices, towers, houses, trees) using the
// Kenney City Kit models (CC0). Near chunks use detailed models, far chunks low-detail
// ones. Chunks are generated as the player flies and the same chunk always looks the
// same within a session; a new session gets a new city.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { footprint, hitFootprint } from './collision.js';

const CHUNK = 500; // metres
const NEAR_R = 2; // chunks around the player drawn with detailed models
const FAR_R = 10; // furthest chunk ring drawn at all
const HOUSE_FAR_R = 5; // houses beyond this are too small to bother with
const GROUND_Y = -1; // sink slightly so the base never floats over the lower imagery layers

const range = (prefix, from, to) => {
  const out = [];
  for (let c = from.charCodeAt(0); c <= to.charCodeAt(0); c++) out.push(prefix + String.fromCharCode(c));
  return out;
};

// scale: [horizontal, vertical] metres per model unit.
const SETS = {
  office: { dir: 'commercial', files: range('building-', 'a', 'n'), scale: [11, 11] },
  tower: { dir: 'commercial', files: range('building-skyscraper-', 'a', 'e'), scale: [12, 12] },
  house: { dir: 'suburban', files: range('building-type-', 'a', 'u'), scale: [10, 10] },
  tree: { dir: 'suburban', files: ['tree-large', 'tree-small'], scale: [12, 12] },
  far_office: { dir: 'commercial', files: [...range('low-detail-building-', 'a', 'm'), 'low-detail-building-wide-a', 'low-detail-building-wide-b'], scale: [36, 12] },
  far_tower: { dir: 'commercial', files: range('low-detail-building-', 'a', 'm'), scale: [30, 30] },
  far_house: { dir: 'commercial', files: ['low-detail-building-n'], scale: [30, 12] },
};

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

function hash(a, b, seed) {
  let h = (seed ^ Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise in [0, 1], used to group chunks into districts. */
function noise(x, z, seed) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const h = (a, b) => hash(a, b, seed) / 4294967296;
  const a = h(xi, zi) + (h(xi + 1, zi) - h(xi, zi)) * u;
  const b = h(xi, zi + 1) + (h(xi + 1, zi + 1) - h(xi, zi + 1)) * u;
  return a + (b - a) * v;
}

// ---------------------------------------------------------------------------
// Chunk generation
// ---------------------------------------------------------------------------

/** Airfield and runway approach corridors stay clear. */
function blocked(x, z) {
  return x * x + z * z < 1300 * 1300 || (Math.abs(x + 40) < 500 && Math.abs(z) < 4000);
}

function generateChunk(cx, cz, seed) {
  const r = rng(hash(cx, cz, seed));
  const d = noise(cx * 0.22, cz * 0.22, seed) * 0.7 + noise(cx * 0.6 + 50, cz * 0.6, seed + 1) * 0.3;
  let lot, street, fill;
  if (d > 0.65) {
    // Downtown: dense offices, more towers towards the district centre.
    const towerChance = Math.min(0.5, 0.05 + (d - 0.65) * 4);
    lot = 46;
    street = 4;
    fill = () => (r() < 0.85 ? (r() < towerChance ? 'tower' : 'office') : null);
  } else if (d > 0.47) {
    // Suburb: houses with gardens.
    lot = 30;
    street = 5;
    fill = () => (r() < 0.6 ? 'house' : r() < 0.5 ? 'tree' : null);
  } else {
    // Countryside: the odd farmhouse and scattered trees.
    lot = 60;
    street = 0;
    fill = () => (r() < 0.04 ? 'house' : r() < 0.18 ? 'tree' : null);
  }
  const lots = [];
  const n = Math.floor(CHUNK / lot);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (street && (i % street === 0 || j % street === 0)) continue;
      const kind = fill();
      if (!kind) continue;
      const x = cx * CHUNK + (i + 0.5) * lot + (r() - 0.5) * lot * 0.16;
      const z = cz * CHUNK + (j + 0.5) * lot + (r() - 0.5) * lot * 0.16;
      if (blocked(x, z)) continue;
      const tree = kind === 'tree';
      lots.push({
        kind,
        variant: (r() * 1e6) | 0,
        x,
        z,
        rot: tree ? r() * Math.PI * 2 : ((r() * 4) | 0) * (Math.PI / 2),
        h: kind === 'office' ? 0.8 + r() * 0.7 : kind === 'tower' ? 0.85 + r() * 0.45 : 0.95 + r() * 0.15,
        s: tree ? 0.7 + r() * 0.7 : 1,
      });
    }
  }
  return lots;
}

// ---------------------------------------------------------------------------
// Models and instancing
// ---------------------------------------------------------------------------

async function loadSets() {
  const loader = new GLTFLoader();
  const materials = {};
  const sets = {};
  await Promise.all(Object.entries(SETS).map(async ([name, set]) => {
    sets[name] = await Promise.all(set.files.map(async (file) => {
      const gltf = await loader.loadAsync(`models/city/${set.dir}/${file}.glb`);
      gltf.scene.updateMatrixWorld(true);
      let mesh = null;
      gltf.scene.traverse((o) => { if (!mesh && o.isMesh) mesh = o; });
      const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      geo.computeBoundingBox();
      // All models of one kit share a single colour-map texture.
      const mat = (materials[set.dir] ??= mesh.material);
      return { geo, box: geo.boundingBox, mat, mesh: null, cap: 0 };
    }));
  }));
  return sets;
}

/** Make sure `m` has an InstancedMesh with room for `need` instances. */
function ensure(scene, m, need, near) {
  if (m.mesh && m.cap >= need) return;
  if (m.mesh) {
    scene.remove(m.mesh);
    m.mesh.dispose();
  }
  m.cap = Math.max(16, need, m.cap * 2);
  m.mesh = new THREE.InstancedMesh(m.geo, m.mat, m.cap);
  m.mesh.frustumCulled = false; // instances surround the player
  m.mesh.castShadow = near;
  m.mesh.receiveShadow = near;
  scene.add(m.mesh);
}

/**
 * `clearRadius` resolves to the radius (m) around the origin that real buildings already
 * cover; the generated city starts outside it.
 */
export function createCity(scene, clearRadius = Promise.resolve(0), seed = (Math.random() * 2 ** 32) >>> 0) {
  const cache = new Map();
  let sets = null;
  let clear2 = 0;
  let lastKey = '';
  const mat4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);

  Promise.all([loadSets(), clearRadius.catch(() => 0)])
    .then(([s, r]) => { sets = s; clear2 = r * r; lastKey = ''; })
    .catch((e) => console.warn('City models failed to load', e));

  function chunk(cx, cz) {
    const key = `${cx},${cz}`;
    let lots = cache.get(key);
    if (!lots) {
      lots = generateChunk(cx, cz, seed);
      cache.set(key, lots);
    }
    return lots;
  }

  /** Footprint of a lot's detailed model, which is what is drawn around the player. */
  function lotFootprint(l) {
    const models = sets[l.kind];
    const box = models[l.variant % models.length].box;
    const [sh, sv] = SETS[l.kind].scale;
    const k = sh * l.s;
    const c = Math.cos(l.rot);
    const s = Math.sin(l.rot);
    const corners = [[box.min.x, box.min.z], [box.max.x, box.min.z], [box.max.x, box.max.z], [box.min.x, box.max.z]];
    const pts = corners.map(([x, z]) => [l.x + (x * c + z * s) * k, l.z + (-x * s + z * c) * k]);
    return footprint(pts, GROUND_Y + box.max.y * sv * l.h * l.s);
  }

  function rebuild(pcx, pcz) {
    const buckets = new Map(); // model -> list of matrices
    for (let dz = -FAR_R; dz <= FAR_R; dz++) {
      for (let dx = -FAR_R; dx <= FAR_R; dx++) {
        const dist = Math.hypot(dx, dz);
        if (dist > FAR_R) continue;
        const near = Math.max(Math.abs(dx), Math.abs(dz)) <= NEAR_R;
        for (const l of chunk(pcx + dx, pcz + dz)) {
          if (l.x * l.x + l.z * l.z < clear2) continue;
          if (!near && (l.kind === 'tree' || (l.kind === 'house' && dist > HOUSE_FAR_R))) continue;
          const name = near ? l.kind : `far_${l.kind}`;
          const models = sets[name];
          const model = models[l.variant % models.length];
          const [sh, sv] = SETS[name].scale;
          quat.setFromAxisAngle(yAxis, l.rot);
          pos.set(l.x, GROUND_Y, l.z);
          scl.set(sh * l.s, sv * l.h * l.s, sh * l.s);
          let list = buckets.get(model);
          if (!list) buckets.set(model, (list = { near, mats: [] }));
          list.mats.push(mat4.compose(pos, quat, scl).clone());
        }
      }
    }
    for (const models of Object.values(sets)) {
      for (const m of models) {
        const b = buckets.get(m);
        const count = b ? b.mats.length : 0;
        if (count) ensure(scene, m, count, b.near);
        if (!m.mesh) continue;
        for (let i = 0; i < count; i++) m.mesh.setMatrixAt(i, b.mats[i]);
        m.mesh.count = count;
        m.mesh.instanceMatrix.needsUpdate = true;
      }
    }
    // Forget chunks well out of range.
    for (const key of cache.keys()) {
      const [cx, cz] = key.split(',').map(Number);
      if (Math.abs(cx - pcx) > FAR_R + 2 || Math.abs(cz - pcz) > FAR_R + 2) cache.delete(key);
    }
  }

  return {
    seed,
    /** Sphere (x, y, z, r) against the generated buildings and trees; see hitFootprint. */
    collide(x, y, z, r) {
      if (!sets) return null;
      const pcx = Math.floor(x / CHUNK);
      const pcz = Math.floor(z / CHUNK);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const l of chunk(pcx + dx, pcz + dz)) {
            if (Math.abs(l.x - x) > 80 + r || Math.abs(l.z - z) > 80 + r) continue;
            if (l.x * l.x + l.z * l.z < clear2) continue;
            l.fp ??= lotFootprint(l);
            const h = hitFootprint(l.fp, x, y, z, r);
            if (h) return h;
          }
        }
      }
      return null;
    },
    /** Stream chunks around `p`; only rebuilds when the player enters a new chunk. */
    update(p) {
      if (!sets) return;
      const pcx = Math.floor(p.x / CHUNK);
      const pcz = Math.floor(p.z / CHUNK);
      const key = `${pcx},${pcz}`;
      if (key === lastKey) return;
      lastKey = key;
      rebuild(pcx, pcz);
    },
  };
}
