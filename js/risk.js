import { State } from "./state.js";

const RISK_THRESHOLD_HIGH = 0.5; // score >= this counts as a "flagged" zone for alerts
// The dataset's overall fatal-share base rate (see baseline_signal_check.py:
// ~51.9%). Used as the pivot for how prominently a zone is drawn: districts
// sitting near or below the base rate aren't meaningfully "low risk" in any
// statistical sense (this data has ~no real signal -- see the synthetic-data
// memory), so drawing them as boldly as a genuinely above-average district
// would overstate them. Fading them toward the basemap is the honest choice,
// and it's also what actually fixes "the map looks cluttered": with every
// district drawn at similar visual weight, all 11 compete for attention
// instead of the 2-3 that are actually above baseline standing out.
const BASELINE_SCORE = 0.52;

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function scoreColor(score) {
  if (score >= 0.6) return "#ff3d68"; // clearly above baseline
  if (score >= BASELINE_SCORE) return "#ffb020"; // at/just above baseline
  return "#3a5568"; // at/below baseline -- recedes into the dark basemap, not a claim of "safe"
}

function fillOpacityFor(score) {
  if (score >= 0.6) return Math.min(0.55, 0.32 + (score - 0.6) * 0.7);
  if (score >= BASELINE_SCORE) return 0.14 + (score - BASELINE_SCORE) * 1.8;
  return 0.04;
}

function strokeWeightFor(score) {
  if (score >= 0.6) return 2.5;
  if (score >= BASELINE_SCORE) return 1.5;
  return 0.75;
}

function asTurfFeature(geometry) {
  return { type: "Feature", properties: {}, geometry };
}

/**
 * Loads risk_lookup.geojson (the data -- district x time-bucket scores, from
 * the modelling teammates' export or the placeholder generator) and
 * pahang_districts.geojson (the shapes -- real DOSM district boundaries), and
 * joins them by district name. Keeping these as two files means the data
 * schema documented in README.md for the modelling handoff never has to
 * change just because the map rendering got upgraded from circles to real
 * polygons.
 */
export async function loadRiskLayer() {
  const [riskRes, shapeRes] = await Promise.all([
    fetch("data/risk_lookup.geojson"),
    fetch("data/pahang_districts.geojson"),
  ]);
  const riskGeo = await riskRes.json();
  const shapeGeo = await shapeRes.json();

  const shapeByDistrict = new Map(shapeGeo.features.map((f) => [f.properties.district, f.geometry]));

  State.riskFeatures = riskGeo.features
    .map((f) => {
      const geometry = shapeByDistrict.get(f.properties.district);
      if (!geometry) {
        console.warn(`No boundary shape found for district "${f.properties.district}" -- skipping.`);
        return null;
      }
      return { district: f.properties.district, geometry, risk_by_time: f.properties.risk_by_time };
    })
    .filter(Boolean);

  renderRiskLayer();
}

/**
 * Draws the REAL recorded crash coordinates from the dataset.
 *
 * The risk shading aggregates to whole districts, so one flagged district
 * paints thousands of km2 -- which reads as "this entire region is
 * dangerous" when the underlying rows actually carry ~1 m coordinates. Those
 * coordinates, unlike the dataset's attribute columns, stand up to checking:
 * 76% fall inside Pahang (vs ~8% expected if lat/lng had been shuffled
 * independently) and they cluster ~5.6x tighter than uniform random points,
 * i.e. they track roads and towns the way real incident locations do.
 *
 * Strictly "where crashes were recorded", never "how dangerous this spot
 * is": the severity columns ARE shuffled, so no colouring by outcome. Points
 * are also drawn small and translucent on purpose -- density is the readable
 * signal at this sample size (2,288 points across the whole state, busiest
 * ~2 km cell holds only 7), and drawing them as bold markers would imply
 * far more certainty per point than jittered coordinates support.
 */
export async function loadCrashPoints() {
  const res = await fetch("data/crash_points.geojson");
  const geo = await res.json();
  const group = L.layerGroup();
  geo.features.forEach((f) => {
    const [lng, lat] = f.geometry.coordinates;
    L.circleMarker([lat, lng], {
      radius: 3,
      stroke: false,
      fillColor: "#ff5c8a",
      fillOpacity: 0.45,
      interactive: false, // purely a density backdrop; must not eat map taps
      className: "crash-point",
    }).addTo(group);
  });
  State.crashPointsLayer = group;
  State.crashPointsCount = geo.features.length;
  return group;
}

