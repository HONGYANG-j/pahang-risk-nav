import { State } from "./state.js";
import { initMap, startGeolocation, setFollow, enterNavMode, exitNavMode, latLngFromScreen, updateUserPosition } from "./map.js";
import { loadRiskLayer, setTimeBucket, loadCrashPoints, setCrashPointsVisible } from "./risk.js";
import { planRoute, clearRoute } from "./routing.js";
import { spawnBots } from "./bots.js";
import { initAlerts } from "./alerts.js";
import { startDemoMode, stopDemoMode } from "./demo.js";
import { logEvent } from "./eventlog.js";
import { initAssistant } from "./assistant.js";

// start() is async and wired to a click, so a double-tap (routine on mobile)
// ran the whole thing twice: L.map() threw "Map container is already
// initialized", and every listener below got registered twice -- one map tap
// firing two handlers, one demo-button press toggling demo on and straight
// back off, two geolocation watches, two sets of bots.
let started = false;

async function start() {
  if (started) return;
  started = true;
  document.getElementById("landing-screen").hidden = true;
  document.getElementById("app").hidden = false;

  await initMap();
  await loadRiskLayer();
  setTimeBucket(State.timeBucket);
  startGeolocation();
  initAlerts();
  initAssistant();
  spawnBots(); // fire and forget -- OSRM calls happen in the background

  document.querySelectorAll("#time-toggle button").forEach((btn) => {
    btn.addEventListener("click", () => setTimeBucket(btn.dataset.bucket));
  });

  async function submitRoute() {
    const raw = document.getElementById("dest-input").value.trim();
    // #route-status is transient in-drawer feedback (errors, "Routing...") --
    // distinct from #route-info in the persistent trip-bar, which shows the
    // final "you have an active route" result and needs to stay visible after
    // the drawer closes.
    const status = document.getElementById("route-status");
    const parts = raw.split(",").map((s) => parseFloat(s.trim()));
    if (parts.length !== 2 || parts.some(Number.isNaN)) {
      status.textContent = "Enter destination as: lat,lng";
      return;
    }
    // Manual routing doesn't need live GPS at all -- that's the OTHER path
    // (real position via startGeolocation). This one is "no GPS, pick a
    // destination and go": without a start point of some kind planRoute()
    // has nothing to route FROM, so without this, anyone whose device never
    // gets a fix (permission denied, no GPS hardware, testing indoors)
    // couldn't plan a route at all -- not even to explore or simulate one.
    // The map's current centre is a reasonable stand-in start: wherever the
    // user has actually panned to, or Pahang's centroid on first load.
    if (!State.userPos) {
      const center = State.map.getCenter();
      updateUserPosition(center.lat, center.lng, 0, undefined, "manual");
      logEvent("No live GPS — planning from the map's centre. Press GO, then START to simulate the drive.", "info");
    }
    status.textContent = "Routing...";
    try {
      await planRoute({ lat: parts[0], lng: parts[1] });
      logEvent(`Route planned to ${parts[0].toFixed(4)}, ${parts[1].toFixed(4)}`, "info");
      status.textContent = "";
      closeDrawer(); // route is live -- back to the map + trip-bar, same as Waze after picking a destination
    } catch (e) {
      status.textContent = `Routing failed: ${e.message}`;
      logEvent(`Routing failed: ${e.message}`, "warn");
    }
  }
  document.getElementById("route-btn").addEventListener("click", submitRoute);

  // GO starts disabled and only enables once there's something to route to,
  // so the button can't be pressed into the "Enter destination as: lat,lng"
  // error state. Kept in sync from both entry points (typing, and the map
  // tap that writes into this same field).
  const destInput = document.getElementById("dest-input");
  const syncGoEnabled = () => {
    const btn = document.getElementById("route-btn");
    const ok = destInput.value.trim().length > 0;
    btn.disabled = !ok;
    btn.title = ok ? "Plan a route to this destination" : "Pick a destination first";
  };
  destInput.addEventListener("input", syncGoEnabled);
  // The assistant input already supports Enter-to-send (assistant.js) --
  // this field didn't, which reads as broken on mobile where the keyboard's
  // own "Go" key is the expected way to submit a single text field.
  document.getElementById("dest-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitRoute();
  });

  // Was no way to cancel an active route once planned -- clearRoute() existed
  // (demo mode used it internally to tear down its own route) but nothing
  // user-facing ever called it, so a route you decided against stayed drawn
  // and the trip-bar stayed up for the rest of the session.
  document.getElementById("trip-clear-btn").addEventListener("click", () => {
    clearRoute();
    logEvent("Route cleared", "info");
  });

  let navStartedDemo = false;
  document.getElementById("nav-toggle-btn").addEventListener("click", async () => {
    if (State.navMode) {
      // Only tear down the simulated drive if pressing START is what began it
      // -- otherwise EXIT would silently kill a demo the user started from the
      // drawer and expected to keep running.
      if (navStartedDemo && State.demoMode) {
        stopDemoMode();
        syncDemoButton(false);
        navStartedDemo = false;
      } else {
        exitNavMode();
      }
      logEvent("Navigation view closed — showing whole route", "info");
      return;
    }

    enterNavMode();
    // On a stationary device there is nothing for the camera to follow, so
    // "START" appeared to do nothing at all beyond zooming in -- the whole
    // point of pressing it is to see the drive. If we're not actually moving
    // and a route is planned, drive it in simulation, clearly badged as
    // playback rather than passed off as a real trip.
    if (State.route.coords?.length && !State.demoMode && State.userSpeedKmh < 1) {
      navStartedDemo = true;
      syncDemoButton(true);
      logEvent("Navigation started — simulating this drive (not real movement)", "info");
      await startDemoMode({ useExistingRoute: true });
    } else {
      logEvent("Navigation started", "info");
    }
  });

  /** Keeps the drawer's demo button honest when a simulated drive is started
   * or stopped from the trip bar instead of from the drawer itself. */
  function syncDemoButton(active) {
    const btn = document.getElementById("demo-mode-btn");
    const label = document.getElementById("demo-btn-label");
    if (!btn || !label) return;
    btn.classList.toggle("active", active);
    label.textContent = active ? "Stop demo" : "Demo mode";
  }

  document.getElementById("recenter-btn").addEventListener("click", () => setFollow(true));

  // Loaded lazily and never auto-shown: 2,288 points is a lot of ink over the
  // whole state, and the district shading is still the app's primary risk
  // visual. Fetched once on first toggle rather than at startup so it costs
  // nothing for users who never open it.
  const crashBtn = document.getElementById("crash-points-btn");
  const crashLabel = document.getElementById("crash-points-label");
  let crashLoading = false;
  crashBtn.addEventListener("click", async () => {
    if (crashLoading) return;
    if (State.crashPointsVisible) {
      setCrashPointsVisible(false);
      crashBtn.classList.remove("active");
      crashLabel.textContent = "Show crash locations";
      return;
    }
    if (!State.crashPointsLayer) {
      crashLoading = true;
      crashLabel.textContent = "Loading…";
      try {
        await loadCrashPoints();
      } catch (e) {
        crashLabel.textContent = "Show crash locations";
        logEvent(`Could not load crash locations: ${e.message}`, "warn");
        return;
      } finally {
        crashLoading = false;
      }
    }
    setCrashPointsVisible(true);
    crashBtn.classList.add("active");
    crashLabel.textContent = "Hide crash locations";
    logEvent(
      `Showing ${State.crashPointsCount} recorded crash locations — real coordinates, no severity attached`,
      "info"
    );
  });

  const drawer = document.getElementById("detail-drawer");
  const openDrawer = () => { drawer.hidden = false; };
  const closeDrawer = () => { drawer.hidden = true; };
  document.getElementById("menu-btn").addEventListener("click", openDrawer);
  document.getElementById("detail-close-btn").addEventListener("click", closeDrawer);
  document.getElementById("detail-backdrop").addEventListener("click", closeDrawer);

  // Typing a raw "lat,lng" destination is close to unusable -- nobody knows
  // their destination's coordinates. Tapping the map is the natural way to
  // pick a point, and needs no geocoding backend: it just fills the same
  // input the manual flow already used, so routing itself is unchanged.
  // Leaflet only fires `click` on an actual tap/release, not mid-drag, so
  // this doesn't fight with panning the map.
  State.map.on("click", (e) => {
    // Not e.latlng: Leaflet derives that from getBoundingClientRect(), which
    // is the axis-aligned bounding box once nav mode rotates the container --
    // so it silently returns the wrong point there. latLngFromScreen undoes
    // the rotation properly (and is identical to e.latlng when unrotated).
    const { lat, lng } = latLngFromScreen(e.originalEvent.clientX, e.originalEvent.clientY);
    document.getElementById("dest-input").value = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    syncGoEnabled(); // programmatic .value assignment doesn't fire `input`
    document.getElementById("route-status").textContent = "Destination set from map tap — tap GO to route there.";
    openDrawer();
    document.getElementById("route-panel").scrollIntoView({ block: "nearest" });
  });

  // startDemoMode is async (it fetches routes), so without a guard a fast
  // double-click can start a second run on top of the first.
  let demoBusy = false;
  document.getElementById("demo-mode-btn").addEventListener("click", async (e) => {
    if (demoBusy) return;
    demoBusy = true;
    const btn = e.currentTarget;
    const label = document.getElementById("demo-btn-label");
    try {
      if (!State.demoMode) {
        label.textContent = "Stop demo";
        btn.classList.add("active");
        logEvent("Demo mode started — scripted scenario running", "info");
        await startDemoMode();
      } else {
        label.textContent = "Demo mode";
        btn.classList.remove("active");
        logEvent("Demo mode stopped — live GPS resumed", "info");
        stopDemoMode();
      }
    } finally {
      demoBusy = false;
    }
  });
}

document.getElementById("start-btn").addEventListener("click", start);
