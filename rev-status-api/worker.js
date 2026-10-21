// REV — وضعیت لحظه‌ای کراودسورس + ثبت جایگاه جدید + امتیاز کاربران (نسخه ۲)
//
// KV binding لازم: STATUS_KV
// Secret لازم: ADMIN_TOKEN (برای دیدن و تأیید ثبت‌های جدید)
//
// وضعیت لحظه‌ای: کلید ایستگاه از مختصات: g:<lat6>,<lng6>
//   POST /report { key, name, status: free|busy|broken, phone? }
//   GET  /status
// ثبت جایگاه جدید توسط کاربر (در انتظار تأیید مدیر):
//   POST /submit-station { name, city, address, lat, lng, power_kw, connectors[], notes, phone }
//   GET  /submissions?token=<ADMIN_TOKEN>
//   POST /moderate { token, id, action: approve|reject }
// امتیاز کاربران (کلید: شماره موبایل):
//   گزارش وضعیت لحظه‌ای: +۲ (سقف روزانه ۱۰ گزارش)
//   جایگاه جدیدِ تأییدشده: +۵
//   GET  /points?phone=09xxxxxxxxx
// سلامت:
//   GET  /health

const STATUSES = ["free", "busy", "broken"];

// سازگاری با نام Binding فعلی Cloudflare و نام قدیمی.
function getStatusKV(env) {
  const kv = getStatusKV(env) || env.REV_STATUS_KV;
  if (!kv) throw new Error("Missing KV binding: STATUS_KV or REV_STATUS_KV");
  return kv;
}
const PHONE_RE = /^09\d{9}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function validKey(key) {
  return typeof key === "string" && /^g:-?\d{1,3}\.\d{6},-?\d{1,3}\.\d{6}$/.test(key);
}

function validPhone(p) {
  return typeof p === "string" && PHONE_RE.test(p);
}

async function addPoints(env, phone, delta, field) {
  if (!validPhone(phone) || !delta) return null;
  const k = "pts:" + phone;
  let rec = null;
  try { rec = await getStatusKV(env).get(k, "json"); } catch { /* ignore */ }
  rec = rec && typeof rec === "object" ? rec : { total: 0, reports: 0, stations: 0 };
  rec.total = (rec.total || 0) + delta;
  if (field) rec[field] = (rec[field] || 0) + 1;
  rec.updated = Date.now();
  await getStatusKV(env).put(k, JSON.stringify(rec));
  return rec;
}

async function reportPoints(env, phone, stationKey) {
  // هر کاربر برای هر ایستگاه در هر روز فقط یک‌بار امتیاز گزارش می‌گیرد.
  // ثبت دوباره یا تغییر وضعیت همان ایستگاه همچنان وضعیت را به‌روز می‌کند، اما امتیاز تکراری نمی‌دهد.
  if (!validPhone(phone) || !validKey(stationKey)) return null;
  const day = new Date().toISOString().slice(0, 10);
  const dailyKey = "pd:" + phone + ":" + day;
  let cnt = 0;
  try { cnt = parseInt((await getStatusKV(env).get(dailyKey)) || "0", 10) || 0; } catch { /* ignore */ }
  if (cnt >= 10) return null;
  const rewardKey = "pr:" + phone + ":" + stationKey + ":" + day;
  try {
    if (await getStatusKV(env).get(rewardKey)) return null;
    // نشانگر پاداش قبل از افزایش امتیاز ذخیره می‌شود تا کلیک‌های تکراری امتیاز نسازند.
    await getStatusKV(env).put(rewardKey, "1", { expirationTtl: 172800 });
    await getStatusKV(env).put(dailyKey, String(cnt + 1), { expirationTtl: 172800 });
    return await addPoints(env, phone, 2, "reports");
  } catch { return null; }
}


