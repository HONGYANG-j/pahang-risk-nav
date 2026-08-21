import { State } from "./state.js";
import { getRiskAt, getDistrictAt } from "./risk.js";
import { rerouteAvoiding } from "./routing.js";
import { haversineMeters } from "./risk.js";
import { logEvent } from "./eventlog.js";
import { resolveJamNear } from "./bots.js";

const CHECK_MS = 2000;
const USER_PROXIMITY_M = 300;
const ROUTE_JAM_PROXIMITY_M = 250;
const COOLDOWN_MS = 30000;

const dismissed = new Map(); // key -> expiry timestamp
let checkHandle = null;
let currentTroublePoint = null;
let lastAlertKey = null;
let lastLoggedDistrict = null;

function riskLabel(score) {
  if (score == null) return { text: "—", cls: "" };
  if (score >= 0.6) return { text: "HIGH", cls: "risk-high" };
  if (score >= 0.4) return { text: "MED", cls: "risk-med" };
  return { text: "LOW", cls: "risk-low" };
}

/** Refreshes the always-visible HUD stat chips. Runs every tick regardless of
 * whether an alert is showing -- this is the "informative" readout, separate
 * from the alert banner which only appears on a flagged condition. */
function updateStats() {
  const districtEl = document.getElementById("stat-district");
  const riskEl = document.getElementById("stat-risk");
  const jamsEl = document.getElementById("stat-jams");
  if (jamsEl) jamsEl.textContent = String(State.activeJams.length);

  if (!State.userPos) return;
  const here = getDistrictAt(State.userPos.lat, State.userPos.lng);
  if (districtEl) districtEl.textContent = here ? here.district : "—";
  if (riskEl) {
    const { text, cls } = riskLabel(here?.score);
    riskEl.textContent = text;
    riskEl.className = `hud-value hud-value-text ${cls}`;
  }

  if (here && here.district !== lastLoggedDistrict) {
    logEvent(`Entered ${here.district} district`, "info");
    lastLoggedDistrict = here.district;
  } else if (!here) {
    lastLoggedDistrict = null;
  }
}

function isDismissed(key) {
  const exp = dismissed.get(key);
  return exp != null && Date.now() < exp;
}

function dismiss(key) {
  const now = Date.now();
  for (const [k, exp] of dismissed) {
    if (exp <= now) dismissed.delete(k); // keep the map from growing without bound
  }
  dismissed.set(key, now + COOLDOWN_MS);
}

// Bot count moved here (out of the headline sentence, which reads better
// short) -- still visible, just as the provenance line instead of crammed
// into the same sentence as the question being asked ("reroute?").
const simulatedSource = (n) =>
  `Simulated: ${n} vehicles clustered and slowing — demonstrates crowdsourced jam detection, not real users.`;
const PLACEHOLDER_SOURCE =
  "Placeholder score from synthetic sample data — not a validated risk estimate.";

function jamNearRoute() {
  if (!State.route.coords) return null;
  for (const jam of State.activeJams) {
    for (let i = 0; i < State.route.coords.length; i += 5) {
      const [lat, lng] = State.route.coords[i];
      if (haversineMeters(lat, lng, jam.lat, jam.lng) <= ROUTE_JAM_PROXIMITY_M) {
        return jam;
      }
    }
  }
  return null;
}

function jamNearUser() {
  if (!State.userPos) return null;
  return (
    State.activeJams.find(
      (jam) => haversineMeters(State.userPos.lat, State.userPos.lng, jam.lat, jam.lng) <= USER_PROXIMITY_M
    ) || null
  );
}

function evaluate() {
  updateStats();
  if (!State.userPos) return;

  const routeJam = jamNearRoute();
  if (routeJam) {
    const key = `routejam-${routeJam.lat.toFixed(3)}-${routeJam.lng.toFixed(3)}`;
    if (!isDismissed(key)) {
      currentTroublePoint = { lat: routeJam.lat, lng: routeJam.lng };
      showAlert(
        "Traffic jam ahead on your route — reroute?",
        key,
        simulatedSource(routeJam.botCount)
      );
      return;
    }
  }

  const userJam = jamNearUser();
  if (userJam) {
    const key = `userjam-${userJam.lat.toFixed(3)}-${userJam.lng.toFixed(3)}`;
    if (!isDismissed(key)) {
      currentTroublePoint = { lat: userJam.lat, lng: userJam.lng };
      showAlert(
        "Traffic jam nearby.",
        key,
        simulatedSource(userJam.botCount)
      );
      return;
    }
  }

  const risk = getRiskAt(State.userPos.lat, State.userPos.lng);
  if (risk) {
    const key = `risk-${risk.district}-${State.timeBucket}`;
    if (!isDismissed(key)) {
      currentTroublePoint = { lat: State.userPos.lat, lng: State.userPos.lng };
      const factors = risk.top_factors.length ? risk.top_factors.join(", ") : "no single dominant factor";
      showAlert(
        `Entering ${risk.district} — higher historical risk during ${State.timeBucket} hours (${factors}).`,
        key,
        PLACEHOLDER_SOURCE
      );
      return;
    }
  }

  hideAlert();
}

