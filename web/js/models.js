// Aircraft models. Each model is a THREE.Group whose nose points to -Z and
// whose origin sits at the aircraft's centre (gear height above ground).
// A user-supplied GLB in web/models/<key>.glb replaces the procedural mesh once
// that aircraft is first needed (selected in the menu or spawned as a bot).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AIRCRAFT } from './aircraft.js';
import { GEAR_HEIGHT } from './sim.js';

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Planform polygon in the XZ plane. Points are [x right, f forward]; mirrored when `mirror`. */
function planform(half, thick, mirror = true) {
  const pts = mirror ? [...half, ...half.slice().reverse().map(([x, f]) => [-x, f])] : half;
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  const bevel = thick * 0.45;
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: thick, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1,
  });
  g.translate(0, 0, -thick / 2);
  g.rotateX(-Math.PI / 2); // shape y -> -Z (forward), depth -> +Y
  g.computeVertexNormals();
  return g;
}

/** Vertical surface. Points are [f forward, h up]. */
function fin(pts, thick) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
  g.translate(0, 0, -thick / 2);
  g.rotateY(Math.PI / 2); // shape x -> -Z (forward), depth -> X
  g.computeVertexNormals();
  return g;
}

/** Body of revolution. Profile is [radius, f] from tail to nose. */
function lathe(profile, sx = 1, sy = 1, seg = 20) {
  const g = new THREE.LatheGeometry(profile.map(([r, f]) => new THREE.Vector2(r, f)), seg);
  g.rotateX(-Math.PI / 2); // lathe Y axis -> -Z
  g.scale(sx, sy, 1);
  g.computeVertexNormals();
  return g;
}

function airframeMaterials(base) {
  return {
    skin: new THREE.MeshStandardMaterial({ color: base, metalness: 0.35, roughness: 0.55 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2b2f35, metalness: 0.6, roughness: 0.45 }),
    glass: new THREE.MeshStandardMaterial({
      color: 0xc9a243, metalness: 0.9, roughness: 0.08, emissive: 0x2a1d05, transparent: true, opacity: 0.88,
    }),
    nozzle: new THREE.MeshStandardMaterial({ color: 0x3a3631, metalness: 0.8, roughness: 0.35 }),
  };
}

let roundelTex = null;
function roundel() {
  // Turkish Air Force roundel: red disc, white ring, red centre.
  if (!roundelTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d');
    const ring = (r, col) => { x.fillStyle = col; x.beginPath(); x.arc(64, 64, r, 0, Math.PI * 2); x.fill(); };
    ring(62, '#e30a17'); ring(40, '#ffffff'); ring(22, '#e30a17');
    roundelTex = new THREE.CanvasTexture(c);
    roundelTex.colorSpace = THREE.SRGBColorSpace;
  }
  return roundelTex;
}

function addRoundel(group, x, y, z, size) {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(size, 24),
    new THREE.MeshBasicMaterial({ map: roundel(), transparent: true, polygonOffset: true, polygonOffsetFactor: -4 }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, y, z);
  group.add(m);
}

function mesh(g, m, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.castShadow = true;
  return o;
}

// ---------------------------------------------------------------------------
// Procedural airframes (dimensions in metres, z = -forward)
// ---------------------------------------------------------------------------