async function votePoints(env, phone) {
  // +۱ امتیاز برای رأی اعتبارسنجی، سقف ۱۰ رأی در روز
  if (!validPhone(phone)) return null;
  const day = new Date().toISOString().slice(0, 10);
  const dk = "vd:" + phone + ":" + day;
  let cnt = 0;
  try { cnt = parseInt((await getStatusKV(env).get(dk)) || "0", 10) || 0; } catch { /* ignore */ }
  if (cnt >= 10) return null;
  await getStatusKV(env).put(dk, String(cnt + 1), { expirationTtl: 172800 });
  return addPoints(env, phone, 1, "validations");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "rev-status-api", v: 3 });
    }

    // ---------- وضعیت لحظه‌ای ----------
    if (url.pathname === "/report" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, error: "invalid_json" }, 400); }
      const status = body && body.status;
      const name = body && typeof body.name === "string" ? body.name.slice(0, 120) : "";
      const phone = body && typeof body.phone === "string" ? body.phone.trim() : "";
      const lat = Number(body && body.lat);
      const lng = Number(body && body.lng);
      const userLat = Number(body && body.user_lat);
      const userLng = Number(body && body.user_lng);
      const accuracy = Number(body && body.accuracy);
      const positionTimestamp = Number(body && body.position_timestamp);
      if (!validPhone(phone)) return json({ ok: false, error: "invalid_phone" }, 400);
      if (!STATUSES.includes(status)) return json({ ok: false, error: "invalid_status" }, 400);
      if (![lat, lng, userLat, userLng, accuracy, positionTimestamp].every(Number.isFinite) ||
          lat < 24 || lat > 40.5 || lng < 43 || lng > 64 ||
          userLat < -90 || userLat > 90 || userLng < -180 || userLng > 180) {
        return json({ ok: false, error: "invalid_coordinates" }, 400);
      }
      if (accuracy < 0 || accuracy > 60) return json({ ok: false, error: "location_accuracy" }, 400);
      if (Math.abs(Date.now() - positionTimestamp) > 120000 || positionTimestamp > Date.now() + 5000) {
        return json({ ok: false, error: "location_stale" }, 400);
      }
      const rad = x => x * Math.PI / 180;
      const dLat = rad(userLat - lat), dLng = rad(userLng - lng);
      const aa = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(userLat)) * Math.sin(dLng / 2) ** 2;
      const distance = 6371000 * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(Math.max(0, 1 - aa)));
      if (distance > 100) return json({ ok: false, error: "too_far", distance_m: Math.round(distance) }, 403);

      // The station key is derived on the server so clients cannot submit an arbitrary/mismatched key.
      const key = "g:" + lat.toFixed(6) + "," + lng.toFixed(6);
      const kvKey = "st:" + key;
      let prev = null;
      try { prev = await getStatusKV(env).get(kvKey, "json"); } catch { /* ignore */ }
      const rec = {
        s: status,
        at: Date.now(),
        n: (prev && typeof prev.n === "number" ? prev.n : 0) + 1,
        name: name || (prev && prev.name) || "",
        reported_by: phone,
        distance_m: Math.round(distance),
      };
      await getStatusKV(env).put(kvKey, JSON.stringify(rec));
      const pts = await reportPoints(env, phone, key);
      return json({ ok: true, record: rec, points: pts ? pts.total : undefined, points_awarded: pts ? 2 : 0, distance_m: Math.round(distance) });
    }

    if ((url.pathname === "/status" || url.pathname === "/station-status") && request.method === "GET") {
      const out = {};
      let cursor;
      do {
        const page = await getStatusKV(env).list({ prefix: "st:", cursor, limit: 1000 });
        for (const k of page.keys) {
          const rec = await getStatusKV(env).get(k.name, "json");
          if (rec && STATUSES.includes(rec.s)) out[k.name.slice(3)] = rec;
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      // /status keeps its legacy response shape; /station-status is used by the map UI.
      return url.pathname === "/station-status"
        ? json({ ok: true, statuses: out })
        : json(out);
    }

    // ---------- ثبت جایگاه جدید ----------
    if (url.pathname === "/submit-station" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, error: "invalid_json" }, 400); }
      const name = body && typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
      const address = body && typeof body.address === "string" ? body.address.trim().slice(0, 300) : "";
      const city = body && typeof body.city === "string" ? body.city.trim().slice(0, 60) : "";
      const phone = body && typeof body.phone === "string" ? body.phone.trim() : "";
      const lat = body ? Number(body.lat) : NaN;
      const lng = body ? Number(body.lng) : NaN;
      const power = body && body.power_kw != null ? Number(body.power_kw) : null;
      const connectors = body && Array.isArray(body.connectors)
        ? body.connectors.filter(c => typeof c === "string").slice(0, 8).map(c => c.slice(0, 30))
        : [];
      const notes = body && typeof body.notes === "string" ? body.notes.trim().slice(0, 400) : "";

      if (name.length < 3) return json({ ok: false, error: "invalid_name" }, 400);
      if (address.length < 8) return json({ ok: false, error: "invalid_address" }, 400);
      if (!validPhone(phone)) return json({ ok: false, error: "invalid_phone" }, 400);
      if (!isFinite(lat) || !isFinite(lng) || lat < 24 || lat > 40.5 || lng < 43 || lng > 64) {
        return json({ ok: false, error: "invalid_coords" }, 400);
      }
      if (power != null && (!isFinite(power) || power < 0 || power > 1000)) {
        return json({ ok: false, error: "invalid_power" }, 400);
      }

      const id = crypto.randomUUID();
      const rec = {
        id, name, city, address, lat, lng,
        power_kw: power, connectors, notes, phone,
        status: "pending", at: Date.now(),
      };
      await getStatusKV(env).put("sub:" + id, JSON.stringify(rec));
      return json({ ok: true, id, status: "pending" });
    }


    // ---------- نقشه ثبت‌های در انتظار (عمومی، بدون شماره) ----------
    if (url.pathname === "/pending-map" && request.method === "GET") {
      const out = [];
      let cursor;
      do {
        const page = await getStatusKV(env).list({ prefix: "sub:", cursor, limit: 1000 });
        for (const k of page.keys) {
          const rec = await getStatusKV(env).get(k.name, "json");
          if (rec && rec.status === "pending") {
            const votes = rec.votes || {};
            let confirms = 0, rejects = 0;
            for (const p in votes) { if (votes[p] === "confirm") confirms++; else if (votes[p] === "reject") rejects++; }
            out.push({
              id: rec.id, name: rec.name, city: rec.city, address: rec.address,
              lat: rec.lat, lng: rec.lng, power_kw: rec.power_kw,
              connectors: rec.connectors, notes: rec.notes, at: rec.at,
              confirms, rejects, verified: confirms >= 3 && confirms > rejects,
            });
          }
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return json({ ok: true, stations: out });
    }

    // ---------- رأی صحت‌سنجی کاربران ----------
    if (url.pathname === "/vote" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, error: "invalid_json" }, 400); }
      const id = body && typeof body.id === "string" ? body.id : "";
      const vote = body && body.vote;
      const phone = body && typeof body.phone === "string" ? body.phone.trim() : "";
      if (!id || !["confirm", "reject"].includes(vote)) return json({ ok: false, error: "invalid_request" }, 400);
      if (!validPhone(phone)) return json({ ok: false, error: "invalid_phone" }, 400);
      const kvKey = "sub:" + id;
      const rec = await getStatusKV(env).get(kvKey, "json");
      if (!rec) return json({ ok: false, error: "not_found" }, 404);
      if (rec.status !== "pending") return json({ ok: false, error: "already_moderated" }, 409);
      if (rec.phone === phone) return json({ ok: false, error: "own_submission" }, 403);
      rec.votes = rec.votes && typeof rec.votes === "object" ? rec.votes : {};
      const isNew = !rec.votes[phone];
      rec.votes[phone] = vote;
      await getStatusKV(env).put(kvKey, JSON.stringify(rec));
      let confirms = 0, rejects = 0;
      for (const p in rec.votes) { if (rec.votes[p] === "confirm") confirms++; else rejects++; }
      const pts = isNew ? await votePoints(env, phone) : null;
      return json({ ok: true, confirms, rejects, verified: confirms >= 3 && confirms > rejects, points: pts ? pts.total : undefined });
    }

    // ---------- پنل مدیر ----------
    const adminToken = env.ADMIN_TOKEN || env.STATUS_ADMIN_TOKEN || "";
    function isAdmin(tok) { return adminToken && tok && tok === adminToken; }

    if (url.pathname === "/submissions" && request.method === "GET") {
      if (!adminToken) return json({ ok: false, error: "admin_token_not_set" }, 503);
      if (!isAdmin(url.searchParams.get("token"))) return json({ ok: false, error: "unauthorized" }, 401);
      const out = [];
      let cursor;
      do {
        const page = await getStatusKV(env).list({ prefix: "sub:", cursor, limit: 1000 });
        for (const k of page.keys) {
          const rec = await getStatusKV(env).get(k.name, "json");
          if (rec && rec.status === "pending") out.push(rec);
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      out.sort((a, b) => a.at - b.at);
      return json({ ok: true, count: out.length, submissions: out });
    }

    if (url.pathname === "/moderate" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, error: "invalid_json" }, 400); }
      if (!adminToken) return json({ ok: false, error: "admin_token_not_set" }, 503);
      if (!isAdmin(body && body.token)) return json({ ok: false, error: "unauthorized" }, 401);
      const id = body && typeof body.id === "string" ? body.id : "";
      const action = body && body.action;
      if (!id || !["approve", "reject"].includes(action)) {
        return json({ ok: false, error: "invalid_request" }, 400);
      }
      const kvKey = "sub:" + id;
      const rec = await getStatusKV(env).get(kvKey, "json");
      if (!rec) return json({ ok: false, error: "not_found" }, 404);
      if (rec.status !== "pending") return json({ ok: false, error: "already_moderated" }, 409);
      rec.status = action === "approve" ? "approved" : "rejected";
      rec.moderated_at = Date.now();
      await getStatusKV(env).put(kvKey, JSON.stringify(rec));
      let pts = null;
      if (action === "approve") {
        pts = await addPoints(env, rec.phone, 5, "stations");
        // پاداش +۵ برای کاربرانی که این جایگاه را تأیید کرده بودند
        const votes = rec.votes || {};
        for (const p in votes) {
          if (votes[p] === "confirm") { try { await addPoints(env, p, 5, "validations"); } catch { /* ignore */ } }
        }
      }
      return json({ ok: true, id, status: rec.status, points: pts ? pts.total : undefined });
    }

    // ---------- امتیاز کاربر ----------
    if (url.pathname === "/points" && request.method === "GET") {
      const phone = (url.searchParams.get("phone") || "").trim();
      if (!validPhone(phone)) return json({ ok: false, error: "invalid_phone" }, 400);
      const rec = await getStatusKV(env).get("pts:" + phone, "json");
      return json({ ok: true, phone, total: rec ? rec.total || 0 : 0, reports: rec ? rec.reports || 0 : 0, stations: rec ? rec.stations || 0 : 0 });
    }

    return json({ ok: false, error: "not_found" }, 404);
  },
};
