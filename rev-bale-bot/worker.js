/**
 * rev-bale-bot — بازوی بله «رانش EV» (فاز ۱)
 *
 * نقش‌ها:
 *  - کاربر: گزارش وضعیت شارژر با ۳ لمس، شارژر نزدیک، حساب و امتیاز
 *  - راننده یدک‌کش: اتصال حساب با توکن پنل، دیدن پیشنهادهای فعال و قبول/رد، ارسال موقعیت (heartbeat)
 *  - مدیر (فقط OWNER_ID): صف بررسی ایستگاه‌های ارسالی، گزارش امروز، انتشار در کانال با تأیید
 *
 * اتصال‌ها:
 *  - وضعیت ایستگاه: rev-status-api (POST /report, GET /status, GET /submissions, POST /moderate, GET /points)
 *  - فهرست ایستگاه‌ها: rev-api (GET /api/stations)
 *  - دیسپچ یدک‌کش: rev-tow-dispatch (GET /api/driver/offers, POST /api/driver/respond, POST /api/driver/heartbeat, GET /api/support)
 *
 * سکرت‌ها (در داشبورد کلادفلر ست می‌شوند، هرگز در کد نیستند):
 *  BALE_TOKEN, STATUS_ADMIN_TOKEN, WEBHOOK_SECRET, INTERNAL_KEY
 * متغیرها: OWNER_ID (پیش‌فرض 1068481085), CHANNEL_ID (مثل @raneshev یا آی‌دی عددی کانال)
 * بایندینگ: KV با نام BOT_KV
 */

const BALE_API = "https://tapi.bale.ai";
const STATUS_API = "https://rev-status-api.mojtaba-alimi64.workers.dev";
const REV_API = "https://rev-api.mojtaba-alimi64.workers.dev";
const TOW_API = "https://rev-tow-dispatch.mojtaba-alimi64.workers.dev";
const DEFAULT_OWNER_ID = 1068481085;
const SESSION_TTL = 900; // ۱۵ دقیقه
const STATION_CACHE_TTL = 600; // ۱۰ دقیقه

const STATUS_LABEL = { free: "آزاد 🟢", busy: "اشغال 🟡", broken: "خراب 🔴" };
const STATUS_TEXT = { free: "آزاد", busy: "اشغال", broken: "خراب" };

// ---------- توابع خالص (قابل تست) ----------
export function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function stationKey(lat, lng) {
  return `g:${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
}

export function nearestStations(stations, lat, lng, limit = 5, maxM = 3000) {
  return stations
    .filter((s) => isFinite(s.latitude) && isFinite(s.longitude))
    .map((s) => ({ ...s, distM: Math.round(haversineM(lat, lng, s.latitude, s.longitude)) }))
    .filter((s) => s.distM <= maxM)
    .sort((a, b) => a.distM - b.distM)
    .slice(0, limit);
}

export function validPhone(p) {
  return typeof p === "string" && /^09\d{9}$/.test(p.trim());
}

function fmtDist(m) {
  return m < 1000 ? `${m} متر` : `${(m / 1000).toFixed(1)} کیلومتر`;
}

function freshLabel(at) {
  if (!at) return "";
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return "همین الان";
  if (mins < 60) return `${mins} دقیقه پیش`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} ساعت پیش` : `${Math.round(h / 24)} روز پیش`;
}