function showAlert(text, key, source = "") {
  const banner = document.getElementById("alert-banner");
  const textEl = document.getElementById("alert-text");
  const sourceEl = document.getElementById("alert-source");
  const fixBtn = document.getElementById("alert-fix-btn");
  const rerouteBtn = document.getElementById("alert-reroute-btn");
  if (!banner || !textEl) return;

  // Restore Reroute explicitly. map.js's showGpsAlert() hides it (rerouting
  // is meaningless with no position), and nothing here ever put it back --
  // so after any GPS hiccup, every later alert rendered "...— reroute?" with
  // no Reroute button at all. Tied to whether a route actually exists, so it
  // is also never a dead button on an alert with nothing to reroute.
  if (rerouteBtn) rerouteBtn.hidden = !State.route.destination;
  textEl.textContent = text;
  // Every alert states its own provenance, so what's real vs simulated vs
  // placeholder stays legible on camera without relying on narration.
  if (sourceEl) sourceEl.textContent = source;
  banner.hidden = false;
  banner.dataset.key = key;
  // "Simulate Fix" (the policy-sandbox action) only makes sense for a
  // dynamic jam a patrol could clear -- not the historical placeholder
  // risk score, which isn't something a button plausibly "fixes".
  if (fixBtn) fixBtn.hidden = !(key.startsWith("routejam") || key.startsWith("userjam"));

  // Log once per new condition, not every 2s while the same alert persists.
  if (key !== lastAlertKey) {
    const severity = key.startsWith("routejam") || key.startsWith("userjam") ? "warn" : "danger";
    logEvent(text, severity);
    lastAlertKey = key;
  }
}

function hideAlert() {
  const banner = document.getElementById("alert-banner");
  if (banner) banner.hidden = true;
  lastAlertKey = null;
}

export function initAlerts() {
  document.getElementById("alert-dismiss-btn").addEventListener("click", () => {
    const banner = document.getElementById("alert-banner");
    if (banner.dataset.key) dismiss(banner.dataset.key);
    hideAlert();
  });

  document.getElementById("alert-fix-btn").addEventListener("click", () => {
    const banner = document.getElementById("alert-banner");
    if (banner.dataset.key) dismiss(banner.dataset.key);
    hideAlert();
    if (currentTroublePoint) {
      const released = resolveJamNear(currentTroublePoint);
      logEvent(
        released > 0
          ? `Simulated fix dispatched — jam cleared in simulation (${released} vehicles released)`
          : "Simulated fix dispatched — no jam found at that point anymore",
        "info"
      );
    }
  });

  document.getElementById("alert-reroute-btn").addEventListener("click", async () => {
    const banner = document.getElementById("alert-banner");
    if (banner.dataset.key) dismiss(banner.dataset.key);
    hideAlert();
    if (currentTroublePoint && State.route.destination) {
      // rerouteAvoiding can make several sequential OSRM calls (alternatives,
      // then up to two via-point attempts) -- a couple of seconds with no
      // feedback reads as "did my click even register?", not just "slow".
      const routeInfoEl = document.getElementById("route-info");
      if (routeInfoEl) routeInfoEl.textContent = "Rerouting…";
      try {
        const result = await rerouteAvoiding(currentTroublePoint);
        // null means no candidate actually cleared the trouble point without
        // a wild detour -- rerouteAvoiding already left the original route
        // showing rather than drawing a fake one, so say so honestly instead
        // of claiming a reroute that didn't happen.
        logEvent(
          result ? "Rerouted to avoid flagged area" : "No clear alternate route found — continuing on original route",
          result ? "info" : "warn"
        );
      } catch (e) {
        console.warn("Reroute failed:", e.message);
        logEvent(`Reroute failed: ${e.message}`, "warn");
      }
    }
  });

  if (checkHandle == null) {
    checkHandle = setInterval(evaluate, CHECK_MS);
  }
}

export function stopAlerts() {
  if (checkHandle != null) {
    clearInterval(checkHandle);
    checkHandle = null;
  }
  hideAlert();
}
