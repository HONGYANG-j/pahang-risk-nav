import { State } from "./state.js";
import { logEvent } from "./eventlog.js";

const moveListeners = [];

export function onUserMove(fn) {
  moveListeners.push(fn);
}

/**
 * Loads the real Pahang state boundary (DOSM open data) and builds:
 *  - a mask covering the whole world MINUS Pahang (so everywhere else reads
 *    as dimmed/out-of-scope, rather than just restricting pan/zoom to a
 *    rectangular bounding box that would still show slivers of neighbouring
 *    states)
 *  - a bright outline hugging the real coastline/border
 * Pahang's geometry is a MultiPolygon (mainland + a few small islands, incl.
 * Tioman) -- every part's outer ring becomes a hole in the mask so islands
 * stay lit up too, not just the mainland.
 */
async function loadPahangMask(map) {
  const res = await fetch("data/pahang_state.geojson");
  const feature = await res.json();
  const toLatLng = (ring) => ring.map(([lng, lat]) => [lat, lng]);
  const holes = feature.geometry.coordinates.map((poly) => toLatLng(poly[0]));

  const WORLD = [
    [85, -180],
    [85, 180],
    [-85, 180],
    [-85, -180],
  ];
  L.polygon([WORLD, ...holes], {
    stroke: false,
    fillColor: "#060a14", // matches style.css's --void -- can't read the CSS custom property from here, so kept in sync by hand
    fillOpacity: 0.82,
    interactive: false,
  }).addTo(map);

  const outline = L.polygon(holes, {
    color: "#22e8ff",
    weight: 2,
    opacity: 0.6,
    fill: false,
    interactive: false,
  }).addTo(map);

  return outline.getBounds();
}

export async function initMap() {
  // zoomControl: false -- Leaflet's default on-screen +/- buttons render at
  // top:10,left:10 inside #map, which sits directly under #mini-topbar's
  // brand icon (#mini-topbar spans the full top edge at a higher z-index).
  // Every other screen corner is similarly claimed by this app's own chrome
  // (#top-stack/#bottom-stack both span nearly full width), so there's no
  // free corner to move the control to -- removing it is simpler and lower-
  // risk than fighting for one. Scroll-wheel/pinch/double-click zoom still
  // work; this only removes the on-screen buttons.
  const map = L.map("map", { zoomControl: false, worldCopyJump: false });
  // Esri Dark Gray Canvas (base layer only -- there's a separate "Reference"
  // layer with labels, deliberately not added: street/place names in tiny
  // map text were competing with our own HUD readouts for attention).
  // Switched from CARTO's dark_nolabels tiles (2026-08-27): CARTO now gates
  // that basemap CDN behind an API key -- it still returns HTTP 200, but the
  // "tile" is a ~100-byte placeholder stamped "API KEY REQUIRED", covering
  // the whole map. Esri's ArcGIS Online tile service remains free/keyless
  // for this usage tier. Note the URL's tile order is {z}/{y}/{x} (Esri's
  // REST convention), not Leaflet's usual {z}/{x}/{y} -- L.tileLayer just
  // substitutes named placeholders wherever they appear, so this is fine.
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    attribution: "Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ",
    maxZoom: 16,
    noWrap: true,
  }).addTo(map);
  State.map = map;

  const bounds = await loadPahangMask(map);
  map.fitBounds(bounds, { padding: [16, 16] });
  // Deliberately NOT calling setMaxBounds() here. An earlier version did, to
  // make "show only Pahang" a hard technical restriction -- but that clamps
  // every pan/setView call, including the ones driven by a REAL device's GPS
  // fix. A tester (or eventually a real user) physically outside Pahang would
  // get a live position marker that exists in the DOM at its true coordinates
  // but that the viewport can never scroll to -- confirmed by reproducing it
  // here with a mocked Singapore position: the marker rendered 5000+px below
  // the visible viewport. "Pahang is the focus" only needs to be a VISUAL
  // fact (the dimmed mask below), not a navigation lock -- so the map can
  // always follow wherever the device actually is, dimmed or not.
  map.setMinZoom(3);

  // Hand map control to the user the moment they drag, and offer an explicit
  // way back. `dragstart` is user-only, unlike movestart/zoomstart which also
  // fire for our own programmatic setView calls.
  // Skipped in nav mode, where applyNavCamera re-centres on every position
  // update regardless of followUser: letting a drag flip follow off there
  // just surfaced a "recentre" button that did nothing visible (the camera
  // was already snapping back on its own) while implying panning worked.
  map.on("dragstart", () => {
    if (!State.navMode) setFollow(false);
  });
  return map;
}

