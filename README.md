# Risk-Aware Navigation — Prototype

Companion "AI app" concept for the DAX 2026 Road Safety submission. This is a
demo prototype, not one of the three official scored deliverables (dashboard /
video / report) — see `../` for those.

## Positioning

Rider-first risk intelligence, not a car-first app with a motorcycle toggle.
Historical structural risk ("this stretch is statistically dangerous at 9pm in
the rain") rather than Waze's reactive live-incident reporting ("a crash
happened here 5 minutes ago") — a different product category, not a smaller
version of the same one. Three features exist specifically to demonstrate this
is more than a consumer nav app:

- **Planner Assistant** (`js/assistant.js`) — a grounded query tool for a
  police/state-planner persona ("where should patrols go tonight?"). Answers
  are template-composed from real app state only — no LLM API call. That's
  deliberate, not a shortcut: there's no backend here to hold an API key
  safely, and a free-generating chatbot over this data risks inventing numbers
  that were never computed, which is exactly what the competition's ethics
  rules forbid.
- **Policy Sandbox "Simulate Fix"** — the jam alert's action row includes a
  button that simulates dispatching a fix (patrol clears the jam) so the
  bot/simulation layer reads as "test an intervention before spending a real
  budget on it," not an apology for lacking real users.
- **Impact panel** (landing screen) — real, sourced MIROS/DOSM figures
  (RM3.12M per fatality, 50%+ of fatalities are motorcyclists) framing why
  this matters, explicitly labelled as national figures since no Pahang-district
  breakdown was available.

**Deliberately not built here** (would need data or infrastructure this
project doesn't have — see conversation/memory for the reasoning): a
socioeconomic (OpenDOSM) risk overlay, hyper-local hotspot data (monsoon
flood zones, informal roads), and anything presented as a roadmap slide,
which belongs in the pitch deck, not the running app.

## Live vs. Demo — two fully separate modes

These used to share one "START" button, which silently fell into simulating a
route if the device happened to be stationary. Reported back as confusing (and
as a real bug: pressing EXIT while a demo launched from the drawer was running
left it going in the background) — so they're now two independent panels with
no shared state beyond the map itself:

- **Route (live)** — real GPS only. Plan a destination, then **START** on the
  trip bar gives a close-up, heading-up driving view that follows your actual
  device position. If you're not moving, the view just doesn't move — it will
  never silently switch to a simulation.
- **Demo Drive** — fully simulated, never touches real GPS. Its own start
  *and* destination (each settable by tapping 📍 then the map, or typing
  coordinates; both optional — blank defaults to your live position and a
  nearby high-risk district, the original one-click behaviour). Badged
  **SIMULATED DRIVE** throughout, and the status pill reads **SIMULATED**
  (not LIVE) while one is running.

The trip bar's button is shared between them but always tells the truth about
which one is active: **▶ START** (live, nothing running) → **✕ EXIT** (in the
live nav view) or **■ STOP** (a demo drive is running) — driven purely by
`(State.demoMode, State.navMode)`, never by which control was pressed to get
there. Pressing it during a demo drive always fully stops it: the animation,
the camera, and the badge together, whether the drive was started from the
trip bar or the Demo Drive panel.

## ⚠ The supplied dataset is synthetic — read this first

`prasiswazah.csv` does **not** contain authentic incident-level crash data. Its
columns appear to be independently shuffled: each keeps a plausible-looking
marginal distribution, but every relationship *between* columns is destroyed.
Four independent checks over the full file:

| Check | Result | Real data would show |
|---|---|---|
| Vehicles sharing a `Report Number` | median **110 km** apart (max 704 km); 100% of pairs >1 km | Same location |
| `Day` vs weekday of `Date of Report` | matches **15.9%** | ~100% (chance = 14.3%) |
| "Dark Without Street Light" crashes | **63%** fall in daytime hours — same as "Daylight" (60%) | Near-deterministic |
| Belt/helmet vs vehicle type | Motorcycles show "Belt" 55%; cars show "Helmet" 27% | Helmets on bikes, belts in cars |

Consequently the overall fatality rate is **51.9%** (real crash data runs 1–3%),
and every risk factor moves it by only ~5–7 points, several in the wrong
direction (dry roads read *more* fatal than wet; 70 km/h more than 110 km/h).
**That is noise around a base rate — a severity classifier will score ≈52%
regardless of how well it is built, and any "insight" drawn from a cross-tab is
a pattern that isn't there.**

**The coordinates are the exception — they hold up.** `Latitude`/`Longitude`
are present at ~1 m precision (5 dp) and, unlike the attribute columns, are
demonstrably *not* shuffled:

| Check | Result | If lat/lng were shuffled |
|---|---|---|
| Points falling inside Pahang | **76%** | ~8% (Pahang is 8.4% of the bounding box the values span) |
| Median nearest-neighbour distance | **3.4 km** | 18.9 km (uniform random over the same box) |
| Point inside the district its own `District` column names | **65%** | ~9% by chance |

So the *locations* are real signal: they cluster along roads and towns the way
incident data does. Two caveats keep them honest — ~24% of rows fall outside
Pahang entirely (consistent with coordinates jittered for privacy before
release, so individual points are approximate, not exact crash sites; those
rows are excluded from the map), and the **severity columns are still
shuffled**, so a point means "a crash was recorded near here", never "this
spot is dangerous". The app draws them via **Show crash locations** in the
drawer — see `data/build_crash_points.py`. Density is deliberately the only
readable signal: 2,288 points across the whole state, with the busiest ~2 km
cell holding just 7, is too thin to claim individual hotspots.

Those verified coordinates are also enough to fit a real, honest model: a 2D
Gaussian kernel density estimate (`scipy.stats.gaussian_kde`, Scott's rule
bandwidth) computed in a local equirectangular projection (so the kernel is
circular in real metres, not skewed by latitude), evaluated on an 800 m grid,
and clipped to the real Pahang district polygons — see
`data/build_density_model.py`. The app draws it via **Show density model** in
the drawer, as a smooth heatmap layered over (or instead of) the flat
district shading. It's unsupervised — no trained classifier, no teammate
handoff needed — and it only ever sees the verified coordinates, never the
shuffled outcome/factor columns, so it answers "where do past crashes
cluster" and nothing about severity, cause, or future risk. That distinction
is stated in the model's own metadata and worth repeating in the pitch: this
is real density estimation on real locations, not a prediction.

What survives: single-column descriptive statistics, **and the crash
coordinates**. What does not: correlations, cross-tabs, and predictions. The likely cause is deliberate anonymisation by the
organisers (real MIROS data with coordinates is sensitive) — worth asking them
whether an authentic dataset exists. Until then this app labels its risk layer a
placeholder everywhere it appears, rather than presenting it as a finding.

## What's real vs simulated (read this before demoing to anyone)

- **Real:** your device's live GPS position and speed (browser Geolocation API)
  — this is the "depends on GPS" path. Manual routing (below) is the other
  path and needs none of this. The status pill states which of the three you
  are actually looking at — **LIVE** (a genuine GPS fix), **SIMULATED** (a
  demo drive; real geolocation is stopped), **SEARCHING…/NO GPS** — because
  `updateUserPosition()` is called by all three sources and used to light up a
  green LIVE pill for every one of them, including on a device with no fix at
  all.
- **Real, but snapped:** the destination. OSRM can only route between points
  on its road network, so a tapped point is snapped to the nearest road —
  measured 1.9 km away for a tap in Pahang's interior. The pin is drawn at the
  snapped point (not the raw tap) so the map never implies a destination the
  route doesn't actually reach, and any snap over 100 m is called out in the
  event log.
- **Placeholder, not a model:** the coloured risk zones. Computed from
  `prasiswazah.csv`, which is synthetic (above) — they demonstrate the interface,
  not a validated risk estimate.
- **Real:** the density model (**Show density model**). A genuine KDE fit to
  the verified crash coordinates — see above. Real methodology, but still
  only "where crashes cluster", never a prediction or a severity claim.
- **Simulated:** the other "bot" vehicles and the jams they form. They exist to
  demonstrate the crowdsourced-detection concept visually, since a new app has
  no real user base yet. They are never presented as real live users — the UI
  always labels them as simulated (legend + footer + per-alert source line).

Keep this distinction explicit in the pitch video narration. It's what keeps
the concept defensible if a judge asks where the "real-time" data comes from.

## Running it

### Easiest way (no typing, no terminal)

**Double-click [`run.bat`](run.bat).** A black window opens (that's the
server — leave it open while you use the app) and your browser opens to the
app automatically. To stop it, just close the black window.

Needs Python installed (get it from [python.org/downloads](https://www.python.org/downloads/)
— tick **"Add python.exe to PATH"** during setup, it's unticked by default).
If `run.bat` prints an error about Python not being found, that's the fix;
after installing, double-click `run.bat` again.

Once it opens, there are two independent ways to use it (see "Live vs. Demo"
above):

- **Live** — allow location access, plan a destination in the **Route**
  panel (tap the map or type `lat,lng`, works with or without a fix), then
  **START** for the close-up driving view of your real position.
- **No phone / not actually moving? Use Demo Drive** — its own panel, its own
  optional start + destination (blank defaults to your position and a nearby
  high-risk district), press **Start Demo Drive**. This is the way to explore
  the app or preview a route without a real device — Live's START intentionally
  no longer falls into this on its own.

### Command-line way (if you're already in a terminal)

A local server is required either way — the Geolocation API doesn't work on
`file://` origins:

```bash
python risk-nav-app/serve.py 8080
```

Then open `http://localhost:8080`. This is exactly what `run.bat` does for
you automatically.

Use `serve.py`, not plain `python -m http.server` — it disables caching.
Browsers cache ES modules aggressively, so with a normal static server you can
edit a module, reload, and silently still be running the old file (it shows up
as "export not found" errors against code you just fixed).

### Demo mode

Use **Demo mode** for actual video recording instead of relying on live
conditions cooperating in a one-take recording. It scripts a ~55s scenario:
plans a real ~12km route toward a genuinely high-risk district, cruises at a
realistic 60 km/h, raises a "jam ahead on your route" alert while still at
speed, slows to a crawl through the jam, then parks at the destination.
Pressing **Reroute** during the run switches the vehicle onto the new route and
away from the jam — the speed readout recovering to 60 is the visible proof it
worked. The trip-bar's remaining-distance/ETA readout and the travelled/ahead
route-line split update live throughout, same as they would on real GPS.

**Pacing the jam beat.** At 12 km/h under 20x compression the vehicle covers
only ~17 m per 250 ms tick, so every 100 m of slowdown zone costs ~1.5 s of
real time. A 900 m radius therefore meant 1800 m of crawling — about **27
seconds** stuck at walking pace, starting exactly halfway, which measured out
as most of the run and read as "the demo stopped halfway and isn't moving".
The radius is 350 m (`min(350, total * 0.05)`), giving a ~10 s beat. Worth
re-measuring rather than eyeballing if these constants ever change: step the
animation tick by hand (capture the 250 ms `setInterval` callback and call it
in a loop) so wall-clock throttling can't distort the result.

**Arrival is announced.** Reaching the destination used to just clear the
interval and go quiet — the vehicle stopped, but the badge still said a drive
was in progress and the drawer button still said "Stop demo", so a *completed*
run was visually identical to a *frozen* one. The badge now flips to a green
**ARRIVED**, the trip bar reads "Arrived", and the event log records it.
Deliberately does not tear the run down (no `clearRoute`/`exitNavMode`): the
arrival view is worth keeping on screen, and Stop demo / EXIT already do a
full reset.

The simulated vehicle drives at realistic speed in *simulated* time, with
simulated time running 20x faster than real time so a district-scale drive fits
in a short clip. The speed readout therefore shows the vehicle's real speed
(~60 km/h), not the rate the marker crosses the screen — the on-screen
**"x20 playback"** badge makes that compression explicit.

## Swapping in the real model (for the modeling teammates)

`data/risk_lookup.geojson` is currently generated by `data/build_risk_lookup.py`
from the raw dataset (fatal-crash rate by district x time-of-day bucket — a
real but simple aggregate, not the trained classifier). Replace it with the
model's output in the same schema and nothing else in the app needs to change:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": { "type": "Point", "coordinates": [lng, lat] },
      "properties": {
        "district": "Kuantan",
        "total_crashes": 366,
        "radius_km": 12.3,
        "risk_by_time": {
          "morning":   { "score": 0.0-1.0, "n": <int>, "top_factors": ["..."], "low_confidence": bool },
          "afternoon": { "...": "..." },
          "evening":   { "...": "..." },
          "night":     { "...": "..." }
        }
      }
    }
  ]
}
```

`score` is treated as a 0-1 risk level; anything >= 0.5 gets flagged as a
proximity-alert zone (see `RISK_THRESHOLD_HIGH` in `js/risk.js`). If the model
works at a finer grain than district (e.g. road segment), more Features can
just be added — the renderer doesn't assume exactly 11.

## Architecture

Plain HTML/CSS/JS (ES modules), no build step, no backend, no accounts:

- `js/map.js` — Leaflet map (CARTO Dark Matter, no-labels tiles), live GPS position + speed + heading (directional chevron marker), Pahang mask (visual only — see note below), a low-accuracy fallback + stall detection for unreliable GPS (see note below)
- `js/risk.js` — loads/renders the historical risk overlay (real district polygons, weighted relative to the dataset's baseline rate so only above-average districts stand out), proximity checks
- `js/routing.js` — OSRM (public demo server) driving directions + reroute, a live "on the way" progress view (remaining distance/ETA, travelled/ahead route-line split), and a turn-by-turn banner (next maneuver + distance + street, from OSRM's `steps`) — all driven off every position update
- `js/bots.js` — simulated traffic + jam clustering
- `js/alerts.js` — proximity alert banner, HUD stat readouts, wires "reroute" into routing.js
- `js/eventlog.js` — the on-screen scrolling activity log
- `js/demo.js` — scripted demo-mode scenario for recording
- `js/app.js` — wires it all together

**"Pahang only" is a visual mask, not a navigation lock.** An earlier version
also called `map.setMaxBounds()` to make it a hard restriction — but that
clamps every pan, including the ones a real device's GPS drives. Tested by
mocking geolocation to a real position outside Pahang (Singapore): the marker
still rendered in the DOM at its true coordinates, 5000+ px below the visible
viewport, because the viewport itself couldn't scroll there. Removed
`setMaxBounds()` so the map can always follow the device's real position —
"Pahang is the focus" stays true visually (everywhere else reads dimmed) but
never breaks the app for anyone testing, developing, or eventually using it
from outside the state.

**GPS reliability: low-accuracy fallback + stall detection.** Reported
symptom: "GPS stopped after several seconds" with zero on-screen explanation.
Root cause was a genuine bug: a `TIMEOUT` error from `watchPosition()` just
`return`ed, forever, no matter how many times it repeated — reasonable for
one slow fix (the browser keeps retrying on its own), wrong for a device that
*never* gets one. `enableHighAccuracy: true` commonly can't get a fix at all
on hardware without a real GPS chip (most laptops), which times out
repeatedly rather than falling back on its own. Fixed with two changes in
`map.js`: after 3 consecutive timeouts, retry once with
`enableHighAccuracy: false` (WiFi/cell-based — less precise, far more likely
to actually succeed); after 6, treat it as a real failure and update the
status pill (always; a banner too, but *only* if no fix was ever obtained —
if one was, `State.userPos` is non-null and `alerts.js`'s own evaluate loop
is already running, so a banner shown here would just get raced and
overwritten within 2 seconds). Testing this surfaced a second, previously
invisible bug: `setStatusPill("live")` only ever ran inside the `if
(firstFix)` branch, so once *any* fix had ever arrived, no later fix could
flip the pill back to "LIVE" after a stall knocked it to "NO GPS" — it just
stayed stuck. Moved that call (and the geo-error-banner cleanup) out to run
on every successful fix, not just the first. Verified by mocking
`watchPosition` to fire real `TIMEOUT` errors on demand: confirmed the
fallback re-subscribes with `enableHighAccuracy: false` at exactly 3, the
pill escalates at exactly 6, a stall-after-a-real-fix correctly updates only
the pill (no banner race), and a fresh fix after a stall correctly recovers
the pill to "LIVE".

**Geodata:** `data/pahang_state.geojson` and `data/pahang_districts.geojson` are
real DOSM (Department of Statistics Malaysia) administrative boundaries,
fetched from their public [data-open](https://github.com/dosm-malaysia/data-open)
repo and filtered to Pahang. These are what the map mask and the risk-zone
shapes are drawn from — `risk_lookup.geojson` supplies only the per-district
*scores*, joined to these shapes by district name at render time. [Turf.js](https://turfjs.org/)
(loaded via CDN, same as Leaflet) handles the point-in-polygon math for real
district shapes instead of the circle-distance approximation used originally.

**Layout:** Waze-density, not "a whole map." Two small always-visible chrome
pieces — `#mini-topbar` (brand + LIVE/playback status + one menu button) and
`#bottom-stack` (alert banner, active-route trip bar, speed readout) — plus
everything else (stats, time-of-day toggle, demo/assistant controls,
destination search, event log, legend) behind a single `#detail-drawer`
bottom sheet opened by the menu button. The map stays dominant instead of
competing with permanently-docked panels.

Both chrome clusters flow in normal document order inside one
absolutely-positioned container (`#mini-topbar`, `#bottom-stack`), rather than
each band being independently `position: absolute` with a hand-tuned pixel
offset from the next. The latter looked fine until any one band's height
changed (HUD stats wrapping to two lines on a phone, the playback badge
appearing) and the next band silently overlapped it. This bit twice during the
drawer restructure itself: the alert banner was left as a top-level sibling
instead of actually living inside `#bottom-stack`'s flow (so it rendered at
`top:0`, on top of the topbar), and `#bottom-stack`'s bottom clearance assumed
`#disclosure-footer` fits on one line — it doesn't, at almost any realistic
viewport width, since the disclosure sentence is long enough to need ~900px to
avoid wrapping. Both fixed; verified overlap-free via bounding-rect checks (not
just eyeballing a screenshot) at 375px and 1280px widths. Worth keeping in mind
before adding new floating panels: a screenshot can look fine while still
having a few pixels of real overlap, so measure, don't just look.

