// Shared, mutable app state. Plain object on purpose -- this is a small
// prototype, not worth a state-management library for six modules.
export const State = {
  map: null,
  userMarker: null,
  userPos: null,       // {lat, lng}
  userSpeedKmh: 0,
  followUser: true, // map keeps the vehicle centred until the user pans away
  timeBucket: "afternoon",

  riskFeatures: [],    // [{district, geometry, risk_by_time}] -- risk_lookup.geojson joined with pahang_districts.geojson shapes
  riskLayerGroup: null,

  crashPointsLayer: null,   // real recorded crash coordinates from the dataset (see risk.js loadCrashPoints)
  crashPointsCount: 0,
  crashPointsVisible: false,

  densityLayer: null,   // real KDE hotspot model over the crash coordinates (see risk.js loadDensityModel) -- genuine density estimation, not the placeholder district shading
  densityCells: 0,
  densityVisible: false,

  weather: null,   // real current conditions from Open-Meteo (see weather.js) -- {tempC, precipMm, code}, never fed into the risk score

  bots: [],             // array of bot objects, see bots.js
  activeJams: [],        // array of {lat, lng, botCount}

  route: {
    coords: null,        // array of [lat,lng]
    layer: null,          // remaining/ahead polyline (bright)
    traveledLayer: null,  // covered-so-far polyline (dimmed) -- the "on the way" progress view
    destination: null,
    destMarker: null,    // visually confirms *where* the route ends -- previously only the line itself hinted at it
    cumDist: null,        // cumulative distance in metres per coords[] index, for progress tracking
    totalDistanceM: null,
    totalDurationS: null,
    steps: null,          // OSRM maneuver steps for the active route -- turn-by-turn banner
    stepStartM: null,      // cumulative distance at the START of each step, parallel to steps[] (+1 entry for the total)
  },

  demoMode: false,
  navMode: false, // close-up vehicle-following "driving" view vs. the zoomed-out route overview
  watchId: null,
};
