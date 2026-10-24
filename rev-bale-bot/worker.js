/**
 * rev-bale-bot — بازوی بله «رانش EV» (فاز ۲)
 *
 * نقش‌ها:
 *  - کاربر: گزارش وضعیت شارژر با ۳ لمس (+عکس و تأیید جمعی)، شارژر نزدیک با سازگاری پورت خودرو،
 *    هشدار آزادی ایستگاه، درخواست امداد واقعی، ماشین‌حساب شارژ، فروشگاه Rev Part، خلاصه صبحگاهی
 *  - کاپیتان ایستگاه: کاربر تأییدشده مدیر برای یک ایستگاه (درخواست از داخل بات)
 *  - راننده یدک‌کش: اتصال حساب با توکن پنل، دیدن پیشنهادهای فعال و قبول/رد، ارسال موقعیت (heartbeat)
 *  - مدیر (فقط OWNER_ID): صف بررسی ایستگاه‌های ارسالی، گزارش امروز، انتشار در کانال با تأیید، مدیریت کاپیتان و فروشگاه
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

// ---------- فاز ۲: پورت شارژ و سازگاری ----------
export const PORTS = [
  { k: "ccs2", t: "CCS2" },
  { k: "gbt_dc", t: "GB/T سریع (DC)" },
  { k: "gbt_ac", t: "GB/T عادی (AC)" },
  { k: "type2", t: "Type 2" },
  { k: "chademo", t: "CHAdeMO" },
  { k: "type1", t: "Type 1" },
];
export const portLabel = (k) => (PORTS.find((p) => p.k === k) || {}).t || k || "—";

export function parsePorts(input) {
  const out = new Set();
  const walk = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === "object") return Object.values(v).forEach(walk);
    const s = String(v).toLowerCase();
    if (s.includes("ccs")) out.add("ccs2");
    if (s.includes("chademo")) out.add("chademo");
    if (s.includes("gb/t") || s.includes("gbt")) {
      if (s.includes("dc") || s.includes("سریع")) out.add("gbt_dc");
      else if (s.includes("ac") || s.includes("عادی")) out.add("gbt_ac");
      else { out.add("gbt_dc"); out.add("gbt_ac"); }
    }
    if (s.includes("type 2") || s.includes("type2") || s.includes("mennekes")) out.add("type2");
    if (s.includes("type 1") || s.includes("type1") || s.includes("j1772")) out.add("type1");
  };
  walk(input);
  return [...out];
}

export function stationCompatible(station, port) {
  if (!port) return true;
  const ps = parsePorts(station && (station.connectors ?? station.connector ?? station.ports));
  if (!ps.length) return true; // کانکتور نامشخص = سازگار فرض می‌شود تا داده کامل شود
  return ps.includes(port);
}

// ---------- فاز ۲: ماشین‌حساب شارژ (فرمول آموزشی رانش) ----------
export function consumptionKwh100(capacityKwh, rangeKm) {
  const c = Number(capacityKwh), r = Number(rangeKm);
  if (!isFinite(c) || !isFinite(r) || c <= 0 || r <= 0) return null;
  return Math.round((c / r) * 1000) / 10;
}

export const TOW_PROBLEMS = ["باتری خالی 🔋", "خرابی فنی ⚙️", "تصادف 🚧", "سایر"];

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
    [{ text: "🔌 شارژ و ایستگاه‌ها" }, { text: "🧭 سفر و امداد" }],
    [{ text: "🚗 ابزارهای خودرو" }, { text: "👤 حساب و خدمات" }],
  ],
  resize_keyboard: true,
};

const KB_OWNER = {
  keyboard: [
    [{ text: "📥 صف بررسی ایستگاه‌ها" }, { text: "📊 گزارش امروز" }],
    [{ text: "📣 پست در کانال" }, { text: "➕ افزودن کالا" }],
    [{ text: "👤 منوی کاربران" }],
  ],
  resize_keyboard: true,
};

const KB_CHARGING = {
  keyboard: [
    [{ text: "🔌 شارژر نزدیک" }, { text: "📍 گزارش وضعیت شارژر" }],
    [{ text: "🔙 بازگشت به منوی اصلی" }],
  ],
  resize_keyboard: true,
};

const KB_TRAVEL = {
  keyboard: [
    [{ text: "🧭 برنامه‌ریز سفر" }, { text: "🚨 درخواست امداد" }],
    [{ text: "🚕 بخش راننده" }, { text: "🔙 بازگشت به منوی اصلی" }],
  ],
  resize_keyboard: true,
};

const KB_TOOLS = {
  keyboard: [
    [{ text: "🧮 ماشین‌حساب شارژ" }, { text: "👤 حساب من" }],
    [{ text: "🔙 بازگشت به منوی اصلی" }],
  ],
  resize_keyboard: true,
};

const KB_SERVICES = {
  keyboard: [
    [{ text: "🛒 فروشگاه Rev Part" }, { text: "👤 حساب من" }],
    [{ text: "🔙 بازگشت به منوی اصلی" }],
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
  const res = await fetch(`${REV_API}/api/stations`);
  const j = await res.json();
  const list = Array.isArray(j.data) ? j.data : [];
  await kvPut(env, "cache:stations", { list }, STATION_CACHE_TTL);
  return list;
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

  if (flow === "tow_loc") { await createTowRequest(env, chatId, ses, loc); return; }
  if (flow === "home_loc") {
    const usr = (await getUser(env, chatId)) || {};
    await kvPut(env, `usr:${chatId}`, { ...usr, home: { lat: loc.latitude, lng: loc.longitude } });
    await clearSession(env, chatId);
    await send(env, chatId, "موقعیت خونه‌ت ذخیره شد 🏠 از این به بعد خلاصه صبحگاهی وضعیت شارژرهای نزدیکت رو می‌فرستم.", { reply_markup: kbFor(env, chatId) });
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
    const usr = await getUser(env, chatId);
    const myPort = usr && usr.car ? usr.car.port : null;
    const lines = near.map((s, i) => {
      const rec = live[stationKey(s.latitude, s.longitude)];
      const st = rec ? `${STATUS_LABEL[rec.s]} (${freshLabel(rec.at)})` : "بدون گزارش تازه";
      const compat = myPort ? (stationCompatible(s, myPort) ? " — ✓ با پورتت می‌خونه" : " — ⛔ با پورتت نمی‌خونه") : "";
      return `${i + 1}. ${s.name}\n📏 ${fmtDist(s.distM)} — ${st}${compat}`;
    });
    const rows = near.map((s) => {
      const key = stationKey(s.latitude, s.longitude);
      return [
        { text: `🔔 آزاد شد خبرم کن`, callback_data: `bell:${key}` },
        { text: "🎖 کاپیتان این ایستگاه", callback_data: `cap:apply:${key}` },
      ];
    });
    await send(env, chatId,
      "نزدیک‌ترین شارژرها:\n\n" + lines.join("\n\n") +
      "\n\nبا دکمه 🔔 هر ایستگاه، وقتی آزاد شد بهت خبر می‌دم؛ با 🎖 می‌تونی کاپیتان اون ایستگاه بشی.",
      { reply_markup: { inline_keyboard: rows } });
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
  await setSession(env, chatId, { ...ses, flow: "report_photo", status });
  await answerCb(env, cb.id);
  await editText(env, chatId, cb.message.message_id,
    `وضعیت «${STATUS_TEXT[status]}» انتخاب شد. عکس ایستگاه رو هم می‌فرستی؟ عکس، گزارشت رو برای تأیید جمعی به کاربرهای نزدیک نشون می‌ده و اعتبارش رو بالا می‌بره.`, {
      reply_markup: {
        inline_keyboard: [[
          { text: "📷 آره، عکس می‌فرستم", callback_data: "repgo:photo" },
          { text: "✅ بدون عکس ثبت کن", callback_data: "repgo:plain" },
        ]],
      },
    });
}

async function recordReporter(env, key, chatId) {
  const hist = (await kvGet(env, `hist:${key}`)) || [];
  const next = [chatId, ...hist.filter((c) => c !== chatId)].slice(0, 20);
  await kvPut(env, `hist:${key}`, next);
}

async function stationNameOf(env, key) {
  const stations = await fetchStations(env);
  const s = stations.find((x) => stationKey(x.latitude, x.longitude) === key);
  return s ? s.name : "ایستگاه";
}

async function notifyFreeSubscribers(env, key, reporterChatId) {
  const subs = (await kvGet(env, `sub:${key}`)) || [];
  if (!subs.length) return;
  const name = await stationNameOf(env, key);
  for (const c of subs) {
    if (c === reporterChatId) continue;
    await send(env, c, `🟢 خبر خوب! ایستگاه «${name}» همین الان آزاد گزارش شد.`);
  }
}

async function doReport(env, chatId, ses, photoFileId, editMsgId) {
  const usr = await getUser(env, chatId);
  const { status: code, j } = await jfetch(`${STATUS_API}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: ses.key, status: ses.status,
      name: "", phone: usr && usr.phone ? usr.phone : "",
      lat: ses.lat, lng: ses.lng,
    }),
  });
  await clearSession(env, chatId);
  const say = async (t) => {
    if (editMsgId) { try { await editText(env, chatId, editMsgId, t); return; } catch { /* fall through */ } }
    await send(env, chatId, t, { reply_markup: kbFor(env, chatId) });
  };
  if (j && j.ok) {
    const pts = typeof j.points === "number" ? `\nامتیازت الان: ${j.points}` : "";
    const capof = await kvGet(env, `capof:${chatId}`);
    const capTag = capof === ses.key ? " 🎖 (گزارش کاپیتان ایستگاه)" : "";
    await say(`گزارش «${STATUS_TEXT[ses.status]}» ثبت شد${capTag}. ممنون که نقشه رو زنده نگه می‌داری ⚡${pts}`);
    await recordReporter(env, ses.key, chatId);
    if (ses.status === "free") await notifyFreeSubscribers(env, ses.key, chatId);
    if (photoFileId) await startCrowdVerify(env, chatId, ses, photoFileId);
  } else if (j && j.error === "too_far") {
    await say(`گزارش ثبت نشد: حدود ${j.distance} متر از ایستگاه فاصله داری و ثبت فقط کنار خود شارژر قبول می‌شه (قانون ضدگزارش‌جعلی).`);
  } else {
    await say(`گزارش ثبت نشد (خطای ${j && j.error ? j.error : code}). چند دقیقه دیگه دوباره تلاش کن.`);
  }
}