// ---------- کلاینت بله ----------
async function bale(env, method, params = {}) {
  const res = await fetch(`${BALE_API}/bot${env.BALE_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  try { return await res.json(); } catch { return { ok: false, status: res.status }; }
}

const send = (env, chatId, text, extra = {}) =>
  bale(env, "sendMessage", { chat_id: chatId, text, ...extra });

const answerCb = (env, id, text) =>
  bale(env, "answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });

const editText = (env, chatId, messageId, text, extra = {}) =>
  bale(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, ...extra });

// ---------- کیبوردها ----------
const KB_USER = {
  keyboard: [
    [{ text: "📍 گزارش وضعیت شارژر" }, { text: "🔌 شارژر نزدیک" }],
    [{ text: "🧭 مسیریابی" }, { text: "🚨 درخواست امداد" }],
    [{ text: "🚕 بخش راننده" }, { text: "👤 حساب من" }],
  ],
  resize_keyboard: true,
};

const KB_OWNER = {
  keyboard: [
    [{ text: "📥 صف بررسی ایستگاه‌ها" }, { text: "📊 گزارش امروز" }],
    [{ text: "📣 پست در کانال" }, { text: "📍 گزارش وضعیت شارژر" }],
    [{ text: "🧭 مسیریابی" }, { text: "🔌 شارژر نزدیک" }],
    [{ text: "🚨 درخواست امداد" }, { text: "🚕 بخش راننده" }],
    [{ text: "👤 حساب من" }],
  ],
  resize_keyboard: true,
};

const KB_LOCATION = {
  keyboard: [
    [{ text: "📍 ارسال موقعیت من", request_location: true }],
    [{ text: "🔙 بازگشت" }],
  ],
  resize_keyboard: true,
};

const kbFor = (env, chatId) => (chatId === ownerId(env) ? KB_OWNER : KB_USER);
const ownerId = (env) => Number(env.OWNER_ID || DEFAULT_OWNER_ID);

// ---------- KV ----------
const kvGet = async (env, k) => { try { return await env.BOT_KV.get(k, "json"); } catch { return null; } };
const kvPut = (env, k, v, ttl) =>
  env.BOT_KV.put(k, JSON.stringify(v), ttl ? { expirationTtl: ttl } : undefined);
const getUser = (env, chatId) => kvGet(env, `usr:${chatId}`);
const getDriver = (env, chatId) => kvGet(env, `drv:${chatId}`);
const getSession = (env, chatId) => kvGet(env, `ses:${chatId}`);
const setSession = (env, chatId, s) => kvPut(env, `ses:${chatId}`, s, SESSION_TTL);
const clearSession = (env, chatId) => env.BOT_KV.delete(`ses:${chatId}`);

// ---------- داده‌های بیرونی ----------
async function fetchStations(env) {
  const cached = await kvGet(env, "cache:stations");
  if (cached && Array.isArray(cached.list)) return cached.list;
  try {
    const res = await fetch(`${REV_API}/api/stations`, {
      headers: { Accept: "application/json", "User-Agent": "REV-BaleBot/1.0 (+https://www.revyab.ir)" },
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return [];
    const raw = await res.text();
    let j;
    try { j = JSON.parse(raw); }
    catch { return []; }
    const list = Array.isArray(j.data) ? j.data : [];
    if (list.length) await kvPut(env, "cache:stations", { list }, STATION_CACHE_TTL);
    return list;
  } catch {
    return [];
  }
}

async function fetchLiveStatus() {
  try {
    const res = await fetch(`${STATUS_API}/status`);
    return await res.json();
  } catch { return {}; }
}

async function jfetch(url, opts = {}) {
  const res = await fetch(url, opts);
  let j = null;
  try { j = await res.json(); } catch { /* ignore */ }
  return { status: res.status, j };
}

// ---------- Conversational route planning ----------
async function geocodeRoutePlace(place) {
  const errors = [];
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=ir&q=' + encodeURIComponent(place);
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'REV-BaleBot/1.0 (+https://www.revyab.ir)' },
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) errors.push('Nominatim HTTP ' + response.status);
    else {
      const rows = await response.json();
      if (Array.isArray(rows) && rows.length && Number.isFinite(Number(rows[0].lon)) && Number.isFinite(Number(rows[0].lat))) return [Number(rows[0].lon), Number(rows[0].lat)];
      errors.push('Nominatim: مقصد پیدا نشد');
    }
  } catch (e) { errors.push('Nominatim: ' + String(e && e.message || 'خطای اتصال')); }

  // Open-Meteo geocoder fallback. Only accept locations explicitly identified as Iran.
  try {
    const url = 'https://geocoding-api.open-meteo.com/v1/search?count=10&language=fa&format=json&name=' + encodeURIComponent(place);
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(7000) });
    if (!response.ok) errors.push('Open-Meteo HTTP ' + response.status);
    else {
      const data = await response.json();
      const results = Array.isArray(data.results) ? data.results : [];
      const match = results.find(x => String(x.country_code || '').toUpperCase() === 'IR' && Number.isFinite(Number(x.longitude)) && Number.isFinite(Number(x.latitude)));
      if (match) return [Number(match.longitude), Number(match.latitude)];
      errors.push('Open-Meteo: مقصدی در ایران پیدا نشد');
    }
  } catch (e) { errors.push('Open-Meteo: ' + String(e && e.message || 'خطای اتصال')); }

  // Photon fallback without the optional language parameter.
  try {
    const url = 'https://photon.komoot.io/api/?limit=5&q=' + encodeURIComponent(place + ', Iran');
    const response = await fetch(url, { headers: { Accept: 'application/geo+json' }, signal: AbortSignal.timeout(7000) });
    if (!response.ok) errors.push('Photon HTTP ' + response.status);
    else {
      const data = await response.json();
      const features = data && Array.isArray(data.features) ? data.features : [];
      const match = features.find(feature => {
        const props = feature && feature.properties || {};
        const country = String(props.countrycode || props.country_code || '').toUpperCase();
        const coords = feature && feature.geometry && feature.geometry.coordinates;
        return country === 'IR' && Array.isArray(coords) && Number.isFinite(Number(coords[0])) && Number.isFinite(Number(coords[1]));
      }) || features.find(feature => {
        const coords = feature && feature.geometry && feature.geometry.coordinates;
        return Array.isArray(coords) && Number.isFinite(Number(coords[0])) && Number.isFinite(Number(coords[1]));
      });
      if (match) return [Number(match.geometry.coordinates[0]), Number(match.geometry.coordinates[1])];
      errors.push('Photon: مقصد پیدا نشد');
    }
  } catch (e) { errors.push('Photon: ' + String(e && e.message || 'خطای اتصال')); }
  throw new Error('سرویس‌های مکان‌یابی مقصد پاسخ معتبر ندادند. (' + errors.join('; ') + ') مقصد را با نام شهر و نشانی دقیق‌تر بفرست.');
}
function routeDistanceKm(a, b) {
  const rad = n => n * Math.PI / 180;
  const dLat = rad(b[1] - a[1]), dLon = rad(b[0] - a[0]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(x)));
}
async function handleRouteDestination(env, chatId, place, ses) {
  await send(env, chatId, 'دارم مسیر و شارژرهای بین راه را بررسی می‌کنم…');
  try {
    const destination = await geocodeRoutePlace(place);
    const origin = ses.origin;
    const routePath = origin[0] + ',' + origin[1] + ';' + destination[0] + ',' + destination[1];
    const routeQuery = '?overview=full&geometries=geojson&steps=false';
    // دو سرویس عمومی به‌صورت پشتیبان؛ اگر یکی در دسترس نبود، دومی امتحان می‌شود.
    const routeEndpoints = [
      'https://router.project-osrm.org/route/v1/driving/' + routePath + routeQuery,
      'https://routing.openstreetmap.de/routed-car/route/v1/driving/' + routePath + routeQuery,
    ];
    let payload = null;
    const routeErrors = [];
    for (let i = 0; i < routeEndpoints.length; i++) {
      const endpoint = routeEndpoints[i];
      const providerName = i === 0 ? 'OSRM عمومی' : 'OSM routing جایگزین';
      try {
        const response = await fetch(endpoint, {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'REV-BaleBot/1.0 (+https://www.revyab.ir)',
            Referer: 'https://www.revyab.ir/',
          },
          signal: AbortSignal.timeout(12000),
        });
        if (!response.ok) {
          routeErrors.push(providerName + ': HTTP ' + response.status);
          continue;
        }
        const candidate = await response.json();
        if (candidate.code === 'Ok' && Array.isArray(candidate.routes) && candidate.routes.length) {
          payload = candidate;
          break;
        }
        routeErrors.push(providerName + ': ' + (candidate.message || candidate.code || 'پاسخ نامعتبر'));
      } catch (e) {
        routeErrors.push(providerName + ': ' + String(e && e.message || 'خطای اتصال'));
      }
    }
    if (!payload) throw new Error('سرویس‌های مسیر پاسخ ندادند (' + routeErrors.join('؛ ') + '). ممکن است دسترسی از سمت سرویس‌دهنده محدود شده باشد؛ کمی بعد دوباره تلاش کن.');
    const route = payload.routes[0], coords = route.geometry && route.geometry.coordinates || [];
    const stations = await fetchStations(env);
    const along = stations.map(st => {
      const point = [Number(st.longitude), Number(st.latitude)]; let distance = Infinity;
      const stride = Math.max(1, Math.floor(coords.length / 80));
      for (let i = 0; i < coords.length; i += stride) distance = Math.min(distance, routeDistanceKm(point, coords[i]));
      return { st, distance };
    }).filter(x => Number.isFinite(x.distance) && x.distance <= 8).sort((a, b) => a.distance - b.distance).slice(0, 5);
    const km = (route.distance / 1000).toFixed(1), mins = Math.round(route.duration / 60);
    const timeText = mins >= 60 ? Math.floor(mins / 60) + ' ساعت و ' + (mins % 60) + ' دقیقه' : mins + ' دقیقه';
    const mapUrl = 'https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=' + origin[1] + '%2C' + origin[0] + '%3B' + destination[1] + '%2C' + destination[0];
    const revUrl = 'https://mojtabaalimi64-cloud.github.io/rev-mobile/nearby-map.html?app=1&navstart=1&olat=' + encodeURIComponent(origin[1]) + '&olng=' + encodeURIComponent(origin[0]) + '&dlat=' + encodeURIComponent(destination[1]) + '&dlng=' + encodeURIComponent(destination[0]) + '&oname=' + encodeURIComponent('مبدأ ارسالی از بله') + '&dname=' + encodeURIComponent(place);
    const chargerText = along.length ? along.map((x, i) => (i + 1) + '. ' + (x.st.name || 'ایستگاه شارژ') + ' — حدود ' + x.distance.toFixed(1) + ' کیلومتر از نقاط نمونه مسیر').join('\n') : 'در داده فعلی REV، شارژری در فاصله تقریبی ۸ کیلومتری نقاط بررسی‌شده مسیر پیدا نشد.';
    await clearSession(env, chatId);
    await send(env, chatId, '🧭 خلاصه مسیر به ' + place + '\n\n📏 مسافت جاده‌ای: ' + km + ' کیلومتر\n⏱ زمان تخمینی: ' + timeText + '\n\n🔌 شارژرهای احتمالی نزدیک مسیر:\n' + chargerText + '\n\n⚠️ زمان و مسیر تخمینی‌اند؛ وضعیت و سازگاری شارژرها را پیش از حرکت بررسی کن. برای هدایت زنده و محاسبه مجدد مسیر از اپ REV استفاده کن.', { reply_markup: { inline_keyboard: [[{ text: '🧭 باز کردن مسیر در مسیریاب REV', url: revUrl }], [{ text: '🗺️ نمایش در نقشه جایگزین', url: mapUrl }]] }, disable_web_page_preview: true });
  } catch (error) {
    await clearSession(env, chatId);
    await send(env, chatId, 'مسیریابی انجام نشد: ' + String(error && error.message || 'خطای نامشخص') + '\nلطفاً مقصد را دقیق‌تر بنویس یا دوباره تلاش کن.', { reply_markup: kbFor(env, chatId) });
  }
}

// ---------- جریان کاربر: گزارش وضعیت و شارژر نزدیک ----------
async function askLocation(env, chatId, flow) {
  await setSession(env, chatId, { flow, at: Date.now() });
  await send(env, chatId,
    flow === "report"
      ? "برای گزارش وضعیت، باید کنار شارژر باشی (ثبت فقط در شعاع ۱۰۰ متری قبول می‌شه).\nموقعیتت رو بفرست:"
      : "موقعیتت رو بفرست تا نزدیک‌ترین شارژرها رو نشونت بدم:",
    { reply_markup: KB_LOCATION });
}

async function handleLocation(env, chatId, loc) {
  const ses = await getSession(env, chatId);
  const flow = ses && ses.flow ? ses.flow : "nearby";
  if (flow === "route_origin") {
    await setSession(env, chatId, { flow: "route_destination", origin: [Number(loc.longitude), Number(loc.latitude)], at: Date.now() });
    await send(env, chatId, "مبدأ دریافت شد 📍\nحالا مقصد را بنویس؛ مثلاً «تهران، میدان آزادی» یا «اصفهان، سی‌وسه‌پل».", { reply_markup: { keyboard: [[{ text: "🔙 بازگشت" }]], resize_keyboard: true } });
    return;
  }
  const stations = await fetchStations(env);
  const near = nearestStations(stations, loc.latitude, loc.longitude);

  if (!near.length) {
    await send(env, chatId, "توی شعاع ۳ کیلومتری‌ت ایستگاهی روی نقشه پیدا نکردم. اگه شارژری اینجاست که روی نقشه نیست، از بخش «ثبت جایگاه» آپ پیداش کن یا به پشتیبانی خبر بده.",
      { reply_markup: kbFor(env, chatId) });
    await clearSession(env, chatId);
    return;
  }

  if (flow === "nearby") {
    const live = await fetchLiveStatus();
    const lines = near.map((s, i) => {
      const rec = live[stationKey(s.latitude, s.longitude)];
      const st = rec ? `${STATUS_LABEL[rec.s]} (${freshLabel(rec.at)})` : "بدون گزارش تازه";
      return `${i + 1}. ${s.name}\n📏 ${fmtDist(s.distM)} — ${st}`;
    });
    await send(env, chatId, "نزدیک‌ترین شارژرها:\n\n" + lines.join("\n\n"), { reply_markup: kbFor(env, chatId) });
    await clearSession(env, chatId);
    return;
  }

  // flow === report: انتخاب ایستگاه با دکمه
  await setSession(env, chatId, { flow: "report_pick", lat: loc.latitude, lng: loc.longitude, at: Date.now() });
  const buttons = near.map((s) => [{
    text: `${s.name} (${fmtDist(s.distM)})`,
    callback_data: `pick:${stationKey(s.latitude, s.longitude)}`,
  }]);
  await send(env, chatId, "کدوم ایستگاه؟", {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function handlePick(env, cb) {
  const chatId = cb.message.chat.id;
  const ses = await getSession(env, chatId);
  if (!ses || ses.flow !== "report_pick") { await answerCb(env, cb.id, "این انتخاب منقضی شده؛ دوباره شروع کن."); return; }
  const key = cb.data.slice("pick:".length);
  await setSession(env, chatId, { ...ses, flow: "report_status", key });
  await answerCb(env, cb.id);
  await editText(env, chatId, cb.message.message_id, "وضعیت الان این ایستگاه چیه؟", {
    reply_markup: {
      inline_keyboard: [[
        { text: "آزاد 🟢", callback_data: "rep:free" },
        { text: "اشغال 🟡", callback_data: "rep:busy" },
        { text: "خراب 🔴", callback_data: "rep:broken" },
      ]],
    },
  });
}

async function handleReport(env, cb) {
  const chatId = cb.message.chat.id;
  const ses = await getSession(env, chatId);
  if (!ses || ses.flow !== "report_status" || !ses.key) { await answerCb(env, cb.id, "منقضی شده؛ دوباره شروع کن."); return; }
  const status = cb.data.slice("rep:".length);
  const usr = await getUser(env, chatId);
  const { status: code, j } = await jfetch(`${STATUS_API}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: ses.key, status,
      name: "", phone: usr && usr.phone ? usr.phone : "",
      lat: ses.lat, lng: ses.lng,
    }),
  });
  await clearSession(env, chatId);
  if (j && j.ok) {
    const pts = typeof j.points === "number" ? `\nامتیازت الان: ${j.points}` : "";
    await answerCb(env, cb.id, "ثبت شد ✅");
    await editText(env, chatId, cb.message.message_id,
      `گزارش «${STATUS_TEXT[status]}» ثبت شد. ممنون که نقشه رو زنده نگه می‌داری ⚡${pts}`);
  } else if (j && j.error === "too_far") {
    await answerCb(env, cb.id, "دوری از ایستگاه");
    await editText(env, chatId, cb.message.message_id,
      `گزارش ثبت نشد: حدود ${j.distance} متر از ایستگاه فاصله داری و ثبت فقط کنار خود شارژر قبول می‌شه (قانون ضدگزارش‌جعلی).`);
  } else {
    await answerCb(env, cb.id, "خطا در ثبت");
    await editText(env, chatId, cb.message.message_id,
      `گزارش ثبت نشد (خطای ${j && j.error ? j.error : code}). چند دقیقه دیگه دوباره تلاش کن.`);
  }
}