// Tuned to demo mode's 250ms tick rate: short enough that consecutive pans
// don't visibly lag behind the next position update, long enough to read as
// a glide instead of a snap. Real GPS fixes arrive slower (seconds apart),
// so the same duration reads as smooth there too. Leaflet retargets an
// in-flight pan animation rather than queuing a new one, so back-to-back
// calls blend into continuous motion instead of stacking up.
const PAN_ANIMATE = { animate: true, duration: 0.22, easeLinearity: 1 };

// Close enough to read individual streets, the way a nav app frames a drive.
// The route-overview framing (fitBounds) is a different job -- see drawRouteLine.
const NAV_ZOOM = 16;
// Centre the camera this far AHEAD of the vehicle rather than on it, so the
// road you're about to drive fills the screen and the vehicle sits low --
// the framing in every turn-by-turn app. Zooming in on the vehicle alone
// (what this used to do) just magnifies where you already are.
const LOOK_AHEAD_M = 340;

/** Point `distM` metres from (lat,lng) along a compass bearing. */
function destinationPoint(lat, lng, bearingDeg, distM) {
  const R = 6371000;
  const br = (bearingDeg * Math.PI) / 180;
  const f1 = (lat * Math.PI) / 180;
  const l1 = (lng * Math.PI) / 180;
  const d = distM / R;
  const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(br));
  const l2 = l1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
  return { lat: (f2 * 180) / Math.PI, lng: (l2 * 180) / Math.PI };
}

// Kept continuous (not wrapped to 0-360) so the CSS transition always takes
// the short way round: a raw 359deg -> 1deg jump would spin the whole map
// backwards through a full turn.
let rotationDeg = 0;

/** Rotates the map so the direction of travel points up the screen. Leaflet
 * has no native rotation, so this transforms the map CONTAINER -- which
 * Leaflet never touches itself (it transforms inner panes), so the two don't
 * fight. The container is enlarged to a square in nav mode (see style.css)
 * so its corners still cover the viewport at any angle. */
function setMapRotation(headingDeg) {
  const target = -headingDeg;
  // shortest signed delta to the new angle, accumulated onto the running value
  const delta = ((((target - rotationDeg + 180) % 360) + 360) % 360) - 180;
  rotationDeg += delta;
  State.map.getContainer().style.transform = `rotate(${rotationDeg}deg)`;
  // Rotating the container took every label with it -- district-risk and
  // destination tooltips read upside-down facing south, reported as "the
  // place name etc is upside down". Exposed as a CSS custom property on #app
  // (a stable ancestor the rotation itself never touches) so any element can
  // counter-rotate back to upright: `transform: rotate(calc(var(--map-rotation)
  // * -1deg))`. Custom properties inherit straight through a transformed
  // ancestor -- transform is a paint-time operation, not a cascade barrier --
  // so this reaches tooltips several DOM layers inside the rotated #map with
  // no extra plumbing. Can't just add that transform to .leaflet-tooltip
  // itself, though: Leaflet already owns that element's transform (inline
  // translate3d for positioning), so a competing CSS rule would either lose
  // to it outright or clobber the position -- each tooltip's actual content
  // is wrapped in its own inner element instead (see risk.js, routing.js).
  document.getElementById("app")?.style.setProperty("--map-rotation", String(rotationDeg));
}

/** Screen coords -> latlng, correcting for the nav-mode rotation. Leaflet
 * derives its own container point from getBoundingClientRect(), which for a
 * rotated element is the axis-aligned bounding box, not the real untransformed
 * box -- so e.latlng is wrong whenever rotation is applied. Rotating the click
 * back by the inverse angle about the container centre (which rotation leaves
 * fixed) recovers the true untransformed container point. */
export function latLngFromScreen(clientX, clientY) {
  const el = State.map.getContainer();
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const t = (-rotationDeg * Math.PI) / 180; // inverse of the applied rotation
  const dx = clientX - cx;
  const dy = clientY - cy;
  const ux = dx * Math.cos(t) - dy * Math.sin(t);
  const uy = dx * Math.sin(t) + dy * Math.cos(t);
  return State.map.containerPointToLatLng([el.offsetWidth / 2 + ux, el.offsetHeight / 2 + uy]);
}

/** Positions the nav-mode camera: centred ahead of the vehicle, rotated
 * heading-up. Called on every position update while nav mode is on. */