// ---------- تأیید جمعی گزارش عکس‌دار ----------
async function startCrowdVerify(env, reporterChatId, ses, photoFileId) {
  const id = String(Date.now());
  const name = await stationNameOf(env, ses.key);
  await kvPut(env, `photo:${id}`, {
    key: ses.key, name, status: ses.status, fileId: photoFileId,
    reporter: reporterChatId, yes: [], no: [], done: false, at: Date.now(),
  }, 7 * 24 * 3600);
  const hist = (await kvGet(env, `hist:${ses.key}`)) || [];
  const targets = hist.filter((c) => c !== reporterChatId).slice(0, 5);
  for (const c of targets) {
    await bale(env, "sendPhoto", {
      chat_id: c, photo: photoFileId,
      caption: `📷 یه گزارش تازه برای «${name}»: وضعیت «${STATUS_TEXT[ses.status]}».\nاین عکس و گزارش رو تأیید می‌کنی؟`,
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ درسته", callback_data: `ver:y:${id}` },
          { text: "❌ درست نیست", callback_data: `ver:n:${id}` },
        ]],
      },
    });
  }
  if (targets.length) {
    await send(env, reporterChatId, "عکست برای تأیید جمعی به چند کاربر نزدیک ایستگاه فرستاده شد؛ نتیجه‌ش رو خبرت می‌کنم.");
  }
}