// ---------- حساب و امتیاز ----------
async function handleAccount(env, chatId) {
  const usr = await getUser(env, chatId);
  if (!usr || !usr.phone) {
    await setSession(env, chatId, { flow: "phone", at: Date.now() });
    await send(env, chatId, "برای دیدن امتیازت و اینکه امتیاز گزارش‌هات به حسابت بشینه، شماره موبایلت رو بفرست (مثل 09123456789):");
    return;
  }
  const { j } = await jfetch(`${STATUS_API}/points?phone=${encodeURIComponent(usr.phone)}`);
  if (j && j.ok && j.points) {
    const p = j.points;
    await send(env, chatId,
      `حساب تو\nشماره: ${usr.phone}\nامتیاز کل: ${p.total || 0}\nگزارش‌ها: ${p.reports || 0} — جایگاه‌های ثبت‌شده: ${p.stations || 0} — تأییدها: ${p.validations || 0}`,
      { reply_markup: kbFor(env, chatId) });
  } else {
    await send(env, chatId, "فعلاً امتیازی برات پیدا نکردم. اولین گزارش وضعیتت رو که ثبت کنی، امتیاز شروع می‌شه.", { reply_markup: kbFor(env, chatId) });
  }
}

async function handlePhoneInput(env, chatId, text) {
  const phone = text.trim();
  if (!validPhone(phone)) {
    await send(env, chatId, "این شماره درست به نظر نمیاد. با فرمت 09 و ۱۱ رقم بفرست:");
    return;
  }
  const usr = (await getUser(env, chatId)) || {};
  await kvPut(env, `usr:${chatId}`, { ...usr, phone });
  await clearSession(env, chatId);
  await send(env, chatId, "شماره‌ت ذخیره شد ✅", { reply_markup: kbFor(env, chatId) });
  await handleAccount(env, chatId);
}

