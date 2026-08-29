import { State } from "./state.js";
import { updateUserPosition, startGeolocation, stopGeolocation, setFollow, enterNavMode, exitNavMode } from "./map.js";
import { planRoute, fetchRoutes, onReroute, clearRoute } from "./routing.js";
import { haversineMeters } from "./risk.js";
import { spawnBots, stopBots } from "./bots.js";
import { logEvent } from "./eventlog.js";

const DEMO_TICK_MS = 250;
// The simulated vehicle drives at a realistic speed in SIMULATED time, and
// simulated time runs faster than real time so a district-scale drive fits in
// a short recording. The speed readout therefore shows the real speed of the
// simulated vehicle (~60 km/h), not the rate the marker crosses the screen --
// the "x20" badge in the UI makes that compression explicit rather than
// letting the readout imply a 200+ km/h drive.
const DEMO_TIME_SCALE = 20; // simulated seconds per real second
const CRUISE_KMH = 60;
const JAM_CRAWL_KMH = 12; // speed once caught in the simulated jam
// How far either side of the jam the vehicle crawls. This is a *beat*, not a
// leg of the drive: at 12 km/h under 20x compression the vehicle covers only
// ~17 m per 250 ms tick, so every 100 m of slowdown zone costs ~1.5 s of real
// time. The old 900 m radius meant 1800 m of crawling -- about 27 seconds
// stuck at walking pace starting exactly halfway, which measured out as most
// of the run and reads as "the demo stopped halfway and isn't moving".
// ~350 m keeps it to a legible ~10 s.
const JAM_SLOWDOWN_RADIUS_M = 350;

const MAX_DEMO_DISTANCE_M = 12000; // keeps a run to roughly a minute of footage
// A destination too close leaves no room for the beats: the jam-slowdown radius
// would cover most of the drive, so the cruise -> slow-for-jam contrast never
// shows on camera. Prefer a high-risk district at least this far out.
const MIN_DEMO_DISTANCE_M = 8000;
const JAM_PLACE_FRACTION = 0.5; // jam sits halfway along the driven path...
const JAM_TRIGGER_FRACTION = 0.2; // ...and appears once we're a fifth of the way in, so it's *ahead*
const JAM_BOT_COUNT = 3;

let animHandle = null;
// Per-run distance cap. MAX_DEMO_DISTANCE_M keeps the *self-chosen* demo
// destination to about a minute of footage; a route the user picked
// themselves must be driven in full, however long it is. Set once per run in
// startDemoMode so the rerouted leg inherits it too.
let demoMaxDistanceM = MAX_DEMO_DISTANCE_M;

function pickNearbyHighRiskFeature(start, bucket) {
  const candidates = [];
  for (const f of State.riskFeatures) {
    const timeData = f.risk_by_time[bucket];
    if (!timeData || timeData.score < 0.5) continue;
    // District shapes are real polygons now (not centroid points), so use
    // turf's centroid as the representative point for "how far is this district".
    const [lng, lat] = turf.centroid({ type: "Feature", properties: {}, geometry: f.geometry }).geometry
      .coordinates;
    const dist = haversineMeters(start.lat, start.lng, lat, lng);
    // Generous cutoff on purpose: Pahang districts are large and far apart, so
    // from any given start the only *nearby* high-risk centroid is usually the
    // one you're already standing in (a 3km hop, too short to demo). Heading
    // toward a distant district is fine -- animateAlongPath truncates the drive
    // to MAX_DEMO_DISTANCE_M anyway, so we just use the first stretch of it.
    if (dist < 150000) {
      candidates.push({ lat, lng, district: f.district, dist });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.dist - b.dist);
  // Closest one that still gives the drive room to breathe; otherwise just the
  // closest available, so the demo always has somewhere to go.
  return candidates.find((c) => c.dist >= MIN_DEMO_DISTANCE_M) || candidates[0];
}

function forceJamAt(point) {
  const candidates = State.bots.slice(0, JAM_BOT_COUNT);
  if (candidates.length < JAM_BOT_COUNT) {
    console.warn(
      `Demo jam needs ${JAM_BOT_COUNT} bots but only ${candidates.length} exist ` +
        "(OSRM bot routes may have failed) -- jam alert will not fire."
    );
  }
  const jitter = 0.0004; // ~40m wobble so markers don't perfectly overlap
  candidates.forEach((bot, k) => {
    const angle = (k / candidates.length) * 2 * Math.PI;
    const p1 = [point.lat + jitter * Math.sin(angle), point.lng + jitter * Math.cos(angle)];
    const p2 = [point.lat + jitter * Math.sin(angle + 1), point.lng + jitter * Math.cos(angle + 1)];
    bot.coords = [p1, p2];
    bot.idx = 0;
    bot.dir = 1;
    bot.slow = true;
    bot.forcedSlow = true; // exempt from random recovery -- must hold for the rest of the scripted demo
  });
}

/** Cumulative along-path distance in metres, one entry per coordinate. */
function cumulativeDistances(coords) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum[i] =
      cum[i - 1] + haversineMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return cum;
}

