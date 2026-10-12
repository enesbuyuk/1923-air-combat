// Street map under the radar scope: Esri's dark grey canvas with its place-name layer
// on top (no API key needed), fetched tile by tile as the aircraft moves and drawn
// heading-up around the player.

const ZOOM = 12;
const TILE = 256;
/** Base map, then the transparent label layer drawn over it. */
const LAYERS = ['Canvas/World_Dark_Gray_Base', 'Canvas/World_Dark_Gray_Reference'];
const TILE_URL = (layer, z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/${layer}/MapServer/tile/${z}/${y}/${x}`;
/** Web Mercator ground resolution at zoom 0 (m per tile pixel at the equator). */
const M_PER_PX_Z0 = 156543.034;

/** `${layer}/${x}/${y}` -> HTMLImageElement; usable once `complete` with a non-zero width. */
const cache = new Map();

function tile(layer, x, y) {
  const key = `${layer}/${x}/${y}`;
  let img = cache.get(key);
  if (!img) {
    img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = TILE_URL(layer, ZOOM, x, y);
    cache.set(key, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/**
 * Draw the map clipped to the scope circle.
 * @param {CanvasRenderingContext2D} g
 * @param {number} cx scope centre (CSS px)
 * @param {number} cy
 * @param {number} r scope radius (CSS px)
 * @param {number} range metres from centre to the scope edge
 * @param {{lat: number, lon: number}} geo player position
 * @param {number} heading radians, clockwise from north (heading-up)
 */
export function drawMap(g, cx, cy, r, range, geo, heading) {
  const n = 2 ** ZOOM;
  const latR = (geo.lat * Math.PI) / 180;
  // Player position in tile pixels at ZOOM.
  const px = ((geo.lon + 180) / 360) * n * TILE;
  const py = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n * TILE;
  const metresPerPx = (M_PER_PX_Z0 * Math.cos(latR)) / n;
  const k = (metresPerPx * r) / range; // screen px per tile px
  const reach = r / k; // scope radius in tile px
  g.save();
  g.shadowBlur = 0;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.clip();
  g.translate(cx, cy);
  g.rotate(-heading);
  g.scale(k, k);
  g.imageSmoothingQuality = 'high';
  for (const layer of LAYERS) {
    for (let ty = Math.floor((py - reach) / TILE); ty <= Math.floor((py + reach) / TILE); ty++) {
      for (let tx = Math.floor((px - reach) / TILE); tx <= Math.floor((px + reach) / TILE); tx++) {
        const img = tile(layer, ((tx % n) + n) % n, ty);
        // Slight overlap hides hairline seams between scaled tiles.
        if (img) g.drawImage(img, tx * TILE - px, ty * TILE - py, TILE + 0.5, TILE + 0.5);
      }
    }
  }
  g.restore();
}
