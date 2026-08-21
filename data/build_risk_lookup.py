"""
Builds data/risk_lookup.geojson from ../../prasiswazah.csv.

WHAT THIS IS: the share of vehicle records, per district x time-of-day bucket,
whose 'Type of Crash' is Fatal. It gives the app something to render before the
modeling teammates' classifier is ready. Swap the output for their export later
-- same schema (see risk-nav-app/README.md), so js/risk.js needs no change.

WHAT THIS IS NOT: a risk model. The source dataset's columns are independently
shuffled (see the disclaimer emitted into the output metadata below), so the
scores it produces are noise around a base rate, and every consumer of this file
is expected to label them as placeholders rather than findings.

Note the unit of analysis is a VEHICLE RECORD, not a distinct crash: 'Report
Number' does not group a real crash event in this dataset -- vehicles sharing
one are a median of 110km apart.

Rerun with: python build_risk_lookup.py
"""
import csv
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path

SRC = Path(__file__).resolve().parents[2] / "prasiswazah.csv"
OUT = Path(__file__).resolve().parent / "risk_lookup.geojson"

PAHANG_BOUNDS = dict(lat_min=2.0, lat_max=5.0, lon_min=101.0, lon_max=104.5)

BUCKETS = ["morning", "afternoon", "evening", "night"]


def bucket_for_hour(h):
    if 6 <= h < 12:
        return "morning"
    if 12 <= h < 18:
        return "afternoon"
    if 18 <= h < 22:
        return "evening"
    return "night"  # 22-23, 0-5


def parse_hour(time_str):
    s = time_str.strip()
    # format like "7:00:00 PM"
    t, ampm = s.rsplit(" ", 1)
    h, m, sec = t.split(":")
    h = int(h) % 12
    if ampm.upper() == "PM":
        h += 12
    return h


def in_bounds(lat, lon):
    return (
        PAHANG_BOUNDS["lat_min"] <= lat <= PAHANG_BOUNDS["lat_max"]
        and PAHANG_BOUNDS["lon_min"] <= lon <= PAHANG_BOUNDS["lon_max"]
    )


def top_factor(rows, field, default_value):
    """Most common non-default value of `field` among `rows`, if it clears 30% share."""
    vals = [r[field] for r in rows if r[field] != default_value]
    if not vals:
        return None
    counts = defaultdict(int)
    for v in vals:
        counts[v] += 1
    val, n = max(counts.items(), key=lambda kv: kv[1])
    if n / len(rows) >= 0.30:
        return val
    return None


def main():
    with open(SRC, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    for r in rows:
        r["_hour"] = parse_hour(r["Time of Crash"])
        r["_bucket"] = bucket_for_hour(r["_hour"])

    by_district = defaultdict(list)
    for r in rows:
        by_district[r["District"]].append(r)

    features = []
    for district, drows in sorted(by_district.items()):
        valid_geo = [
            r for r in drows if in_bounds(float(r["Latitude"]), float(r["Longitude"]))
        ]
        geo_source = valid_geo if valid_geo else drows
        centroid_lat = statistics.median(float(r["Latitude"]) for r in geo_source)
        centroid_lon = statistics.median(float(r["Longitude"]) for r in geo_source)

        risk_by_time = {}
        for bucket in BUCKETS:
            brows = [r for r in drows if r["_bucket"] == bucket]
            n = len(brows)
            if n == 0:
                risk_by_time[bucket] = {"score": 0.0, "n": 0, "top_factors": [], "low_confidence": True}
                continue
            fatal_rows = [r for r in brows if r["Type of Crash"] == "Fatal"]
            score = round(len(fatal_rows) / n, 3)

            factors = []
            wf = top_factor(fatal_rows or brows, "Weather", "Clear")
            if wf:
                factors.append(wf)
            lf = top_factor(fatal_rows or brows, "Light Condition", "Daylight")
            if lf:
                factors.append(lf)
            rf = top_factor(fatal_rows or brows, "Road Surface Condition", "Dry")
            if rf:
                factors.append(rf)
            if not factors:
                moto_share = sum(1 for r in (fatal_rows or brows) if "Motorcycle" in r["Vehicle Type"]) / len(fatal_rows or brows)
                if moto_share >= 0.6:
                    factors.append("High motorcycle involvement")

            risk_by_time[bucket] = {
                "score": score,
                "n": n,
                "top_factors": factors[:2],
                "low_confidence": n < 15,
            }

        radius_km = max(6, min(15, 6 + math.log1p(len(drows))))

        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [centroid_lon, centroid_lat]},
                "properties": {
                    "district": district,
                    "total_crashes": len(drows),
                    "radius_km": round(radius_km, 1),
                    "risk_by_time": risk_by_time,
                },
            }
        )

    geojson = {
        "type": "FeatureCollection",
        "metadata": {
            "source": "prasiswazah.csv (DAX 2026 Road Safety dataset)",
            "metric": "score = share of vehicle records in this district+time bucket "
            "whose 'Type of Crash' is Fatal",
            "unit_of_analysis": "vehicle record -- NOT a distinct crash event",
            "status": "PLACEHOLDER -- NOT A VALIDATED RISK MODEL",
            "disclaimer": (
                "The source dataset's columns are independently shuffled: vehicles sharing a "
                "Report Number sit a median of 110km apart, 'Day' matches the weekday of "
                "'Date of Report' only 15.9% of the time (chance = 14.3%), and Light Condition "
                "is independent of crash hour. Scores here span roughly 0.42-0.57 around a 51.9% "
                "base rate -- that spread is noise, not signal. Do not present these as findings; "
                "replace this file with a validated model before drawing any conclusion."
            ),
        },
        "features": features,
    }
    OUT.write_text(json.dumps(geojson, indent=2), encoding="utf-8")
    print(f"Wrote {OUT} with {len(features)} districts.")


if __name__ == "__main__":
    main()