// ---------- امداد (سمت کاربر) ----------
async function handleTowInfo(env, chatId) {
  const { j } = await jfetch(`${TOW_API}/api/support`);
  const phone = j && j.phone ? j.phone : (j && j.data && j.data.phone) || "";
  await send(env, chatId,
    "درخواست امداد از داخل آپ REV ثبت می‌شه تا نزدیک‌ترین راننده فعال پیدات کنه و موقعیتش رو زنده ببینی.\n" +
    (phone ? `شماره پشتیبانی امداد: ${phone}\n` : "") +
    "اگه راننده یدک‌کشی، از دکمه «بخش راننده» حسابت رو وصل کن.",
    { reply_markup: kbFor(env, chatId) });
}

// ---------- بخش راننده ----------
async function handleDriverHome(env, chatId) {
  const drv = await getDriver(env, chatId);
  if (!drv || !drv.token) {
    await setSession(env, chatId, { flow: "driver_token", at: Date.now() });
    await send(env, chatId,
      "برای وصل‌کردن حساب راننده‌ت، «توکن راننده» رو بفرست.\nتوکن رو از پنل راننده داخل آپ REV (بخش خدمات ← پنل راننده) می‌گیری. این توکن فقط برای اتصال این چت به حساب توئه و پیش خودت می‌مونه.");
    return;
  }
  await send(env, chatId, "بخش راننده", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📩 پیشنهادهای فعال", callback_data: "drv:offers" }],
        [{ text: "📍 ارسال موقعیت فعلی", callback_data: "drv:loc" }],
        [{ text: "❌ قطع اتصال حساب", callback_data: "drv:unlink" }],
      ],
    },
  });
}