function applyNavCamera(animate) {
  if (!State.navMode || !State.userPos) return;
  const ahead = destinationPoint(State.userPos.lat, State.userPos.lng, lastHeadingDeg, LOOK_AHEAD_M);
  State.map.panTo([ahead.lat, ahead.lng], animate ? PAN_ANIMATE : { animate: false });
  setMapRotation(lastHeadingDeg);
}

/** Navigation mode: the close-up, vehicle-following "driving" view, as
 * opposed to the zoomed-out overview you get when first planning a route.
 * Without an explicit way in, planning a route left you looking at the whole
 * route from far away with no obvious path to the actual nav view -- reported
 * as "idk how to enter the navigation mode". */
/** Leaflet's zoom/pan animations are requestAnimationFrame-driven, and rAF is
 * suspended while a tab isn't being rendered -- so an animated setView issued
 * then silently never applies at all (measured: zoom stayed 13 instead of 16,
 * while the same call with animate:false landed immediately). For one-shot
 * view changes whose whole point IS the resulting view, correctness can't
 * depend on the animation running: animate only when it can actually play. */
function viewAnim() {
  return { animate: !document.hidden };
}

export function enterNavMode() {
  State.navMode = true;
  setFollow(true); // also hides #recenter-btn, which nav mode has no use for
  // The container becomes an oversized square in nav mode so its corners still
  // cover the viewport once rotated -- Leaflet caches container size, so it has
  // to be told the element changed before any setView/panTo maths is correct.
  document.getElementById("app").classList.add("nav-mode");
  State.map.invalidateSize({ animate: false });
  if (State.userPos) {
    const ahead = destinationPoint(State.userPos.lat, State.userPos.lng, lastHeadingDeg, LOOK_AHEAD_M);
    State.map.setView([ahead.lat, ahead.lng], NAV_ZOOM, viewAnim());
  }
  setMapRotation(lastHeadingDeg);
  syncNavButton();
}

export function exitNavMode() {
  State.navMode = false;
  setMapRotation(0); // unrotate before restoring size, so the overview is north-up again
  document.getElementById("app").classList.remove("nav-mode");
  State.map.invalidateSize({ animate: false });
  syncNavButton();
  // Back to the overview framing, so leaving nav mode has a visible result
  // rather than just silently changing how future updates behave.
  if (State.route.layer) {
    State.map.fitBounds(State.route.layer.getBounds(), { padding: [40, 40], ...viewAnim() });
  }
}

/** Keeps the trip-bar's start/exit toggle in sync with actual nav state --
 * called from both transitions plus clearRoute, so the button can never claim
 * a mode the app isn't in. */
/** Was previously "which button started this?"-dependent (a `navStartedDemo`
 * flag): pressing EXIT while a demo was running launched from the drawer left
 * the simulated drive running in the background with the camera detached --
 * reported as "even when i pressed exit, the navigation kept on running".
 * A pure function of the two state flags instead, so the label (and what
 * clicking it does, wired in app.js) can never disagree with what's actually
 * running: STOP always means "a simulated drive is active, and this ends it
 * completely", regardless of whether Live's START or the Demo Drive panel
 * began it. */
export function syncNavButton() {
  const btn = document.getElementById("nav-toggle-btn");
  if (btn) {
    if (State.demoMode) {
      btn.textContent = "■ STOP";
      btn.title = "Stop the simulated demo drive";
    } else if (State.navMode) {
      btn.textContent = "✕ EXIT";
      btn.title = "Leave the navigation view and see the whole route";
    } else {
      btn.textContent = "▶ START";
      btn.title = "Start navigating — close-up driving view of your real position";
    }
    btn.classList.toggle("active", State.navMode);
  }

  // The Demo Drive panel's own button can start a demo, but stopping one can
  // happen from either that button OR the trip-bar STOP above -- keep both
  // in sync regardless of which one actually changed the state.
  const demoBtn = document.getElementById("demo-drive-btn");
  const demoLabel = document.getElementById("demo-drive-label");
  if (demoBtn && demoLabel) {
    demoBtn.classList.toggle("active", State.demoMode);
    demoLabel.textContent = State.demoMode ? "Stop Demo Drive" : "Start Demo Drive";
  }
}

/** Toggles "keep the vehicle centred" mode and syncs the recentre button. */
export function setFollow(on) {
  State.followUser = on;
  const btn = document.getElementById("recenter-btn");
  if (btn) btn.hidden = on;
  if (on && State.userPos && State.map) {
    State.map.panTo([State.userPos.lat, State.userPos.lng], PAN_ANIMATE);
  }
}