function buildF16() {
  const g = new THREE.Group();
  const m = airframeMaterials(0x8d949c);
  g.add(mesh(lathe([[0.5, -7.5], [0.72, -6.4], [0.82, -4.0], [0.82, 1.5], [0.72, 3.6], [0.48, 5.6], [0.18, 7.1], [0.02, 7.6]], 1, 0.95), m.skin));
  g.add(mesh(new THREE.BoxGeometry(1.15, 0.75, 4.2), m.skin, 0, -0.75, -0.6)); // intake trunk
  g.add(mesh(new THREE.BoxGeometry(1.0, 0.55, 0.3), m.dark, 0, -0.78, -2.75)); // intake mouth
  g.add(mesh(planform([[0.55, 4.2], [0.95, 0.6], [4.75, -2.7], [4.75, -3.6], [0.7, -4.4]], 0.18), m.skin));
  g.add(mesh(planform([[0.5, -5.1], [3.0, -6.6], [3.0, -7.4], [0.5, -7.3]], 0.12), m.skin));
  g.add(mesh(fin([[-3.6, 0.55], [-6.0, 4.1], [-7.0, 4.1], [-7.3, 0.55]], 0.14), m.skin));
  const canopy = mesh(new THREE.SphereGeometry(0.55, 20, 12), m.glass, 0, 0.62, -3.9);
  canopy.scale.set(1, 0.85, 2.7);
  g.add(canopy);
  g.add(mesh(new THREE.CylinderGeometry(0.5, 0.58, 1.1, 16, 1, true).rotateX(Math.PI / 2), m.nozzle, 0, 0.05, 7.3));
  for (const s of [-1, 1]) {
    g.add(mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.0, 8).rotateX(Math.PI / 2), m.dark, s * 4.85, 0, -2.7)); // wingtip AIM-9
    addRoundel(g, s * 3.0, 0.14, -2.6, 0.45);
  }
  return g;
}

function buildF22() {
  const g = new THREE.Group();
  const m = airframeMaterials(0x7c838b);
  g.add(mesh(lathe([[0.85, 3.0], [0.8, 5.5], [0.55, 7.8], [0.25, 9.0], [0.02, 9.5]], 1.45, 0.75), m.skin));
  g.add(mesh(planform([[0.9, 4.2], [1.95, 1.4], [2.0, -6.6], [1.35, -8.6]], 1.05), m.skin, 0, -0.1, 0));
  g.add(mesh(planform([[1.9, 1.2], [6.8, -4.1], [6.8, -5.0], [1.9, -6.0]], 0.2), m.skin));
  g.add(mesh(planform([[1.6, -6.3], [4.7, -8.2], [4.5, -9.3], [1.5, -9.1]], 0.14), m.skin));
  for (const s of [-1, 1]) {
    const t = mesh(fin([[-4.3, 0.0], [-6.8, 3.0], [-8.1, 3.0], [-7.7, 0.0]], 0.14), m.skin, s * 1.65, 0.45, 0);
    t.rotation.z = -s * 0.49;
    g.add(t);
    const intake = mesh(new THREE.BoxGeometry(0.75, 1.0, 3.6), m.skin, s * 1.85, -0.15, -1.3);
    intake.rotation.y = s * 0.12;
    g.add(intake);
    g.add(mesh(new THREE.BoxGeometry(0.9, 0.55, 0.9), m.nozzle, s * 0.75, 0.0, 8.6));
  }
  const canopy = mesh(new THREE.SphereGeometry(0.6, 20, 12), m.glass, 0, 0.7, -5.4);
  canopy.scale.set(1, 0.8, 3.0);
  g.add(canopy);
  return g;
}

function buildB2() {
  const g = new THREE.Group();
  const m = airframeMaterials(0x2c3036);
  m.skin.roughness = 0.75;
  m.skin.metalness = 0.2;
  // Flying wing with W-shaped trailing edge (half planform, mirrored).
  g.add(mesh(planform([[0.0, 10.5], [26.2, -6.6], [25.6, -8.0], [17.2, -3.3], [11.2, -7.6], [5.6, -3.9], [0.0, -7.2]], 0.55), m.skin));
  const hump = mesh(new THREE.SphereGeometry(1, 28, 14), m.skin, 0, 0.35, 1.2);
  hump.scale.set(4.2, 1.6, 9.0);
  g.add(hump);
  for (const s of [-1, 1]) {
    const eng = mesh(new THREE.SphereGeometry(1, 20, 10), m.skin, s * 3.6, 0.35, 0.2);
    eng.scale.set(2.4, 1.05, 6.0);
    g.add(eng);
    g.add(mesh(new THREE.BoxGeometry(3.4, 0.25, 0.9), m.nozzle, s * 3.5, 0.55, 4.4));
  }
  for (const s of [-1, 1]) {
    const w = mesh(new THREE.BoxGeometry(0.9, 0.3, 0.9), m.glass, s * 0.6, 1.75, -6.1);
    w.rotation.x = -0.35;
    g.add(w);
  }
  return g;
}