async function handleDriverToken(env, chatId, text) {
  const token = text.trim();
  const { status, j } = await jfetch(`${TOW_API}/api/driver/offers?token=${encodeURIComponent(token)}`);
  if (status === 200 && j) {
    await kvPut(env, `drv:${chatId}`, { token, linkedAt: Date.now() });
    await clearSession(env, chatId);
    await send(env, chatId, "حسابت وصل شد ✅ از این به بعد پیشنهادهای امداد همین‌جا هم میاد.", { reply_markup: kbFor(env, chatId) });
    await handleDriverHome(env, chatId);
  } else {
    await send(env, chatId, "این توکن قبول نشد. از پنل راننده آپ دوباره کپی کن و بفرست:");
  }
}

async function driverOffersText(env, drv) {
  const { status, j } = await jfetch(`${TOW_API}/api/driver/offers?token=${encodeURIComponent(drv.token)}`);
  if (status !== 200 || !j) return { text: "نتونستم پیشنهادها رو بگیرم؛ چند دقیقه دیگه تلاش کن.", kb: null };
  const o = j.offer || j.data || null;
  if (!o || !o.request) return { text: "الان پیشنهاد فعالی نداری.", kb: null };
  const r = o.request;
  const lines = [
    "📩 پیشنهاد امداد",
    r.fromName || r.pickup ? `مبدأ: ${r.fromName || r.pickup}` : null,
    r.toName || r.dest ? `مقصد: ${r.toName || r.dest}` : null,
    r.car || r.vehicle ? `خودرو: ${r.car || r.vehicle}` : null,
    r.phone ? `تماس مشتری: ${r.phone}` : null,
  ].filter(Boolean);
  return {
    text: lines.join("\n"),
    kb: {
      inline_keyboard: [[
        { text: "✅ قبول", callback_data: `drv:acc:${o.reqId}` },
        { text: "❌ رد", callback_data: `drv:rej:${o.reqId}` },
      ]],
    },
    reqId: o.reqId,
  };
}

