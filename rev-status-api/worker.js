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
//   جایگاه جدیدِ تأییدشده: +۵۰
//   GET  /points?phone=09xxxxxxxxx
// سلامت:
//   GET  /health

const STATUSES = ["free", "busy", "broken"];
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
  try { rec = await env.STATUS_KV.get(k, "json"); } catch { /* ignore */ }
  rec = rec && typeof rec === "object" ? rec : { total: 0, reports: 0, stations: 0 };
  rec.total = (rec.total || 0) + delta;
  if (field) rec[field] = (rec[field] || 0) + 1;
  rec.updated = Date.now();
  await env.STATUS_KV.put(k, JSON.stringify(rec));
  return rec;
}

async function reportPoints(env, phone) {
  // +۲ امتیاز برای گزارش وضعیت، با سقف ۱۰ گزارش در روز
  if (!validPhone(phone)) return null;
  const day = new Date().toISOString().slice(0, 10);
  const dk = "pd:" + phone + ":" + day;
  let cnt = 0;
  try { cnt = parseInt((await env.STATUS_KV.get(dk)) || "0", 10) || 0; } catch { /* ignore */ }
  if (cnt >= 10) return null;
  await env.STATUS_KV.put(dk, String(cnt + 1), { expirationTtl: 172800 });
  return addPoints(env, phone, 2, "reports");
}


async function votePoints(env, phone) {
  // +۱ امتیاز برای رأی اعتبارسنجی، سقف ۱۰ رأی در روز
  if (!validPhone(phone)) return null;
  const day = new Date().toISOString().slice(0, 10);
  const dk = "vd:" + phone + ":" + day;
  let cnt = 0;
  try { cnt = parseInt((await env.STATUS_KV.get(dk)) || "0", 10) || 0; } catch { /* ignore */ }
  if (cnt >= 10) return null;
  await env.STATUS_KV.put(dk, String(cnt + 1), { expirationTtl: 172800 });
  return addPoints(env, phone, 1, "validations");
}