async function handleVerify(env, cb) {
  const chatId = cb.message.chat.id;
  const [, vote, id] = cb.data.split(":");
  const rec = await kvGet(env, `photo:${id}`);
  if (!rec || rec.done) { await answerCb(env, cb.id, "این رأی‌گیری تموم شده."); return; }
  if (rec.reporter === chatId) { await answerCb(env, cb.id, "گزارش خودته 🙂"); return; }
  if (rec.yes.includes(chatId) || rec.no.includes(chatId)) { await answerCb(env, cb.id, "قبلاً رأی دادی."); return; }
  rec[vote === "y" ? "yes" : "no"].push(chatId);
  await answerCb(env, cb.id, "رأی‌ت ثبت شد ✅");
  if (rec.yes.length >= 2 || rec.no.length >= 2) {
    rec.done = true;
    const verified = rec.yes.length >= 2;
    await send(env, rec.reporter, verified
      ? `🎖 گزارشت برای «${rec.name}» با تأیید جمعی کاربرها تأیید شد. آفرین، داده قابل‌اعتماد یعنی نقشه بهتر برای همه.`
      : `گزارش عکسی‌ت برای «${rec.name}» از طرف کاربرهای نزدیک تأیید نشد؛ اشکالی نداره، دفعه بعد با عکس واضح‌تر امتحان کن.`);
    if (!verified) await send(env, ownerId(env), `⚠️ گزارش عکس‌دار «${rec.name}» در تأیید جمعی رد شد (گزارش‌دهنده: ${rec.reporter}).`);
  }
  await kvPut(env, `photo:${id}`, rec, 7 * 24 * 3600);
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
  await send(env, chatId, "تنظیمات حساب:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🚗 ماشین من", callback_data: "car:show" }],
        [{ text: "🔔 هشدارهای ایستگاه من", callback_data: "subs:list" }],
        [{ text: "🏠 ثبت موقعیت خانه (خلاصه صبحگاهی)", callback_data: "home:set" }],
      ],
    },
  });
}

// ---------- فاز ۲: پروفایل خودرو، اشتراک‌ها، خانه ----------
const faNum = (s) => {
  const t = String(s || "")
    .replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
    .replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/[^0-9.]/g, "");
  const n = Number(t);
  return isFinite(n) && t !== "" ? n : null;
};

const portPickerKb = () => ({
  inline_keyboard: PORTS.map((p) => [{ text: p.t, callback_data: `port:${p.k}` }]),
});

async function handleProfileCb(env, cb) {
  const chatId = cb.message.chat.id;
  const data = cb.data;
  const usr = (await getUser(env, chatId)) || {};

  if (data === "car:show") {
    await answerCb(env, cb.id);
    if (usr.car && (usr.car.model || usr.car.port)) {
      await send(env, chatId,
        `ماشین تو\nمدل: ${usr.car.model || "—"}\nپورت شارژ: ${portLabel(usr.car.port)}\n\nاز این به بعد توی «شارژر نزدیک» سازگاری هر ایستگاه با پورتت رو نشون می‌دم.`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔌 تغییر پورت", callback_data: "port:menu" }],
              [{ text: "✏️ تغییر مدل", callback_data: "car:model" }],
            ],
          },
        });
    } else {
      await setSession(env, chatId, { flow: "car_model", at: Date.now() });
      await send(env, chatId, "مدل ماشینت رو بنویس (مثل: KMC E50A):");
    }
    return;
  }
  if (data === "car:model") {
    await setSession(env, chatId, { flow: "car_model", at: Date.now() });
    await answerCb(env, cb.id);
    await send(env, chatId, "مدل ماشینت رو بنویس:");
    return;
  }
  if (data === "port:menu") {
    await answerCb(env, cb.id);
    await send(env, chatId, "پورت شارژ ماشینت کدومه؟", { reply_markup: portPickerKb() });
    return;
  }
  if (data.startsWith("port:")) {
    const port = data.slice("port:".length);
    usr.car = { ...(usr.car || {}), port };
    await kvPut(env, `usr:${chatId}`, usr);
    await answerCb(env, cb.id, "ذخیره شد ✅");
    await send(env, chatId, `پورت «${portLabel(port)}» ذخیره شد ✅`, { reply_markup: kbFor(env, chatId) });
    return;
  }
  if (data === "subs:list") {
    await answerCb(env, cb.id);
    const keys = Array.isArray(usr.subs) ? usr.subs : [];
    if (!keys.length) { await send(env, chatId, "هنوز برای هیچ ایستگاهی هشدار آزادی فعال نکردی. از «شارژر نزدیک» دکمه 🔔 رو بزن."); return; }
    const rows = [];
    for (const k of keys) rows.push([{ text: `🔕 خاموش‌کردن: ${await stationNameOf(env, k)}`, callback_data: `unbell:${k}` }]);
    await send(env, chatId, "هشدارهای فعال تو:", { reply_markup: { inline_keyboard: rows } });
    return;
  }
  if (data === "home:set") {
    await setSession(env, chatId, { flow: "home_loc", at: Date.now() });
    await answerCb(env, cb.id);
    await send(env, chatId, "موقعیت خونه‌ت رو بفرست:", { reply_markup: KB_LOCATION });
  }
}

