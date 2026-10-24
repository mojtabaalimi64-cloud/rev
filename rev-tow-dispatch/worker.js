/**
 * REV Tow Dispatch — standalone Cloudflare Worker
 *
 * What it does (matches REV services page + dispatch plan):
 *  1. Customer submits a tow request (POST /api/tow/request)
 *  2. Worker finds registered drivers whose radius (50–100 km) covers the
 *     request location, ranks them: nearest first, but in a "crowded" area
 *     (another driver within 15 km of the nearest) the highest-scored driver
 *     in that band goes first.
 *  3. The top driver gets the offer; drivers poll GET /api/driver/offers.
 *  4. If a driver rejects or ACCEPT_TIMEOUT_MIN passes with no response,
 *     the offer expires lazily (on the next poll/status check) and moves to
 *     the next driver. When nobody is left: status "در انتظار اپراتور".
 *  5. A minimal driver web page is served at /driver (token login, accept/
 *     reject buttons, GPS heartbeat).
 *
 * Setup (no source access needed — create a NEW worker in the dashboard):
 *  - Workers & Pages → Create → paste this file as worker.js → Deploy
 *  - Bindings → D1 database → variable name TOW_DB → database rev-db
 *  - Settings → Variables → Secret: ADMIN_KEY = <random string>
 *  - Note the worker URL, e.g. https://rev-tow-dispatch.<sub>.workers.dev
 *
 * Limits of this MVP (honest): no push notifications — drivers poll every
 * ~25 s from the /driver page; customer status via polling too; no D1, KV
 * only (fine for the expected volume).
 */

// ---------- tunables ----------
const ACCEPT_TIMEOUT_MIN = 3;      // driver has this long to accept
const DRIVER_STALE_MIN = 30;       // no heartbeat → driver not dispatchable
const CROWD_BAND_KM = 15;          // "crowded area" distance band
const RADIUS_MIN = 50, RADIUS_MAX = 100, RADIUS_DEFAULT = 80;
const REQ_LIMIT_PER_HOUR = 5;      // per phone number

const SITE_ORIGINS = [
  "https://mojtabaalimi64-cloud.github.io",
  "http://localhost:8000",
];

// ---------- pure helpers (exported for tests) ----------
export function haversineKm(a, b) {
  const R = 6371, dLa = (b.lat - a.lat) * Math.PI / 180,
        dLo = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function clampRadius(r) {
  const n = Number(r);
  if (!isFinite(n)) return RADIUS_DEFAULT;
  return Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, n));
}

export function validPhone(p) {
  return /^09\d{9}$/.test(String(p || "").trim());
}

/**
 * Rank dispatch candidates.
 * drivers: [{id, lat, lng, radius, score, lastSeen, active}]
 * Rule: nearest first; but if drivers are "crowded" (within CROWD_BAND_KM
 * of the nearest), the highest score in that band goes first.
 */
export function rankDrivers(drivers, point, skippedIds = []) {
  const skipped = new Set(skippedIds);
  const cands = drivers
    .filter(d => d.active !== false && d.lat != null && d.lng != null && !skipped.has(d.id))
    .map(d => ({ d, dist: haversineKm(point, { lat: d.lat, lng: d.lng }) }))
    .filter(x => x.dist <= clampRadius(x.d.radius))
    .sort((a, b) => a.dist - b.dist);
  if (!cands.length) return [];
  const band = cands.filter(x => x.dist <= cands[0].dist + CROWD_BAND_KM)
                    .sort((a, b) => (b.d.score || 0) - (a.d.score || 0) || a.dist - b.dist);
  const rest = cands.filter(x => x.dist > cands[0].dist + CROWD_BAND_KM);
  return [...band, ...rest].map(x => ({ driver: x.d, distKm: Math.round(x.dist * 10) / 10 }));
}

// ---------- http helpers ----------
function json(data, status = 200, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors },
  });
}
function corsHeaders(req) {
  const origin = req.headers.get("origin") || "";
  const allow = SITE_ORIGINS.includes(origin) ? origin : SITE_ORIGINS[0];
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-admin-key",
  };
}
async function body(req) {
  try { return await req.json(); } catch { return {}; }
}
const now = () => Date.now();
function randomHex(bytes = 16) {
  const data = new Uint8Array(bytes); crypto.getRandomValues(data);
  return Array.from(data, x => x.toString(16).padStart(2, "0")).join("");
}
async function hashDriverPassword(password, saltHex, iterations = 100000) {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g) || [], x => parseInt(x, 16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return Array.from(new Uint8Array(bits), x => x.toString(16).padStart(2, "0")).join("");
}
async function setDriverPassword(d, password) {
  d.passwordSalt = randomHex(16);
  d.passwordIterations = 100000;
  d.passwordHash = await hashDriverPassword(password, d.passwordSalt, d.passwordIterations);
  d.passwordUpdatedAt = now();
}
function makeTempPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const bytes = new Uint8Array(14); crypto.getRandomValues(bytes);
  return Array.from(bytes, x => alphabet[x % alphabet.length]).join("");
}

// Primary storage: Cloudflare D1. Routine application operations do not use KV.
async function storeGet(env, key) {
  const row = await env.TOW_DB.prepare(
    "SELECT value, expires_at FROM rev_tow_kv WHERE key = ?"
  ).bind(String(key)).first();
  if (!row) return null;
  if (row.expires_at != null && Number(row.expires_at) <= now()) {
    await storeDelete(env, key);
    return null;
  }
  return row.value == null ? null : String(row.value);
}
async function storePut(env, key, value, options = {}) {
  const ttl = Number(options && options.expirationTtl);
  const expiresAt = Number.isFinite(ttl) && ttl > 0 ? now() + ttl * 1000 : null;
  await env.TOW_DB.prepare(
    "INSERT INTO rev_tow_kv (key, value, expires_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at"
  ).bind(String(key), String(value), expiresAt).run();
}
async function storeDelete(env, key) {
  await env.TOW_DB.prepare("DELETE FROM rev_tow_kv WHERE key = ?").bind(String(key)).run();
}
async function storeList(env, options = {}) {
  const prefix = String(options.prefix || "");
  const cursor = typeof options.cursor === "string" ? options.cursor : "";
  const rows = await env.TOW_DB.prepare(
    "SELECT key FROM rev_tow_kv WHERE key LIKE ? AND key > ? ORDER BY key LIMIT 1000"
  ).bind(prefix + "%", cursor).all();
  const keys = (rows.results || []).map(row => ({ name: row.key }));
  const complete = keys.length < 1000;
  return { keys, list_complete: complete, cursor: complete ? undefined : keys[keys.length - 1].name };
}