function distM(lat1, lng1, lat2, lng2) {
  const R = 6371000, t = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * t / 2) ** 2 +
    Math.cos(lat1 * t) * Math.cos(lat2 * t) * Math.sin((lng2 - lng1) * t / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function voteSums(rec) {
  // جمع ساده و جمع وزنی رأی‌ها؛ رأی‌های قدیمی (بدون وزن ثبت‌شده) وزن ۱ می‌گیرند
  const votes = rec.votes && typeof rec.votes === "object" ? rec.votes : {};
  const vw = rec.vw && typeof rec.vw === "object" ? rec.vw : {};
  let confirms = 0, rejects = 0, cw = 0, rw = 0;
  for (const p in votes) {
    const w = typeof vw[p] === "number" ? vw[p] : 1;
    if (votes[p] === "confirm") { confirms++; cw += w; }
    else if (votes[p] === "reject") { rejects++; rw += w; }
  }
  return { confirms, rejects, cw, rw, verified: cw >= 3 && cw > rw };
}

export default {
  async fetch(request, env) {
    // سازگاری دوطرفه نام‌ها: داشبورد REV_STATUS_KV / STATUS_ADMIN_TOKEN دارد، ورانگلر STATUS_KV / ADMIN_TOKEN
    if (!env.STATUS_KV && env.REV_STATUS_KV) env.STATUS_KV = env.REV_STATUS_KV;
    if (!env.ADMIN_TOKEN && env.STATUS_ADMIN_TOKEN) env.ADMIN_TOKEN = env.STATUS_ADMIN_TOKEN;
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "rev-status-api", v: 5 });
    }

    // ---------- وضعیت لحظه‌ای ----------
    if (url.pathname === "/report" && request.method === "POST") {
      let body;
      try { body = await request.json(); }
      catch { return json({ ok: false, error: "invalid_json" }, 400); }
      const key = body && body.key;
      const status = body && body.status;
      const name = body && typeof body.name === "string" ? body.name.slice(0, 120) : "";
      const phone = body && typeof body.phone === "string" ? body.phone.trim() : "";
      if (!validKey(key)) return json({ ok: false, error: "invalid_key" }, 400);
      if (!STATUSES.includes(status)) return json({ ok: false, error: "invalid_status" }, 400);

      const kvKey = "st:" + key;
      let prev = null;
      try { prev = await env.STATUS_KV.get(kvKey, "json"); } catch { /* ignore */ }
      const rec = {
        s: status,
        at: Date.now(),
        n: (prev && typeof prev.n === "number" ? prev.n : 0) + 1,
        name: name || (prev && prev.name) || "",
      };
      await env.STATUS_KV.put(kvKey, JSON.stringify(rec));
      const pts = await reportPoints(env, phone);
      return json({ ok: true, record: rec, points: pts ? pts.total : undefined });
    }

    if (url.pathname === "/status" && request.method === "GET") {
      const out = {};
      let cursor;
      do {
        const page = await env.STATUS_KV.list({ prefix: "st:", cursor, limit: 1000 });
        for (const k of page.keys) {
          const rec = await env.STATUS_KV.get(k.name, "json");
          if (rec && STATUSES.includes(rec.s)) out[k.name.slice(3)] = rec;
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return json(out);
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

      // ضدفارم: حداکثر ۳ ثبت در انتظار برای هر شماره
      let pendingMine = 0;
      {
        let cursor;
        do {
          const page = await env.STATUS_KV.list({ prefix: "sub:", cursor, limit: 1000 });
          for (const k of page.keys) {
            const r0 = await env.STATUS_KV.get(k.name, "json");
            if (r0 && r0.status === "pending" && r0.phone === phone) pendingMine++;
          }
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
      }
      if (pendingMine >= 3) return json({ ok: false, error: "too_many_pending" }, 429);

      const id = crypto.randomUUID();
      const rec = {
        id, name, city, address, lat, lng,
        power_kw: power, connectors, notes, phone,
        status: "pending", at: Date.now(),
      };
      await env.STATUS_KV.put("sub:" + id, JSON.stringify(rec));
      return json({ ok: true, id, status: "pending" });
    }


    // ---------- نقشه ثبت‌های در انتظار (عمومی، بدون شماره) ----------
    if (url.pathname === "/pending-map" && request.method === "GET") {
      const out = [];
      let cursor;
      do {
        const page = await env.STATUS_KV.list({ prefix: "sub:", cursor, limit: 1000 });
        for (const k of page.keys) {
          const rec = await env.STATUS_KV.get(k.name, "json");
          if (rec && rec.status === "pending") {
            const vs = voteSums(rec);
            out.push({
              id: rec.id, name: rec.name, city: rec.city, address: rec.address,
              lat: rec.lat, lng: rec.lng, power_kw: rec.power_kw,
              connectors: rec.connectors, notes: rec.notes, at: rec.at,
              confirms: vs.confirms, rejects: vs.rejects, verified: vs.verified,
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
      const rec = await env.STATUS_KV.get(kvKey, "json");
      if (!rec) return json({ ok: false, error: "not_found" }, 404);
      if (rec.status !== "pending") return json({ ok: false, error: "already_moderated" }, 409);
      if (rec.phone === phone) return json({ ok: false, error: "own_submission" }, 403);
      // ضدفارم: وزن رأی از سابقه کاربر می‌آید — باسابقه‌ها (۲۰+ امتیاز یا ۵+ گزارش) وزن ۱، بقیه ۰٫۳۴
      let base = 0.34;
      try {
        const pr = await env.STATUS_KV.get("pts:" + phone, "json");
        if (pr && ((pr.total || 0) >= 20 || (pr.reports || 0) >= 5)) base = 1;
      } catch { /* ignore */ }
      let weight = base;
      if (vote === "confirm") {
        const vlat = body && body.lat != null ? Number(body.lat) : null;
        const vlng = body && body.lng != null ? Number(body.lng) : null;
        if (vlat != null && vlng != null && isFinite(vlat) && isFinite(vlng)) {
          // تأیید «دیدمش» فقط از نزدیک جایگاه (شعاع ۱ کیلومتر)
          if (distM(vlat, vlng, rec.lat, rec.lng) > 1000) {
            return json({ ok: false, error: "too_far" }, 403);
          }
        } else {
          // بدون موقعیت، تأیید حداکثر با وزن کاربر تازه حساب می‌شود
          weight = Math.min(base, 0.34);
        }
      }
      rec.votes = rec.votes && typeof rec.votes === "object" ? rec.votes : {};
      rec.vw = rec.vw && typeof rec.vw === "object" ? rec.vw : {};
      const isNew = !rec.votes[phone];
      rec.votes[phone] = vote;
      rec.vw[phone] = weight;
      await env.STATUS_KV.put(kvKey, JSON.stringify(rec));
      const vs = voteSums(rec);
      const pts = isNew ? await votePoints(env, phone) : null;
      return json({ ok: true, confirms: vs.confirms, rejects: vs.rejects, verified: vs.verified, weight, points: pts ? pts.total : undefined });
    }

    // ---------- پنل مدیر ----------
    const adminToken = env.ADMIN_TOKEN || "";
    function isAdmin(tok) { return adminToken && tok && tok === adminToken; }

    if (url.pathname === "/submissions" && request.method === "GET") {
      if (!adminToken) return json({ ok: false, error: "admin_token_not_set" }, 503);
      if (!isAdmin(url.searchParams.get("token"))) return json({ ok: false, error: "unauthorized" }, 401);
      const out = [];
      let cursor;
      do {
        const page = await env.STATUS_KV.list({ prefix: "sub:", cursor, limit: 1000 });
        for (const k of page.keys) {
          const rec = await env.STATUS_KV.get(k.name, "json");
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
      const rec = await env.STATUS_KV.get(kvKey, "json");
      if (!rec) return json({ ok: false, error: "not_found" }, 404);
      if (rec.status !== "pending") return json({ ok: false, error: "already_moderated" }, 409);
      rec.status = action === "approve" ? "approved" : "rejected";
      rec.moderated_at = Date.now();
      await env.STATUS_KV.put(kvKey, JSON.stringify(rec));
      let pts = null;
      if (action === "approve") {
        pts = await addPoints(env, rec.phone, 50, "stations");
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
      const rec = await env.STATUS_KV.get("pts:" + phone, "json");
      return json({ ok: true, phone, total: rec ? rec.total || 0 : 0, reports: rec ? rec.reports || 0 : 0, stations: rec ? rec.stations || 0 : 0 });
    }

    return json({ ok: false, error: "not_found" }, 404);
  },
};
