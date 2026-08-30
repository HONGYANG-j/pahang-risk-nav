import { State } from "./state.js";
import { getRiskAlongRoute, haversineMeters } from "./risk.js";
import { onUserMove, syncNavButton } from "./map.js";
import { logEvent } from "./eventlog.js";
import { speak } from "./tts.js";

const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";
const ROUTE_JAM_CLEARANCE_M = 400; // an alternate must clear the trouble point by at least this much to count as "avoiding" it
const MAX_DETOUR_RATIO = 1.6; // ...without ballooning to more than 1.6x the original distance

// Notified when an active route is *replaced* by a reroute (not on initial
// planning). Demo mode uses this to steer the simulated vehicle onto the new
// route -- otherwise the line would change while the car drove the old path.
const rerouteListeners = [];
export function onReroute(fn) {
  rerouteListeners.push(fn);
}

/**
 * Fetches route(s) from OSRM's public demo server.
 * Returns an array of {coords: [[lat,lng],...], distanceM, durationS}.
 * NOTE: public demo server, no SLA/key -- fine for a prototype demo, not production.
 */
export async function fetchRoutes(from, to, { alternatives = false } = {}) {
  const url = `${OSRM_BASE}/${from.lng},${from.lat};${to.lng},${to.lat}` +
    `?overview=full&geometries=geojson&alternatives=${alternatives}&steps=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM request failed: ${res.status}`);
  const data = await res.json();
  if (data.code !== "Ok" || !data.routes?.length) {
    throw new Error(`OSRM returned no route (${data.code})`);
  }
  // OSRM can only route between points ON its road network, so it snaps each
  // requested coordinate to the nearest road and tells us where it landed
  // (`waypoints[].location`) and how far that was (`.distance`). That snap is
  // unbounded: a tap in Pahang's interior jungle can snap kilometres away.
  // Callers need this to keep the map honest about where the route ACTUALLY
  // ends -- see updateDestMarker's use in planRoute.
  const last = data.waypoints?.[data.waypoints.length - 1];
  const snappedDest = last
    ? { lat: last.location[1], lng: last.location[0], snapDistanceM: last.distance, name: last.name || "" }
    : null;

  return data.routes.map((r) => ({
    coords: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    distanceM: r.distance,
    durationS: r.duration,
    steps: r.legs?.[0]?.steps || [], // turn-by-turn maneuvers -- single leg since we never request via-points from OSRM directly
    snappedDest,
  }));
}

/** Cumulative along-route distance in metres, one entry per coordinate --
 * lets the live progress view convert "nearest point on the route" into
 * "how far travelled" without re-summing the whole route on every GPS tick. */
function cumulativeDistances(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum[i] = cum[i - 1] + haversineMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return cum;
}

/** Cumulative distance at the START of each step (steps[i].maneuver happens
 * at stepStartM[i]), plus one trailing entry for the route's total -- lets
 * updateTurnBanner convert "how far travelled" into "which step am I on,
 * how far to the next maneuver" without re-summing steps on every tick. */
function stepStartDistances(steps) {
  const starts = [0];
  for (let i = 0; i < steps.length; i++) {
    starts.push(starts[i] + steps[i].distance);
  }
  return starts;
}