**Live "on the way" progress view.** The trip-bar doesn't just show the
planned total anymore — `routing.js` subscribes to every position update
(`onUserMove` from `map.js`, which real GPS and demo mode both already funnel
through via `updateUserPosition()`, so this needed zero changes in either) and
recomputes remaining distance/ETA plus a travelled/ahead split on the route
line itself (dimmed behind you, bright ahead), the same idea as any
turn-by-turn app. Progress is tracked by nearest-vertex distance along the
route, not GPS-index guessing, using the same "good enough for a district-scale
demo drive, not a tight loop" trade-off already made elsewhere (the reroute
via-point heuristic). One real bug this surfaced: `rerouteAvoiding` is async
(a real OSRM round-trip), and in demo mode the simulated vehicle keeps
animating along the *old* route for the full duration of that call -- seeding
the first post-reroute progress reading from `State.userPos` used a position
that was already stale by the time the new route was drawn, showing a
one-tick wrong-then-self-correcting number. Fixed by seeding from the new
route's own first coordinate instead, which is correct regardless of timing.

**Navigation mode (START / EXIT).** Planning a route frames the *whole* route
(`fitBounds`), which is right for choosing one and wrong for driving it —
there was no way into the close-up, vehicle-following view the turn banner is
designed for, reported as "idk how to enter the navigation mode". The trip bar
now carries a **START** button; **EXIT** returns to the whole-route overview.