function buildKaan() {
  const g = new THREE.Group();
  const m = airframeMaterials(0x949ba3);
  g.add(mesh(lathe([[0.95, 3.2], [0.9, 6.0], [0.6, 8.6], [0.25, 10.0], [0.02, 10.5]], 1.4, 0.78), m.skin));
  g.add(mesh(planform([[1.0, 4.6], [2.2, 1.6], [2.25, -7.4], [1.55, -9.6]], 1.15), m.skin, 0, -0.1, 0));
  // Trapezoidal wing, ~40 deg leading-edge sweep.
  g.add(mesh(planform([[2.1, 1.8], [7.0, -3.9], [7.0, -5.0], [2.1, -6.6]], 0.22), m.skin));
  g.add(mesh(planform([[1.8, -7.1], [5.1, -9.2], [5.0, -10.3], [1.7, -10.1]], 0.14), m.skin));
  for (const s of [-1, 1]) {
    const t = mesh(fin([[-5.0, 0.0], [-7.5, 3.3], [-8.8, 3.3], [-8.6, 0.0]], 0.15), m.skin, s * 1.9, 0.5, 0);
    t.rotation.z = -s * 0.45;
    g.add(t);
    const intake = mesh(new THREE.BoxGeometry(0.85, 1.05, 4.0), m.skin, s * 2.05, -0.2, -1.2);
    intake.rotation.y = s * 0.1;
    g.add(intake);
    g.add(mesh(new THREE.CylinderGeometry(0.5, 0.58, 1.2, 16, 1, true).rotateX(Math.PI / 2), m.nozzle, s * 0.85, 0.0, 9.4));
    addRoundel(g, s * 4.6, 0.2, -4.0, 0.6);
  }
  const canopy = mesh(new THREE.SphereGeometry(0.62, 20, 12), m.glass, 0, 0.75, -5.8);
  canopy.scale.set(1, 0.8, 3.0);
  g.add(canopy);
  // Red fin flash for the national fighter.
  const flash = new THREE.MeshStandardMaterial({ color: 0xe30a17, roughness: 0.6 });
  for (const s of [-1, 1]) {
    const f = mesh(fin([[-7.6, 2.4], [-7.95, 3.25], [-8.8, 3.25], [-8.75, 2.4]], 0.17), flash, s * 1.9, 0.5, 0);
    f.rotation.z = -s * 0.45;
    g.add(f);
  }
  return g;
}

const BUILDERS = { f16: buildF16, f22: buildF22, b2: buildB2, kaan: buildKaan };

// ---------------------------------------------------------------------------
// GLB overrides
// ---------------------------------------------------------------------------

// Compressed GLBs (gltf-transform: KTX2 / Basis textures, Draco or Meshopt geometry, see
// tools/optimize_models.sh) need decoders. Each is imported only when a file declares the
// extension, so plain GLBs cost nothing extra. Decoder binaries come from the same three.js
// build as the import map.
const ADDONS = (() => {
  try {
    return import.meta.resolve('three/addons/');
  } catch {
    return `https://cdn.jsdelivr.net/npm/three@0.${THREE.REVISION}.0/examples/jsm/`;
  }
})();

const gltfLoader = new GLTFLoader();
const decoders = {};
let decoderRenderer = null;

/**
 * Renderer the KTX2 transcoder checks for supported GPU formats (ASTC / BC7 / ETC2 / S3TC).
 * Optional: without it a throwaway WebGL context on the same GPU is probed instead.
 */