// ---------- storage ----------
const kDriver = id => `driver:${id}`;
const kReq = id => `req:${id}`;
const kOffer = reqId => `offer:${reqId}`;
const kRate = phone => `rate:${phone}`;

async function getDriver(env, id) {
  const raw = await storeGet(env, kDriver(id));
  return raw ? JSON.parse(raw) : null;
}
async function saveDriver(env, d) {
  const key = kDriver(d.id); await storePut(env, key, JSON.stringify(d));
  await addIndexedName(env, "driver:", key);
}
function normStats(d) {
  if (!d.stats || typeof d.stats !== "object") d.stats = { accepted: 0, completed: 0, rejected: 0, missed: 0 };
  for (const k of ["accepted", "completed", "rejected", "missed"]) if (!Number.isFinite(d.stats[k])) d.stats[k] = 0;
  return d;
}
async function indexedNames(env, prefix) {
  const indexKey = "_index:" + prefix;
  const progressKey = "_index-progress:" + prefix;
  const saved = await storeGet(env, indexKey);
  if (saved) { try { const a = JSON.parse(saved); if (Array.isArray(a)) return a.filter(x => typeof x === "string"); } catch {} }

  // Build the index from D1 records; storeList paginates without KV.
  let progress = null;
  const rawProgress = await storeGet(env, progressKey);
  if (rawProgress) { try { progress = JSON.parse(rawProgress); } catch {} }
  const names = progress && Array.isArray(progress.names) ? progress.names.filter(x => typeof x === "string") : [];
  let cursor = progress && typeof progress.cursor === "string" ? progress.cursor : undefined;
  do {
    let page;
    try {
      page = await storeList(env, { prefix, cursor });
    } catch (e) {
      // Keep the checkpoint so a transient storage error can resume.
      await storePut(env, progressKey, JSON.stringify({ names, cursor: cursor || null, updatedAt: now() }));
      throw e;
    }
    for (const item of page.keys || []) if (!names.includes(item.name)) names.push(item.name);
    cursor = page.list_complete ? undefined : page.cursor;
    if (cursor) {
      await storePut(env, progressKey, JSON.stringify({ names, cursor, updatedAt: now() }));
    }
  } while (cursor);
  await storePut(env, indexKey, JSON.stringify(names));
  await storeDelete(env, progressKey);
  return names;
}
async function addIndexedName(env, prefix, name) {
  const names = await indexedNames(env, prefix);
  if (!names.includes(name)) { names.push(name); await storePut(env, "_index:" + prefix, JSON.stringify(names)); }
}
async function listRequests(env) {
  const out = [];
  for (const name of await indexedNames(env, "req:")) {
    const raw = await storeGet(env, name);
    if (raw) { try { out.push(JSON.parse(raw)); } catch { console.error("[rev-tow-dispatch] invalid request record", { key: name }); } }
  }
  return out;
}
async function getReq(env, id) {
  const raw = await storeGet(env, kReq(id));
  return raw ? JSON.parse(raw) : null;
}
async function saveReq(env, r) {
  const key = kReq(r.id); await storePut(env, key, JSON.stringify(r));
  await addIndexedName(env, "req:", key);
}
async function listDrivers(env) {
  const out = [];
  for (const name of await indexedNames(env, "driver:")) {
    const raw = await storeGet(env, name);
    if (raw) { try { out.push(JSON.parse(raw)); } catch { console.error("[rev-tow-dispatch] invalid driver record", { key: name }); } }
  }
  return out;
}
async function driverByToken(env, token) {
  if (!token) return null;
  const drivers = await listDrivers(env);
  return drivers.find(d => d.token === token && d.registrationRevoked !== true && d.registrationDeleted !== true) || null;
}

// ---------- dispatch core ----------
async function sweepOffer(env, reqId) {
  // Expire a stale offer and move to the next driver (lazy timeout).
  const raw = await storeGet(env, kOffer(reqId));
  if (!raw) return null;
  const offer = JSON.parse(raw);
  if (offer.expiresAt > now()) return offer; // still live
  await storeDelete(env, kOffer(reqId));
  const req = await getReq(env, reqId);
  if (!req || req.status === "لغو شد" || req.status === "انجام شد") return null;
  req.skipped = [...(req.skipped || []), offer.driverId];
  req.skippedWhy = { ...(req.skippedWhy || {}), [offer.driverId]: "timeout" };
  req.log.push({ t: now(), ev: `راننده ${offer.driverId} در ${ACCEPT_TIMEOUT_MIN} دقیقه پاسخ نداد — ارجاع به نفر بعدی` });
  await saveReq(env, req);
  return await dispatchToNext(env, req);
}

async function releasePendingOffersForDriver(env, driver, reason) {
  const offerNames = await indexedNames(env, "offer:");
  for (const itemName of offerNames) {
    const item = { name: itemName };
    const raw = await storeGet(env, item.name);
    if (!raw) continue;
    const offer = JSON.parse(raw);
    if (offer.driverId !== driver.id) continue;
    await storeDelete(env, item.name);
    const r = await getReq(env, offer.reqId);
    if (!r || r.status === "لغو شد" || r.status === "انجام شد") continue;
    r.skipped = [...new Set([...(r.skipped || []), driver.id])];
    r.log.push({ t: now(), ev: `راننده ${driver.name} ${reason} — درخواست به راننده بعدی ارجاع شد` });
    await saveReq(env, r);
    await dispatchToNext(env, r);
  }
}

async function dispatchToNext(env, req) {
  if (!req.gps) {
    req.status = "در انتظار اپراتور";
    req.log.push({ t: now(), ev: "بدون مختصات GPS — ارجاع به اپراتور" });
    await saveReq(env, req);
    return null;
  }
  const drivers = (await listDrivers(env)).filter(d =>
    d.active !== false && d.onShift === true && d.approved === true && d.lastSeen && now() - d.lastSeen < DRIVER_STALE_MIN * 60 * 1000);
  const ranked = rankDrivers(drivers, req.gps, req.skipped || []);
  if (!ranked.length) {
    req.status = "در انتظار اپراتور";
    req.log.push({ t: now(), ev: "راننده‌ای در شعاع پوشش یافت نشد — ارجاع به اپراتور" });
    await saveReq(env, req);
    return null;
  }
  const pick = ranked[0];
  const offer = {
    reqId: req.id, driverId: pick.driver.id,
    at: now(), expiresAt: now() + ACCEPT_TIMEOUT_MIN * 60 * 1000, state: "pending",
  };
  await storePut(env, kOffer(req.id), JSON.stringify(offer));
  await addIndexedName(env, "offer:", kOffer(req.id));
  req.status = "در انتظار پذیرش راننده";
  req.currentOffer = { driverId: pick.driver.id, distKm: pick.distKm, expiresAt: offer.expiresAt };
  req.log.push({ t: now(), ev: `ارسال به راننده ${pick.driver.name} (${pick.distKm} km)` });
  await saveReq(env, req);
  return offer;
}

