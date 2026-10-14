# REV Trip Planner — Neshan integration plan

## Goal
Add Neshan traffic-aware routing to the REV EV trip planner without breaking the current OpenStreetMap/OSRM + Open-Meteo fallback.

## Current baseline
- Public app: GitHub Pages, `trip.html`
- Existing route provider: OSRM (does not provide live traffic)
- Weather: Open-Meteo hourly forecast, sampled along route and used for wind/temperature/precipitation and energy estimates
- Backend: Cloudflare Worker(s); never put provider secrets in GitHub Pages JavaScript.

## Provider integration strategy
1. Keep OSRM as fallback and as an explicitly labelled "traffic-unaware estimate".
2. Once a Neshan API key and permitted endpoint/product are confirmed, proxy requests through a Cloudflare Worker.
3. Store the key as a Cloudflare Worker Secret (e.g. `NESHAN_API_KEY`); do not place it in `trip.html`, `admin.html`, `content.json`, or a public GitHub file.
4. Implement provider adapters for:
   - geocoding (address to coordinates), if included in the user's Neshan plan;
   - routing / directions (route geometry, distance, duration, alternatives);
   - distance matrix / ETA for candidate departure times, only if supported by the subscribed plan and terms.
5. Normalize provider responses into a small stable schema:
   `{provider, distanceMeters, durationSeconds, geometry, trafficAware, fetchedAt, alternatives?}`.
6. If Neshan is unavailable, rate-limited, not configured, or returns an error, gracefully use OSRM and clearly label that traffic is not included.
7. Cache equivalent routing requests briefly in the Worker to limit quota/cost. Validate coordinates and rate-limit public calls.

## Departure-time recommendation
- Do not claim live traffic for future departure times unless the provider explicitly supports traffic forecasts for the requested future time.
- Evaluate a configurable set of departure candidates (e.g. hourly over the next 6–12 hours, within forecast/provider coverage).
- For each candidate, estimate route duration using provider data that genuinely corresponds to that departure time. If Neshan only returns current traffic, label the result as a current-traffic baseline, not a future forecast.
- Fetch Open-Meteo hourly weather for route points at the candidate estimated arrival times. Calculate a transparent score from travel duration, precipitation probability, gusts, temperature-related HVAC load, and EV energy use.
- Return exactly one recommended departure time plus two or three reasons and data freshness. If traffic forecast data is unavailable, explicitly say that the choice is weather-and-duration-based, not traffic-forecast-optimized.
- Avoid unsafe recommendations that prioritize small time savings over severe weather warnings.

## User setup required later
- Register/obtain a Neshan developer API key and confirm which API products are enabled (routing, geocoding, distance matrix / traffic).
- Save the key as a Worker Secret named `NESHAN_API_KEY`.
- Confirm current Neshan documentation, quotas, endpoint details, pricing, and whether scheduled/future departure traffic estimates are supported before coding live calls.

## Acceptance tests
- No Neshan key: current planner still works with OSRM and weather.
- Valid Neshan key: traffic-aware route appears, with provider and retrieval time labelled.
- Neshan failure: graceful OSRM fallback with an explicit no-live-traffic warning.
- No API key appears in repository source or browser network request URLs from GitHub Pages.
- Departure recommendation always distinguishes current traffic from a genuine future traffic forecast.
