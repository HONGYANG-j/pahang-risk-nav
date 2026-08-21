import { State } from "./state.js";
import { fetchRoutes } from "./routing.js";
import { haversineMeters } from "./risk.js";

const BOT_COUNT = 5;
const TICK_MS = 600;
const SLOW_JOIN_PROB = 0.02;   // chance per tick a normal bot becomes slow
const SLOW_LEAVE_PROB = 0.05;  // chance per tick a slow bot recovers
const JAM_CLUSTER_RADIUS_M = 200;
const JAM_MIN_BOTS = 3;

let tickHandle = null;

function randomPointNear(center, radiusKm) {
  const r = radiusKm * Math.sqrt(Math.random());
  const theta = Math.random() * 2 * Math.PI;
  const dLat = (r / 111) * Math.sin(theta);
  const dLng = (r / (111 * Math.cos((center.lat * Math.PI) / 180))) * Math.cos(theta);
  return { lat: center.lat + dLat, lng: center.lng + dLng };
}

function botDivIcon(slow) {
  return L.divIcon({
    className: "",
    html: `<div class="bot-icon${slow ? " slow" : ""}"></div>`,
    iconSize: [10, 10],
    iconAnchor: [5, 5],
  });
}

async function makeBot(id, center) {
  const a = randomPointNear(center, 4);
  const b = randomPointNear(center, 4);
  try {
    const [route] = await fetchRoutes(a, b);
    const marker = L.marker(route.coords[0], { icon: botDivIcon(false) }).addTo(State.map);
    return {
      id,
      coords: route.coords,
      idx: 0,
      dir: 1,
      slow: false,
      forcedSlow: false,
      marker,
    };
  } catch (e) {
    console.warn("bot route fetch failed, skipping bot", id, e.message);
    return null;
  }
}

export async function spawnBots() {
  const center = State.userPos || { lat: 3.8077, lng: 103.326 };
  const results = await Promise.all(
    Array.from({ length: BOT_COUNT }, (_, i) => makeBot(i, center))
  );
  State.bots = results.filter(Boolean);
  if (tickHandle == null) {
    tickHandle = setInterval(tick, TICK_MS);
  }
}

export function stopBots() {
  if (tickHandle != null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  State.bots.forEach((b) => b.marker.remove());
  State.bots = [];
  State.activeJams = [];
}

function tick() {
  State.bots.forEach((bot) => {
    if (!bot.forcedSlow) {
      if (bot.slow) {
        if (Math.random() < SLOW_LEAVE_PROB) bot.slow = false;
      } else if (Math.random() < SLOW_JOIN_PROB) {
        bot.slow = true;
      }
    }

    const step = (bot.slow ? 1 : 4) * bot.dir; // slow bots barely move -> visible clustering
    bot.idx += step;
    if (bot.idx >= bot.coords.length - 1) {
      bot.idx = bot.coords.length - 1;
      bot.dir = -1;
    } else if (bot.idx <= 0) {
      bot.idx = 0;
      bot.dir = 1;
    }

    const pos = bot.coords[bot.idx];
    bot.marker.setLatLng(pos);
    bot.marker.setIcon(botDivIcon(bot.slow));
  });

  detectJams();
}

function detectJams() {
  const slowBots = State.bots.filter((b) => b.slow);
  const jams = [];
  const used = new Set();

  slowBots.forEach((bot) => {
    if (used.has(bot.id)) return;
    const pos = bot.coords[bot.idx];
    const cluster = slowBots.filter((other) => {
      const otherPos = other.coords[other.idx];
      return haversineMeters(pos[0], pos[1], otherPos[0], otherPos[1]) <= JAM_CLUSTER_RADIUS_M;
    });
    if (cluster.length >= JAM_MIN_BOTS) {
      cluster.forEach((b) => used.add(b.id));
      const lat = cluster.reduce((s, b) => s + b.coords[b.idx][0], 0) / cluster.length;
      const lng = cluster.reduce((s, b) => s + b.coords[b.idx][1], 0) / cluster.length;
      jams.push({ lat, lng, botCount: cluster.length });
    }
  });

  State.activeJams = jams;
}

/**
 * Policy-sandbox action: simulates dispatching a fix (e.g. a patrol clearing
 * the jam) by releasing whichever bots are contributing to a jam near `point`
 * from their slow state. The next tick's detectJams() naturally stops
 * reporting it once no slow bots remain there -- no separate bookkeeping
 * needed. Returns how many bots were released, so the caller can tell whether
 * there was actually anything nearby to fix.
 */
export function resolveJamNear(point, radiusM = JAM_CLUSTER_RADIUS_M + 100) {
  let released = 0;
  State.bots.forEach((bot) => {
    if (!bot.slow) return;
    const pos = bot.coords[bot.idx];
    if (haversineMeters(pos[0], pos[1], point.lat, point.lng) <= radiusM) {
      bot.slow = false;
      bot.forcedSlow = false;
      released++;
    }
  });
  return released;
}