// ---------- routes ----------
async function handle(req, env, cors) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (method === "OPTIONS") return new Response(null, { headers: cors });

  // health
  if (path === "/" && method === "GET")
    return json({ ok: true, service: "rev-tow-dispatch" }, 200, cors);

  // driver web page
  if (path === "/driver" && method === "GET")
    return new Response(DRIVER_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });

  // ---- public support contact ----
  if (path === "/api/support" && method === "GET") {
    const phone = String(await storeGet(env, "settings:support_phone") || "").trim();
    return json({ ok: true, phone }, 200, cors);
  }

  // ---- customer: create tow request ----
  if (path === "/api/tow/request" && method === "POST") {
    const b = await body(req);
    if (!b.name || String(b.name).trim().length < 2) return json({ ok: false, err: "نام معتبر نیست" }, 400, cors);
    if (!validPhone(b.phone)) return json({ ok: false, err: "شماره موبایل معتبر نیست" }, 400, cors);
    // simple rate limit
    const rk = kRate(b.phone.trim());
    const n = Number(await storeGet(env, rk) || 0);
    if (n >= REQ_LIMIT_PER_HOUR) return json({ ok: false, err: "محدودیت ثبت درخواست" }, 429, cors);
    await storePut(env, rk, String(n + 1), { expirationTtl: 3600 });

    const id = "TW-" + Math.random().toString(36).slice(2, 8).toUpperCase();
    const r = {
      id, ts: now(), status: "ثبت شد",
      name: String(b.name).trim(), phone: String(b.phone).trim(),
      car: String(b.car || "").trim(), problem: String(b.problem || "سایر"),
      loc: String(b.loc || "").trim(),
      gps: (b.gps && isFinite(b.gps.lat) && isFinite(b.gps.lng))
        ? { lat: Number(b.gps.lat), lng: Number(b.gps.lng) } : null,
      note: String(b.note || "").trim(),
      skipped: [], log: [{ t: now(), ev: "درخواست ثبت شد" }],
    };
    await saveReq(env, r);
    await dispatchToNext(env, r);
    const fresh = await getReq(env, id);
    return json({ ok: true, id, status: fresh.status }, 200, cors);
  }

  // ---- customer: status ----
  if (path === "/api/tow/status" && method === "GET") {
    const id = url.searchParams.get("id");
    if (!id) return json({ ok: false }, 400, cors);
    await sweepOffer(env, id); // lazy timeout
    const r = await getReq(env, id);
    if (!r) return json({ ok: false, err: "یافت نشد" }, 404, cors);
    let driver = null;
    if (r.assignedDriver) {
      const d = await getDriver(env, r.assignedDriver);
      if (d) driver = { name: d.name, phone: d.phone };
    }
    return json({ ok: true, id: r.id, status: r.status, driver, serviceCode: r.serviceCode || null, log: r.log.slice(-8) }, 200, cors);
  }

  // ---- customer: my requests (profile history by phone) ----
  if (path === "/api/tow/my-requests" && method === "GET") {
    const phone = String(url.searchParams.get("phone") || "").trim();
    if (!validPhone(phone)) return json({ ok: false, err: "شماره معتبر نیست" }, 400, cors);
    const mine = (await listRequests(env))
      .filter(r => r.phone === phone)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 30);
    const out = [];
    for (const r of mine) {
      let driver = null;
      if (r.assignedDriver) {
        const d = await getDriver(env, r.assignedDriver);
        if (d) driver = { name: d.name, phone: d.phone };
      }
      out.push({ id: r.id, ts: r.ts, status: r.status, problem: r.problem, car: r.car, loc: r.loc, gps: r.gps, note: r.note, serviceCode: r.serviceCode || null, driver });
    }
    return json({ ok: true, requests: out }, 200, cors);
  }

  // ---- customer: cancel ----
  if (path === "/api/tow/cancel" && method === "POST") {
    const b = await body(req);
    const r = await getReq(env, b.id);
    if (!r || r.phone !== String(b.phone || "").trim()) return json({ ok: false, err: "یافت نشد" }, 404, cors);
    if (r.status === "لغو شد") return json({ ok: true, status: r.status }, 200, cors);
    if (r.status === "انجام شد") return json({ ok: false, err: "مأموریت انجام شده قابل لغو نیست" }, 409, cors);
    const reason = String(b.reason || "بدون ذکر دلیل").trim().slice(0, 200);
    r.status = "لغو شد";
    r.cancelledAt = now();
    r.cancelledBy = "customer";
    r.cancelReason = reason;
    r.log.push({ t: now(), ev: "توسط درخواست‌کننده لغو شد: " + reason });
    await saveReq(env, r);
    await storeDelete(env, kOffer(r.id));
    return json({ ok: true }, 200, cors);
  }

  // ---- driver: register ----
  if (path === "/api/driver/register" && method === "POST") {
    const b = await body(req);
    if (!b.name || String(b.name).trim().length < 2) return json({ ok: false, err: "نام معتبر نیست" }, 400, cors);
    if (!validPhone(b.phone)) return json({ ok: false, err: "شماره موبایل معتبر نیست" }, 400, cors);
    if (typeof b.password !== "string" || b.password.length < 8 || b.password.length > 128)
      return json({ ok: false, err: "رمز عبور باید حداقل ۸ نویسه داشته باشد" }, 400, cors);
    if (!isFinite(Number(b.lat)) || !isFinite(Number(b.lng)))
      return json({ ok: false, err: "مختصات لازم است" }, 400, cors);
    const phone = String(b.phone).trim();
    // رکوردهای حذف‌شده/لغوشده در بایگانی می‌مانند؛ ثبت‌نام جدید با همان شماره پرونده قبلی را پاک نمی‌کند.
    const allExistingDrivers = await listDrivers(env);
    const dup = allExistingDrivers.find(x => x.phone === phone && x.registrationRevoked !== true && x.registrationDeleted !== true);
    if (dup) {
      return json({ ok: false, err: "این شماره قبلاً به‌عنوان راننده ثبت شده است؛ برای بازیابی دسترسی با مدیر REV در تماس باش." }, 409, cors);
    }
    const id = "DRV-" + Math.random().toString(36).slice(2, 8).toUpperCase();
    const token = crypto.randomUUID().replace(/-/g, "");
    const d = {
      id, name: String(b.name).trim(), phone,
      vehicle: String(b.vehicle || "").trim(), city: String(b.city || "").trim(), province: String(b.province || "").trim().slice(0, 80),
      lat: Number(b.lat), lng: Number(b.lng),
      radius: clampRadius(b.radius), score: 100, token,
      active: true, approved: false, created: now(), lastSeen: now(), missed: 0,
      stats: { accepted: 0, completed: 0, rejected: 0, missed: 0 },
    };
    await setDriverPassword(d, b.password);
    await saveDriver(env, d);
    return json({ ok: true, id, token, radius: d.radius, approved: false }, 200, cors);
  }

  // ---- driver: password login ----
  if (path === "/api/driver/login" && method === "POST") {
    const b = await body(req);
    if (!validPhone(b.phone) || typeof b.password !== "string" || b.password.length > 128)
      return json({ ok: false, err: "شماره موبایل یا رمز عبور نادرست است" }, 401, cors);
    const phone = String(b.phone).trim();
    const matchingDrivers = (await listDrivers(env)).filter(x => x.phone === phone);
    const d = matchingDrivers.find(x => x.registrationDeleted !== true && x.registrationRevoked !== true) || matchingDrivers[0] || null;
    if (d && d.registrationDeleted === true)
      return json({ ok: false, err: "ثبت‌نام قبلی حذف شده است؛ لطفاً دوباره ثبت‌نام کن." }, 403, cors);
    if (d && d.registrationRevoked === true)
      return json({ ok: false, err: "تأیید حساب قبلی لغو شده است؛ لطفاً دوباره ثبت‌نام کن." }, 403, cors);
    if (!d || !d.passwordSalt || !d.passwordHash)
      return json({ ok: false, err: "برای این حساب هنوز رمز تعریف نشده؛ از مدیر REV بخواه رمز موقت صادر کند." }, 401, cors);
    const candidate = await hashDriverPassword(b.password, d.passwordSalt, d.passwordIterations || 120000);
    if (candidate !== d.passwordHash) return json({ ok: false, err: "شماره موبایل یا رمز عبور نادرست است" }, 401, cors);
    if (d.active === false) return json({ ok: false, err: "حساب راننده توسط مدیریت غیرفعال شده است." }, 403, cors);
    d.token = crypto.randomUUID().replace(/-/g, "");
    d.lastSeen = now();
    await saveDriver(env, d);
    return json({ ok: true, id: d.id, token: d.token, name: d.name, phone: d.phone, radius: d.radius, approved: d.approved === true }, 200, cors);
  }

  // ---- driver: change own password ----
  if (path === "/api/driver/password/change" && method === "POST") {
    const b = await body(req);
    const d = await driverByToken(env, b.token);
    if (!d) return json({ ok: false, err: "نشست ورود معتبر نیست؛ دوباره وارد شو." }, 401, cors);
    if (typeof b.currentPassword !== "string" || typeof b.newPassword !== "string")
      return json({ ok: false, err: "رمز فعلی و رمز جدید را وارد کن." }, 400, cors);
    if (!d.passwordSalt || !d.passwordHash)
      return json({ ok: false, err: "برای این حساب رمز تعریف نشده؛ با مدیر تماس بگیر." }, 400, cors);
    if (b.newPassword.length < 8 || b.newPassword.length > 128)
      return json({ ok: false, err: "رمز جدید باید حداقل ۸ نویسه داشته باشد." }, 400, cors);
    if (b.currentPassword === b.newPassword)
      return json({ ok: false, err: "رمز جدید باید با رمز فعلی متفاوت باشد." }, 400, cors);
    const currentHash = await hashDriverPassword(b.currentPassword, d.passwordSalt, d.passwordIterations || 120000);
    if (currentHash !== d.passwordHash)
      return json({ ok: false, err: "رمز فعلی درست نیست." }, 401, cors);
    await setDriverPassword(d, b.newPassword);
    d.passwordMustChange = false;
    await saveDriver(env, d);
    return json({ ok: true, changedAt: d.passwordUpdatedAt }, 200, cors);
  }

  // ---- driver: start/end shift ----
  if (path === "/api/driver/shift" && method === "POST") {
    const b = await body(req);
    const d = await driverByToken(env, b.token);
    if (!d) return json({ ok: false, err: "توکن راننده معتبر نیست" }, 401, cors);
    if (b.onShift === true && (d.approved !== true || d.active === false))
      return json({ ok: false, err: "حساب راننده هنوز تأیید نشده یا توسط مدیریت غیرفعال شده است" }, 403, cors);
    d.onShift = b.onShift === true;
    d.lastSeen = now();
    await saveDriver(env, d);
    // Release outstanding offers when the driver ends their shift.
    if (d.onShift === false) await releasePendingOffersForDriver(env, d, "شیفت را پایان داد");
    return json({ ok: true, onShift: d.onShift }, 200, cors);
  }

  // ---- driver: heartbeat ----
  if (path === "/api/driver/heartbeat" && method === "POST") {
    const b = await body(req);
    const d = await driverByToken(env, b.token);
    if (!d) return json({ ok: false }, 401, cors);
    if (isFinite(Number(b.lat)) && isFinite(Number(b.lng))) { d.lat = Number(b.lat); d.lng = Number(b.lng); }
    if (b.radius !== undefined && b.radius !== null && b.radius !== "") d.radius = clampRadius(b.radius);
    d.lastSeen = now();
    await saveDriver(env, d);
    return json({ ok: true }, 200, cors);
  }

  // ---- driver: poll offers ----
  if (path === "/api/driver/offers" && method === "GET") {
    const d = await driverByToken(env, url.searchParams.get("token"));
    if (!d) return json({ ok: false }, 401, cors);
    d.lastSeen = now(); await saveDriver(env, d);
    if (d.approved !== true || d.active === false || d.onShift !== true)
      return json({ ok: true, offer: null, approved: d.approved === true, onShift: d.onShift === true }, 200, cors);
    const offerNames = await indexedNames(env, "offer:");
    let mine = null;
    for (const offerName of offerNames) {
      const k = { name: offerName };
      const raw = await storeGet(env, k.name);
      if (!raw) continue;
      const o = JSON.parse(raw);
      if (o.expiresAt <= now()) { await sweepOffer(env, o.reqId); continue; }
      if (o.driverId === d.id) {
        const r = await getReq(env, o.reqId);
        mine = { reqId: o.reqId, expiresAt: o.expiresAt, request: r ? {
          id: r.id, problem: r.problem, car: r.car, loc: r.loc,
          gps: r.gps, note: r.note, phone: r.phone,
        } : null };
      }
    }
    return json({ ok: true, offer: mine }, 200, cors);
  }

  // ---- driver: accept / reject ----
  if (path === "/api/driver/respond" && method === "POST") {
    const b = await body(req);
    const d = await driverByToken(env, b.token);
    if (!d) return json({ ok: false }, 401, cors);
    if (d.approved !== true || d.active === false || d.onShift !== true) {
      await releasePendingOffersForDriver(env, d, "امکان دریافت درخواست را از دست داد");
      return json({ ok: false, err: "برای پاسخ به درخواست باید حساب تأییدشده و شیفت فعال داشته باشی" }, 403, cors);
    }
    const raw = await storeGet(env, kOffer(b.reqId));
    if (!raw) return json({ ok: false, err: "پیشنهادی فعال نیست" }, 410, cors);
    const offer = JSON.parse(raw);
    if (offer.driverId !== d.id) return json({ ok: false, err: "این پیشنهاد برای شما نیست" }, 403, cors);
    const r = await getReq(env, b.reqId);
    if (!r) return json({ ok: false }, 404, cors);

    if (r.status === "لغو شد" || r.status === "انجام شد") {
      await storeDelete(env, kOffer(r.id));
      return json({ ok: false, err: "این درخواست دیگر فعال نیست" }, 409, cors);
    }
    if (b.accept === true) {
      await storeDelete(env, kOffer(r.id));
      r.status = "راننده در راه";
      r.assignedDriver = d.id;
      r.serviceCode = String(Math.floor(1000 + Math.random() * 9000));
      r.log.push({ t: now(), ev: `راننده ${d.name} پذیرفت` });
      r.log.push({ t: now(), ev: "کد اختصاصی امداد صادر شد" });
      d.score = Math.min(200, (d.score || 100) + 1);
      await saveReq(env, r); await saveDriver(env, d);
      return json({ ok: true, status: r.status, serviceCode: r.serviceCode }, 200, cors);
    }
    // reject → same as timeout: move to next driver
    r.skippedWhy = { ...(r.skippedWhy || {}), [d.id]: "reject" };
    await storeDelete(env, kOffer(r.id));
    r.skipped = [...(r.skipped || []), d.id];
    r.log.push({ t: now(), ev: `راننده ${d.name} رد کرد — ارجاع به نفر بعدی` });
    await saveReq(env, r);
    await dispatchToNext(env, r);
    return json({ ok: true, moved: true }, 200, cors);
  }

  // ---- assigned driver: cancel active mission ----
  if (path === "/api/driver/cancel" && method === "POST") {
    const b = await body(req);
    const d = await driverByToken(env, b.token);
    if (!d) return json({ ok: false, err: "احراز هویت نامعتبر" }, 401, cors);
    const r = await getReq(env, b.reqId);
    if (!r || r.assignedDriver !== d.id) return json({ ok: false, err: "مأموریت برای این راننده نیست" }, 403, cors);
    if (r.status === "لغو شد") return json({ ok: true, status: r.status }, 200, cors);
    if (r.status !== "راننده در راه") return json({ ok: false, err: "این مأموریت قابل لغو نیست" }, 409, cors);
    const reason = String(b.reason || "").trim().slice(0, 200);
    if (!reason) return json({ ok: false, err: "دلیل لغو الزامی است" }, 400, cors);
    r.status = "لغو شد";
    r.cancelledAt = now();
    r.cancelledBy = "driver";
    r.cancelReason = reason;
    r.log.push({ t: now(), ev: "توسط راننده " + d.name + " لغو شد: " + reason });
    await saveReq(env, r);
    await storeDelete(env, kOffer(r.id));
    return json({ ok: true, status: r.status }, 200, cors);
  }

  // ---- driver: complete mission ----
  if (path === "/api/driver/complete" && method === "POST") {
    const b = await body(req);
    const d = await driverByToken(env, b.token);
    if (!d) return json({ ok: false }, 401, cors);
    const r = await getReq(env, b.reqId);
    if (!r || r.assignedDriver !== d.id) return json({ ok: false, err: "این مأموریت برای شما نیست" }, 403, cors);
    if (r.status !== "راننده در راه") return json({ ok: false, err: "مأموریت در وضعیت پایان نیست" }, 409, cors);
    r.status = "انجام شد";
    r.completedAt = now();
    r.log.push({ t: now(), ev: `مأموریت توسط راننده ${d.name} انجام شد` });
    await saveReq(env, r);
    return json({ ok: true, status: r.status }, 200, cors);
  }

  // ---- driver: history & stats ----
  if (path === "/api/driver/history" && method === "GET") {
    const token = url.searchParams.get("token");
    const d = (await listDrivers(env)).find(x => x.token === token) || null;
    if (!d) return json({ ok: false }, 401, cors);
    if (d.registrationDeleted === true || d.registrationRevoked === true) {
      return json({ ok: true, registrationRevoked: true, registrationDeleted: d.registrationDeleted === true, driver: { id: d.id, name: d.name, phone: d.phone, registrationRevoked: true, registrationDeleted: d.registrationDeleted === true, approved: false, active: false } }, 200, cors);
    }
    const allReqs = await listRequests(env);
    const mine = allReqs.filter(r => r.assignedDriver === d.id);
    const stats = {
      accepted: mine.length,
      completed: mine.filter(r => r.status === "انجام شد").length,
      rejected: allReqs.filter(r => r.skippedWhy && r.skippedWhy[d.id] === "reject").length,
      missed: allReqs.filter(r => r.skippedWhy && r.skippedWhy[d.id] === "timeout").length,
    };
    const missions = mine
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 30)
      .map(r => ({ id: r.id, ts: r.ts, status: r.status, problem: r.problem, car: r.car, loc: r.loc, serviceCode: r.serviceCode || null }));
    return json({ ok: true, driver: {
      id: d.id, name: d.name, phone: d.phone, vehicle: d.vehicle || "", city: d.city || "",
      radius: d.radius, score: d.score, active: d.active !== false, approved: d.approved === true, onShift: d.onShift === true,
      registrationRevoked: d.registrationRevoked === true,
      stats,
    }, missions }, 200, cors);
  }

  // ---- admin ----
  const adminKey = req.headers.get("x-admin-key");
  const opKeys = String(env.OPERATOR_KEYS || "").split(",").map(s => s.trim()).filter(Boolean);
  const isMaster = !!adminKey && !!env.ADMIN_KEY && adminKey === env.ADMIN_KEY;
  const isOperator = !!adminKey && opKeys.includes(adminKey);
  const isAdmin = isMaster || isOperator;
  if (path.startsWith("/api/admin/")) {
    if (!isAdmin) return json({ ok: false, err: "unauthorized" }, 401, cors);
    if (path === "/api/admin/whoami") {
      return json({ ok: true, role: isMaster ? "master" : "operator" }, 200, cors);
    }
    // کارهای نوشتنی/حساس فقط برای مدیر اصلی
    if (method === "POST" && !isMaster) {
      return json({ ok: false, err: "این کار فقط برای مدیر اصلی REV است؛ کلید اپراتور فقط‌مشاهده است." }, 403, cors);
    }
    if (path === "/api/admin/support" && method === "GET") {
      return json({ ok: true, phone: String(await storeGet(env, "settings:support_phone") || "").trim() }, 200, cors);
    }
    if (path === "/api/admin/support" && method === "POST") {
      const b = await body(req);
      const phone = String(b.phone || "").trim();
      if (phone && !/^[+()0-9\\s-]{7,24}$/.test(phone)) return json({ ok: false, err: "شماره پشتیبانی معتبر نیست؛ فقط ارقام و + - پرانتز مجاز است." }, 400, cors);
      await storePut(env, "settings:support_phone", phone);
      return json({ ok: true, phone }, 200, cors);
    }
    if (path === "/api/admin/request/crm" && method === "POST") {
      const b = await body(req);
      const r = await getReq(env, String(b.id || ""));
      if (!r) return json({ ok: false, err: "درخواست پیدا نشد" }, 404, cors);
      const prior = r.crm && typeof r.crm === "object" ? r.crm : {};
      const stage = String(b.stage === undefined ? (prior.stage || "جدید") : b.stage).trim();
      const allowedStages = ["جدید", "تماس با مشتری", "در انتظار پیگیری", "ارجاع به اپراتور", "حل‌شده"];
      if (!allowedStages.includes(stage)) return json({ ok: false, err: "مرحله CRM معتبر نیست" }, 400, cors);
      const priority = String(b.priority === undefined ? (prior.priority || "عادی") : b.priority).trim();
      if (!["عادی", "مهم", "فوری"].includes(priority)) return json({ ok: false, err: "اولویت معتبر نیست" }, 400, cors);
      const followUpAt = String(b.followUpAt === undefined ? (prior.followUpAt || "") : b.followUpAt).trim().slice(0, 40);
      const owner = String(b.owner === undefined ? (prior.owner || "") : b.owner).trim().slice(0, 100);
      const note = String(b.note === undefined ? (prior.note || "") : b.note).trim().slice(0, 2000);
      r.crm = { stage, priority, followUpAt, owner, note, updatedAt: now() };
      r.log = Array.isArray(r.log) ? r.log : [];
      r.log.push({ t: now(), ev: "پیگیری CRM به‌روزرسانی شد: " + stage });
      await saveReq(env, r);
      return json({ ok: true, crm: r.crm }, 200, cors);
    }
    if (path === "/api/admin/drivers") {
      const allReqs = await listRequests(env);
      const drivers = (await listDrivers(env)).map(d => ({
        ...d, token: undefined, passwordHash: undefined, passwordSalt: undefined,
        stats: {
          accepted: allReqs.filter(r => r.assignedDriver === d.id).length,
          completed: allReqs.filter(r => r.assignedDriver === d.id && r.status === "انجام شد").length,
          rejected: allReqs.filter(r => r.skippedWhy && r.skippedWhy[d.id] === "reject").length,
          missed: allReqs.filter(r => r.skippedWhy && r.skippedWhy[d.id] === "timeout").length,
        },
      }));
      return json({ ok: true, drivers }, 200, cors);
    }
    if (path === "/api/admin/requests") {
      const out = [];
      for (const k of await indexedNames(env, "req:")) {
        const raw = await storeGet(env, k);
        if (raw) { try { out.push(JSON.parse(raw)); } catch { console.error("[rev-tow-dispatch] invalid request record", { key: k }); } }
      }
      out.sort((a, b) => b.ts - a.ts);
      return json({ ok: true, requests: out }, 200, cors);
    }
    if (path === "/api/admin/driver/score" && method === "POST") {
      const b = await body(req);
      const d = await getDriver(env, b.id);
      if (!d) return json({ ok: false }, 404, cors);
      d.score = Number(b.score) || 0;
      await saveDriver(env, d);
      return json({ ok: true }, 200, cors);
    }
    if (path === "/api/admin/driver/delete-registration" && method === "POST") {
      if (!isMaster) return json({ ok: false, err: "فقط مدیر اصلی مجاز است" }, 403, cors);
      const b = await body(req);
      const d = await getDriver(env, String(b.id || ""));
      if (!d) return json({ ok: false, err: "راننده پیدا نشد" }, 404, cors);
      d.registrationDeleted = true;
      d.registrationDeletedAt = now();
      d.registrationRevoked = true;
      d.registrationRevokedAt = d.registrationRevokedAt || now();
      d.approved = false;
      d.active = false;
      d.onShift = false;
      d.token = crypto.randomUUID().replace(/-/g, "");
      await saveDriver(env, d);
      await releasePendingOffersForDriver(env, d, "ثبت‌نام راننده توسط مدیر حذف شد");
      return json({ ok: true, registrationDeleted: true, id: d.id }, 200, cors);
    }
    if (path === "/api/admin/driver/active" && method === "POST") {
      const b = await body(req);
      const d = await getDriver(env, b.id);
      if (!d) return json({ ok: false }, 404, cors);
      d.active = b.active !== false;
      if (d.active === false) d.onShift = false;
      await saveDriver(env, d);
      if (d.active === false) await releasePendingOffersForDriver(env, d, "توسط مدیریت غیرفعال شد");
      return json({ ok: true, active: d.active, onShift: d.onShift === true }, 200, cors);
    }
    if (path === "/api/admin/driver/approve" && method === "POST") {
      const b = await body(req);
      const d = await getDriver(env, b.id);
      if (!d) return json({ ok: false }, 404, cors);
      d.approved = b.approved !== false;
      if (d.approved === false) {
        d.onShift = false;
        d.active = false;
        d.registrationRevoked = true;
        d.registrationRevokedAt = now();
      } else {
        d.registrationRevoked = false;
        d.active = true;
        delete d.registrationRevokedAt;
      }
      await saveDriver(env, d);
      if (d.approved === false) await releasePendingOffersForDriver(env, d, "تأییدش توسط مدیریت لغو شد");
      return json({ ok: true, approved: d.approved, onShift: d.onShift === true, registrationRevoked: d.registrationRevoked === true }, 200, cors);
    }
    if (path === "/api/admin/driver/profile" && method === "POST") {
      const b = await body(req);
      const d = await getDriver(env, b.id);
      if (!d) return json({ ok: false, err: "راننده پیدا نشد" }, 404, cors);
      if (b.name !== undefined) {
        const name = String(b.name || "").trim();
        if (name.length < 2 || name.length > 100) return json({ ok: false, err: "نام باید بین ۲ تا ۱۰۰ نویسه باشد" }, 400, cors);
        d.name = name;
      }
      if (b.vehicle !== undefined) d.vehicle = String(b.vehicle || "").trim().slice(0, 120);
      if (b.city !== undefined) d.city = String(b.city || "").trim().slice(0, 80);
      if (b.province !== undefined) d.province = String(b.province || "").trim().slice(0, 80);
      await saveDriver(env, d);
      return json({ ok: true, driver: { id: d.id, name: d.name, vehicle: d.vehicle || "", city: d.city || "", province: d.province || "" } }, 200, cors);
    }
    if (path === "/api/admin/driver/crm" && method === "POST") {
      const b = await body(req);
      const d = await getDriver(env, String(b.id || ""));
      if (!d) return json({ ok: false, err: "راننده پیدا نشد" }, 404, cors);
      const prior = d.crm && typeof d.crm === "object" ? d.crm : {};
      const stage = String(b.stage === undefined ? (prior.stage || "جدید") : b.stage).trim();
      const allowedStages = ["جدید", "در حال بررسی", "نیازمند تماس", "در انتظار مدارک", "فعال", "محدودشده", "بسته‌شده"];
      if (!allowedStages.includes(stage)) return json({ ok: false, err: "مرحله CRM راننده معتبر نیست" }, 400, cors);
      const priority = String(b.priority === undefined ? (prior.priority || "عادی") : b.priority).trim();
      if (!["عادی", "مهم", "فوری"].includes(priority)) return json({ ok: false, err: "اولویت معتبر نیست" }, 400, cors);
      const followUpAt = String(b.followUpAt === undefined ? (prior.followUpAt || "") : b.followUpAt).trim().slice(0, 40);
      const owner = String(b.owner === undefined ? (prior.owner || "") : b.owner).trim().slice(0, 100);
      const note = String(b.note === undefined ? (prior.note || "") : b.note).trim().slice(0, 2000);
      d.crm = { stage, priority, followUpAt, owner, note, updatedAt: now() };
      if (b.documents !== undefined) {
        if (!Array.isArray(b.documents) || b.documents.length > 20)
          return json({ ok: false, err: "حداکثر ۲۰ مدرک قابل ثبت است" }, 400, cors);
        const documents = [];
        for (const item of b.documents) {
          if (!item || typeof item !== "object") continue;
          const label = String(item.label || item.name || "").trim().slice(0, 100);
          const url = String(item.url || "").trim().slice(0, 1000);
          if (!label || !/^https:\/\//i.test(url))
            return json({ ok: false, err: "برای هر مدرک عنوان و لینک HTTPS معتبر لازم است" }, 400, cors);
          documents.push({ label, url, addedAt: Number(item.addedAt) || now() });
        }
        d.documents = documents;
      }
      await saveDriver(env, d);
      return json({ ok: true, crm: d.crm, documents: d.documents || [] }, 200, cors);
    }
    if (path === "/api/admin/driver/reset-token" && method === "POST") {
      const b = await body(req);
      const d = await getDriver(env, b.id);
      if (!d) return json({ ok: false }, 404, cors);
      d.token = crypto.randomUUID().replace(/-/g, "");
      await saveDriver(env, d);
      return json({ ok: true, token: d.token }, 200, cors);
    }
    if (path === "/api/admin/driver/reset-password" && method === "POST") {
      if (!isMaster) return json({ ok: false, err: "فقط مدیر اصلی مجاز است" }, 403, cors);
      const b = await body(req);
      const d = await getDriver(env, b.id);
      if (!d) return json({ ok: false, err: "راننده پیدا نشد" }, 404, cors);
      const temporaryPassword = makeTempPassword();
      await setDriverPassword(d, temporaryPassword);
      d.token = crypto.randomUUID().replace(/-/g, "");
      await saveDriver(env, d);
      return json({ ok: true, temporaryPassword, phone: d.phone }, 200, cors);
    }
    if (path === "/api/admin/sweep" && method === "POST") {
      const offerNames = await indexedNames(env, "offer:");
      let swept = 0;
      for (const offerName of offerNames) {
        const k = { name: offerName };
        const raw = await storeGet(env, k.name);
        if (raw && JSON.parse(raw).expiresAt <= now()) {
          await sweepOffer(env, JSON.parse(raw).reqId); swept++;
        }
      }
      return json({ ok: true, swept }, 200, cors);
    }
    return json({ ok: false }, 404, cors);
  }

  return json({ ok: false, err: "not found" }, 404, cors);
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req);
    try {
      return await handle(req, env, cors);
    } catch (e) {
      // Log diagnostic details in Cloudflare Workers Logs; never log request headers,
      // admin keys, or driver tokens.
      console.error("[rev-tow-dispatch] unhandled request error", {
        path: new URL(req.url).pathname,
        method: req.method,
        name: e && e.name ? String(e.name) : "Error",
        message: e && e.message ? String(e.message) : String(e),
        stack: e && e.stack ? String(e.stack) : null,
      });
      const message = e && e.message ? String(e.message) : String(e);
      return json({ ok: false, err: "server error" }, 500, cors);
    }
  },
};