// ---------- فاز ۲: کاپیتان ایستگاه ----------
async function handleCaptain(env, cb) {
  const chatId = cb.message.chat.id;
  const data = cb.data;

  if (data.startsWith("cap:apply:")) {
    const key = data.slice("cap:apply:".length);
    const existing = await kvGet(env, `cap:${key}`);
    if (existing && existing.chatId !== chatId) { await answerCb(env, cb.id, "این ایستگاه کاپیتان داره."); return; }
    const mine = await kvGet(env, `capof:${chatId}`);
    if (mine && mine !== key) { await answerCb(env, cb.id, "تو کاپیتان یه ایستگاه دیگه‌ای."); return; }
    const id = String(Date.now());
    const usr = await getUser(env, chatId);
    await kvPut(env, `capapp:${id}`, { key, chatId, name: (usr && usr.name) || "", phone: (usr && usr.phone) || "" }, 3 * 24 * 3600);
    const name = await stationNameOf(env, key);
    await answerCb(env, cb.id, "درخواست رفت برای مدیر 🎖");
    await send(env, chatId, `درخواست کاپیتانی «${name}» برای مدیر فرستاده شد؛ نتیجه رو همین‌جا خبرت می‌کنم.`);
    await send(env, ownerId(env), `🎖 درخواست کاپیتانی\nایستگاه: ${name}\nکاربر: ${chatId}${usr && usr.phone ? ` — ${usr.phone}` : ""}`, {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ قبول", callback_data: `cap:ok:${id}` },
          { text: "❌ رد", callback_data: `cap:no:${id}` },
        ]],
      },
    });
    return;
  }

  if (chatId !== ownerId(env)) { await answerCb(env, cb.id, "فقط مدیر."); return; }
  const [, action, id] = data.split(":");
  const app = await kvGet(env, `capapp:${id}`);
  if (!app) { await answerCb(env, cb.id, "درخواست منقضی شده."); return; }
  await env.BOT_KV.delete(`capapp:${id}`);
  const name = await stationNameOf(env, app.key);
  if (action === "ok") {
    await kvPut(env, `cap:${app.key}`, { chatId: app.chatId, since: Date.now() });
    await kvPut(env, `capof:${app.chatId}`, app.key);
    await answerCb(env, cb.id, "کاپیتان شد 🎖");
    await editText(env, chatId, cb.message.message_id, `🎖 کاپیتان «${name}» مشخص شد: ${app.chatId}`);
    await send(env, app.chatId, `🎖 تبریک! کاپیتان ایستگاه «${name}» شدی.\nاز این به بعد گزارش‌هات با نشان کاپیتان ثبت می‌شن و هر هفته یادآوری گزارش وضعیت ایستگاهت رو می‌گیری.`);
  } else {
    await answerCb(env, cb.id, "رد شد");
    await editText(env, chatId, cb.message.message_id, `درخواست کاپیتانی «${name}» رد شد.`);
    await send(env, app.chatId, `درخواست کاپیتانی «${name}» این بار قبول نشد؛ با چند گزارش دقیق دیگه دوباره تلاش کن.`);
  }
}

// ---------- فاز ۲: ماشین‌حساب شارژ ----------
async function startCalc(env, chatId) {
  await setSession(env, chatId, { flow: "calc_cap", at: Date.now() });
  await send(env, chatId, "🧮 ماشین‌حساب شارژ رانش\nظرفیت باتری ماشینت چنده؟ (کیلووات‌ساعت — مثل 50.3):");
}

async function handleCalcCb(env, cb) {
  const chatId = cb.message.chat.id;
  if (cb.data === "calc:cost") {
    const ses = await getSession(env, chatId);
    if (!ses || !ses.cons) { await answerCb(env, cb.id, "منقضی شده."); return; }
    await setSession(env, chatId, { ...ses, flow: "calc_tariff" });
    await answerCb(env, cb.id);
    await send(env, chatId, "تعرفه برق رو چند حساب کنم؟ (ریال به‌ازای هر کیلووات‌ساعت):");
  }
}

async function handlePhoneInput(env, chatId, text) {
  const phone = text.trim();
  if (!validPhone(phone)) {
    await send(env, chatId, "این شماره درست به نظر نمیاد. با فرمت 09 و ۱۱ رقم بفرست:");
    return;
  }
  const ses = await getSession(env, chatId);
  const usr = (await getUser(env, chatId)) || {};
  await kvPut(env, `usr:${chatId}`, { ...usr, phone });
  await clearSession(env, chatId);
  await send(env, chatId, "شماره‌ت ذخیره شد ✅", { reply_markup: kbFor(env, chatId) });
  if (ses && ses.next === "tow") { await handleTowHome(env, chatId); return; }
  await handleAccount(env, chatId);
}

// ---------- هشدار آزادی ایستگاه ----------
async function handleBell(env, cb) {
  const chatId = cb.message.chat.id;
  const key = cb.data.slice("bell:".length);
  const subs = (await kvGet(env, `sub:${key}`)) || [];
  const usr = (await getUser(env, chatId)) || {};
  const mine = Array.isArray(usr.subs) ? usr.subs : [];
  if (subs.includes(chatId)) { await answerCb(env, cb.id, "از قبل برات فعاله 🔔"); return; }
  subs.push(chatId);
  await kvPut(env, `sub:${key}`, subs.slice(-200));
  if (!mine.includes(key)) mine.push(key);
  await kvPut(env, `usr:${chatId}`, { ...usr, subs: mine.slice(-20) });
  const name = await stationNameOf(env, key);
  await answerCb(env, cb.id, "فعال شد 🔔");
  await send(env, chatId, `حله! هر وقت ایستگاه «${name}» آزاد گزارش بشه، همین‌جا خبرت می‌کنم.`, { reply_markup: kbFor(env, chatId) });
}

