"""
Computes a real kernel density estimate (KDE) over the dataset's verified
crash coordinates, and outputs a grid the frontend renders as a smooth
heatmap ("Predicted risk (density model)").

Why this exists, and why it's legitimate where the rest of the dataset isn't:
prasiswazah.csv's ATTRIBUTE columns are independently shuffled (see
build_risk_lookup.py / README), so nothing about *why* a crash happened is
usable. But the coordinates survive verification -- 76% land inside real
Pahang boundaries against ~8.4% expected if lat/lng had been shuffled
independently, and points cluster ~5.6x tighter than uniform-random ones
would (median nearest-neighbour 3.4km vs 18.9km). So *where* crashes were
recorded is real signal, and density estimation over real point locations is
genuine, defensible unsupervised ML -- unlike the district-level risk shading
(risk_lookup.geojson), which is a coarse count aggregate standing in for a
model that doesn't exist yet, this is an actual statistical model fit to data
that held up under scrutiny.

What this IS: a map of where recorded crashes cluster geographically.
What this is NOT: a prediction of future crashes, or of severity/cause --
the columns needed for that (weather, road type, driver factors...) are the
shuffled ones. The frontend labels it accordingly.

Method: 2D Gaussian KDE (scipy), computed in a local equirectangular
projection (not raw lat/lng) so the kernel is actually circular in metres,
not stretched by latitude -- Pahang spans ~2 degrees of latitude, enough for
naive lat/lng-distance KDE to visibly skew east-west. Evaluated on a grid,
masked to Pahang's real district polygons (a bounding box would leak density
into the sea/neighbouring states), and only significant cells are kept to
keep the output small.
"""
import json
import math
import os

import numpy as np
from scipy.stats import gaussian_kde

HERE = os.path.dirname(os.path.abspath(__file__))
POINTS_PATH = os.path.join(HERE, "crash_points.geojson")
DISTRICTS_PATH = os.path.join(HERE, "pahang_districts.geojson")
OUT_PATH = os.path.join(HERE, "density_model.json")

GRID_STEP_M = 800  # ~800m cells -- fine enough to show real hotspot shape, coarse enough to keep the file small
MIN_DENSITY_FRACTION = 0.03  # drop cells below 3% of peak density; they'd render as invisible noise anyway


def load_points():
    with open(POINTS_PATH, encoding="utf-8") as fh:
        geo = json.load(fh)
    return [(f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0]) for f in geo["features"]]  # (lat, lng)


def _rings(geom):
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


def load_pahang_polys():
    with open(DISTRICTS_PATH, encoding="utf-8") as fh:
        gj = json.load(fh)
    return [_rings(f["geometry"]) for f in gj["features"]]


def in_pahang(lng, lat, polys):
    for feature in polys:
        for outer, holes in feature:
            if _in_ring(lng, lat, outer) and not any(_in_ring(lng, lat, h) for h in holes):
                return True
    return False


def main():
    pts = load_points()
    lats = np.array([p[0] for p in pts])
    lngs = np.array([p[1] for p in pts])
    mean_lat = float(lats.mean())

    # Local equirectangular projection to metres, centred on the data's own
    # mean latitude -- keeps the KDE's kernel circular in real distance
    # instead of stretched by longitude's latitude-dependent scale.
    M_PER_DEG_LAT = 111_320.0
    m_per_deg_lng = 111_320.0 * math.cos(math.radians(mean_lat))

    x = lngs * m_per_deg_lng
    y = lats * M_PER_DEG_LAT

    kde = gaussian_kde(np.vstack([x, y]))  # Scott's rule bandwidth (scipy default) -- a reasonable, standard, defensible default

    x_min, x_max = x.min(), x.max()
    y_min, y_max = y.min(), y.max()
    pad = GRID_STEP_M * 3
    xs = np.arange(x_min - pad, x_max + pad, GRID_STEP_M)
    ys = np.arange(y_min - pad, y_max + pad, GRID_STEP_M)
    gx, gy = np.meshgrid(xs, ys)
    grid_flat = np.vstack([gx.ravel(), gy.ravel()])

    density = kde(grid_flat)
    density = density / density.max()  # normalise 0-1 for the frontend

    polys = load_pahang_polys()
    lng_grid = gx.ravel() / m_per_deg_lng
    lat_grid = gy.ravel() / M_PER_DEG_LAT

    cells = []
    for lat_v, lng_v, d in zip(lat_grid, lng_grid, density):
        if d < MIN_DENSITY_FRACTION:
            continue
        if not in_pahang(lng_v, lat_v, polys):
            continue
        cells.append([round(float(lat_v), 5), round(float(lng_v), 5), round(float(d), 4)])

    out = {
        "metadata": {
            "method": "2D Gaussian KDE (scipy.stats.gaussian_kde, Scott's rule bandwidth), local equirectangular projection, evaluated on an 800m grid, clipped to real Pahang district polygons",
            "source": "data/crash_points.geojson -- verified real crash coordinates only (see that file's own metadata for the verification)",
            "input_points": len(pts),
            "grid_cells": len(cells),
            "disclaimer": (
                "This is a density model of WHERE past recorded crashes cluster, not a "
                "prediction of future crashes or of severity/cause -- the dataset's outcome "
                "and factor columns are independently shuffled (see README), so nothing about "
                "WHY a crash happened is used here, only verified real locations."
            ),
        },
        "cells": cells,  # [lat, lng, normalised_density 0-1]
    }
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(out, fh)
    print(f"wrote {len(cells)} grid cells ({os.path.getsize(OUT_PATH)} bytes) to {OUT_PATH}")


if __name__ == "__main__":
    main()
