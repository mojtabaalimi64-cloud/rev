const SITE_ORIGIN = "https://mojtabaalimi64-cloud.github.io";
const REV_REFERER = SITE_ORIGIN + "/rev/";
const OVERPASS_SERVERS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];
const MAX_ROUTE_SAMPLES = 16;
const MAX_RADIUS_KM = 10;
const DEFAULT_RADIUS_KM = 5;
const UPSTREAM_TIMEOUT_MS = 7000;
const CACHE_MAX_ROWS = 5000;
const CACHE_MAX_AGE_DAYS = 180;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}
function corsHeaders(origin) {
  const allowed = !origin || origin === SITE_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowed ? (origin || SITE_ORIGIN) : "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}
function withCors(response, origin) {
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) h.set(k, v);
  return new Response(response.body, { status: response.status, headers: h });
}
function validPoint(p) {
  return Array.isArray(p) && p.length >= 2 &&
    Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])) &&
    Math.abs(Number(p[0])) <= 180 && Math.abs(Number(p[1])) <= 90;
}
function haversineKm(a, b) {
  const rad = x => x * Math.PI / 180;
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(x)));
}
function sampleCoordinates(coords, maxPoints = MAX_ROUTE_SAMPLES) {
  if (coords.length <= maxPoints) return coords;
  const cumulative = [0];
  for (let i = 1; i < coords.length; i++) {
    cumulative[i] = cumulative[i - 1] + haversineKm(coords[i - 1], coords[i]);
  }
  const total = cumulative[cumulative.length - 1];
  if (!Number.isFinite(total) || total <= 0) {
    return Array.from({ length: maxPoints }, (_, i) =>
      coords[Math.round(i * (coords.length - 1) / (maxPoints - 1))]);
  }
  const out = [];
  let seg = 1;
  for (let n = 0; n < maxPoints; n++) {
    const target = total * n / (maxPoints - 1);
    while (seg < cumulative.length - 1 && cumulative[seg] < target) seg++;
    const prev = seg - 1;
    const span = cumulative[seg] - cumulative[prev];
    const t = span ? (target - cumulative[prev]) / span : 0;
    out.push([
      coords[prev][0] + (coords[seg][0] - coords[prev][0]) * t,
      coords[prev][1] + (coords[seg][1] - coords[prev][1]) * t
    ]);
  }
  return out;
}
function stationId(raw) {
  const type = raw.type || "node";
  const osmId = raw.id ?? raw.source_id;
  if (osmId != null) return "osm:" + type + ":" + osmId;
  const lat = Number(raw.lat ?? raw.latitude ?? raw.center?.lat);
  const lon = Number(raw.lon ?? raw.longitude ?? raw.center?.lon);
  return "coord:" + lat.toFixed(5) + ":" + lon.toFixed(5);
}
function normalizeOsm(raw) {
  const tags = raw.tags || {};
  const lat = Number(raw.lat ?? raw.center?.lat ?? raw.latitude);
  const lon = Number(raw.lon ?? raw.center?.lon ?? raw.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const powerRaw = tags["socket:output"] || tags["charging_station:output"] || tags.power;
  const match = typeof powerRaw === "string" ? powerRaw.match(/[0-9]+(?:\.[0-9]+)?/) : null;
  const power = match ? Number(match[0]) : (Number.isFinite(Number(raw.power_kw)) ? Number(raw.power_kw) : null);
  const connectors = Object.keys(tags)
    .filter(k => /^(socket:|socket_type:|connector:)/.test(k))
    .map(k => k + "=" + tags[k]);
  const id = stationId(raw);
  const name = tags.name || tags.operator || "ایستگاه شارژ ثبت‌شده در OpenStreetMap";
  const address = [
    tags["addr:street"], tags["addr:housenumber"],
    tags["addr:city"] || tags["addr:town"] || tags["addr:village"]
  ].filter(Boolean).join(" ");
  return {
    id,
    source_id: String(raw.id ?? id),
    name,
    address,
    latitude: lat,
    longitude: lon,
    operator: tags.operator || "",
    status: tags["charging_station:status"] || "unknown",
    power_kw: Number.isFinite(power) && power > 0 ? power : null,
    connectors,
    source_url: "https://www.openstreetmap.org/" + (raw.type || "node") + "/" + (raw.id ?? ""),
    source: "OpenStreetMap",
    updated_at: new Date().toISOString(),
    raw_json: JSON.stringify({ type: raw.type || "node", id: raw.id, tags })
  };
}
function queryFor(coords, radiusKm) {
  const radiusM = Math.round(Math.min(MAX_RADIUS_KM, Math.max(1, radiusKm)) * 1000);
  const parts = coords.map(([lon, lat]) =>
    'nwr(around:' + radiusM + ',' + lat.toFixed(5) + ',' + lon.toFixed(5) + ')["amenity"="charging_station"];'
  );
  return "[out:json][timeout:6];(" + parts.join("") + ");out center tags;";
}
async function fetchOverpass(query) {
  let lastError = "سرویس نقشه پاسخ نداد.";
  for (const endpoint of OVERPASS_SERVERS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "Accept": "application/json",
          "User-Agent": "REV-EV-TripPlanner/1.4 (+https://mojtabaalimi64-cloud.github.io/rev/)",
          "Referer": REV_REFERER
        },
        body: "data=" + encodeURIComponent(query),
        signal: controller.signal
      });
      if (response.status === 429) {
        // Respect provider rate limits; do not try other public endpoints to bypass a 429.
        const retry = response.headers.get("Retry-After") || "60";
        throw Object.assign(new Error("سرویس نقشه محدودیت درخواست اعمال کرده (HTTP 429)."), {
          rateLimited: true, retryAfter: retry
        });
      }
      if (!response.ok) {
        lastError = endpoint + ": HTTP " + response.status;
        continue;
      }
      const payload = await response.json();
      if (!Array.isArray(payload.elements)) {
        lastError = endpoint + ": پاسخ نامعتبر";
        continue;
      }
      return payload.elements;
    } catch (e) {
      if (e.rateLimited) throw e;
      lastError = endpoint + ": " + (e.name === "AbortError" ? "مهلت پاسخ تمام شد" : (e.message || "خطای شبکه"));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError);
}
async function saveStations(db, stations) {
  if (!db || !stations.length) return;
  const now = new Date().toISOString();
  const statements = stations.map(s => db.prepare(`
    INSERT INTO online_station_cache
      (id, source_id, name, address, latitude, longitude, operator, status, power_kw,
       connectors_json, source_url, source, first_seen_at, last_seen_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source_id=excluded.source_id,
      name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE online_station_cache.name END,
      address=CASE WHEN excluded.address<>'' THEN excluded.address ELSE online_station_cache.address END,
      latitude=excluded.latitude, longitude=excluded.longitude,
      operator=CASE WHEN excluded.operator<>'' THEN excluded.operator ELSE online_station_cache.operator END,
      status=CASE WHEN excluded.status<>'' THEN excluded.status ELSE online_station_cache.status END,
      power_kw=COALESCE(excluded.power_kw, online_station_cache.power_kw),
      connectors_json=CASE WHEN excluded.connectors_json<>'[]' THEN excluded.connectors_json ELSE online_station_cache.connectors_json END,
      source_url=COALESCE(excluded.source_url, online_station_cache.source_url),
      last_seen_at=excluded.last_seen_at,
      raw_json=COALESCE(excluded.raw_json, online_station_cache.raw_json)
  `).bind(
    s.id, s.source_id, s.name || "", s.address || "", s.latitude, s.longitude,
    s.operator || "", s.status || "unknown", s.power_kw,
    JSON.stringify(s.connectors || []), s.source_url || "", s.source || "OpenStreetMap",
    now, now, s.raw_json || null
  ));
  // D1 batch avoids a separate network round trip per station.
  for (let i = 0; i < statements.length; i += 80) {
    await db.batch(statements.slice(i, i + 80));
  }
}
function distanceToSamplesKm(station, coords) {
  let best = Infinity;
  for (const p of coords) best = Math.min(best, haversineKm([station.longitude, station.latitude], p));
  return best;
}
function fromDbRow(row) {
  let connectors = [];
  try { connectors = JSON.parse(row.connectors_json || "[]"); } catch {}
  return {
    id: row.id, source_id: row.source_id, name: row.name, address: row.address,
    latitude: row.latitude, longitude: row.longitude, operator: row.operator || "",
    status: row.status || "unknown", power_kw: row.power_kw,
    connectors, source_url: row.source_url || "",
    source: row.source || "OpenStreetMap", updated_at: row.last_seen_at || row.first_seen_at,
    cached_at: row.last_seen_at || row.first_seen_at
  };
}
async function readCachedStations(db, coords, radiusKm) {
  if (!db) return [];
  const result = await db.prepare(
    "SELECT * FROM online_station_cache ORDER BY last_seen_at DESC LIMIT ?"
  ).bind(CACHE_MAX_ROWS).all();
  const rows = result.results || [];
  const maxDistance = Math.min(MAX_RADIUS_KM, Math.max(1, radiusKm)) + 3;
  return rows.map(fromDbRow)
    .filter(s => distanceToSamplesKm(s, coords) <= maxDistance)
    .map(s => ({ ...s, _distance: distanceToSamplesKm(s, coords) }))
    .sort((a, b) => a._distance - b._distance)
    .map(({ _distance, ...s }) => s);
}
function ageInfo(stations) {
  const times = stations.map(s => Date.parse(s.updated_at || s.cached_at || "")).filter(Number.isFinite);
  const newest = times.length ? Math.max(...times) : 0;
  const stale = !newest || (Date.now() - newest) > CACHE_MAX_AGE_DAYS * 86400000;
  return { newest: newest ? new Date(newest).toISOString() : null, stale };
}
async function handleRequest(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin") || "";
  if (origin && origin !== SITE_ORIGIN) return json({ success: false, error: "Origin not allowed" }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (url.pathname === "/" || url.pathname === "/health") {
    return json({ success: true, status: "ready", cache: "D1", time: new Date().toISOString() });
  }
  if (url.pathname !== "/api/online-stations") return json({ success: false, error: "Not found" }, 404);
  if (request.method !== "POST") return json({ success: false, error: "Use POST" }, 405);

  let body;
  try { body = await request.json(); }
  catch { return json({ success: false, error: "بدنه درخواست JSON معتبر نیست." }, 400); }
  if (!Array.isArray(body.coords) || !body.coords.length || !body.coords.every(validPoint)) {
    return json({ success: false, error: "مختصات مسیر معتبر نیست." }, 400);
  }
  const coords = sampleCoordinates(body.coords.map(p => [Number(p[0]), Number(p[1])]), MAX_ROUTE_SAMPLES);
  const radiusKm = Math.min(MAX_RADIUS_KM, Math.max(1, Number(body.radiusKm) || DEFAULT_RADIUS_KM));
  const db = env.DB;
  if (!db) return json({ success: false, error: "اتصال D1 با نام DB به Worker متصل نشده است." }, 500);

  try {
    const query = queryFor(coords, radiusKm);
    const elements = await fetchOverpass(query);
    const unique = new Map();
    for (const raw of elements) {
      const s = normalizeOsm(raw);
      if (s) unique.set(s.id, s);
    }
    const liveStations = [...unique.values()];
    await saveStations(db, liveStations);
    return json({
      success: true, source: "OpenStreetMap", cached: false, stale: false,
      count: liveStations.length, cached_at: new Date().toISOString(), data: liveStations
    });
  } catch (error) {
    try {
      const cached = await readCachedStations(db, coords, radiusKm);
      if (cached.length) {
        const age = ageInfo(cached);
        return json({
          success: true, source: "REV D1 cache", cached: true, stale: age.stale,
          cached_at: age.newest, count: cached.length,
          warning: error.message || "منبع آنلاین موقتاً در دسترس نیست.",
          retry_after: error.retryAfter || null, data: cached
        });
      }
    } catch (cacheError) {
      return json({
        success: false,
        error: "منبع آنلاین در دسترس نیست و خواندن کش D1 هم ناموفق بود: " + (cacheError.message || "خطای دیتابیس")
      }, 502);
    }
    return json({
      success: false,
      error: (error.message || "سرویس نقشه موقتاً در دسترس نیست.") +
        " هنوز ایستگاه ذخیره‌شده‌ای نزدیک این مسیر پیدا نشد.",
      retry_after: error.retryAfter || null,
      data: []
    }, 502);
  }
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    try {
      return withCors(await handleRequest(request, env), origin);
    } catch (error) {
      return withCors(json({ success: false, error: error.message || "خطای داخلی Worker" }, 500), origin);
    }
  }
};