async function handleUnbell(env, cb) {
  const chatId = cb.message.chat.id;
  const key = cb.data.slice("unbell:".length);
  const subs = ((await kvGet(env, `sub:${key}`)) || []).filter((c) => c !== chatId);
  await kvPut(env, `sub:${key}`, subs);
  const usr = (await getUser(env, chatId)) || {};
  usr.subs = (Array.isArray(usr.subs) ? usr.subs : []).filter((k) => k !== key);
  await kvPut(env, `usr:${chatId}`, usr);
  await answerCb(env, cb.id, "هشدار خاموش شد");
}

// ---------- امداد (سمت کاربر) ----------
async function towStatusText(env, chatId) {
  const act = await kvGet(env, `tow:${chatId}`);
  if (!act || !act.reqId) return null;
  const { j } = await jfetch(`${TOW_API}/api/tow/status?id=${encodeURIComponent(act.reqId)}`);
  if (!j || !j.ok) return { act, text: "نتونستم وضعیت درخواستت رو بگیرم؛ چند دقیقه دیگه «وضعیت» رو بزن." };
  const done = ["انجام شد", "لغو شد"].includes(j.status);
  if (done) await env.BOT_KV.delete(`tow:${chatId}`);
  const lines = [
    `🚨 درخواست امداد ${act.reqId}`,
    `وضعیت: ${j.status}`,
    j.driver ? `راننده: ${j.driver.name || ""}${j.driver.phone ? ` — ${j.driver.phone}` : ""}` : null,
    j.serviceCode ? `کد امداد: ${j.serviceCode}` : null,
    done ? null : "موقعیت زنده راننده رو توی آپ REV می‌بینی.",
  ].filter(Boolean);
  return { act, text: lines.join("\n"), done };
}

async function handleTowHome(env, chatId) {
  const st = await towStatusText(env, chatId);
  if (st) {
    await send(env, chatId, st.text, st.done ? { reply_markup: kbFor(env, chatId) } : {
      reply_markup: {
        inline_keyboard: [[
          { text: "🔄 وضعیت", callback_data: "tow:status" },
          { text: "❌ لغو درخواست", callback_data: "tow:cancel" },
        ]],
      },
    });
    return;
  }
  const usr = await getUser(env, chatId);
  if (!usr || !usr.phone) {
    await setSession(env, chatId, { flow: "phone", next: "tow", at: Date.now() });
    await send(env, chatId, "برای ثبت درخواست امداد، اول شماره موبایلت رو بفرست (مثل 09123456789):");
    return;
  }
  if (!usr.name) {
    await setSession(env, chatId, { flow: "tow_name", at: Date.now() });
    await send(env, chatId, "اسمت رو بفرست (راننده با این اسم پیدات می‌کنه):");
    return;
  }
  await setSession(env, chatId, { flow: "tow_problem", at: Date.now() });
  await send(env, chatId, "مشکل چیه؟", {
    reply_markup: {
      inline_keyboard: TOW_PROBLEMS.map((p) => [{ text: p, callback_data: `tow:prob:${p}` }]),
    },
  });
}

async function createTowRequest(env, chatId, ses, loc) {
  const usr = await getUser(env, chatId);
  const { status, j } = await jfetch(`${TOW_API}/api/tow/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: usr.name || "کاربر بله", phone: usr.phone,
      car: usr.car && usr.car.model ? usr.car.model : "",
      problem: ses.problem || "سایر",
      loc: "ثبت‌شده از بازوی بله",
      gps: { lat: loc.latitude, lng: loc.longitude },
    }),
  });
  await clearSession(env, chatId);
  if (j && j.ok && j.id) {
    await kvPut(env, `tow:${chatId}`, { reqId: j.id, at: Date.now() }, 24 * 3600);
    await send(env, chatId,
      `درخواستت ثبت شد ✅ (کد: ${j.id})\nوضعیت: ${j.status || "ثبت شد"}\n\nبه محض قبول راننده، از دکمه «درخواست امداد» وضعیت و مشخصاتش رو می‌بینی؛ موقعیت زنده‌ش هم توی آپ REV هست.`,
      { reply_markup: kbFor(env, chatId) });
    await send(env, ownerId(env), `🚨 درخواست امداد تازه از بله: ${j.id} — ${usr.name || ""} (${usr.phone})`);
  } else {
    await send(env, chatId, `ثبت درخواست انجام نشد (${j && j.err ? j.err : status}). چند دقیقه دیگه دوباره تلاش کن.`, { reply_markup: kbFor(env, chatId) });
  }
}

async function handleTowCb(env, cb) {
  const chatId = cb.message.chat.id;
  const data = cb.data;
  if (data.startsWith("tow:prob:")) {
    const ses = await getSession(env, chatId);
    if (!ses || ses.flow !== "tow_problem") { await answerCb(env, cb.id, "منقضی شده؛ از منو دوباره شروع کن."); return; }
    await setSession(env, chatId, { flow: "tow_loc", problem: data.slice("tow:prob:".length), at: Date.now() });
    await answerCb(env, cb.id);
    await send(env, chatId, "حالا موقعیتت رو بفرست تا نزدیک‌ترین راننده پیدات کنه:", { reply_markup: KB_LOCATION });
    return;
  }
  if (data === "tow:status") {
    const st = await towStatusText(env, chatId);
    await answerCb(env, cb.id);
    if (st) await editText(env, chatId, cb.message.message_id, st.text, st.done ? {} : {
      reply_markup: {
        inline_keyboard: [[
          { text: "🔄 وضعیت", callback_data: "tow:status" },
          { text: "❌ لغو درخواست", callback_data: "tow:cancel" },
        ]],
      },
    });
    return;
  }
  if (data === "tow:cancel") {
    const act = await kvGet(env, `tow:${chatId}`);
    const usr = await getUser(env, chatId);
    if (act && usr && usr.phone) {
      await jfetch(`${TOW_API}/api/tow/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: act.reqId, phone: usr.phone }),
      });
    }
    await env.BOT_KV.delete(`tow:${chatId}`);
    await answerCb(env, cb.id, "لغو شد");
    await editText(env, chatId, cb.message.message_id, "درخواست امداد لغو شد.");
  }
}