function drawRouteLine(coords, durationS, steps, color = "#2f6fed") {
  if (State.route.layer) State.route.layer.remove();
  if (State.route.traveledLayer) State.route.traveledLayer.remove();
  // Two layers, not one: the covered stretch dims out behind you as you
  // drive (updateRouteProgress below repoints both on every position update)
  // -- what makes this read as a live "on the way" view instead of just a
  // static planned line that happens to sit under a moving marker.
  const traveledLayer = L.polyline([], { color: "#56698a", weight: 4, opacity: 0.55 }).addTo(State.map);
  const layer = L.polyline(coords, { color, weight: 5, opacity: 0.85 }).addTo(State.map);
  State.route.layer = layer;
  State.route.traveledLayer = traveledLayer;
  State.route.coords = coords;
  State.route.cumDist = cumulativeDistances(coords);
  // Own measurement, not OSRM's separately-reported distance -- so "remaining"
  // is computed from the same numbers as "travelled" and hits exactly 0 at
  // the route's actual last vertex instead of drifting from a slightly
  // different distance figure.
  State.route.totalDistanceM = State.route.cumDist[State.route.cumDist.length - 1] || 0;
  State.route.totalDurationS = durationS;
  State.route.steps = steps || [];
  State.route.stepStartM = stepStartDistances(State.route.steps);
  // A new route (or a reroute) means every maneuver is un-announced again --
  // without this a reroute would silently stay silent, since the old route's
  // step 2 having already been spoken doesn't say anything about the new
  // route's step 2.
  announcedStepIndex = -1;
  // Fit-to-whole-route is the right framing when PICKING a route, but wrong
  // while driving one: a reroute fires this same function mid-drive, and
  // zooming out to the full route there would throw the camera off the
  // vehicle exactly when the driver needs the close-up view most.
  if (!State.navMode) State.map.fitBounds(layer.getBounds(), { padding: [40, 40] });
}

/** The route line's endpoint IS the destination, but nothing marked it as
 * such -- easy to lose track of exactly where you're headed on a long or
 * winding route. A small distinct pin fixes that with no new dependency. */
function updateDestMarker(dest, label) {
  if (State.route.destMarker) State.route.destMarker.remove();
  State.route.destMarker = L.marker([dest.lat, dest.lng], {
    icon: L.divIcon({ className: "dest-marker-icon", html: '<div class="dest-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 17] }),
    zIndexOffset: 900,
  }).addTo(State.map);
  if (label) {
    // .tt-upright counter-rotates against nav mode's heading-up map rotation
    // -- see the CSS comment for why this can't just be a rule on the
    // tooltip element itself.
    State.route.destMarker.bindTooltip(`<div class="tt-upright">${label}</div>`, {
      className: "hud-tooltip",
      direction: "top",
      offset: [0, -18],
    });
  }
}

/**
 * Tears down the active route. Needed when leaving demo mode: a leftover demo
 * route would keep matching against jams and firing "on your route" alerts once
 * live GPS resumes somewhere else entirely.
 */
export function clearRoute() {
  if (State.route.layer) State.route.layer.remove();
  if (State.route.traveledLayer) State.route.traveledLayer.remove();
  if (State.route.destMarker) State.route.destMarker.remove();
  State.route.layer = null;
  State.route.traveledLayer = null;
  State.route.destMarker = null;
  State.route.coords = null;
  State.route.cumDist = null;
  State.route.totalDistanceM = null;
  State.route.totalDurationS = null;
  State.route.steps = null;
  State.route.stepStartM = null;
  State.route.destination = null;
  const el = document.getElementById("route-info");
  if (el) el.textContent = "";
  const bar = document.getElementById("trip-bar");
  if (bar) bar.hidden = true;
  const turnBanner = document.getElementById("turn-banner");
  if (turnBanner) turnBanner.hidden = true;
  setProgressFill(0);
  // No route left to navigate -- leaving navMode set would keep suppressing
  // drawRouteLine's overview framing for the NEXT route the user plans.
  State.navMode = false;
  syncNavButton();
}

function setProgressFill(fraction) {
  const fill = document.getElementById("trip-progress-fill");
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, fraction * 100))}%`;
}

/** Closest route vertex to `pos` by straight-line distance. A full nearest-
 * segment projection would be more precise, but OSRM's geometry is dense
 * enough for this app's routes (a district-scale drive, not a tight loop)
 * that nearest-vertex is indistinguishable in practice -- consistent with
 * the "good enough to demo, not production-grade" bar used elsewhere here
 * (the reroute via-point heuristic makes the same trade-off). */
function nearestIndexOnRoute(coords, pos) {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = haversineMeters(coords[i][0], coords[i][1], pos.lat, pos.lng);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

const ARRIVED_M = 50; // remaining distance under this counts as "arrived"

function formatTurnDistance(m) {
  if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

// modifier -> degrees to rotate the arrow icon, clockwise from "straight
// ahead". Approximate, not the real road geometry's exact angle -- same
// "good enough to communicate the turn" bar as the rest of this prototype's
// iconography.
const TURN_ICON_DEG = {
  straight: 0, "slight right": 30, right: 90, "sharp right": 120,
  uturn: 180, "sharp left": -120, left: -90, "slight left": -30,
};

// modifier -> how to say it. Same coverage as TURN_ICON_DEG, worded for
// speech rather than an icon rotation.
const TURN_SPEECH = {
  straight: "Continue straight", "slight right": "Bear right", right: "Turn right",
  "sharp right": "Sharp right turn", uturn: "Make a U-turn", "sharp left": "Sharp left turn",
  left: "Turn left", "slight left": "Bear left",
};

// Announce a maneuver once it's this close, not the moment it becomes
// "next" (which could be several km away on a long straight) -- close
// enough to be actionable, matching how real turn-by-turn apps time their
// first announcement of a maneuver. Tuned against demo mode specifically:
// at DEMO_TIME_SCALE's compression, the vehicle covers ground fast even at
// "slow" -- a smaller distance here left under a second of real time between
// the announcement starting and the turn arriving, nowhere near enough for
// a multi-word phrase to finish being spoken. 400m gives a few real seconds
// of lead time at cruise speed; real GPS navigation gets the same distance,
// which reads as an earlier-than-typical heads-up there, a reasonable
// trade for keeping one threshold instead of a demo-only special case.
const ANNOUNCE_DISTANCE_M = 400;

// Index of the step last announced by voice, so each maneuver is spoken
// exactly once no matter how many ticks it stays within ANNOUNCE_DISTANCE_M
// (crawling through a jam right before a turn, for instance). -1 = nothing
// announced yet for the current route; drawRouteLine resets this on every
// new route or reroute.
let announcedStepIndex = -1;

// A minimum real-world gap between spoken turn announcements. Dense urban
// routing (found live-testing a real Kuantan street route) can put several
// maneuvers within a couple hundred metres of each other -- without this,
// each new announcement calls speak()'s cancel()-then-speak() and cuts the
// previous one off mid-word, producing a garbled overlapping stream rather
// than clean back-to-back instructions. Real turn-by-turn systems do the
// same thing: they don't narrate every minor intersection on a dense route,
// they consolidate/skip. A skipped announcement isn't silently lost
// information either -- the visual turn banner still shows it.
const MIN_TURN_ANNOUNCE_GAP_MS = 3000;
let lastTurnAnnounceAt = 0;

function speechDistance(m) {
  if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)} meters`;
  return `${(m / 1000).toFixed(1)} kilometers`;
}