/**
 * Interpolates a position `target` metres along the path. Pacing by distance
 * (rather than by coordinate index) is what keeps the speed readout stable --
 * OSRM geometry is dense at junctions and sparse on straights, so stepping a
 * fixed number of indices per tick produces wildly swinging apparent speeds.
 */
function positionAtDistance(coords, cum, target) {
  const total = cum[cum.length - 1];
  if (target <= 0) return coords[0];
  if (target >= total) return coords[coords.length - 1];

  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= target) lo = mid;
    else hi = mid;
  }
  const segLen = cum[hi] - cum[lo] || 1;
  const t = (target - cum[lo]) / segLen;
  return [
    coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t,
    coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t,
  ];
}

/** Compass bearing (0-360, clockwise from north) from point 1 to point 2 --
 * matches CSS rotate()'s own clockwise-positive convention, so the marker's
 * heading can be applied directly with no sign-flipping. */
function bearingDegrees(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function truncateToDistance(coords, cum, maxM) {
  if (cum[cum.length - 1] <= maxM) return coords;
  const out = [];
  for (let i = 0; i < coords.length; i++) {
    out.push(coords[i]);
    if (cum[i] >= maxM) break;
  }
  return out;
}

function animateAlongPath(rawCoords, { placeJam = true } = {}) {
  driveFinished = false; // a rerouted leg is a fresh drive that can arrive again
  let coords = rawCoords;
  let cum = cumulativeDistances(coords);
  // Only the self-chosen demo destination gets capped for footage length.
  // Applying the cap to a route the USER picked was a real bug: the drive
  // stopped dead at 12 km of, say, a 32 km route and stayed frozen there
  // forever, while the trip bar still read "20.1 km to go" -- reported as
  // "it stops halfway". Pressing Reroute appeared to fix it only because
  // onReroute restarts this function with a fresh (also capped) leg.
  coords = truncateToDistance(coords, cum, demoMaxDistanceM);
  cum = cumulativeDistances(coords);

  const total = cum[cum.length - 1];
  const jamPoint = positionAtDistance(coords, cum, total * JAM_PLACE_FRACTION);
  // Scale the slowdown zone to the route: a flat 900m radius on a short route
  // would have the vehicle crawling for most of the drive instead of giving one
  // legible "slowed for the jam" beat.
  const slowdownRadiusM = Math.min(JAM_SLOWDOWN_RADIUS_M, total * 0.05);
  let travelled = 0;
  let jamForced = !placeJam; // a rerouted leg must not spawn a second jam

  // Don't fight nav mode's close-up framing -- animateAlongPath also runs for
  // the rerouted leg, mid-drive, where yanking back to zoom 13 would undo the
  // driving view at the worst moment.
  if (!State.navMode) State.map.setView(coords[0], 13);

  animHandle = setInterval(() => {
    const pos = positionAtDistance(coords, cum, travelled);
    // Look 1m ahead along the path for a forward-facing heading -- works at
    // travelled=0 (no "previous point" needed) and clamps at the very end
    // instead of reading off the end of the route.
    const aheadPos = positionAtDistance(coords, cum, Math.min(total, travelled + 1));
    const heading = bearingDegrees(pos[0], pos[1], aheadPos[0], aheadPos[1]);

    if (!jamForced && travelled >= total * JAM_TRIGGER_FRACTION) {
      forceJamAt({ lat: jamPoint[0], lng: jamPoint[1] });
      jamForced = true;
    }

    const nearJam = State.activeJams.some(
      (j) => haversineMeters(pos[0], pos[1], j.lat, j.lng) <= slowdownRadiusM
    );
    const speedMps = (nearJam ? JAM_CRAWL_KMH : CRUISE_KMH) / 3.6;

    updateUserPosition(pos[0], pos[1], speedMps, heading, "demo"); // handles map following itself

    travelled += speedMps * (DEMO_TICK_MS / 1000) * DEMO_TIME_SCALE;

    if (travelled >= total) {
      // Park the vehicle rather than leaving the readout frozen at cruise speed
      // -- a stationary marker still showing "60 km/h" reads as a bug on camera.
      updateUserPosition(pos[0], pos[1], 0, undefined, "demo");
      clearInterval(animHandle);
      animHandle = null;
      finishDemoDrive(pos);
    }
  }, DEMO_TICK_MS);
}

// Steer the simulated vehicle onto a rerouted path. Registered once at module
// load; the reroute always starts from the current position, so the new leg can
// simply be driven from its first coordinate.
onReroute((coords) => {
  if (!State.demoMode) return;
  if (animHandle != null) {
    clearInterval(animHandle);
    animHandle = null;
  }
  animateAlongPath(coords, { placeJam: false });
});

function setPlaybackBadge(visible, text) {
  const badge = document.getElementById("playback-badge");
  if (!badge) return;
  badge.hidden = !visible;
  badge.classList.toggle("arrived", text === ARRIVED_BADGE);
  if (visible && text) badge.textContent = text;
}

const DRIVING_BADGE = "SIMULATED DRIVE · ×20";
const ARRIVED_BADGE = "ARRIVED";
const ENDED_BADGE = "DRIVE ENDED";

/** Reaching the destination used to just clear the interval and go silent:
 * the vehicle stopped, but the badge still said a drive was in progress and
 * the demo button still said "Stop demo", so a completed run was visually
 * identical to a frozen one -- reported as "the demo stopped and is not
 * moving at all". Announce it instead. Deliberately does NOT tear the demo
 * down (no clearRoute/exitNavMode): the arrival view is worth keeping on
 * screen, and Stop demo / EXIT already do a full reset when the user wants
 * one. */
let driveFinished = false;

function finishDemoDrive(pos) {
  if (driveFinished) return; // idempotent: only ever announce one arrival per leg
  driveFinished = true;
  // Only claim arrival if the vehicle actually reached the route's end. The
  // drive can legitimately stop short of it (a distance cap on the
  // self-chosen demo route), and badging that "ARRIVED" would be a plain
  // false statement on screen.
  const end = State.route.coords?.[State.route.coords.length - 1];
  const arrived = !end || haversineMeters(pos[0], pos[1], end[0], end[1]) <= 100;
  if (arrived) {
    setPlaybackBadge(true, ARRIVED_BADGE);
    logEvent("Simulated drive complete — arrived at destination", "info");
  } else {
    setPlaybackBadge(true, ENDED_BADGE);
    logEvent("Simulated drive ended before the destination", "warn");
  }
}

/**
 * Starts a simulated drive. This is the ONLY way a demo drive begins now --
 * previously the trip bar's live-mode START button would also silently fall
 * into simulating whatever route was planned if the device was stationary,
 * which blurred live and demo into one another (reported as confusing) and
 * meant EXIT/START had to guess which one it was undoing. Live mode's START
 * is real-GPS-only now; this is the deliberate, separate way to run a demo.
 *
 * @param {object} opts
 * @param {{lat:number,lng:number}|null} opts.start explicit start point --
 *   from the Demo Drive panel's own start field (map-tap or typed), NOT
 *   State.userPos. Falls back to the live position (or a Pahang default) only
 *   if the user left it blank, so "add a starting location for demo mode"
 *   actually means what it says rather than always silently using wherever
 *   live GPS (or its own map-centre fallback) happens to be.
 * @param {{lat:number,lng:number}|null} opts.dest explicit destination --
 *   same idea. Leaving it blank keeps the original "auto-pick a nearby
 *   high-risk district" convenience.
 */
export async function startDemoMode({ start: chosenStart = null, dest: chosenDest = null } = {}) {
  if (State.demoMode) return;
  State.demoMode = true;
  stopGeolocation();
  setPlaybackBadge(true, DRIVING_BADGE);
  setFollow(true); // a recording should track the vehicle even if the map was panned earlier

  if (State.bots.length < JAM_BOT_COUNT) {
    await spawnBots();
  }

  const start = chosenStart || State.userPos || { lat: 3.8077, lng: 103.326 };
  // An explicitly chosen destination is deliberate -- drive it in full,
  // however long it is, the same reasoning as an explicitly planned live
  // route. Auto-picked ones stay capped so an unlucky far-off pick can't
  // produce a multi-minute recording.
  demoMaxDistanceM = chosenDest ? Infinity : MAX_DEMO_DISTANCE_M;
  const target = chosenDest || pickNearbyHighRiskFeature(start, State.timeBucket) || {
    lat: start.lat + 0.05,
    lng: start.lng + 0.03,
  };

  // Seed the position so planRoute() has an origin, then plan a real route.
  // Driving an actual planned route (rather than just moving the marker) is
  // what lets the "jam ahead on your route -> reroute" alert path fire.
  updateUserPosition(start.lat, start.lng, 0, undefined, "demo");

  let coords;
  try {
    if (chosenDest) {
      // A real destination the user actually asked for -- route straight to
      // it, no truncate-and-replan probe needed (that dance exists only to
      // keep an AUTO-picked, possibly-distant target's displayed distance
      // honest against the drive actually performed).
      const { route } = await planRoute(target);
      coords = route.coords;
    } else {
      // Probe the road toward the chosen district, then set the actual demo
      // destination one demo-length along it. Routing straight to a district
      // 100km+ away would print "172 km, ~136 min" on screen while we only ever
      // drive the first stretch -- this keeps the displayed route honest and
      // equal to the drive performed.
      const [probe] = await fetchRoutes(start, target);
      const trimmed = truncateToDistance(
        probe.coords,
        cumulativeDistances(probe.coords),
        MAX_DEMO_DISTANCE_M
      );
      const endpoint = trimmed[trimmed.length - 1];
      const { route } = await planRoute({ lat: endpoint[0], lng: endpoint[1] });
      coords = route.coords;
    }
  } catch (e) {
    console.warn("Demo route planning failed, using straight line fallback:", e.message);
    coords = [
      [start.lat, start.lng],
      [target.lat, target.lng],
    ];
  }

  // Demo mode exists to produce recordable footage, and the close-up driving
  // view is the shot -- so enter it automatically rather than making the
  // recording depend on remembering to press START first.
  enterNavMode();
  animateAlongPath(coords);
}

export function stopDemoMode() {
  if (!State.demoMode) return;
  State.demoMode = false;
  if (animHandle != null) clearInterval(animHandle);
  animHandle = null;
  setPlaybackBadge(false);
  exitNavMode();
  clearRoute(); // otherwise the demo route lingers and keeps matching jam alerts
  stopBots();
  spawnBots();
  // The speed readout otherwise stays frozen at the simulated vehicle's last
  // speed (commonly 60, cruise speed) even though nothing is moving anymore
  // -- real GPS hasn't produced a fresh reading yet, and won't until/unless
  // a fix actually arrives. "--" matches the same placeholder shown before
  // any fix has ever arrived, for the same reason: no live speed to show.
  State.userSpeedKmh = 0;
  const speedEl = document.getElementById("speed-value");
  if (speedEl) speedEl.textContent = "--";
  startGeolocation();
}