/** Toggles the recorded-crash-location layer. */
export function setCrashPointsVisible(on) {
  if (!State.crashPointsLayer || !State.map) return;
  if (on) State.crashPointsLayer.addTo(State.map);
  else State.crashPointsLayer.remove();
  State.crashPointsVisible = on;
}

export function renderRiskLayer() {
  if (State.riskLayerGroup) {
    State.riskLayerGroup.remove();
  }

  const group = L.geoJSON(
    State.riskFeatures.map((f) => ({
      type: "Feature",
      properties: { district: f.district, timeData: f.risk_by_time[State.timeBucket] },
      geometry: f.geometry,
    })),
    {
      style: (feature) => {
        const timeData = feature.properties.timeData;
        const score = timeData?.score ?? 0;
        return {
          color: scoreColor(score),
          weight: strokeWeightFor(score),
          opacity: score >= BASELINE_SCORE ? 0.85 : 0.4,
          fillColor: scoreColor(score),
          fillOpacity: fillOpacityFor(score),
          className: score >= 0.6 ? "risk-zone risk-zone-high" : "risk-zone",
        };
      },
      onEachFeature: (feature, layer) => {
        const { district, timeData } = feature.properties;
        if (!timeData) return;
        const factorsText = timeData.top_factors.length
          ? timeData.top_factors.join(", ")
          : "no dominant factor";
        layer.bindTooltip(
          `<strong>${district}</strong><br/>` +
            `Fatal share of records (${State.timeBucket}): ${(timeData.score * 100).toFixed(0)}%` +
            (timeData.low_confidence ? " (low sample)" : "") +
            `<br/>Associated factors: ${factorsText}<br/>` +
            `<span style="font-size:0.7em;color:#e0a0a0">&#9888; Placeholder from synthetic sample ` +
            `data (n=${timeData.n} vehicle records) &mdash; not a validated risk estimate.</span>`,
          { sticky: true, className: "hud-tooltip" }
        );
      },
    }
  );

  group.addTo(State.map);
  State.riskLayerGroup = group;
}

export function setTimeBucket(bucket) {
  State.timeBucket = bucket;
  renderRiskLayer();
  document.querySelectorAll("#time-toggle button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.bucket === bucket);
  });
}

/** Returns the highest-scoring flagged risk zone containing (lat,lng), or null. */
export function getRiskAt(lat, lng) {
  const pt = turf.point([lng, lat]);
  let best = null;
  for (const f of State.riskFeatures) {
    const timeData = f.risk_by_time[State.timeBucket];
    if (!timeData || timeData.score < RISK_THRESHOLD_HIGH) continue;
    if (turf.booleanPointInPolygon(pt, asTurfFeature(f.geometry))) {
      if (!best || timeData.score > best.score) {
        best = { district: f.district, score: timeData.score, top_factors: timeData.top_factors };
      }
    }
  }
  return best;
}

/**
 * Returns {district, score} for whichever district polygon contains (lat,lng),
 * regardless of the alert threshold -- for informational HUD display (the
 * proximity-alert logic in alerts.js uses getRiskAt instead, which only
 * returns FLAGGED zones).
 */
export function getDistrictAt(lat, lng) {
  const pt = turf.point([lng, lat]);
  for (const f of State.riskFeatures) {
    if (turf.booleanPointInPolygon(pt, asTurfFeature(f.geometry))) {
      const timeData = f.risk_by_time[State.timeBucket];
      return { district: f.district, score: timeData ? timeData.score : null };
    }
  }
  return null;
}

/** Checks a polyline (array of [lat,lng]) for any flagged risk zone it passes through. */
export function getRiskAlongRoute(coords) {
  const sampleEvery = Math.max(1, Math.floor(coords.length / 60)); // cap sampling cost
  for (let i = 0; i < coords.length; i += sampleEvery) {
    const [lat, lng] = coords[i];
    const hit = getRiskAt(lat, lng);
    if (hit) return hit;
  }
  return null;
}

export { haversineMeters };
