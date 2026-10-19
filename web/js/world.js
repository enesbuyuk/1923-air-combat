// Istanbul / 1923 environment: satellite imagery ground, OSM-derived
// runways and aprons, OSM buildings, a streaming procedural city and lighting
// (sky and haze: atmosphere.js).

import * as THREE from 'three';
import { buildAtmosphere } from './atmosphere.js';
import { createCity } from './city.js';
import { loadBuildings } from './buildings.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FootprintGrid, footprint } from './collision.js';

// Reference point (world origin) near the LTBX aerodrome reference point.
const LAT0 = 40.993;
const LON0 = 29.2165;
const M_PER_DEG_LAT = 111132;
const M_PER_DEG_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);

/**
 * Static scenery never moves: compute its matrices once instead of on every frame.
 * Call after the object and its children are placed.
 */
export function freeze(root) {
  root.traverse((o) => {
    o.updateMatrix();
    o.matrixAutoUpdate = false;
  });
}

function geoToWorld(lat, lon) {
  return { x: (lon - LON0) * M_PER_DEG_LON, z: -(lat - LAT0) * M_PER_DEG_LAT };
}

/** Inverse of geoToWorld: world metres (x east, z south) to degrees. */
export function worldToGeo(x, z) {
  return { lat: LAT0 - z / M_PER_DEG_LAT, lon: LON0 + x / M_PER_DEG_LON };
}

// Runway / apron geometry from OpenStreetMap, in world metres (x east, z south).
const RUNWAYS = [
  { ref: '18/36', a: [-38, -680], b: [-42, 735], width: 30, main: true },
  { ref: '04/22', a: [-306, 297], b: [223, -236], width: 25 },
];
const APRONS = [
  [[7, -322], [36, -320], [36, -619], [7, -618]],
  [[3, 372], [3, 677], [40, 678], [40, 372]],
  [[-317, 74], [-365, 67], [-360, 18], [-347, -90], [-333, -100], [-300, -95], [-310, 70]],
  [[-337, 209], [-368, 207], [-373, 198], [-369, 136], [-366, 81], [-330, 85], [-322, 205]],
];
// Obstacle limitation: past each runway end the approach surface starts APPROACH_START
// out, climbs at APPROACH_SLOPE (1:40, well under a 3 degree glide) and fans out from
// APPROACH_HALF_WIDTH at APPROACH_SPLAY per metre. Real buildings poking through it are cut
// down to it, so a normal approach clears the roofs.
const APPROACH_LENGTH = 3000;
const APPROACH_START = 60;
const APPROACH_SLOPE = 0.025;
const APPROACH_HALF_WIDTH = 100;
const APPROACH_SPLAY = 0.15;

/** Highest roof (m) the approach surfaces allow over outline `pts`; Infinity outside them. */
function approachCeiling(pts) {
  let top = Infinity;
  for (const { a, b } of RUNWAYS) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / len;
    const uz = (b[1] - a[1]) / len;
    // Outward from each end: back past `a`, on past `b`.
    for (const [ex, ez, out] of [[a[0], a[1], -1], [b[0], b[1], 1]]) {
      for (const [x, z] of pts) {
        const d = out * ((x - ex) * ux + (z - ez) * uz);
        if (d < 0 || d > APPROACH_LENGTH) continue;
        const side = Math.abs((x - ex) * uz - (z - ez) * ux);
        if (side > APPROACH_HALF_WIDTH + APPROACH_SPLAY * d) continue;
        top = Math.min(top, APPROACH_SLOPE * Math.max(0, d - APPROACH_START));
      }
    }
  }
  return top;
}

const HELIPADS = [[180, 136], [182, 73], [40, 80], [86, 37], [346, 260], [337, 221], [328, 183], [318, 145]];

// ---------------------------------------------------------------------------
// Satellite tiles (Esri World Imagery)
// ---------------------------------------------------------------------------

const TILE_URL = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

const lon2tile = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2tile = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const tile2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const tile2lat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

function tileLayer(scene, renderer, zoom, radius, y, order, fallback, stats) {
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  const cx = Math.floor(lon2tile(LON0, zoom));
  const cy = Math.floor(lat2tile(LAT0, zoom));
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const group = new THREE.Group();
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const tx = cx + dx;
      const ty = cy + dy;
      const nw = geoToWorld(tile2lat(ty, zoom), tile2lon(tx, zoom));
      const se = geoToWorld(tile2lat(ty + 1, zoom), tile2lon(tx + 1, zoom));
      const w = se.x - nw.x;
      const h = se.z - nw.z;
      const geo = new THREE.PlaneGeometry(w, h);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshLambertMaterial({
        color: fallback, polygonOffset: true, polygonOffsetFactor: -order, polygonOffsetUnits: -order * 4,
      });
      const m = new THREE.Mesh(geo, mat);
      m.position.set(nw.x + w / 2, y, nw.z + h / 2);
      m.receiveShadow = true;
      m.renderOrder = order;
      group.add(m);
      stats.total++;
      loader.load(
        TILE_URL(zoom, tx, ty),
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = aniso;
          mat.map = tex;
          mat.color.set(0xffffff);
          mat.needsUpdate = true;
          stats.loaded++;
        },
        undefined,
        () => { stats.failed++; },
      );
    }
  }
  freeze(group);
  scene.add(group);
  return group;
}

