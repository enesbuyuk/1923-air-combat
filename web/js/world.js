// Istanbul / 1923 environment: satellite imagery ground, OSM-derived
// runways and aprons, OSM buildings, a streaming procedural city, sky and lighting.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { createCity } from './city.js';
import { loadBuildings } from './buildings.js';
import { FootprintGrid } from './collision.js';

// Reference point (world origin) near the LTBX aerodrome reference point.
const LAT0 = 40.993;
const LON0 = 29.2165;
const M_PER_DEG_LAT = 111132;
const M_PER_DEG_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);

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
  for (const poly of APRONS) {
    const s = new THREE.Shape(poly.map(([px, pz]) => new THREE.Vector2(px, -pz)));
    const g = new THREE.ShapeGeometry(s);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, apronMat);
    m.position.y = 0.25;
    m.renderOrder = 7;
    group.add(m);
  }
  const padMat = new THREE.MeshLambertMaterial({ color: 0x5c5e60, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -30 });
  const hMat = new THREE.MeshBasicMaterial({ color: 0xf2f2f2, polygonOffset: true, polygonOffsetFactor: -7, polygonOffsetUnits: -35 });
  for (const [px, pz] of HELIPADS) {
    const pad = new THREE.Mesh(new THREE.CircleGeometry(9, 24).rotateX(-Math.PI / 2), padMat);
    pad.position.set(px, 0.27, pz);
    group.add(pad);
    const hShape = new THREE.Shape();
    hShape.moveTo(-3, -4); hShape.lineTo(-1.8, -4); hShape.lineTo(-1.8, -0.6); hShape.lineTo(1.8, -0.6);
    hShape.lineTo(1.8, -4); hShape.lineTo(3, -4); hShape.lineTo(3, 4); hShape.lineTo(1.8, 4);
    hShape.lineTo(1.8, 0.6); hShape.lineTo(-1.8, 0.6); hShape.lineTo(-1.8, 4); hShape.lineTo(-3, 4);
    const h = new THREE.Mesh(new THREE.ShapeGeometry(hShape).rotateX(-Math.PI / 2), hMat);
    h.position.set(px, 0.34, pz);
    group.add(h);
  }
  // Hangars along the west apron and control tower.
  const hangarMat = new THREE.MeshStandardMaterial({ color: 0x9aa39a, roughness: 0.8 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x5d6b5a, roughness: 0.7 });
  const hangars = [[-400, 160, 0.05], [-405, 100, 0.05], [-398, 25, 0.12], [-388, -45, 0.12], [80, -470, 0], [80, 520, 0]];
  for (const [hx, hz, rot] of hangars) {
    const body = new THREE.Mesh(new THREE.BoxGeometry(34, 10, 40), hangarMat);
    body.position.set(hx, 5, hz);
    body.rotation.y = rot;
    body.castShadow = body.receiveShadow = true;
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(17, 17, 40, 20, 1, false, -Math.PI / 2, Math.PI), roofMat);
    roof.rotation.set(Math.PI / 2, 0, rot);
    roof.rotation.order = 'ZXY';
    roof.scale.set(1, 1, 0.35);
    roof.position.set(hx, 10, hz);
    group.add(body, roof);
  }
  const tower = new THREE.Group();
  const tBase = new THREE.Mesh(new THREE.CylinderGeometry(3, 4, 22, 12), hangarMat);
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
  scene.add(group);
  return group;
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
  const sky = new Sky();
  sky.scale.setScalar(450000);
  const u = sky.material.uniforms;
  u.turbidity.value = 6;
  u.rayleigh.value = 1.6;
  u.mieCoefficient.value = 0.005;
  u.mieDirectionalG.value = 0.8;
  const sun = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(52), THREE.MathUtils.degToRad(200));
  u.sunPosition.value.copy(sun);
  scene.add(sky);

  scene.fog = new THREE.Fog(0xb8c8d8, 6000, 38000);
  scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x5a5040, 1.1));
  const dir = new THREE.DirectionalLight(0xfff1dc, 2.2);
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

  const tiles = { total: 0, loaded: 0, failed: 0 };
  tileLayer(scene, renderer, 13, 4, -1.0, 1, 0x7d7b62, tiles);
  tileLayer(scene, renderer, 15, 4, -0.5, 2, 0x86846a, tiles);
  tileLayer(scene, renderer, 17, 4, 0, 3, 0x8a8a70, tiles);
  buildAirfield(scene);
  // Real OSM buildings near the airfield, generated city beyond them.
  const osm = new FootprintGrid();
  const city = createCity(scene, loadBuildings(scene, osm));

  return {
    tiles,
    /** Keep the shadow frustum centred on the player and stream city chunks around them. */
    follow(pos) {
      dir.position.set(pos.x + sun.x * 2000, pos.y + sun.y * 2000, pos.z + sun.z * 2000);
      dir.target.position.copy(pos);
      city.update(pos);
    },
    /** Sphere (x, y, z, r) against every building: null or { nx, nz, depth }. */
    collide(x, y, z, r) {
      return osm.hit(x, y, z, r) ?? city.collide(x, y, z, r);
    },
  };
}