function announceManeuver(type, modifier, streetName, distanceM) {
  if (type === "arrive") {
    speak("Arriving at your destination");
    return;
  }
  const distText = speechDistance(distanceM);
  if (type.includes("roundabout") || type.includes("rotary")) {
    speak(`Enter the roundabout in ${distText}`);
    return;
  }
  const phrase = TURN_SPEECH[modifier] || "Continue";
  speak(streetName ? `${phrase} onto ${streetName} in ${distText}` : `${phrase} in ${distText}`);
}

/** Updates the top-of-screen turn-by-turn banner: which maneuver is coming
 * up and how far to it. `traveledM` is the same figure updateRouteProgress
 * already computed, passed in rather than recomputed. */
function updateTurnBanner(traveledM) {
  const banner = document.getElementById("turn-banner");
  if (!banner) return;
  const steps = State.route.steps;
  const stepStartM = State.route.stepStartM;
  if (!steps?.length || !stepStartM) {
    banner.hidden = true;
    return;
  }

  // Steps partition the route; steps[i].maneuver happens at stepStartM[i]
  // (the end of step i-1). Walk forward to the step whose interval we're
  // currently inside, then the maneuver we're APPROACHING is the next one.
  let i = 0;
  while (i < steps.length - 1 && stepStartM[i + 1] <= traveledM) i++;
  const next = steps[i + 1];
  if (!next) {
    banner.hidden = true;
    return;
  }

  const icon = document.getElementById("turn-icon");
  const distEl = document.getElementById("turn-distance");
  const streetEl = document.getElementById("turn-street");
  const type = next.maneuver.type;
  const modifier = next.maneuver.modifier || "straight";

  if (type === "arrive") {
    icon.textContent = "⚑";
    icon.style.transform = "none";
    streetEl.textContent = "Arrive at destination";
  } else if (type.includes("roundabout") || type.includes("rotary")) {
    icon.textContent = "↻";
    icon.style.transform = "none";
    streetEl.textContent = next.name || "";
  } else {
    icon.textContent = "↑";
    icon.style.transform = `rotate(${TURN_ICON_DEG[modifier] ?? 0}deg)`;
    streetEl.textContent = next.name || "";
  }
  const distRemaining = Math.max(0, stepStartM[i + 1] - traveledM);
  distEl.textContent = formatTurnDistance(distRemaining);
  banner.hidden = false;

  // Speak once per maneuver, only once it's actually close -- `i` (not the
  // maneuver text) is the identity check, so this can't double-announce two
  // different steps that happen to share a modifier (e.g. two "left"s back
  // to back). announcedStepIndex only advances on an announcement that
  // actually fires (not one skipped by the cooldown below), so a step
  // blocked by the gate stays eligible and gets announced on a later tick
  // once the gap has passed, as long as it's still the upcoming step.
  if (i !== announcedStepIndex && distRemaining <= ANNOUNCE_DISTANCE_M) {
    const now = Date.now();
    if (now - lastTurnAnnounceAt >= MIN_TURN_ANNOUNCE_GAP_MS) {
      announcedStepIndex = i;
      lastTurnAnnounceAt = now;
      announceManeuver(type, modifier, next.name, distRemaining);
    }
  }
}