// ---------------------------------------------------------------------------
// Runways and airfield
// ---------------------------------------------------------------------------

function runwayTexture(ref, length, width) {
  const c = document.createElement('canvas');
  const pxPerM = 4;
  c.width = Math.round(width * pxPerM);
  c.height = 2048;
  const k = c.height / length; // px per metre along the runway
  const x = c.getContext('2d');
  x.fillStyle = '#3b3d40';
  x.fillRect(0, 0, c.width, c.height);
  // Wear noise
  for (let i = 0; i < 4000; i++) {
    x.fillStyle = `rgba(${Math.random() < 0.5 ? '20,20,20' : '90,90,90'},0.12)`;
    x.fillRect(Math.random() * c.width, Math.random() * c.height, 2, 2 + Math.random() * 6);
  }
  x.fillStyle = '#e9e9e2';
  const W = c.width;
  // Edge lines
  x.fillRect(2, 0, 3, c.height);
  x.fillRect(W - 5, 0, 3, c.height);
  // Centre-line dashes (30 m dash, 20 m gap)
  for (let m = 60; m < length - 60; m += 50) x.fillRect(W / 2 - 2, m * k, 4, 30 * k);
  // Threshold piano keys + numbers at both ends
  const [a, b] = ref.split('/');
  const ends = [{ y: 0, label: a, flip: true }, { y: c.height, label: b, flip: false }];
  for (const end of ends) {
    for (let i = 0; i < 8; i++) {
      const bx = 8 + i * ((W - 16) / 8);
      const by = end.flip ? 4 : c.height - 4 - 30 * k;
      x.fillRect(bx + 2, by, (W - 16) / 8 - 6, 30 * k);
    }
    x.save();
    x.translate(W / 2, end.flip ? 40 * k + 18 : c.height - 40 * k - 18);
    if (end.flip) x.rotate(Math.PI);
    x.font = `bold ${Math.round(W * 0.35)}px sans-serif`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(end.label, 0, 0);
    x.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function buildAirfield(scene) {
  const group = new THREE.Group();
  for (const r of RUNWAYS) {
    const dx = r.b[0] - r.a[0];
    const dz = r.b[1] - r.a[1];
    const length = Math.hypot(dx, dz);
    // Texture top (v=1) maps to end "a"; label order follows the OSM ref.
    const geo = new THREE.PlaneGeometry(r.width, length);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({
      map: runwayTexture(r.ref, length, r.width), polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -40,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.set((r.a[0] + r.b[0]) / 2, 0.3, (r.a[1] + r.b[1]) / 2);
    // Plane's -Z edge is the texture top; rotate so -Z points at end a.
    m.rotation.y = Math.atan2(-(r.a[0] - r.b[0]), -(r.a[1] - r.b[1]));
    m.receiveShadow = true;
    m.renderOrder = 8;
    group.add(m);
    if (r.main) addRunwayLights(group, r, length);
  }
  const apronMat = new THREE.MeshLambertMaterial({
    color: 0x6f7173, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -30,
  });
  // Aprons and helipads share materials, so each set is merged into a single mesh.
  const aprons = mergeGeometries(APRONS.map((poly) => {
    const s = new THREE.Shape(poly.map(([px, pz]) => new THREE.Vector2(px, -pz)));
    return new THREE.ShapeGeometry(s).rotateX(-Math.PI / 2);
  }));
  const apronMesh = new THREE.Mesh(aprons, apronMat);
  apronMesh.position.y = 0.25;
  apronMesh.renderOrder = 7;
  group.add(apronMesh);
  const padMat = new THREE.MeshLambertMaterial({ color: 0x5c5e60, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -30 });
  const hMat = new THREE.MeshBasicMaterial({ color: 0xf2f2f2, polygonOffset: true, polygonOffsetFactor: -7, polygonOffsetUnits: -35 });
  const hShape = new THREE.Shape();
  hShape.moveTo(-3, -4); hShape.lineTo(-1.8, -4); hShape.lineTo(-1.8, -0.6); hShape.lineTo(1.8, -0.6);
  hShape.lineTo(1.8, -4); hShape.lineTo(3, -4); hShape.lineTo(3, 4); hShape.lineTo(1.8, 4);
  hShape.lineTo(1.8, 0.6); hShape.lineTo(-1.8, 0.6); hShape.lineTo(-1.8, 4); hShape.lineTo(-3, 4);
  const pads = mergeGeometries(HELIPADS.map(([px, pz]) => new THREE.CircleGeometry(9, 24).rotateX(-Math.PI / 2).translate(px, 0.27, pz)));
  const marks = mergeGeometries(HELIPADS.map(([px, pz]) => new THREE.ShapeGeometry(hShape).rotateX(-Math.PI / 2).translate(px, 0.34, pz)));
  group.add(new THREE.Mesh(pads, padMat), new THREE.Mesh(marks, hMat));
  // Control tower.
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x9aa39a, roughness: 0.8 });
  const tower = new THREE.Group();
  const tBase = new THREE.Mesh(new THREE.CylinderGeometry(3, 4, 22, 12), towerMat);
  tBase.position.y = 11;
  const cab = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 4.5, 4, 8), new THREE.MeshStandardMaterial({
    color: 0x5f8fae, metalness: 0.8, roughness: 0.15,
  }));
  cab.position.y = 24;
  tower.add(tBase, cab);
  tower.position.set(-250, 0, 260);
  tower.traverse((o) => { o.castShadow = true; });
  group.add(tower);
  // Windsock-ish Turkish flag pole near the tower.
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 18, 6), new THREE.MeshStandardMaterial({ color: 0xdddddd }));
  pole.position.set(-235, 9, 290);
  group.add(pole);
  group.add(flag(-235, 15.5, 290));
  freeze(group);
  scene.add(group);
  return group;
}