async function handleDriverCb(env, cb) {
  const chatId = cb.message.chat.id;
  const drv = await getDriver(env, chatId);
  const data = cb.data;

  if (data === "drv:unlink") {
    await env.BOT_KV.delete(`drv:${chatId}`);
    await answerCb(env, cb.id, "حساب قطع شد");
    await editText(env, chatId, cb.message.message_id, "اتصال حساب راننده قطع شد.");
    return;
  }
  if (!drv || !drv.token) { await answerCb(env, cb.id, "اول حسابت رو وصل کن."); return; }

  if (data === "drv:offers") {
    const { text, kb } = await driverOffersText(env, drv);
    await answerCb(env, cb.id);
    await send(env, chatId, text, kb ? { reply_markup: kb } : {});
    return;
  }
  if (data === "drv:loc") {
    await setSession(env, chatId, { flow: "driver_loc", at: Date.now() });
    await answerCb(env, cb.id);
    await send(env, chatId, "موقعیتت رو بفرست تا برای دیسپچ ثبت بشه:", { reply_markup: KB_LOCATION });
    return;
  }
  if (data.startsWith("drv:acc:") || data.startsWith("drv:rej:")) {
    const accept = data.startsWith("drv:acc:");
    const reqId = data.slice("drv:acc:".length);
    const { status, j } = await jfetch(`${TOW_API}/api/driver/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: drv.token, reqId, accept }),
    });
    if (status === 200 && j && (j.ok !== false)) {
      const code = j.code || (j.request && j.request.code) || (j.data && j.data.code);
      await answerCb(env, cb.id, accept ? "قبول شد ✅" : "رد شد");
      await editText(env, chatId, cb.message.message_id,
        accept
          ? `مأموریت قبول شد ✅${code ? `\nکد امداد: ${code}` : ""}\nموقعیتت رو از دکمه «ارسال موقعیت» زنده نگه دار.`
          : "پیشنهاد رد شد و به راننده بعدی می‌رسه.");
    } else {
      await answerCb(env, cb.id, "انجام نشد؛ شاید مهلتش گذشته.");
      await editText(env, chatId, cb.message.message_id, "این پیشنهاد دیگه فعال نیست (قبول یا منقضی شده).");
    }
  }
}

async function handleDriverLocation(env, chatId, loc) {
  const drv = await getDriver(env, chatId);
  if (!drv || !drv.token) return;
  await jfetch(`${TOW_API}/api/driver/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: drv.token, lat: loc.latitude, lng: loc.longitude }),
  });
  await clearSession(env, chatId);
  await send(env, chatId, "موقعیتت ثبت شد ✅", { reply_markup: kbFor(env, chatId) });
}

// ---------- بخش مدیر ----------
async function ownerPending(env, chatId) {
  if (!env.STATUS_ADMIN_TOKEN) {
    await send(env, chatId, "توکن مدیریت وضعیت روی ورکر ست نشده (STATUS_ADMIN_TOKEN).");
    return;
  }
  const { status, j } = await jfetch(
    `${STATUS_API}/submissions?token=${encodeURIComponent(env.STATUS_ADMIN_TOKEN)}`);
  if (status !== 200 || !j || !j.ok) {
    await send(env, chatId, `نتونستم صف بررسی رو بگیرم (خطای ${status}).`);
    return;
  }
  const subs = j.submissions || [];
  if (!subs.length) { await send(env, chatId, "صف بررسی خالیه ✅"); return; }
  await send(env, chatId, `${subs.length} جایگاه در صف بررسی:`);
  for (const s of subs.slice(0, 10)) {
    const text = [
      `📍 ${s.name || "بدون نام"}`,
      s.city ? `شهر: ${s.city}` : null,
      s.address ? `نشانی: ${s.address}` : null,
      s.power_kw ? `توان: ${s.power_kw} kW` : null,
      Array.isArray(s.connectors) && s.connectors.length ? `کانکتور: ${s.connectors.join("، ")}` : null,
      s.lat && s.lng ? `مختصات: ${s.lat}, ${s.lng}` : null,
      s.phone ? `ثبت‌کننده: ${s.phone}` : null,
    ].filter(Boolean).join("\n");
    await send(env, chatId, text, {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ تأیید", callback_data: `mod:approve:${s.id}` },
          { text: "❌ رد", callback_data: `mod:reject:${s.id}` },
        ]],
      },
    });
  }
}