/** The live "on the way" view: how far's left, updated as you actually move,
 * plus the travelled/ahead split on the route line itself. Wired to every
 * position update (see onUserMove call below) rather than called manually,
 * so it runs identically for real GPS and demo mode -- both already funnel
 * through updateUserPosition(), which is the single thing this listens to. */
function updateRouteProgress(pos) {
  if (!State.route.coords || !State.route.layer) return;
  const bar = document.getElementById("trip-bar");
  if (bar) bar.hidden = false;

  const idx = nearestIndexOnRoute(State.route.coords, pos);
  const totalM = Math.max(1, State.route.totalDistanceM);
  const traveledM = State.route.cumDist[idx];
  const remainingM = Math.max(0, State.route.totalDistanceM - traveledM);

  State.route.traveledLayer.setLatLngs(State.route.coords.slice(0, idx + 1));
  State.route.layer.setLatLngs(State.route.coords.slice(idx));
  setProgressFill(traveledM / totalM);

  const el = document.getElementById("route-info");
  const turnBanner = document.getElementById("turn-banner");
  if (remainingM <= ARRIVED_M) {
    if (el) el.textContent = "Arrived";
    if (turnBanner) turnBanner.hidden = true;
    return;
  }
  if (el) {
    const remainingMin = Math.max(1, Math.round((remainingM / totalM) * State.route.totalDurationS / 60));
    // 24-hour, and terse: the trip bar shares its row with the START and
    // clear buttons, and the longer phrasing ("X km to go ... arrive 4:40 PM")
    // wrapped to two lines at phone width. Matches the event log's existing
    // 24h formatting too.
    const eta = new Date(Date.now() + remainingMin * 60000)
      .toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" });
    el.textContent = `${(remainingM / 1000).toFixed(1)} km · ~${remainingMin} min · ${eta}`;
  }
  updateTurnBanner(traveledM);
}
onUserMove(updateRouteProgress);

const SNAP_NOTICE_M = 100; // below this, the snap is small enough not to be worth mentioning