export function setModelRenderer(renderer) {
  decoderRenderer = renderer;
}

/** Minimal stand-in for KTX2Loader.detectSupport when no renderer was registered. */
function probeRenderer() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  const has = (name) => !!gl?.getExtension(name);
  const caps = { isWebGL2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext };
  const probe = { capabilities: caps, extensions: { has } };
  // Read every format flag now, then free the context (browsers cap live contexts).
  const flags = {};
  for (const n of ['WEBGL_compressed_texture_astc', 'WEBGL_compressed_texture_etc1', 'WEBGL_compressed_texture_etc',
    'WEBGL_compressed_texture_s3tc', 'EXT_texture_compression_bptc', 'WEBGL_compressed_texture_pvrtc',
    'WEBKIT_WEBGL_compressed_texture_pvrtc']) flags[n] = has(n);
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
  probe.extensions.has = (name) => !!flags[name];
  return probe;
}

const DECODERS = {
  KHR_draco_mesh_compression: () => (decoders.draco ??= import('three/addons/loaders/DRACOLoader.js')
    .then(({ DRACOLoader }) => gltfLoader.setDRACOLoader(new DRACOLoader().setDecoderPath(`${ADDONS}libs/draco/gltf/`)))),
  EXT_meshopt_compression: () => (decoders.meshopt ??= import('three/addons/libs/meshopt_decoder.module.js')
    .then(({ MeshoptDecoder }) => gltfLoader.setMeshoptDecoder(MeshoptDecoder))),
  KHR_texture_basisu: () => (decoders.ktx2 ??= import('three/addons/loaders/KTX2Loader.js')
    .then(({ KTX2Loader }) => gltfLoader.setKTX2Loader(new KTX2Loader()
      .setTranscoderPath(`${ADDONS}libs/basis/`)
      .detectSupport(decoderRenderer ?? probeRenderer())))),
};

/** `extensionsUsed` from a GLB header (or a .gltf JSON), without parsing the rest. */
function gltfExtensions(buffer) {
  try {
    const view = new DataView(buffer);
    const isGlb = buffer.byteLength >= 20 && view.getUint32(0, true) === 0x46546c67; // "glTF"
    const json = isGlb ? new Uint8Array(buffer, 20, view.getUint32(12, true)) : new Uint8Array(buffer);
    return JSON.parse(new TextDecoder().decode(json)).extensionsUsed || [];
  } catch {
    return [];
  }
}

/** Downloads `url`; reports byte progress when `onProgress` is given. Null when missing. */
async function fetchModel(url, onProgress) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const total = Number(res.headers.get('content-length')) || 0;
  if (!onProgress || !res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out.buffer;
}

async function tryLoadGLB(key, def, cfg, onProgress) {
  const c = cfg[key] || {};
  // A "version" in models.json (per model or top level) makes the URL unique per upload,
  // so the worker can let browsers cache it as immutable.
  const version = c.version ?? cfg.version;
  const url = `models/${key}.glb${version ? `?v=${encodeURIComponent(version)}` : ''}`;
  const buffer = await fetchModel(url, onProgress);
  if (!buffer) return null;
  await Promise.all(gltfExtensions(buffer).map((ext) => DECODERS[ext]?.()));
  const gltf = await gltfLoader.parseAsync(buffer, 'models/');
  const root = gltf.scene;
  // Optional per-model fix-ups from models/models.json: rotation in degrees, extra scale.
  if (c.rotation) root.rotation.set(...c.rotation.map((d) => THREE.MathUtils.degToRad(d)));
  const wrap = new THREE.Group();
  wrap.add(root);
  wrap.updateMatrixWorld(true);
  const box = meshBounds(wrap, c.boundsExclude && new RegExp(c.boundsExclude, 'i'));
  const size = box.getSize(new THREE.Vector3());
  const longest = c.lengthAxis === 'x' ? size.x : size.z;
  const scale = (def.length / (longest || 1)) * (c.scale || 1);
  const centre = box.getCenter(new THREE.Vector3());
  root.position.sub(centre);
  const hasGear = findGear(root).down.length > 0;
  if (hasGear || c.groundAlign) {
    // Put the wheels on the ground: the sim keeps the aircraft origin GEAR_HEIGHT above it.
    root.position.y += size.y / 2 - GEAR_HEIGHT / scale;
  }
  if (c.offset) root.position.add(new THREE.Vector3(...c.offset).divideScalar(scale));
  wrap.scale.setScalar(scale);
  wrap.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  const g = new THREE.Group();
  g.add(wrap);
  g.userData.source = 'glb';
  return g;
}

