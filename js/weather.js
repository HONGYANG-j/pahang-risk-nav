import { State } from "./state.js";

// Open-Meteo: free, no API key, CORS-enabled for direct browser fetch --
// https://open-meteo.com/en/docs. Real live conditions at the user's actual
// position (or a Pahang fallback centre, same default used elsewhere in this
// app -- demo.js, bots.js). Deliberately NOT fed into the risk score: doing
// that would mean inventing a new risk formula on top of a dataset already
// established to carry no real predictive signal, the same fabrication risk
// this project has avoided everywhere else. Shown as its own honest,
// separate readout.
const REFRESH_MS = 10 * 60 * 1000; // conditions don't need 2s-loop freshness
const FALLBACK_CENTER = { lat: 3.8077, lng: 103.326 };

const WEATHER_CODES = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow",
  80: "Rain showers", 81: "Rain showers", 82: "Violent showers",
  95: "Thunderstorm", 96: "Thunderstorm", 99: "Severe thunderstorm",
};

async function fetchWeather(lat, lng) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,precipitation,weather_code&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo request failed: ${res.status}`);
  const data = await res.json();
  return {
    tempC: data.current?.temperature_2m,
    precipMm: data.current?.precipitation,
    code: data.current?.weather_code,
  };
}

function render(weather) {
  const el = document.getElementById("stat-weather");
  if (!el || !weather) return;
  const label = WEATHER_CODES[weather.code] || "—";
  el.textContent = weather.tempC != null ? `${Math.round(weather.tempC)}°C · ${label}` : label;
  // Reuses the existing risk-med (amber) styling purely as a glance cue for
  // "wet road right now" -- not a claim about the placeholder risk score.
  el.classList.toggle("risk-med", (weather.precipMm ?? 0) > 0);
}

async function refresh() {
  const center = State.userPos || FALLBACK_CENTER;
  try {
    const weather = await fetchWeather(center.lat, center.lng);
    State.weather = weather;
    render(weather);
  } catch (e) {
    console.warn("Weather fetch failed:", e.message);
  }
}

export function initWeather() {
  refresh();
  setInterval(refresh, REFRESH_MS);
}