async function handleModerate(env, cb) {
  const chatId = cb.message.chat.id;
  if (chatId !== ownerId(env)) { await answerCb(env, cb.id, "فقط مدیر."); return; }
  const [, action, id] = cb.data.split(":");
  const { status, j } = await jfetch(`${STATUS_API}/moderate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: env.STATUS_ADMIN_TOKEN, id, action }),
  });
  if (status === 200 && j && j.ok) {
    await answerCb(env, cb.id, action === "approve" ? "تأیید شد ✅" : "رد شد");
    await editText(env, chatId, cb.message.message_id,
      cb.message.text + (action === "approve" ? "\n\n✅ تأیید شد و به نقشه اضافه شد." : "\n\n❌ رد شد."));
  } else {
    await answerCb(env, cb.id, "انجام نشد");
    await send(env, chatId, `خطا در ${action === "approve" ? "تأیید" : "رد"}: ${j && j.error ? j.error : status}`);
  }
}

async function ownerReport(env, chatId) {
  const live = await fetchLiveStatus();
  const keys = Object.keys(live);
  const broken = keys.filter((k) => live[k].s === "broken");
  const lines = [
    "📊 گزارش امروز رانش EV",
    `گزارش وضعیت زنده روی نقشه: ${keys.length}`,
    `ایستگاه خراب گزارش‌شده: ${broken.length}`,
  ];
  if (broken.length) {
    lines.push("");
    lines.push("خراب‌ها:");
    for (const k of broken.slice(0, 8)) lines.push(`• ${live[k].name || k} (${freshLabel(live[k].at)})`);
  }
  if (env.STATUS_ADMIN_TOKEN) {
    const { j } = await jfetch(`${STATUS_API}/submissions?token=${encodeURIComponent(env.STATUS_ADMIN_TOKEN)}`);
    if (j && j.ok) lines.push(`\nصف بررسی ایستگاه‌ها: ${j.count || 0}`);
  }
  await send(env, chatId, lines.join("\n"), { reply_markup: KB_OWNER });
}

async function handleChannelPublish(env, cb) {
  const chatId = cb.message.chat.id;
  if (chatId !== ownerId(env)) { await answerCb(env, cb.id, "فقط مدیر."); return; }
  const [, action, id] = cb.data.split(":");
  const draft = await kvGet(env, `draft:${id}`);
  if (!draft) { await answerCb(env, cb.id, "پیش‌نویس منقضی شده."); return; }
  if (action === "no") {
    await env.BOT_KV.delete(`draft:${id}`);
    await answerCb(env, cb.id, "رد شد");
    await editText(env, chatId, cb.message.message_id, "پیش‌نویس رد شد و منتشر نشد.");
    return;
  }
  if (!env.CHANNEL_ID) {
    await answerCb(env, cb.id, "کانال ست نشده");
    await send(env, chatId, "CHANNEL_ID روی ورکر ست نشده؛ اول کانال رو بساز و آی‌دی یا نام کاربری‌ش رو به ورکر بده.");
    return;
  }
  const r = await bale(env, "sendMessage", { chat_id: env.CHANNEL_ID, text: draft.text });
  if (r && r.ok) {
    await env.BOT_KV.delete(`draft:${id}`);
    await answerCb(env, cb.id, "منتشر شد ✅");
    await editText(env, chatId, cb.message.message_id, "در کانال منتشر شد ✅");
  } else {
    await answerCb(env, cb.id, "خطا در انتشار");
    await send(env, chatId, "انتشار در کانال ناموفق بود. مطمئن شو بازو ادمین کاناله و CHANNEL_ID درسته.");
  }
}

async function makeChannelDraft(env, chatId, text) {
  const id = String(Date.now());
  await kvPut(env, `draft:${id}`, { text }, 3600);
  await send(env, chatId, "پیش‌نویس پست کانال:\n\n" + text, {
    reply_markup: {
      inline_keyboard: [[
        { text: "📣 انتشار در کانال", callback_data: `pub:ok:${id}` },
        { text: "❌ رد", callback_data: `pub:no:${id}` },
      ]],
    },
  });
}

// ---------- مسیریابی آپدیت‌ها ----------
async function handleMessage(env, msg) {
  const chatId = msg.chat.id;
  const text = typeof msg.text === "string" ? msg.text.trim() : "";

  if (msg.location) {
    const ses = await getSession(env, chatId);
    if (ses && ses.flow === "driver_loc") { await handleDriverLocation(env, chatId, msg.location); return; }
    await handleLocation(env, chatId, msg.location);
    return;
  }
  if (!text) return;

  if (text === "/start" || text === "/help" || text === "شروع" || text === "منوی اصلی") {
    await clearSession(env, chatId);
    const isOwner = chatId === ownerId(env);
    await send(env, chatId,
      "سلام! به بازوی رانش EV خوش اومدی ⚡\n\n" +
      "اینجا می‌تونی وضعیت شارژرها رو زنده گزارش بدی، شارژر نزدیک پیدا کنی و برای امداد و خدمات راننده‌ها هم از همین‌جا اقدام کنی.\n" +
      (isOwner ? "\nتو به‌عنوان مدیر وصل شدی؛ ابزارهای مدیریت توی کیبوردته." : "") +
      "\n\nرانش EV؛ مرجع واقعی خودروهای برقی ایران — آینده همین الانه.",
      { reply_markup: kbFor(env, chatId) });
    return;
  }

  const ses = await getSession(env, chatId);
  if (text === "🔙 بازگشت") {
    await clearSession(env, chatId);
    await send(env, chatId, "منوی اصلی", { reply_markup: kbFor(env, chatId) });
    return;
  }
  if (ses && ses.flow === "phone") { await handlePhoneInput(env, chatId, text); return; }
  if (ses && ses.flow === "route_destination") { await handleRouteDestination(env, chatId, text, ses); return; }
  if (ses && ses.flow === "driver_token") { await handleDriverToken(env, chatId, text); return; }
  if (ses && ses.flow === "chanpost") {
    await clearSession(env, chatId);
    await makeChannelDraft(env, chatId, text);
    return;
  }

  switch (text) {
    case "📍 گزارش وضعیت شارژر": await askLocation(env, chatId, "report"); return;
    case "🔌 شارژر نزدیک": await askLocation(env, chatId, "nearby"); return;
    case "🧭 مسیریابی":
      await setSession(env, chatId, { flow: "route_origin", at: Date.now() });
      await send(env, chatId, "برای محاسبه مسیر، مبدأ را با دکمه زیر به‌صورت موقعیت مکانی بفرست. بعد مقصد را می‌پرسم.", { reply_markup: KB_LOCATION });
      return;
    case "🚨 درخواست امداد": await handleTowInfo(env, chatId); return;
    case "🚕 بخش راننده": await handleDriverHome(env, chatId); return;
    case "👤 حساب من": await handleAccount(env, chatId); return;
    case "🔙 بازگشت":
      await clearSession(env, chatId);
      await send(env, chatId, "منوی اصلی", { reply_markup: kbFor(env, chatId) });
      return;
    case "📥 صف بررسی ایستگاه‌ها":
      if (chatId === ownerId(env)) await ownerPending(env, chatId);
      return;
    case "📊 گزارش امروز":
      if (chatId === ownerId(env)) await ownerReport(env, chatId);
      return;
    case "📣 پست در کانال":
      if (chatId === ownerId(env)) {
        await setSession(env, chatId, { flow: "chanpost", at: Date.now() });
        await send(env, chatId, "متن پست کانال رو بفرست؛ اول پیش‌نویسش رو برای تأییدت می‌سازم:");
      }
      return;
    default:
      await send(env, chatId, "از دکمه‌های منو استفاده کن؛ اگه کمکی خواستی بنویس «شروع» یا /start رو بزن.",
        { reply_markup: kbFor(env, chatId) });
  }
}

async function handleCallback(env, cb) {
  const data = cb.data || "";
  try {
    if (data.startsWith("pick:")) return await handlePick(env, cb);
    if (data.startsWith("rep:")) return await handleReport(env, cb);
    if (data.startsWith("mod:")) return await handleModerate(env, cb);
    if (data.startsWith("pub:")) return await handleChannelPublish(env, cb);
    if (data.startsWith("drv:")) return await handleDriverCb(env, cb);
    await answerCb(env, cb.id);
  } catch {
    try { await answerCb(env, cb.id, "یه خطایی پیش اومد."); } catch { /* ignore */ }
  }
}

async function handleUpdate(env, update) {
  if (update.message) await handleMessage(env, update.message);
  else if (update.callback_query) await handleCallback(env, update.callback_query);
}

// ---------- ورودی داخلی (از ورکر دیسپچ و بقیه سرویس‌ها) ----------
async function handleInternal(env, request) {
  if (!env.INTERNAL_KEY || request.headers.get("x-internal-key") !== env.INTERNAL_KEY) {
    return new Response("unauthorized", { status: 401 });
  }
  let body;
  try { body = await request.json(); } catch { return new Response("bad json", { status: 400 }); }

  if (body.type === "owner_alert" && body.text) {
    await send(env, ownerId(env), "🔔 " + String(body.text).slice(0, 3500));
    return Response.json({ ok: true });
  }
  if (body.type === "channel_post" && body.text) {
    await makeChannelDraft(env, ownerId(env), String(body.text).slice(0, 3500));
    return Response.json({ ok: true });
  }
  if (body.type === "tow_offer" && body.chatId) {
    const drv = await getDriver(env, Number(body.chatId));
    if (!drv || !drv.token) return Response.json({ ok: false, error: "driver_not_linked" }, 404);
    const { text, kb } = await driverOffersText(env, drv);
    await send(env, Number(body.chatId), "🚨 پیشنهاد امداد جدید\n\n" + text, kb ? { reply_markup: kb } : {});
    return Response.json({ ok: true });
  }
  return Response.json({ ok: false, error: "unknown_type" }, 400);
}

// ---------- ورودی اصلی ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);


    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "rev-bale-bot", v: 1 });
    }
    if (url.pathname === "/internal/notify" && request.method === "POST") {
      return handleInternal(env, request);
    }
    if (url.pathname.startsWith("/webhook/") && request.method === "POST") {
      const secret = url.pathname.slice("/webhook/".length);
      if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) {
        return new Response("not found", { status: 404 });
      }
      let update;
      try { update = await request.json(); } catch { return new Response("bad json", { status: 400 }); }
      ctx.waitUntil(handleUpdate(env, update).catch(() => {}));
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
};