/** Bounds of renderable meshes only; empties, lights and helpers in some exports inflate setFromObject. */
function meshBounds(root, exclude) {
  const box = new THREE.Box3();
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    // Skip effect geometry (e.g. huge transparent exhaust discs) named in models.json.
    const materials = Array.isArray(o.material) ? o.material : [o.material];
    if (exclude && (exclude.test(o.name) || materials.some((m) => exclude.test(m?.name || '')))) return;
    // Precise (per-vertex) bounds: the fast box of a rotated node can overshoot by metres
    // (B-2 gear doors), which would leave the wheels floating above the runway.
    box.union(new THREE.Box3().setFromObject(o, true));
  });
  return box;
}

// Gear-down variants: "landingOn", "gearDown", or individual legs named "LG-..." / "LG_...".
const GEAR_DOWN = /landing_?on|gear_?down|^LG(?=[-_]|front|back|left|right|nose|main)/i;
const GEAR_UP = /landing_?off|gear_?up/i;

/** Nodes for the gear-down / gear-up variants some models ship with. */
function findGear(root) {
  const down = [];
  const up = [];
  root.traverse((o) => {
    if (GEAR_DOWN.test(o.name)) down.push(o);
    else if (GEAR_UP.test(o.name)) up.push(o);
  });
  return { down, up };
}

/** Show the gear-down or gear-up variant (no-op for models without them). */
export function setGear(group, down) {
  if (!group.userData.gear) group.userData.gear = findGear(group);
  const { down: d, up: u } = group.userData.gear;
  if (group.userData.gearDown === down) return;
  group.userData.gearDown = down;
  d.forEach((o) => { o.visible = down; });
  u.forEach((o) => { o.visible = !down; });
}

/**
 * Aircraft templates. Every type starts with its procedural mesh; the (large) GLB is
 * fetched only when `request(key)` first asks for it, then swapped in. `version` bumps
 * on each swap so callers rebuild their instances.
 */
export class AircraftModels {
  constructor(cfg) {
    this.cfg = cfg;
    this.entries = {};
    this.pending = {};
    /** @type {((key: string) => void) | null} called when a template or its load status changes */
    this.onChange = null;
    /** @type {((key: string, loaded: number, total: number) => void) | null} GLB download bytes */
    this.onProgress = null;
    for (const def of AIRCRAFT) {
      const template = BUILDERS[def.key]();
      template.userData.source = 'procedural';
      this.entries[def.key] = { template, def, status: 'idle', version: 0 };
    }
  }

  /** Entry for `key`; starts its GLB download if not done yet. */
  request(key) {
    this.load(key);
    return this.entries[key];
  }

  /** Fetch the GLB for `key` once; resolves when it is in place (or the procedural mesh stays). */
  load(key) {
    return (this.pending[key] ??= this._load(key));
  }

  /**
   * Downloads the GLBs nobody asked for yet, one at a time while the browser is idle, so
   * bots met later in the air already have their model. Skipped on Save-Data or 2G links.
   */
  prefetchIdle(keys = Object.keys(this.entries)) {
    const net = navigator.connection;
    if (net?.saveData || /2g/.test(net?.effectiveType || '')) return;
    const queue = keys.filter((k) => this.entries[k] && !this.pending[k]);
    const idle = window.requestIdleCallback ?? ((cb) => setTimeout(cb, 200));
    const next = () => {
      const key = queue.shift();
      if (key) idle(() => this.load(key).then(next), { timeout: 5000 });
    };
    next();
  }