/** Plans a route from the user's live position to `dest` ({lat,lng}). */
export async function planRoute(requestedDest) {
  if (!State.userPos) throw new Error("No live position yet");
  const routes = await fetchRoutes(State.userPos, requestedDest, { alternatives: true });
  const primary = routes[0];

  // Route to (and pin) the point OSRM actually reached, not the raw point the
  // user tapped. Reported as "destination fixed not the one I pressed": the
  // pin was drawn at the tap while the route ended at OSRM's snapped road
  // position, so the two silently disagreed -- by up to kilometres when
  // tapping somewhere with no nearby road (measured 1.9 km in Pahang's
  // interior). Pinning the real endpoint makes what you see match what you
  // get, and storing it as State.route.destination keeps reroutes consistent
  // with it too.
  const snap = primary.snappedDest;
  const dest = snap || requestedDest;
  State.route.destination = dest;
  updateDestMarker(dest, snap?.name || null);
  if (snap && snap.snapDistanceM > SNAP_NOTICE_M) {
    const away = snap.snapDistanceM >= 1000
      ? `${(snap.snapDistanceM / 1000).toFixed(1)} km`
      : `${Math.round(snap.snapDistanceM)} m`;
    logEvent(
      `No road at the exact point picked — routing to the nearest road ${away} away${snap.name ? ` (${snap.name})` : ""}`,
      "warn"
    );
  }

  // Told once, here, rather than pinned permanently to the trip-bar text --
  // the live progress readout below needs that space, and the event log is
  // the right place for a one-time "here's what's notable about this route"
  // note anyway (same treatment "rerouted" already gets from alerts.js).
  const riskHit = getRiskAlongRoute(primary.coords);
  if (riskHit) logEvent(`Route crosses ${riskHit.district} risk zone`, "warn");

  drawRouteLine(primary.coords, primary.durationS, primary.steps);
  // Seed with the route's own first point, not State.userPos -- in demo mode
  // specifically, the vehicle keeps animating (real seconds pass for the OSRM
  // round-trip above) right up until this line, so State.userPos can already
  // be a little ahead of where this route actually starts.
  updateRouteProgress({ lat: primary.coords[0][0], lng: primary.coords[0][1] });
  return { route: primary, alternatives: routes.slice(1), riskHit };
}

/**
 * Reroutes away from a trouble point (a flagged risk zone or a simulated jam
 * centroid). Strategy: ask OSRM for alternatives and pick whichever stays
 * farthest from the trouble point; if OSRM returns no real alternative (common
 * on simpler rural road networks), try nudging a via-point sideways at a
 * couple of different distances and routing through that instead.
 *
 * Every candidate is validated before being shown: it must actually clear the
 * trouble point by a real margin, and not balloon the trip distance. An
 * earlier version skipped this and always drew whatever the via-point nudge
 * produced -- since a raw coordinate offset rarely lands on a road that
 * usefully avoids anything, OSRM would snap it to the *nearest* road (often a
 * small side street) and build a route that dips in and immediately doubles
 * back, which reads as a routing bug, not a reroute. If nothing viable turns
 * up, this keeps the original route rather than drawing a fake-looking detour
 * -- honest about "no better option" beats a detour that doesn't detour.
 */
