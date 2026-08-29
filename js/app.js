import { State } from "./state.js";
import { initMap, startGeolocation, setFollow, enterNavMode, exitNavMode, latLngFromScreen, updateUserPosition } from "./map.js";
import { loadRiskLayer, setTimeBucket, loadCrashPoints, setCrashPointsVisible, loadDensityModel, setDensityModelVisible } from "./risk.js";
import { planRoute, clearRoute } from "./routing.js";
import { spawnBots } from "./bots.js";
import { initAlerts } from "./alerts.js";
import { startDemoMode, stopDemoMode } from "./demo.js";
import { logEvent } from "./eventlog.js";
import { initAssistant } from "./assistant.js";
import { initWeather } from "./weather.js";

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
  // #app has to be revealed BEFORE initMap() -- Leaflet measures its
  // container on creation, and a display:none container sizes to 0x0. But
  // everything below (including every addEventListener) is behind two
  // network-bound awaits, so for that whole window the UI is fully drawn and
  // completely dead: measured ~1.5s on a local server, and this loads three
  // GeoJSON files (district polygons are the big one), so a phone on mobile
  // data sits there for meaningfully longer. Tapping the menu in that window
  // did nothing at all, with no indication anything was still loading.
  // The scrim keeps Leaflet's sizing correct while making the wait honest
  // and swallowing clicks instead of silently dropping them.
  const bootScrim = document.getElementById("boot-scrim");
  if (bootScrim) bootScrim.hidden = false;

  try {
    await initMap();
    await loadRiskLayer();
  } finally {
    // Removed even if loading failed -- leaving the scrim up forever would
    // turn a partial failure into a permanently frozen-looking app.
    if (bootScrim) bootScrim.hidden = true;
  }
  setTimeBucket(State.timeBucket);
  startGeolocation();
  initAlerts();
  initAssistant();
  initWeather();
  spawnBots(); // fire and forget -- OSRM calls happen in the background

  document.querySelectorAll("#time-toggle button").forEach((btn) => {
    btn.addEventListener("click", () => setTimeBucket(btn.dataset.bucket));
  });

  // Makes live/demo mutually exclusive in the UI, not just two panels stacked
  // in the same scroll -- only the selected mode's panel is ever visible.
  // Pure UI selection, not app State: which panel you're LOOKING at is
  // independent of whether a demo is actually running (STOP in the trip bar
  // works regardless of which tab the drawer happens to be showing).
  function selectMode(mode) {
    const isLive = mode === "live";
    document.getElementById("mode-live-btn").classList.toggle("active", isLive);
    document.getElementById("mode-demo-btn").classList.toggle("active", !isLive);
    document.getElementById("route-panel").hidden = !isLive;
    document.getElementById("demo-panel").hidden = isLive;
  }
  document.getElementById("mode-live-btn").addEventListener("click", () => selectMode("live"));
  document.getElementById("mode-demo-btn").addEventListener("click", () => selectMode("demo"));

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

  // Live and demo used to share this one button in a way that depended on
  // WHICH one started it (a `navStartedDemo` flag) -- so EXIT while a demo
  // launched from the drawer was running left it going in the background,
  // camera detached: "even when i pressed exit, the navigation kept on
  // running". map.js's syncNavButton now derives the label purely from
  // (demoMode, navMode), and this handler mirrors that same precedence, so
  // the label and the action can never disagree with each other or with
  // what's actually running.
  document.getElementById("nav-toggle-btn").addEventListener("click", () => {
    if (State.demoMode) {
      stopDemoMode();
      logEvent("Demo drive stopped", "info");
      return;
    }
    if (State.navMode) {
      exitNavMode();
      logEvent("Navigation view closed — showing whole route", "info");
      return;
    }
    // Live mode only: your real GPS position, close-up. No more silent
    // fallback to simulating a route if the device happens to be stationary
    // -- that was the live/demo blurring this button is now free of. Want to
    // watch a drive play out? Use Demo Drive, below.
    enterNavMode();
    logEvent("Navigation started", "info");
  });

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

  // Same lazy-load-on-first-toggle pattern as crash points, and the same
  // reason: no point fetching/computing anything for a layer most sessions
  // never open.
  const densityBtn = document.getElementById("density-model-btn");
  const densityLabel = document.getElementById("density-model-label");
  let densityLoading = false;
  densityBtn.addEventListener("click", async () => {
    if (densityLoading) return;
    if (State.densityVisible) {
      setDensityModelVisible(false);
      densityBtn.classList.remove("active");
      densityLabel.textContent = "Show density model";
      return;
    }
    if (!State.densityLayer) {
      densityLoading = true;
      densityLabel.textContent = "Loading…";
      try {
        await loadDensityModel();
      } catch (e) {
        densityLabel.textContent = "Show density model";
        logEvent(`Could not load density model: ${e.message}`, "warn");
        return;
      } finally {
        densityLoading = false;
      }
    }
    setDensityModelVisible(true);
    densityBtn.classList.add("active");
    densityLabel.textContent = "Hide density model";
    logEvent(
      `Showing density model — real kernel density estimate over ${State.densityCells} grid cells, not a prediction of future crashes`,
      "info"
    );
  });

  const drawer = document.getElementById("detail-drawer");
  const openDrawer = () => { drawer.hidden = false; };
  const closeDrawer = () => { drawer.hidden = true; };
  // Only the plain menu-button open re-syncs the tab to whatever's actually
  // running -- the map-tap paths below call selectMode() themselves right
  // before opening the drawer (to reveal the field they just filled), and
  // syncing here too would immediately undo that choice.
  document.getElementById("menu-btn").addEventListener("click", () => {
    selectMode(State.demoMode ? "demo" : "live");
    openDrawer();
  });
  document.getElementById("detail-close-btn").addEventListener("click", closeDrawer);
  document.getElementById("detail-backdrop").addEventListener("click", closeDrawer);

  // Typing a raw "lat,lng" is close to unusable -- nobody knows a point's
  // coordinates. Tapping the map is the natural way to pick one, and needs no
  // geocoding backend: it just fills a text input, so routing/demo-planning
  // themselves are unchanged. Leaflet only fires `click` on an actual
  // tap/release, not mid-drag, so this doesn't fight with panning the map.
  //
  // One tap handler now serves three different fields (live route
  // destination, demo start, demo destination) rather than always meaning
  // "set the live destination" -- `armedField` tracks which input the NEXT
  // tap should fill, set by pressing a field's own pin button, and always
  // resets back to the live-route default afterward so a stray tap can't
  // silently overwrite a demo field the user isn't looking at.
  let armedField = "route-dest";
  function armField(name) {
    armedField = name;
    closeDrawer(); // so the map is actually visible to tap
  }

  State.map.on("click", (e) => {
    // Not e.latlng: Leaflet derives that from getBoundingClientRect(), which
    // is the axis-aligned bounding box once nav mode rotates the container --
    // so it silently returns the wrong point there. latLngFromScreen undoes
    // the rotation properly (and is identical to e.latlng when unrotated).
    const { lat, lng } = latLngFromScreen(e.originalEvent.clientX, e.originalEvent.clientY);
    const value = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    const field = armedField;
    armedField = "route-dest";

    if (field === "demo-start") {
      selectMode("demo"); // otherwise the field just filled would be sitting in a [hidden] panel
      document.getElementById("demo-start-input").value = value;
      document.getElementById("demo-status").textContent = "Start set from map tap.";
      openDrawer();
      document.getElementById("demo-panel").scrollIntoView({ block: "nearest" });
    } else if (field === "demo-dest") {
      selectMode("demo");
      document.getElementById("demo-dest-input").value = value;
      document.getElementById("demo-status").textContent = "Destination set from map tap.";
      openDrawer();
      document.getElementById("demo-panel").scrollIntoView({ block: "nearest" });
    } else {
      selectMode("live");
      document.getElementById("dest-input").value = value;
      syncGoEnabled(); // programmatic .value assignment doesn't fire `input`
      document.getElementById("route-status").textContent = "Destination set from map tap — tap GO to route there.";
      openDrawer();
      document.getElementById("route-panel").scrollIntoView({ block: "nearest" });
    }
  });

  document.getElementById("demo-start-pin-btn").addEventListener("click", () => armField("demo-start"));
  document.getElementById("demo-dest-pin-btn").addEventListener("click", () => armField("demo-dest"));

  /** Parses "lat,lng" -> {lat,lng}, or null for a blank field (both fields
   * are optional: startDemoMode() falls back to live position / an
   * auto-picked district exactly like the original one-button demo did). */
  function parseLatLng(raw, label, statusEl) {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: true, value: null };
    const parts = trimmed.split(",").map((s) => parseFloat(s.trim()));
    if (parts.length !== 2 || parts.some(Number.isNaN)) {
      statusEl.textContent = `${label} must be lat,lng`;
      return { ok: false, value: null };
    }
    return { ok: true, value: { lat: parts[0], lng: parts[1] } };
  }

  // startDemoMode is async (it fetches routes), so without a guard a fast
  // double-click can start a second run on top of the first.
  let demoBusy = false;
  document.getElementById("demo-drive-btn").addEventListener("click", async () => {
    if (demoBusy) return;
    const status = document.getElementById("demo-status");

    if (State.demoMode) {
      stopDemoMode();
      logEvent("Demo drive stopped", "info");
      return;
    }

    const start = parseLatLng(document.getElementById("demo-start-input").value, "Start", status);
    if (!start.ok) return;
    const dest = parseLatLng(document.getElementById("demo-dest-input").value, "Destination", status);
    if (!dest.ok) return;

    demoBusy = true;
    status.textContent = "Starting demo drive…";
    try {
      logEvent("Demo drive started — simulated, not real movement", "info");
      await startDemoMode({ start: start.value, dest: dest.value });
      status.textContent = "";
      closeDrawer(); // matches the live route panel: once it's running, get out of the way
    } catch (e) {
      status.textContent = `Could not start: ${e.message}`;
      logEvent(`Demo drive failed to start: ${e.message}`, "warn");
    } finally {
      demoBusy = false;
    }
  });
}

document.getElementById("start-btn").addEventListener("click", start);