function userDivIcon() {
  return L.divIcon({
    // Named class (was empty) so the CSS smooth-motion transition below can
    // target this specific marker without also affecting bot markers, which
    // should keep their own jerkier simulated-traffic movement.
    className: "user-marker-icon",
    // .user-heading is the thing that actually rotates (see updateUserPosition
    // below) -- kept separate from the outer div, which Leaflet itself already
    // applies a translate3d() to for positioning, so the two transforms don't
    // fight on the same element. Two overlapping chevron shapes (outline behind,
    // fill in front) fake a stroke, since clip-path shapes can't take a normal
    // CSS border.
    html:
      '<div class="user-icon-wrap"><div class="user-icon-ping"></div>' +
      '<div class="user-heading"><div class="user-chevron-outline"></div><div class="user-chevron"></div></div></div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

let firstFix = true;
let lastHeadingDeg = 0; // holds the last known heading so the marker doesn't snap back to "north" when a fix arrives without one (common when stationary)

/** Reflects real geolocation state on the topbar pill -- this used to be
 * static "LIVE" markup that never changed, so a denied/unavailable GPS
 * looked identical to a working one: green dot, "LIVE" text, no marker, no
 * speed, no explanation anywhere on screen. */
function setStatusPill(state) {
  const pill = document.getElementById("status-pill");
  const label = document.getElementById("status-pill-label");
  if (!pill || !label) return;
  pill.classList.remove("state-searching", "state-nogps", "state-simulated");
  if (state === "searching") {
    pill.classList.add("state-searching");
    label.textContent = "SEARCHING…";
  } else if (state === "nogps") {
    pill.classList.add("state-nogps");
    label.textContent = "NO GPS";
  } else if (state === "simulated") {
    pill.classList.add("state-simulated");
    label.textContent = "SIMULATED";
  } else {
    label.textContent = "LIVE";
  }
}

/** Only used for the cold-start case (no fix ever obtained) -- alerts.js's
 * own evaluate() loop already no-ops whenever State.userPos is null, so it
 * can never race with or stomp this banner. Once a real fix arrives,
 * updateUserPosition() below hides it and evaluate() takes back over. */
function showGpsAlert(text) {
  const banner = document.getElementById("alert-banner");
  const textEl = document.getElementById("alert-text");
  const sourceEl = document.getElementById("alert-source");
  const rerouteBtn = document.getElementById("alert-reroute-btn");
  const fixBtn = document.getElementById("alert-fix-btn");
  if (!banner || !textEl) return;
  textEl.textContent = text;
  if (sourceEl) sourceEl.textContent = "";
  if (rerouteBtn) rerouteBtn.hidden = true;
  if (fixBtn) fixBtn.hidden = true;
  banner.hidden = false;
  banner.dataset.key = "geo-error";
}

/**
 * @param {"gps"|"demo"|"manual"} source where this position actually came
 *   from. The status pill must not claim "LIVE" for a position the device's
 *   GPS didn't produce -- demo mode calls this on every simulated tick (with
 *   real geolocation stopped), and the no-GPS manual flow seeds a start point
 *   from the map centre. Both used to light up a green LIVE pill on a device
 *   with no fix at all, which is exactly the real-vs-simulated blurring this
 *   app is otherwise careful about.
 */
export function updateUserPosition(lat, lng, speedMps, headingDeg, source = "gps") {
  State.userPos = { lat, lng };
  if (speedMps != null && !Number.isNaN(speedMps)) {
    State.userSpeedKmh = Math.max(0, speedMps * 3.6);
  }

  if (!State.userMarker) {
    State.userMarker = L.marker([lat, lng], { icon: userDivIcon(), zIndexOffset: 1000 }).addTo(State.map);
  } else {
    State.userMarker.setLatLng([lat, lng]);
  }

  // Real GPS reports heading as null when it can't determine one (e.g.
  // stationary) -- only update on a real value, don't snap to 0/north.
  if (headingDeg != null && !Number.isNaN(headingDeg)) lastHeadingDeg = headingDeg;
  const markerEl = State.userMarker.getElement();
  const headingEl = markerEl ? markerEl.querySelector(".user-heading") : null;
  if (headingEl) headingEl.style.transform = `rotate(${lastHeadingDeg}deg)`;

  const speedEl = document.getElementById("speed-value");
  if (speedEl) speedEl.textContent = State.userSpeedKmh.toFixed(0);

  if (source === "gps") {
    // Every successful fix means "live" -- not just the first one. A fix can
    // legitimately arrive again after a stretch of timeouts already flipped
    // the pill to "nogps" (see startGeolocation's escalation logic); without
    // this outside the firstFix-only branch below, the pill stayed stuck on
    // "NO GPS" forever after the very first fix in the session, since nothing
    // else ever set it back to "live" again.
    setStatusPill("live");
    const banner = document.getElementById("alert-banner");
    if (banner && banner.dataset.key === "geo-error") banner.hidden = true;
  } else if (source === "demo") {
    setStatusPill("simulated");
  }
  // source === "manual": leave the pill showing whatever the real GPS state
  // is (SEARCHING/NO GPS) -- seeding a start point from the map centre says
  // nothing about whether the device has a fix.

  if (State.navMode) {
    // Nav mode owns the camera: centred ahead of the vehicle and rotated
    // heading-up, rather than simply centred on it.
    applyNavCamera(true);
  } else if (firstFix) {
    State.map.setView([lat, lng], Math.max(State.map.getZoom(), 13));
  } else if (State.followUser) {
    // Without this the marker simply walks off screen on a real drive.
    State.map.panTo([lat, lng], PAN_ANIMATE);
  }
  firstFix = false;

  moveListeners.forEach((fn) => fn({ lat, lng }));
}

let geoErrorLogged = false;
let consecutiveTimeouts = 0;
let highAccuracyMode = true;

const TIMEOUT_FALLBACK_COUNT = 3; // this many timeouts in a row before assuming high-accuracy mode just isn't available on this device
const TIMEOUT_ALERT_COUNT = 6; // this many before treating it as a real failure, not a transient blip

export function startGeolocation() {
  if (!("geolocation" in navigator)) {
    setStatusPill("nogps");
    showGpsAlert("This browser doesn't support location access, so live position and speed aren't available.");
    return;
  }
  consecutiveTimeouts = 0;
  highAccuracyMode = true;
  setStatusPill("searching");
  watchPosition();
}

function watchPosition() {
  if (State.watchId != null) navigator.geolocation.clearWatch(State.watchId);
  State.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      consecutiveTimeouts = 0;
      updateUserPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.speed, pos.coords.heading);
    },
    (err) => {
      console.warn("Geolocation error:", err.message);
      if (err.code === err.TIMEOUT) {
        consecutiveTimeouts++;
        // One slow fix isn't worth alarming over -- watchPosition keeps
        // retrying on its own, which used to be this branch's entire
        // reasoning for staying silent forever. The gap: if EVERY retry also
        // times out, that's not transient, and silence forever is exactly
        // what reads as "GPS just stopped" with zero explanation. High-
        // accuracy mode (real GPS hardware) commonly can't get a fix at all
        // on some devices -- laptops especially, which have no GPS chip and
        // fall back to slower WiFi-based positioning anyway -- so try that
        // explicitly once before giving up rather than waiting on a fix that
        // was never coming.
        if (consecutiveTimeouts === TIMEOUT_FALLBACK_COUNT && highAccuracyMode) {
          highAccuracyMode = false;
          logEvent("GPS fix timing out — retrying with lower accuracy for reliability", "warn");
          watchPosition();
          return;
        }
        if (consecutiveTimeouts >= TIMEOUT_ALERT_COUNT) {
          setStatusPill("nogps");
          // Only interrupts with a banner on the true cold-start case (no fix
          // ever) -- if a fix exists, State.userPos is non-null, which means
          // alerts.js's own evaluate() loop is already running and would
          // immediately compete with/overwrite a banner shown here. The pill
          // update alone is the safe, always-visible signal for "had a fix,
          // now stalled."
          if (!State.userPos) {
            showGpsAlert(
              "Still waiting for a location fix — check your device's location/GPS settings, or move somewhere with a clearer view of the sky."
            );
          }
        }
        return;
      }
      setStatusPill("nogps");
      if (State.userPos) return; // had a fix before (signal blip) -- pill already says it, no need to interrupt with a banner
      showGpsAlert(
        err.code === err.PERMISSION_DENIED
          ? "Location permission denied — enable it in your browser/app settings to see your live position and use routing."
          : "Location unavailable — check your device's GPS/location services, then reopen the app."
      );
      if (!geoErrorLogged) {
        geoErrorLogged = true;
        logEvent(`Geolocation unavailable: ${err.message}`, "warn");
      }
    },
    { enableHighAccuracy: highAccuracyMode, maximumAge: 1000, timeout: 10000 }
  );
}

export function stopGeolocation() {
  if (State.watchId != null) {
    navigator.geolocation.clearWatch(State.watchId);
    State.watchId = null;
  }
}