  async _load(key) {
    const entry = this.entries[key];
    const { def } = entry;
    entry.status = 'loading';
    this.onChange?.(key);
    try {
      const progress = this.onProgress && ((loaded, total) => this.onProgress?.(key, loaded, total));
      const template = await tryLoadGLB(key, def, this.cfg, progress);
      if (template) {
        // GLB-specific exhaust / eye positions (metres, aircraft frame) from models.json.
        const c = this.cfg[key] || {};
        if (c.nozzles) def.nozzles = c.nozzles;
        if (c.nozzleRadius) def.nozzleRadius = c.nozzleRadius;
        if (c.eye) def.eye = c.eye;
        // Models with a modelled cockpit stay visible in cockpit view; these materials
        // (canopy glass) are hidden there so they don't fog the view.
        if (c.cockpitHide) def.cockpitHide = new RegExp(c.cockpitHide, 'i');
        entry.template = template;
        entry.version++;
      }
    } catch (e) {
      console.warn(`GLB ${key} failed to load, using procedural model`, e);
    }
    entry.status = 'done';
    this.onChange?.(key);
  }
}

/** Builds the model registry; no GLB is downloaded until requested. */
export async function loadAircraftModels() {
  let cfg = {};
  try {
    const r = await fetch('models/models.json');
    if (r.ok) cfg = await r.json();
  } catch { /* optional */ }
  return new AircraftModels(cfg);
}

/** Clone a template; enemies get a hostile red tint. */
export function instantiate(template, hostile = false) {
  const g = template.clone(true);
  if (hostile) {
    const red = new THREE.Color(0x8a1a1a);
    g.traverse((o) => {
      if (!o.isMesh) return;
      const tint = (mt) => {
        const c = mt.clone();
        if (c.color && !c.map) c.color.lerp(red, 0.55);
        else if (c.color) c.color.lerp(red, 0.35);
        if (c.emissive) c.emissive.setHex(0x220000);
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(tint) : tint(o.material);
    });
  }
  return g;
}

/** Afterburner flame cones attached at each nozzle. */
export function addFlames(group, def) {
  const flames = [];
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffa040, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const inner = new THREE.MeshBasicMaterial({
    color: 0x9fd0ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const tail = new THREE.MeshBasicMaterial({
    color: 0xa040ff, vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  for (const [x, y, z] of def.nozzles) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(def.nozzleRadius, 1, 14, 1, true), mat);
    cone.geometry.translate(0, 0.5, 0);
    cone.rotation.x = Math.PI / 2; // base at nozzle, tip trails toward +Z
    cone.position.set(x, y, z);
    const core = new THREE.Mesh(new THREE.ConeGeometry(def.nozzleRadius * 0.55, 1, 10, 1, true), inner);
    core.geometry.translate(0, 0.5, 0);
    cone.add(core);
    // Purple tail that fades in toward the tip; its opacity follows throttle (main.js).
    const tailGeo = new THREE.ConeGeometry(def.nozzleRadius * 1.05, 1, 14, 8, true);
    tailGeo.translate(0, 0.5, 0);
    const ty = tailGeo.attributes.position;
    const rgba = new Float32Array(ty.count * 4);
    for (let i = 0; i < ty.count; i++) {
      rgba.set([1, 1, 1, THREE.MathUtils.smoothstep(ty.getY(i), 0.35, 1)], i * 4);
    }
    tailGeo.setAttribute('color', new THREE.BufferAttribute(rgba, 4));
    cone.add(new THREE.Mesh(tailGeo, tail));
    group.add(cone);
    flames.push(cone);
  }
  return flames;
}