// ---------------------------------------------------------------------------
// Service hangars
// ---------------------------------------------------------------------------

/**
 * Service hangars: centre [x, z] and the heading of the open front (rad about +y; 0 faces
 * +z). The ground crew only works inside them. Mirrors HANGARS in wasm/src/config.rs.
 */
export const HANGARS = [
  [110, -470, -Math.PI / 2],
  [110, 520, -Math.PI / 2],
  [-180, -400, Math.PI / 2],
  [-190, 0, Math.PI / 2],
  [-180, 470, Math.PI / 2],
];
const HANGAR_URL = 'scenery/hangar.glb';
/** Model scale: a 64 m wide, 14 m high bay, room for the B-2. */
const HANGAR_SCALE = 0.8;
/**
 * Solid parts in the hangar frame (x across, z towards the front), metres after scaling:
 * [x0, x1, z0, z1, top]. Low side wings, the side walls and the back wall.
 */
const HANGAR_SOLIDS = [
  [-73, -32, -46, 34, 3.7],
  [32, 73, -46, 34, 3.7],
  [-33, -31, -46, 34, 13.5],
  [31, 33, -46, 34, 13.5],
  [-33, 33, -46, -44, 13.5],
];

/** Place the hangars and register their walls with `colliders`; the model streams in. */
function buildHangars(scene, colliders) {
  for (const [hx, hz, heading] of HANGARS) {
    const s = Math.sin(heading);
    const c = Math.cos(heading);
    const toWorld = (x, z) => [hx + x * c + z * s, hz - x * s + z * c];
    for (const [x0, x1, z0, z1, top] of HANGAR_SOLIDS) {
      colliders.add(footprint([toWorld(x0, z0), toWorld(x1, z0), toWorld(x1, z1), toWorld(x0, z1)], top));
    }
  }
  new GLTFLoader().loadAsync(HANGAR_URL).then((gltf) => {
    const model = gltf.scene;
    model.scale.setScalar(HANGAR_SCALE);
    model.traverse((o) => {
      if (o.isMesh) o.castShadow = o.receiveShadow = true;
    });
    // Floor slab level with the apron.
    model.position.y = -new THREE.Box3().setFromObject(model).min.y - 0.3;
    for (const [hx, hz, heading] of HANGARS) {
      const h = model.clone();
      h.position.x = hx;
      h.position.z = hz;
      h.rotation.y = heading;
      freeze(h);
      scene.add(h);
    }
  }).catch((err) => console.warn('Hangar model failed to load', err));
}

function flag(x, y, z) {
  const c = document.createElement('canvas');
  c.width = 300; c.height = 200;
  const g = c.getContext('2d');
  g.fillStyle = '#e30a17'; g.fillRect(0, 0, 300, 200);
  g.fillStyle = '#fff'; g.beginPath(); g.arc(112, 100, 50, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#e30a17'; g.beginPath(); g.arc(125, 100, 40, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff';
  g.save(); g.translate(178, 100); g.rotate(-Math.PI / 2); g.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = (i * 4 * Math.PI) / 5;
    g.lineTo(Math.cos(a) * 25, Math.sin(a) * 25);
  }
  g.closePath(); g.fill(); g.restore();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 3), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
  m.position.set(x + 2.25, y, z);
  return m;
}