// ---------- فاز ۲: فروشگاه Rev Part (ثبت سفارش؛ پرداخت درون‌رباتی قدم بعدی) ----------
const fmtPrice = (n) => `${Number(n || 0).toLocaleString("fa-IR")} تومان`;

async function handleShopHome(env, chatId) {
  const catalog = (await kvGet(env, "shop:catalog")) || [];
  if (!catalog.length) {
    await send(env, chatId,
      "🛒 فروشگاه Rev Part به‌زودی با قطعات و لوازم خودروهای برقی راه می‌افته.\nفعلاً برای سفارش و استعلام، از پشتیبانی امداد (داخل آپ) پیام بده.",
      { reply_markup: kbFor(env, chatId) });
    return;
  }
  const rows = catalog.map((it) => [{ text: `${it.name} — ${fmtPrice(it.price)}`, callback_data: `shop:buy:${it.id}` }]);
  await send(env, chatId, "🛒 فروشگاه Rev Part\nبرای ثبت سفارش روی کالا بزن؛ پشتیبانی برای هماهنگی و پرداخت باهات تماس می‌گیره.", {
    reply_markup: { inline_keyboard: rows },
  });
}

async function handleShopCb(env, cb) {
  const chatId = cb.message.chat.id;
  const data = cb.data;
  if (data.startsWith("shop:buy:")) {
    const id = data.slice("shop:buy:".length);
    const catalog = (await kvGet(env, "shop:catalog")) || [];
    const item = catalog.find((x) => String(x.id) === id);
    if (!item) { await answerCb(env, cb.id, "این کالا دیگه نیست."); return; }
    const usr = await getUser(env, chatId);
    const oid = String(Date.now());
    await kvPut(env, `ord:${oid}`, {
      itemId: item.id, name: item.name, price: item.price,
      chatId, phone: (usr && usr.phone) || "", status: "new", at: Date.now(),
    }, 30 * 24 * 3600);
    await answerCb(env, cb.id, "سفارش ثبت شد ✅");
    await send(env, chatId, `سفارشت ثبت شد ✅\n${item.name} — ${fmtPrice(item.price)}\nکد سفارش: ${oid}\nپشتیبانی به‌زودی برای هماهنگی و پرداخت تماس می‌گیره.`);
    await send(env, ownerId(env), `🛒 سفارش تازه Rev Part\n${item.name} — ${fmtPrice(item.price)}\nکد: ${oid}\nمشتری: ${chatId}${usr && usr.phone ? ` — ${usr.phone}` : " (شماره نداده)"}`, {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ انجام شد", callback_data: `ord:done:${oid}` },
          { text: "❌ لغو", callback_data: `ord:cancel:${oid}` },
        ]],
      },
    });
    return;
  }
  if (data.startsWith("ord:")) {
    if (chatId !== ownerId(env)) { await answerCb(env, cb.id, "فقط مدیر."); return; }
    const [, action, oid] = data.split(":");
    const ord = await kvGet(env, `ord:${oid}`);
    if (!ord) { await answerCb(env, cb.id, "سفارش پیدا نشد."); return; }
    ord.status = action === "done" ? "done" : "cancelled";
    await kvPut(env, `ord:${oid}`, ord, 30 * 24 * 3600);
    await answerCb(env, cb.id, action === "done" ? "انجام شد ✅" : "لغو شد");
    await editText(env, chatId, cb.message.message_id, cb.message.text + (action === "done" ? "\n\n✅ انجام شد." : "\n\n❌ لغو شد."));
    await send(env, ord.chatId, action === "done"
      ? `✅ سفارشت (${ord.name}) انجام شد. ممنون از خریدت از Rev Part ⚡`
      : `سفارشت (${ord.name}) لغو شد؛ اگه اشتباهی شده به پشتیبانی بگو.`);
  }
}