export async function rerouteAvoiding(troublePoint) {
  if (!State.userPos || !State.route.destination) throw new Error("No active route to reroute");

  const originalDistanceM = State.route.coords ? routeLength(State.route.coords) : Infinity;
  const routes = await fetchRoutes(State.userPos, State.route.destination, { alternatives: true });
  const candidates = [...routes];

  if (routes.length <= 1) {
    // Both offset attempts, and both legs within each, run concurrently
    // rather than one after another -- this was up to 4 sequential OSRM
    // round-trips (2 offsets x 2 legs), easily a few seconds of silent
    // waiting on the public demo server, which is a real chunk of "why does
    // this feel slow". Firing them together costs about one round-trip's
    // worth of wall-clock time instead.
    const attempts = [2.5, 4.5].map(async (offsetKm) => {
      try {
        const via = nudgeAwayFrom(State.userPos, State.route.destination, troublePoint, offsetKm);
        const [[legA], [legB]] = await Promise.all([
          fetchRoutes(State.userPos, via),
          fetchRoutes(via, State.route.destination),
        ]);
        return {
          coords: [...legA.coords, ...legB.coords],
          distanceM: legA.distanceM + legB.distanceM,
          durationS: legA.durationS + legB.durationS,
          steps: [...legA.steps, ...legB.steps],
        };
      } catch (e) {
        console.warn(`Via-point reroute attempt (${offsetKm}km offset) failed:`, e.message);
        return null;
      }
    });
    candidates.push(...(await Promise.all(attempts)).filter(Boolean));
  }

  // Clearance is checked only PAST a short radius around the route's own
  // start (State.userPos) -- an earlier version checked every point
  // including the first one, which is a bug: the route necessarily starts
  // at the user's current position, which is necessarily near the trouble
  // point (that's *why* the alert fired). That made the clearance check fail
  // for almost every candidate, including genuinely good ones, so reroute
  // nearly always fell through to "no alternative found" -- reported as
  // "it only follows the original routing". What actually matters is
  // whether the route diverges from the trouble point further along, not
  // whether it teleports away from where the driver already is.
  const clearance = (coords) => minDistToPointBeyondStart(coords, troublePoint, State.userPos);

  const viable = candidates.filter(
    (r) => clearance(r.coords) >= ROUTE_JAM_CLEARANCE_M && r.distanceM <= originalDistanceM * MAX_DETOUR_RATIO
  );

  if (!viable.length) {
    const el = document.getElementById("route-info");
    if (el) el.textContent = "No clear alternate route found — continuing on original route.";
    return null;
  }

  const chosen = viable.reduce((best, r) => (clearance(r.coords) > clearance(best.coords) ? r : best));

  drawRouteLine(chosen.coords, chosen.durationS, chosen.steps, "#4caf6b");
  // Same reasoning as planRoute: seed from the new route's own start, not
  // State.userPos, which by the time these OSRM round-trips resolve may
  // already be stale -- most visibly in demo mode, where the simulated
  // vehicle keeps moving along the OLD route for the full duration of this
  // async call. Using a stale position here would show a momentarily wrong
  // "X km to go" that only self-corrects once demo.js's onReroute listener
  // (fired below) resets the animation onto the new path.
  updateRouteProgress({ lat: chosen.coords[0][0], lng: chosen.coords[0][1] });
  rerouteListeners.forEach((fn) => fn(chosen.coords));
  return chosen;
}

function routeLength(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return total;
}

function minDistToPoint(coords, point) {
  let min = Infinity;
  const step = Math.max(1, Math.floor(coords.length / 40));
  for (let i = 0; i < coords.length; i += step) {
    const [lat, lng] = coords[i];
    min = Math.min(min, haversineMeters(lat, lng, point.lat, point.lng));
  }
  return min;
}

const ROUTE_START_EXCLUSION_M = 350; // skip this much of the route from its own start before checking clearance

/** Like minDistToPoint, but ignores the stretch immediately around the
 * route's own start -- see the comment in rerouteAvoiding for why. */
function minDistToPointBeyondStart(coords, point, start) {
  let min = Infinity;
  const step = Math.max(1, Math.floor(coords.length / 60));
  for (let i = 0; i < coords.length; i += step) {
    const [lat, lng] = coords[i];
    if (haversineMeters(lat, lng, start.lat, start.lng) < ROUTE_START_EXCLUSION_M) continue;
    min = Math.min(min, haversineMeters(lat, lng, point.lat, point.lng));
  }
  return min === Infinity ? 0 : min; // whole route stayed within the exclusion radius -- treat as "no clearance"
}

function nudgeAwayFrom(from, to, troublePoint, offsetKm) {
  // Perpendicular offset from the trouble point, on the side away from the
  // straight line from->to (a rough but workable heuristic given the public
  // OSRM demo server has no custom "avoid area" profile). The caller tries
  // multiple offset distances: too small and the nudge just lands on whatever
  // tiny side road happens to be nearest; wider offsets are more likely to
  // reach an actually-different real route -- but the caller validates the
  // result either way rather than trusting any single offset blindly.
  const dx = to.lng - from.lng;
  const dy = to.lat - from.lat;
  const len = Math.hypot(dx, dy) || 1;
  const perp = { x: -dy / len, y: dx / len };
  const sign = Math.sign(
    perp.x * (from.lat - troublePoint.lat) - perp.y * (from.lng - troublePoint.lng)
  ) || 1;
  const offsetDeg = offsetKm / 111; // ~111km per degree of latitude, close enough for this heuristic
  return {
    lat: troublePoint.lat + perp.y * offsetDeg * sign,
    lng: troublePoint.lng + perp.x * offsetDeg * sign,
  };
}