function addRunwayLights(group, r, length) {
  const dir = new THREE.Vector2(r.b[0] - r.a[0], r.b[1] - r.a[1]).normalize();
  const nrm = new THREE.Vector2(-dir.y, dir.x);
  const pts = [];
  for (let d = 0; d <= length; d += 60) {
    for (const s of [-1, 1]) {
      pts.push(r.a[0] + dir.x * d + nrm.x * s * (r.width / 2 + 2), 0.6, r.a[1] + dir.y * d + nrm.y * s * (r.width / 2 + 2));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  group.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xfff2c0, size: 2.2, sizeAttenuation: true })));
}

// ---------------------------------------------------------------------------
// Sky and lights
// ---------------------------------------------------------------------------

export function buildWorld(scene, renderer) {
  const { sky, sun } = buildAtmosphere(scene, renderer);
  freeze(sky);
  // The sky (environment map) now supplies most of the ambient light; this only lifts
  // the shadowed sides of matte surfaces, which do not use the environment.
  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x5a5040, 0.8));
  const dir = new THREE.DirectionalLight(0xfff1dc, 2.4);
  dir.position.copy(sun).multiplyScalar(2000);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  const sc = dir.shadow.camera;
  sc.left = sc.bottom = -120;
  sc.right = sc.top = 120;
  sc.near = 10;
  sc.far = 5000;
  dir.shadow.bias = -0.0005;
  scene.add(dir, dir.target);

  // Far ground under everything (beyond imagery).
  const far = new THREE.Mesh(
    new THREE.PlaneGeometry(200000, 200000).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: 0x7b7a5e }),
  );
  far.position.y = -3;
  scene.add(far);
  // Marmara Sea to the south-west, Black Sea to the north (rough placement for the horizon).
  const water = new THREE.MeshStandardMaterial({ color: 0x1f4a6b, roughness: 0.2, metalness: 0.3 });
  const marmara = new THREE.Mesh(new THREE.PlaneGeometry(120000, 60000).rotateX(-Math.PI / 2), water);
  marmara.position.set(-20000, -2, 48000);
  const blackSea = new THREE.Mesh(new THREE.PlaneGeometry(160000, 60000).rotateX(-Math.PI / 2), water);
  blackSea.position.set(0, -2, -62000);
  scene.add(marmara, blackSea);
  freeze(far);
  freeze(marmara);
  freeze(blackSea);

  const tiles = { total: 0, loaded: 0, failed: 0 };
  tileLayer(scene, renderer, 13, 4, -1.0, 1, 0x7d7b62, tiles);
  tileLayer(scene, renderer, 15, 4, -0.5, 2, 0x86846a, tiles);
  tileLayer(scene, renderer, 17, 4, 0, 3, 0x8a8a70, tiles);
  buildAirfield(scene);
  // Real OSM buildings near the airfield, generated city beyond them.
  const osm = new FootprintGrid();
  buildHangars(scene, osm);
  const city = createCity(scene, loadBuildings(scene, osm, approachCeiling));

  // Light-space axes of the shadow camera (it looks from the sun along -sun with +y up),
  // for snapping the frustum to whole shadow-map texels.
  const lightX = new THREE.Vector3(0, 1, 0).cross(sun).normalize();
  const lightY = new THREE.Vector3().crossVectors(sun, lightX);
  const center = new THREE.Vector3();

  return {
    tiles,
    /**
     * Keep the shadow frustum centred on the player and stream city chunks around them.
     * The centre moves in whole shadow-map texels across the light, so static shadows
     * stay put instead of shimmering as the player moves. Returns whether it moved.
     */
    follow(pos) {
      const texel = (sc.right - sc.left) / dir.shadow.mapSize.x;
      const u = Math.round(pos.dot(lightX) / texel) * texel;
      const v = Math.round(pos.dot(lightY) / texel) * texel;
      const w = pos.dot(sun);
      center.copy(lightX).multiplyScalar(u).addScaledVector(lightY, v).addScaledVector(sun, w);
      const moved = !center.equals(dir.target.position);
      dir.target.position.copy(center);
      dir.position.copy(center).addScaledVector(sun, 2000);
      city.update(pos);
      return moved;
    },
    /**
     * Shadow quality hook (quality.js): shadow-map size in texels, 0 for no shadows.
     * Turning shadows off or on recompiles the lit materials once.
     */
    setShadowQuality(size) {
      dir.castShadow = size > 0;
      if (!size || dir.shadow.mapSize.x === size) return;
      dir.shadow.mapSize.set(size, size);
      dir.shadow.map?.dispose();
      dir.shadow.map = null;
    },
    /** Body (x, y, z, r, below) against every building: null or { nx, nz, depth }. */
    collide(x, y, z, r, below = r) {
      return osm.hit(x, y, z, r, below) ?? city.collide(x, y, z, r, below);
    },
  };
}
