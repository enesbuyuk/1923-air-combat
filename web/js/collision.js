// Building collision: footprints are flat polygons in x/z extruded from the ground up to
// `top`. Both the real OSM buildings and the generated city register footprints here; the
// player's position is tested against them and a hit is reported to the WASM core.

/**
 * A footprint from an outline `pts` ([[x, z], ...], either winding) and a roof height.
 * Coordinates are packed into a Float32Array to keep 70k buildings light.
 */
export function footprint(pts, top) {
  const xz = new Float32Array(pts.length * 2);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  pts.forEach(([x, z], i) => {
    xz[i * 2] = x;
    xz[i * 2 + 1] = z;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  });
  return { xz, top, minX, maxX, minZ, maxZ };
}

/**
 * Body at (x, y, z) reaching `r` sideways and `below` down (a sphere by default) against
 * footprint `f`. Returns null, or { nx, nz, depth }: the horizontal way out of the
 * building and how far to move.
 */
export function hitFootprint(f, x, y, z, r, below = r) {
  if (y - below > f.top) return null;
  if (x + r < f.minX || x - r > f.maxX || z + r < f.minZ || z - r > f.maxZ) return null;
  const p = f.xz;
  const n = p.length / 2;
  let inside = false;
  let best = Infinity;
  let cx = 0;
  let cz = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const x0 = p[j * 2], z0 = p[j * 2 + 1];
    const x1 = p[i * 2], z1 = p[i * 2 + 1];
    if ((z1 > z) !== (z0 > z) && x < ((x0 - x1) * (z - z1)) / (z0 - z1) + x1) inside = !inside;
    // Closest point on this edge.
    const ex = x1 - x0;
    const ez = z1 - z0;
    const l2 = ex * ex + ez * ez;
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - x0) * ex + (z - z0) * ez) / l2)) : 0;
    const qx = x0 + ex * t;
    const qz = z0 + ez * t;
    const d2 = (x - qx) ** 2 + (z - qz) ** 2;
    if (d2 < best) {
      best = d2;
      cx = qx;
      cz = qz;
    }
  }
  const d = Math.sqrt(best);
  if (!inside && d >= r) return null;
  // Inside: push toward the nearest wall; outside but overlapping: push away from it.
  const s = inside ? 1 : -1;
  const nx = d > 1e-4 ? (s * (cx - x)) / d : 1;
  const nz = d > 1e-4 ? (s * (cz - z)) / d : 0;
  return { nx, nz, depth: inside ? d + r : r - d };
}

/** Uniform grid of footprints for fast lookup around a point. */
export class FootprintGrid {
  constructor(cell = 100) {
    this.cell = cell;
    this.cells = new Map();
  }
  add(f) {
    const c = this.cell;
    for (let i = Math.floor(f.minX / c); i <= Math.floor(f.maxX / c); i++) {
      for (let j = Math.floor(f.minZ / c); j <= Math.floor(f.maxZ / c); j++) {
        const key = i * 65536 + j;
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, (list = []));
        list.push(f);
      }
    }
  }
  hit(x, y, z, r, below = r) {
    const c = this.cell;
    for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) {
      for (let j = Math.floor((z - r) / c); j <= Math.floor((z + r) / c); j++) {
        const list = this.cells.get(i * 65536 + j);
        if (!list) continue;
        for (const f of list) {
          const h = hitFootprint(f, x, y, z, r, below);
          if (h) return h;
        }
      }
    }
    return null;
  }
}
