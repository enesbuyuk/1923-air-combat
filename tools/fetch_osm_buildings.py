"""Download OpenStreetMap building footprints around 1923 and write them as a
compact JSON file in game-world metres (x east, z south, origin at LAT0/LON0).

    uv run python3 tools/fetch_osm_buildings.py [radius_m]

Output: web/data/buildings.json
  {
    "radius": R,               # metres covered around the origin
    "count": N,
    "kind":  [N ints]          # 0 residential, 1 industrial, 2 commercial, 3 religious, 4 other
    "h":     [N ints]          # height in decimetres
    "n":     [N ints]          # number of outline points per building
    "p":     [sum(n)*2 ints]   # outline x,z pairs in decimetres, counter-clockwise, not closed
  }

Data (c) OpenStreetMap contributors, ODbL.
"""

import json
import math
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

LAT0 = 40.993
LON0 = 29.2165
M_PER_DEG_LAT = 111132
M_PER_DEG_LON = 111320 * math.cos(math.radians(LAT0))
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]
OUT = Path(__file__).resolve().parent.parent / "web" / "data" / "buildings.json"

INDUSTRIAL = {"industrial", "warehouse", "factory", "manufacture", "hangar", "storage_tank", "service"}
COMMERCIAL = {"commercial", "retail", "office", "supermarket", "hotel", "hospital", "school", "university", "public", "civic", "government"}
RELIGIOUS = {"mosque", "church", "religious", "cathedral", "chapel", "temple"}
SMALL = {"garage", "garages", "shed", "hut", "roof", "carport", "kiosk", "cabin"}
HOUSES = {"house", "detached", "semidetached_house", "bungalow", "farm"}

# Building kinds; web/js/buildings.js picks colours by this index.
RESIDENTIAL, INDUSTRIAL_KIND, COMMERCIAL_KIND, RELIGIOUS_KIND, OTHER = range(5)
FLOOR_HEIGHT = 3.1  # metres per storey
ROOF_HEIGHT = 1.0


def to_world(lat, lon):
    return (lon - LON0) * M_PER_DEG_LON, -(lat - LAT0) * M_PER_DEG_LAT


def classify(tags):
    b = tags.get("building", "yes")
    if tags.get("amenity") == "place_of_worship" or b in RELIGIOUS:
        return RELIGIOUS_KIND
    if b in INDUSTRIAL:
        return INDUSTRIAL_KIND
    if b in COMMERCIAL or "shop" in tags:
        return COMMERCIAL_KIND
    if b in SMALL:
        return OTHER
    return RESIDENTIAL


def parse_float(s):
    try:
        return float(str(s).split()[0].replace(",", "."))
    except (ValueError, IndexError):
        return None


def storeys(n):
    return n * FLOOR_HEIGHT + ROOF_HEIGHT


def height(tags, kind, rnd):
    """Height in metres: OSM height, else levels, else a plausible guess for the kind."""
    h = parse_float(tags.get("height", ""))
    if h and 2 <= h <= 300:
        return h
    lv = parse_float(tags.get("building:levels", ""))
    if lv and 0 < lv <= 80:
        return storeys(lv)
    b = tags.get("building", "yes")
    if b in SMALL:
        return 3.0
    if kind == INDUSTRIAL_KIND:
        return rnd.uniform(7, 13)
    if kind == RELIGIOUS_KIND:
        return rnd.uniform(10, 16)
    if b in HOUSES:
        return storeys(rnd.uniform(2, 3))
    # Typical Anatolian-side apartment blocks: 3-8 floors.
    return storeys(rnd.randint(3, 8))


def point_in_poly(x, z, poly):
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, zi = poly[i]
        xj, zj = poly[j]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
            inside = not inside
        j = i
    return inside


def overpass(bbox):
    query = f"""
[out:json][timeout:180];
(
  way["building"]({bbox});
  way["aeroway"="aerodrome"]({bbox});
);
out tags geom;
"""
    for attempt in range(3):
        for url in OVERPASS:
            req = urllib.request.Request(
                url,
                data=urllib.parse.urlencode({"data": query}).encode(),
                headers={"User-Agent": "1923-air/1.0 (building import)"},
            )
            try:
                with urllib.request.urlopen(req, timeout=300) as r:
                    return json.load(r)
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
                print(f"  {url}: {e}", file=sys.stderr)
        time.sleep(15 * (attempt + 1))
    sys.exit("All Overpass servers failed; try again later.")


def main():
    radius = float(sys.argv[1]) if len(sys.argv) > 1 else 6000
    dlat = radius / M_PER_DEG_LAT
    dlon = radius / M_PER_DEG_LON
    tiles = 4  # query in tiles; one big query times out on dense Istanbul
    elements = {}
    for ti in range(tiles):
        for tj in range(tiles):
            south = LAT0 - dlat + 2 * dlat * ti / tiles
            west = LON0 - dlon + 2 * dlon * tj / tiles
            bbox = f"{south},{west},{south + 2 * dlat / tiles},{west + 2 * dlon / tiles}"
            print(f"Tile {ti * tiles + tj + 1}/{tiles * tiles}…", file=sys.stderr)
            for el in overpass(bbox)["elements"]:
                elements[(el["type"], el["id"])] = el
    data = {"elements": list(elements.values())}

    # The game builds its own airfield; skip OSM buildings inside the aerodrome.
    aerodromes = [
        [to_world(g["lat"], g["lon"]) for g in el["geometry"]]
        for el in data["elements"]
        if el.get("tags", {}).get("aeroway") == "aerodrome" and "geometry" in el
    ]

    kinds, heights, counts, pts = [], [], [], []
    skipped = 0
    for el in data["elements"]:
        tags = el.get("tags", {})
        if "building" not in tags or "geometry" not in el:
            continue
        poly = [to_world(g["lat"], g["lon"]) for g in el["geometry"]]
        if len(poly) > 1 and poly[0] == poly[-1]:
            poly = poly[:-1]
        if len(poly) < 3:
            continue
        cx = sum(p[0] for p in poly) / len(poly)
        cz = sum(p[1] for p in poly) / len(poly)
        if cx * cx + cz * cz > radius * radius:
            continue
        if any(point_in_poly(cx, cz, a) for a in aerodromes):
            skipped += 1
            continue
        # Counter-clockwise when viewed from above (+Y): in x/z with z south that is a
        # negative shoelace sum.
        area = sum(poly[i][0] * poly[i - 1][1] - poly[i - 1][0] * poly[i][1] for i in range(len(poly))) / 2
        if abs(area) < 4:
            continue
        if area > 0:
            poly.reverse()
        kind = classify(tags)
        rnd = random.Random(el["id"])
        kinds.append(kind)
        heights.append(round(height(tags, kind, rnd) * 10))
        counts.append(len(poly))
        for x, z in poly:
            pts.extend((round(x * 10), round(z * 10)))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"radius": radius, "count": len(kinds), "kind": kinds, "h": heights, "n": counts, "p": pts}, separators=(",", ":")))
    print(f"{len(kinds)} buildings ({skipped} inside aerodrome skipped) -> {OUT} ({OUT.stat().st_size // 1024} KB)", file=sys.stderr)


if __name__ == "__main__":
    main()