// ---------- فاز ۲: خلاصه صبحگاهی (کرون ورکر: ۰۷:۰۰ تهران) ----------
async function runDigest(env, onlyChatId = null) {
  const live = await fetchLiveStatus();
  const stations = await fetchStations(env);
  let sent = 0;
  const keys = onlyChatId ? [{ name: `usr:${onlyChatId}` }] : (await env.BOT_KV.list({ prefix: "usr:", limit: 1000 })).keys;
  for (const k of keys) {
    const chatId = Number(k.name.slice(4));
    const usr = await kvGet(env, k.name);
    if (!usr || !usr.home) continue;
    const near = nearestStations(stations, usr.home.lat, usr.home.lng, 3, 3000);
    const lines = [];
    for (const s of near) {
      const rec = live[stationKey(s.latitude, s.longitude)];
      if (rec) lines.push(`• ${s.name}: ${STATUS_LABEL[rec.s]} (${freshLabel(rec.at)})`);
    }
    if (!lines.length) continue;
    let text = "☀️ صبح بخیر! وضعیت شارژرهای نزدیکت:\n" + lines.join("\n");
    const capKey = await kvGet(env, `capof:${chatId}`);
    if (capKey) {
      const capName = await stationNameOf(env, capKey);
      const rec = live[capKey];
      text += `\n\n🎖 ایستگاه تو «${capName}»: ${rec ? STATUS_LABEL[rec.s] + " (" + freshLabel(rec.at) + ")" : "گزارش تازه‌ای نداره"} — امروز یه گزارش ازش بزن.`;
    }
    await send(env, chatId, text);
    sent++;
  }
  return sent;
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
  const r = await bale(env, "sendMessage", {
    chat_id: env.CHANNEL_ID, text: draft.text,
    reply_markup: {
      inline_keyboard: [[
        { text: "🤖 بازوی رانش EV", url: "https://ble.ir/raneshevbot" },
        { text: "🌐 آپ REV", url: "https://mojtabaalimi64-cloud.github.io/rev-mobile/" },
      ]],
    },
  });
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
  if (msg.photo && msg.photo.length) {
    const ses = await getSession(env, chatId);
    if (ses && ses.flow === "await_photo") {
      const f = msg.photo[msg.photo.length - 1];
      await doReport(env, chatId, ses, f.file_id, null);
    }
    return;
  }
  if (!text) return;

  if (text === "/start") {
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

  // هر انتخاب منویی، جریان قبلی را قطع می‌کند تا پاسخ بعدی به سؤال قدیمی نچسبد.
  const topLevelActions = new Set([
    "📍 گزارش وضعیت شارژر", "🔌 شارژر نزدیک", "🚨 درخواست امداد", "🚕 بخش راننده",
    "🧮 ماشین‌حساب شارژ", "🧭 برنامه‌ریز سفر", "🛒 فروشگاه Rev Part", "👤 حساب من",
    "➕ افزودن کالا", "📥 صف بررسی ایستگاه‌ها", "📊 گزارش امروز", "📣 پست در کانال",
    "🔌 شارژ و ایستگاه‌ها", "🧭 سفر و امداد", "🚗 ابزارهای خودرو", "👤 حساب و خدمات",
    "👤 منوی کاربران", "🔙 بازگشت", "🔙 بازگشت به منوی اصلی",
  ]);
  if (topLevelActions.has(text)) await clearSession(env, chatId);

  const ses = await getSession(env, chatId);
  if (ses && ses.flow === "phone") { await handlePhoneInput(env, chatId, text); return; }
  if (ses && ses.flow === "driver_token") { await handleDriverToken(env, chatId, text); return; }
  if (ses && ses.flow === "tow_name") {
    if (text.trim().length < 2) { await send(env, chatId, "اسم رو کامل‌تر بفرست:"); return; }
    const usr = (await getUser(env, chatId)) || {};
    await kvPut(env, `usr:${chatId}`, { ...usr, name: text.trim() });
    await clearSession(env, chatId);
    await handleTowHome(env, chatId);
    return;
  }
  if (ses && ses.flow === "car_model") {
    const usr = (await getUser(env, chatId)) || {};
    usr.car = { ...(usr.car || {}), model: text.trim() };
    await kvPut(env, `usr:${chatId}`, usr);
    await clearSession(env, chatId);
    await send(env, chatId, "مدل ذخیره شد ✅ حالا پورت شارژ ماشینت رو انتخاب کن:", { reply_markup: portPickerKb() });
    return;
  }
  if (ses && ses.flow === "calc_cap") {
    const cap = faNum(text);
    if (!cap) { await send(env, chatId, "عدد کیلووات‌ساعت رو بفرست (مثل 50.3):"); return; }
    await setSession(env, chatId, { flow: "calc_range", cap });
    await send(env, chatId, "برد واقعی ماشینت با یه شارژ کامل چقدره؟ (کیلومتر):");
    return;
  }
  if (ses && ses.flow === "calc_range") {
    const range = faNum(text);
    const cons = consumptionKwh100(ses.cap, range);
    if (!cons) { await send(env, chatId, "عدد کیلومتر رو درست بفرست:"); return; }
    await setSession(env, chatId, { flow: "calc_done", cap: ses.cap, range, cons });
    await send(env, chatId,
      `مصرف ماشینت: ${cons} کیلووات‌ساعت در هر ۱۰۰ کیلومتر\n\nفرمولش همینه (یاد بگیر، همه‌جا به کارت میاد):\nمصرف = ظرفیت باتری ÷ برد واقعی × ۱۰۰\n= ${ses.cap} ÷ ${range} × ۱۰۰`, {
        reply_markup: { inline_keyboard: [[{ text: "💰 هزینه رو هم حساب کن", callback_data: "calc:cost" }]] },
      });
    return;
  }
  if (ses && ses.flow === "calc_tariff") {
    const t = faNum(text);
    if (!t) { await send(env, chatId, "تعرفه رو عددی بفرست (ریال/kWh):"); return; }
    const per100 = Math.round(ses.cons * t);
    const full = Math.round(ses.cap * t);
    await clearSession(env, chatId);
    await send(env, chatId,
      `با تعرفه ${t.toLocaleString("fa-IR")} ریال:\nهزینه هر ۱۰۰ کیلومتر ≈ ${per100.toLocaleString("fa-IR")} ریال\nهزینه یه شارژ کامل ≈ ${full.toLocaleString("fa-IR")} ریال\n\n(هزینه = مصرف × تعرفه)`,
      { reply_markup: kbFor(env, chatId) });
    return;
  }
  if (ses && ses.flow === "shop_name") {
    await setSession(env, chatId, { flow: "shop_price", itemName: text.trim() });
    await send(env, chatId, "قیمتش چنده؟ (تومان):");
    return;
  }
  if (ses && ses.flow === "shop_price") {
    const price = faNum(text);
    if (!price) { await send(env, chatId, "قیمت رو عددی بفرست (تومان):"); return; }
    const catalog = (await kvGet(env, "shop:catalog")) || [];
    catalog.push({ id: String(Date.now()), name: ses.itemName, price });
    await kvPut(env, "shop:catalog", catalog);
    await clearSession(env, chatId);
    await send(env, chatId, `کالا به فروشگاه اضافه شد ✅\n${ses.itemName} — ${fmtPrice(price)}`, { reply_markup: KB_OWNER });
    return;
  }
  if (ses && ses.flow === "chanpost") {
    await clearSession(env, chatId);
    await makeChannelDraft(env, chatId, text);
    return;
  }

  switch (text) {
    case "🔌 شارژ و ایستگاه‌ها":
      await send(env, chatId, "شارژ و ایستگاه‌ها — یکی از گزینه‌ها را انتخاب کن:", { reply_markup: KB_CHARGING }); return;
    case "🧭 سفر و امداد":
      await send(env, chatId, "سفر و امداد — یکی از گزینه‌ها را انتخاب کن:", { reply_markup: KB_TRAVEL }); return;
    case "🚗 ابزارهای خودرو":
      await send(env, chatId, "ابزارهای خودرو — یکی از گزینه‌ها را انتخاب کن:", { reply_markup: KB_TOOLS }); return;
    case "👤 حساب و خدمات":
      await send(env, chatId, "حساب و خدمات — یکی از گزینه‌ها را انتخاب کن:", { reply_markup: KB_SERVICES }); return;
    case "👤 منوی کاربران":
      await send(env, chatId, "منوی کاربران:", { reply_markup: KB_USER }); return;
    case "🔙 بازگشت":
    case "🔙 بازگشت به منوی اصلی":
      await clearSession(env, chatId);
      await send(env, chatId, "منوی اصلی", { reply_markup: kbFor(env, chatId) }); return;
    case "📍 گزارش وضعیت شارژر": await askLocation(env, chatId, "report"); return;
    case "🔌 شارژر نزدیک": await askLocation(env, chatId, "nearby"); return;
    case "🚨 درخواست امداد": await handleTowHome(env, chatId); return;
    case "🚕 بخش راننده": await handleDriverHome(env, chatId); return;
    case "🧮 ماشین‌حساب شارژ": await startCalc(env, chatId); return;
    case "🧭 برنامه‌ریز سفر":
      await send(env, chatId, "برنامه‌ریز سفر برقی رانش — مسیریابی با توقف‌های شارژ، مخصوص ماشین برقی:", {
        reply_markup: { inline_keyboard: [[{ text: "🧭 باز کردن برنامه‌ریز سفر", url: "https://mojtabaalimi64-cloud.github.io/rev-mobile/trips.html" }]] },
      });
      return;
    case "🛒 فروشگاه Rev Part": await handleShopHome(env, chatId); return;
    case "➕ افزودن کالا":
      if (chatId === ownerId(env)) {
        await setSession(env, chatId, { flow: "shop_name", at: Date.now() });
        await send(env, chatId, "اسم کالای تازه رو بفرست:");
      }
      return;
    case "👤 حساب من": await handleAccount(env, chatId); return;
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
  const chatId = cb.message.chat.id;
  try {
    if (data.startsWith("pick:")) return await handlePick(env, cb);
    if (data.startsWith("repgo:")) {
      const ses = await getSession(env, chatId);
      if (!ses || ses.flow !== "report_photo") { await answerCb(env, cb.id, "منقضی شده."); return; }
      if (data === "repgo:photo") {
        await setSession(env, chatId, { ...ses, flow: "await_photo" });
        await answerCb(env, cb.id);
        await editText(env, chatId, cb.message.message_id, "عکس ایستگاه رو بفرست 📷");
      } else {
        await answerCb(env, cb.id);
        return await doReport(env, chatId, ses, null, cb.message.message_id);
      }
      return;
    }
    if (data.startsWith("rep:")) return await handleReport(env, cb);
    if (data.startsWith("bell:")) return await handleBell(env, cb);
    if (data.startsWith("unbell:")) return await handleUnbell(env, cb);
    if (data.startsWith("tow:")) return await handleTowCb(env, cb);
    if (data.startsWith("ver:")) return await handleVerify(env, cb);
    if (data.startsWith("car:") || data.startsWith("port:") || data.startsWith("subs:") || data.startsWith("home:")) return await handleProfileCb(env, cb);
    if (data.startsWith("cap:")) return await handleCaptain(env, cb);
    if (data.startsWith("calc:")) return await handleCalcCb(env, cb);
    if (data.startsWith("shop:") || data.startsWith("ord:")) return await handleShopCb(env, cb);
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
  // کرون ورکر: هر روز ۰۲:۳۰ UTC = ۰۶:۰۰ تهران (زمان‌بندی در داشبورد Cloudflare)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDigest(env).catch(() => {}));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "rev-bale-bot", v: 2 });
    }
    if (url.pathname === "/internal/notify" && request.method === "POST") {
      return handleInternal(env, request);
    }
    if (url.pathname === "/internal/digest" && request.method === "POST") {
      if (!env.INTERNAL_KEY || request.headers.get("x-internal-key") !== env.INTERNAL_KEY) {
        return new Response("unauthorized", { status: 401 });
      }
      let body = {};
      try { body = await request.json(); } catch { /* empty ok */ }
      const sent = await runDigest(env, body.chatId ? Number(body.chatId) : null);
      return Response.json({ ok: true, sent });
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