// ---------- minimal driver page (served at /driver) ----------
const DRIVER_PAGE = `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>پنل راننده یدک‌کش REV</title>
<style>body{font-family:Tahoma;background:#f0f4f4;margin:0;padding:16px;color:#123}
.card{background:#fff;border-radius:12px;padding:16px;margin-bottom:12px;box-shadow:0 1px 4px #0001}
input{width:100%;padding:10px;margin:6px 0;border:1px solid #ccc;border-radius:8px;box-sizing:border-box}
button{padding:12px;border:0;border-radius:8px;font-weight:800;width:100%;margin-top:8px}
.ok{background:#0887a7;color:#fff}.no{background:#e0533d;color:#fff}
.big{font-size:18px;font-weight:800}.mut{color:#666;font-size:12px}
#offer{display:none}</style></head><body>
<div class="card"><div class="big">🚨 پنل راننده یدک‌کش REV</div>
<div class="mut">توکنی که هنگام ثبت‌نام گرفتی را وارد کن. صفحه را باز نگه دار؛ پیشنهادها خودکار می‌آیند.</div>
<input id="tok" placeholder="توکن راننده"><button class="ok" id="login">ورود به پنل راننده</button></div>
<div class="card" id="shiftCard" style="display:none"><div class="big" id="shiftTitle">وضعیت شیفت</div><div class="mut" id="shiftHint">برای دریافت درخواست باید شیفت را شروع کنی.</div><button class="ok" id="startShift">🟢 آماده فعالیت هستم — شروع شیفت</button><button class="no" id="endShift" style="display:none">⏹️ اتمام شیفت کاری</button></div>
<div class="card" id="offer"><div class="big">📥 درخواست جدید</div><div id="od"></div>
<button class="ok" id="acc">✅ قبول می‌کنم</button><button class="no" id="rej">❌ رد</button></div>
<div class="card" id="activeMissions" style="display:none"><div class="big">مأموریت‌های فعال من</div><div id="missionList"></div></div>
<div class="card"><div class="mut" id="st">وارد نشده‌ای.</div></div>
<script>
var T="",REQ=null,ON=false,loopTimer=null,hbTimer=null;
function api(p,o){o=o||{};o.headers=Object.assign({"content-type":"application/json"},o.headers||{});
return fetch(p,o).then(function(r){return r.json().then(function(j){if(!r.ok||j.ok===false)throw new Error(j.err||"خطای ارتباط با سرور");return j})})}
function showShift(on){ON=!!on;document.getElementById("shiftCard").style.display="block";
document.getElementById("shiftTitle").textContent=ON?"🟢 شیفت فعال است":"⏸️ شیفت کاری پایان یافته";
document.getElementById("shiftHint").textContent=ON?"در این وضعیت درخواست‌های جدید برایت ارسال می‌شود.":"برای دریافت درخواست جدید، شروع شیفت را بزن.";
document.getElementById("startShift").style.display=ON?"none":"block";
document.getElementById("endShift").style.display=ON?"block":"none";
document.getElementById("st").textContent=ON?"آنلاین هستی و آماده دریافت درخواست هستی.":"وارد پنل شدی؛ برای دریافت درخواست شیفت را شروع کن.";
if(!ON){REQ=null;document.getElementById("offer").style.display="none"}}
document.getElementById("login").onclick=function(){T=document.getElementById("tok").value.trim();if(!T)return;
api("/api/driver/history?token="+encodeURIComponent(T)).then(function(j){
showShift(j.driver.onShift===true&&j.driver.active!==false);
loop();if(!loopTimer)loopTimer=setInterval(loop,25000);hb();if(!hbTimer)hbTimer=setInterval(hb,60000);
}).catch(function(e){document.getElementById("st").textContent="ورود انجام نشد: "+e.message})};
document.getElementById("startShift").onclick=function(){if(!T)return;
api("/api/driver/shift",{method:"POST",body:JSON.stringify({token:T,onShift:true})}).then(function(){showShift(true);hb();loop()}).catch(function(e){document.getElementById("st").textContent="شروع شیفت انجام نشد: "+e.message})};
document.getElementById("endShift").onclick=function(){if(!T)return;
if(!confirm("از اتمام شیفت کاری مطمئنی؟"))return;
api("/api/driver/shift",{method:"POST",body:JSON.stringify({token:T,onShift:false})}).then(function(){showShift(false)}).catch(function(e){document.getElementById("st").textContent="اتمام شیفت انجام نشد: "+e.message})};
function hb(){if(!T||!ON||!navigator.geolocation)return;navigator.geolocation.getCurrentPosition(function(p){
api("/api/driver/heartbeat",{method:"POST",body:JSON.stringify({token:T,lat:p.coords.latitude,lng:p.coords.longitude})}).catch(function(){})},function(){},{enableHighAccuracy:true,maximumAge:30000,timeout:10000})}
function refreshMissions(){if(!T)return;api("/api/driver/history?token="+encodeURIComponent(T)).then(function(j){var m=(j.missions||[]).filter(function(x){return x.status==="راننده در راه"});document.getElementById("activeMissions").style.display=m.length?"block":"none";document.getElementById("missionList").textContent="";m.forEach(function(x){var d=document.createElement("div");d.className="card";d.textContent=x.id+" — "+x.loc+" — "+x.problem;var b=document.createElement("button");b.className="no";b.textContent="لغو مأموریت";b.onclick=function(){var reason=prompt("دلیل لغو مأموریت را وارد کنید:");if(!reason||!reason.trim())return;if(!confirm("مأموریت لغو شود؟"))return;api("/api/driver/cancel",{method:"POST",body:JSON.stringify({token:T,reqId:x.id,reason:reason.trim()})}).then(function(){refreshMissions();loop()}).catch(function(e){alert(e.message)})};d.appendChild(b);document.getElementById("missionList").appendChild(d)})}).catch(function(e){document.getElementById("st").textContent=e.message})}
function loop(){refreshMissions();api("/api/driver/offers?token="+encodeURIComponent(T)).then(function(j){
if(!j.ok)return;var o=j.offer;var box=document.getElementById("offer");
if(o&&o.request){REQ=o.reqId;box.style.display="block";
document.getElementById("od").innerHTML="<div class='big'>"+o.request.problem+"</div><div>"+(o.request.car||"")+" — "+(o.request.loc||"")+"</div><div class='mut'>تلفن: "+o.request.phone+"</div>"+(o.request.note?"<div>"+o.request.note+"</div>":"")}
else{REQ=null;box.style.display="none"}})}
document.getElementById("acc").onclick=function(){if(REQ)api("/api/driver/respond",{method:"POST",body:JSON.stringify({token:T,reqId:REQ,accept:true})}).then(loop)};
document.getElementById("rej").onclick=function(){if(REQ)api("/api/driver/respond",{method:"POST",body:JSON.stringify({token:T,reqId:REQ,accept:false})}).then(loop)};
</script></body></html>`;