A first version of START only zoomed in, which was correctly reported back as
"it only like enlarge where am I instead of showing like in waze" — zooming on
the vehicle magnifies where you *are*, while a nav view shows where you're
*going*. Two things actually produce that framing, and nav mode now does both:

- **Heading-up rotation.** Leaflet has no native map rotation, so the map
  *container* is CSS-rotated by `-heading` (Leaflet transforms inner panes, never
  the container, so the two don't fight). A rotated rectangle leaves empty
  corners, so in nav mode the container becomes a square of `150vmax` centred on
  the viewport — the viewport diagonal is at most `√2 × vmax`, so that always
  covers it (verified empirically at 9 angles: worst-case corner 445 px against
  609 px available). `#app` clips the overflow, and Leaflet is told to
  `invalidateSize()` since it caches container dimensions. The direction-of-travel
  chevron needs no change: it already rotates by `+heading` inside a container
  rotating by `-heading`, so it nets out pointing up the screen.
- **Look-ahead centring.** The camera centres on a point `LOOK_AHEAD_M` (340 m)
  *ahead* of the vehicle along its heading rather than on the vehicle, so the
  road you're about to drive fills the screen and the vehicle rides low
  (measured 136 px below centre at desktop, 107 px at phone size).

Rotation breaks two things that have to be fixed alongside it. First,
`e.latlng` from a map click. Leaflet derives it via `getBoundingClientRect()`,
which for a rotated element is the axis-aligned bounding box, not the real
untransformed box — so tap-to-set-destination would silently return the wrong
point. `latLngFromScreen()` rotates the click back by the inverse angle about
the container centre (a fixed point under rotation) to recover the true
container point; verified by round-trip (screen → latlng → screen) to
sub-pixel accuracy both rotated and unrotated, and to be bit-identical to
`e.latlng` when unrotated.

Second, every tooltip's text — district-risk popups, the destination pin's
road name — rotated right along with the map, reading upside-down whenever
you're heading roughly south. Can't fix this with a CSS rule on the tooltip
element itself: Leaflet already owns its `transform` (inline `translate3d` for
positioning), so a competing rule would lose. Each tooltip's real content is
wrapped in its own inner `<div class="tt-upright">`, which counter-rotates via
a `--map-rotation` CSS custom property set on `#app` (a stable ancestor the
rotation never touches — custom properties inherit straight through a
transformed element, since `transform` is paint-time, not a cascade barrier).
Verified: read the map's actual rotation and a live tooltip's counter-rotation
back via `getComputedStyle`, summed to ≈0° regardless of heading.

First version of this only counter-rotated the TEXT — the bubble's actual
background/border/shadow were still declared on the outer `.leaflet-tooltip`
element, which never got a counter-rotation (that's the element Leaflet's own
transform owns, the whole reason the inner wrapper exists), so it stayed in
the rotated orientation while the text moved: "the text is fixed, its just the
box is still in place." Fixed by moving all the visible chrome onto
`.tt-upright` itself — the outer element is now a fully transparent
positioning shell with no chrome of its own, so box and text rotate together
as one unit, verified by reading both elements' actual background colour and
transform matrix and confirming the rotated matrix sits on the same element
as the background. The directional arrow (Leaflet's `::before` pointer) is
hidden while nav mode is rotating things, rather than trying to reposition a
fixed-direction pointer for every possible angle — it still shows normally
outside nav mode.
Demo mode enters it automatically, since that close-up view *is* the shot for
the recording. START also handles the case that made it look broken —
"after I pressed start, it is not moving at all": on a stationary device
(testing at a desk) there is simply nothing for the camera to follow, so if a
route is planned and the device isn't actually moving, START drives that route
in simulation, badged **SIMULATED DRIVE · ×20** so it is never mistaken for a
real trip. It drives *the route you planned* (`startDemoMode({useExistingRoute:
true})`), not a demo destination of its own — pressing "start navigating" and
being taken somewhere you never asked for would be its own bug. EXIT only tears
that drive down if START is what started it, so it can't silently kill a demo
launched from the drawer. `State.navMode` also suppresses the two places that would
otherwise yank the camera back out mid-drive — `drawRouteLine`'s `fitBounds`
(which a reroute re-triggers) and `animateAlongPath`'s `setView(..., 13)`
(which the rerouted leg re-triggers). Clearing a route resets it, so the next
route planned still gets the overview framing.

One robustness bug found while testing this: Leaflet's zoom/pan animations are
`requestAnimationFrame`-driven, and rAF is suspended while a tab isn't being
rendered — so `setView(..., {animate: true})` issued then silently never
applies *at all* (measured: zoom stayed 13 instead of 16, while the identical
call with `animate: false` landed immediately). For a one-shot view change
whose entire visible point is the resulting view, correctness can't depend on
an animation running, so `viewAnim()` animates only when `!document.hidden`.

**Turn-by-turn banner + directional marker.** Built with a real Waze
screenshot as a style reference — the two most distinctive, worth-borrowing
elements were the top-of-screen maneuver banner and the heading-rotated
vehicle marker, so those got built into this app's own dark-HUD look rather
than adopting Waze's light theme (kept: dark glass panels, cyan/amber accents,
Unicode-glyph iconography already used everywhere else; skipped: light map
tiles, and the report-a-hazard FAB, since that implies real crowdsourced
input this app doesn't have).

- **Marker:** the plain dot became a rotating chevron (`.user-heading`,
  layered outline+fill via `clip-path` since clipped shapes can't take a
  normal CSS border) driven by the device's real compass heading
  (`pos.coords.heading` from the Geolocation API) or, in demo mode, a bearing
  computed between consecutive simulated positions. Only updates on a real
  heading value — `null`/`NaN` (common when stationary) leaves the marker
  pointing the last known direction instead of snapping to north.
- **Turn banner:** `fetchRoutes()` now requests `steps=true` from OSRM and
  carries the maneuver list through every route (`State.route.steps`,
  including the via-point reroute fallback, which concatenates both legs'
  steps). A parallel cumulative-distance array per step
  (`State.route.stepStartM`) lets `updateTurnBanner()` convert "how far
  travelled" into "which step, how far to the next maneuver" the same way
  `updateRouteProgress()` already does for the whole route — real street
  names, a rotated arrow icon (mapped from OSRM's `modifier`), a roundabout
  icon, and a flag icon for arrival, hiding automatically once actually
  arrived. Lives in a new `#top-stack` wrapper alongside `#mini-topbar`,
  same natural-flow-container pattern as `#bottom-stack`, specifically to
  avoid repeating the hand-tuned-offset overlap bug from the original
  drawer restructure.
- Verified by walking a real 13-step OSRM route with `updateUserPosition()`
  calls at hand-picked cumulative distances (not just eyeballing a live
  drive): confirmed the banner picks the exact predicted next maneuver,
  distance, and street name at a mid-step position, then correctly shows the
  arrival flag near the destination and hides entirely once actually arrived.

**Testing note:** demo mode's `setInterval`-driven animation is subject to
Chrome's background-tab timer throttling whenever the Browser pane isn't
actually displayed/composited (`document.visibilityState` stays `"hidden"`
regardless of which tab is selected in that case) — surfaced here as an
apparently-frozen vehicle during a live jam/reroute regression check that
turned out to be a testing-environment artifact, not a code defect (confirmed
by manually calling `updateUserPosition()` directly, which worked instantly
with no exception). Doesn't affect real usage or the actual recording, where
the window is genuinely visible/focused — but worth remembering next time a
demo-mode check looks stalled: check `document.visibilityState` before
assuming the code broke.

## Known limitations (worth saying out loud, not hiding)

- OSRM's public demo server has no SLA/rate-limit guarantee — fine for a demo,
  not for production.
- Reroute logic uses OSRM's `alternatives` flag or a simple via-point nudge,
  not a true "avoid this polygon" routing profile (the public server doesn't
  support custom avoid-areas) — good enough to demo the concept, not a claim
  of production-grade routing.
