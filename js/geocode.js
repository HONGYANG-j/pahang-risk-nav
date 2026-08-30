// Nominatim (OpenStreetMap) -- free, no API key, standard for prototype
// client-side geocoding. Its usage policy asks for an identifying
// User-Agent/Referer, which a real browser page sends automatically (this
// is a normal page fetch, not a scripted loop hammering it), and one lookup
// per user action stays well inside its ~1 req/sec limit.
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

// left,top,right,bottom in lng,lat -- biases results toward Pahang without
// hard-excluding a real destination just over the state line (bounded=0).
const PAHANG_VIEWBOX = "101.2,4.9,103.9,2.4";

/** True if the input is already "lat,lng" -- the existing power-user
 * shortcut, tried first so it never costs a network round-trip. */
export function looksLikeLatLng(raw) {
  const parts = raw.split(",").map((s) => s.trim());
  return parts.length === 2 && parts.every((p) => p !== "" && !Number.isNaN(Number(p)));
}

/** Resolves a place name to real coordinates via Nominatim. Throws with a
 * message safe to show directly in the UI. */
export async function geocode(query) {
  const url = `${NOMINATIM_URL}?format=json&limit=1&countrycodes=my&viewbox=${PAHANG_VIEWBOX}&bounded=0&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Location lookup failed (${res.status})`);
  const results = await res.json();
  if (!results.length) throw new Error(`No location found for "${query}"`);
  const { lat, lon, display_name } = results[0];
  return { lat: parseFloat(lat), lng: parseFloat(lon), label: display_name };
}
