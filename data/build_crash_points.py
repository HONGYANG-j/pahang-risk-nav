"""
Extracts the real crash coordinates from prasiswazah.csv into a compact
GeoJSON the app can draw directly.

Why this exists (and why it is separate from build_risk_lookup.py):
the risk layer aggregates to whole districts, so a single flagged district
paints ~4,000 km2 of map. That is an aggregation choice, not a limit of the
data -- the CSV carries Latitude/Longitude at ~1 m precision (5 dp), and
those coordinates are demonstrably NOT shuffled the way the attribute
columns are:

  * 76% of points fall inside Pahang, against ~8% expected if latitude and
    longitude had been shuffled independently across the state-sized
    bounding box the values span
  * they cluster ~5.6x more tightly than uniform random points over the same
    box (median nearest-neighbour 3.4 km vs 18.9 km), i.e. they follow roads
    and towns like real incident locations
  * 65% sit inside the very district their own District column names

So the locations are real signal and worth showing. What is NOT usable is the
severity attached to them: the outcome columns are shuffled (see README), so
this layer is deliberately "where crashes were recorded", never "how
dangerous this spot is".

~24% of rows fall outside Pahang entirely, which is consistent with the
coordinates having been jittered for privacy before release -- so individual
points are not exact crash sites and are dropped here rather than drawn in
the sea.
"""
import csv
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
CSV = os.path.join(HERE, "..", "..", "prasiswazah.csv")
OUT = os.path.join(HERE, "crash_points.geojson")
DISTRICTS = os.path.join(HERE, "pahang_districts.geojson")


def _rings(geom):
    """Every outer ring, for Polygon and MultiPolygon alike."""
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
    return [(p[0], p[1:]) for p in polys]


def _in_ring(x, y, ring):
    inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        if (y1 > y) != (y2 > y):
            if x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1:
                inside = not inside
    return inside


def load_pahang():
    """Real district polygons -- a bounding box is far too loose here: it
    admits ~490 points that sit in the sea or in neighbouring states, which
    would draw straight through the app's dimmed not-Pahang mask."""
    with open(DISTRICTS, encoding="utf-8") as fh:
        gj = json.load(fh)
    return [_rings(f["geometry"]) for f in gj["features"]]


def in_pahang(lng, lat, polys):
    for feature in polys:
        for outer, holes in feature:
            if _in_ring(lng, lat, outer) and not any(_in_ring(lng, lat, h) for h in holes):
                return True
    return False


def main():
    polys = load_pahang()
    feats = []
    dropped = 0
    with open(CSV, encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            try:
                lat = float(row["Latitude"])
                lng = float(row["Longitude"])
            except (TypeError, ValueError):
                dropped += 1
                continue
            if not in_pahang(lng, lat, polys):
                dropped += 1
                continue
            feats.append({
                "type": "Feature",
                # rounded to ~10 m: finer than that is false precision given
                # the coordinates were jittered, and it keeps the file small
                "geometry": {"type": "Point", "coordinates": [round(lng, 4), round(lat, 4)]},
                "properties": {"district": (row.get("District") or "").strip()},
            })

    out = {
        "type": "FeatureCollection",
        "metadata": {
            "source": "prasiswazah.csv (DAX 2026 sample), Latitude/Longitude columns",
            "disclaimer": (
                "Recorded crash locations only. Coordinates appear genuine and coherent, "
                "but the dataset's outcome/severity columns are shuffled, so these points "
                "carry no severity meaning. Coordinates also appear jittered for privacy "
                "(~24% of rows fall outside Pahang and are excluded), so treat them as "
                "approximate locations, not exact crash sites."
            ),
            "points": len(feats),
            "dropped_outside_pahang": dropped,
        },
        "features": feats,
    }
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh)
    print(f"wrote {len(feats)} points to {OUT} (dropped {dropped} outside Pahang)")


if __name__ == "__main__":
    main()
