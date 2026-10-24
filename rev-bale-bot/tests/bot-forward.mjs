// Bot-side tests for automatic station registration from forwards (no network, no production data).
// Mocks Bale API + rev-api via global fetch, drives the real bot module through its webhook.
// Usage: node tests/bot-forward.mjs   (from rev-bale-bot/)
import assert from "node:assert/strict";
import bot, {
  isForwardedMessage, extractCoordsFromUrl, extractCoordsFromText, hasMapLink,
  extractPortsFromText, extractHoursFromText, extractStationName, findDuplicateStation,
} from "../worker.js";

let pass = 0;
const ok = (name, cond, extra = "") => {
  assert.ok(cond, name + " " + extra);
  pass++;
  console.log("PASS " + name);
};

class KVMock {
  constructor() { this.m = new Map(); }
  async get(k, type) {
    const v = this.m.get(k);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(k, v) { this.m.set(k, String(v)); }
  async delete(k) { this.m.delete(k); }
}

const sent = [];        // captured Bale sendMessage params
const cbAnswers = [];   // captured answerCallbackQuery params
const edits = [];       // captured editMessageText params
const revApiCalls = []; // captured rev-api calls {method, path, body}
let stationList = [];   // stubbed GET /api/stations data
let reviewShouldFail = false;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("tapi.bale.ai")) {
    const method = u.split("/").pop();
    let params = {};
    try { params = JSON.parse(opts.body || "{}"); } catch { /* ignore */ }
    if (method === "sendMessage") sent.push(params);
    if (method === "answerCallbackQuery") cbAnswers.push(params);
    if (method === "editMessageText") edits.push(params);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }
  if (u.includes("rev-api.mojtaba-alimi64.workers.dev")) {
    const path = u.replace("https://rev-api.mojtaba-alimi64.workers.dev", "");
    const method = opts.method || "GET";
    let body = null;
    try { body = opts.body ? JSON.parse(opts.body) : null; } catch { /* ignore */ }
    revApiCalls.push({ method, path, body, auth: (opts.headers || {}).Authorization || "" });
    if (method === "GET" && path === "/api/stations") {
      return new Response(JSON.stringify({ success: true, data: stationList }), { status: 200 });
    }
    if (method === "POST" && path === "/api/admin/stations") {
      return new Response(JSON.stringify({ success: true, data: { id: body.id } }), { status: 200 });
    }
    if (method === "POST" && path.endsWith("/review")) {
      if (reviewShouldFail) return new Response(JSON.stringify({ success: false, error: "nope" }), { status: 500 });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (method === "DELETE" && path.startsWith("/api/admin/stations/")) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: false, error: "nf" }), { status: 404 });
  }
  if (u.startsWith("https://n.sh/")) {
    // Short-link resolution: final URL carries coords (plain object with .url).
    return { ok: true, status: 200, url: "https://neshan.org/maps/@35.700000,51.400000,15z" };
  }
  return new Response(JSON.stringify({ ok: false }), { status: 404 });
};

const FAKE_TOKEN = "TEST-REV-ADMIN-TOKEN-123";
function makeEnv(extra = {}) {
  return {
    BOT_KV: new KVMock(), OWNER_ID: "999", WEBHOOK_SECRET: "test-secret",
    BALE_TOKEN: "test-bale", STATUS_ADMIN_TOKEN: "x", INTERNAL_KEY: "x",
    REV_API_ADMIN_TOKEN: FAKE_TOKEN, ...extra,
  };
}
async function driveWebhook(env, update) {
  const pending = [];
  const ctx = { waitUntil: (p) => { pending.push(p); } };
  const res = await bot.fetch(new Request("http://localhost/webhook/test-secret", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
  }), env, ctx);
  assert.equal(res.status, 200, "webhook must accept");
  await Promise.all(pending);
}
const fwdMsg = (over = {}) => ({
  message_id: 77, chat: { id: 4242, type: "private" },
  forward_from_chat: { id: -100123, type: "channel" }, forward_date: 1700000000,
  ...over,
});
const reset = () => { sent.length = 0; cbAnswers.length = 0; edits.length = 0; revApiCalls.length = 0; };
const noLeak = () => !JSON.stringify(sent).includes(FAKE_TOKEN);

// ---------- pure: coords ----------
ok("coords @lat,lng", JSON.stringify(extractCoordsFromUrl("https://www.google.com/maps/@35.700000,51.400000,15z")) === JSON.stringify({ lat: 35.7, lng: 51.4 }));
ok("coords ?q=", JSON.stringify(extractCoordsFromUrl("https://maps.google.com/maps?q=35.71,51.42")) === JSON.stringify({ lat: 35.71, lng: 51.42 }));
ok("coords ?ll=", JSON.stringify(extractCoordsFromUrl("https://www.google.com/maps?ll=35.72,51.43")) === JSON.stringify({ lat: 35.72, lng: 51.43 }));
ok("coords lat/lng pair", JSON.stringify(extractCoordsFromUrl("https://neshan.org/maps/?lat=35.73&lng=51.44")) === JSON.stringify({ lat: 35.73, lng: 51.44 }));
ok("coords 0,0 rejected", extractCoordsFromUrl("https://x.com/maps/@0,0,15z") === null);
ok("coords from text picks first map url", JSON.stringify(extractCoordsFromText("ببین https://example.com/a و https://www.google.com/maps/@35.75,51.45,15z")) === JSON.stringify({ lat: 35.75, lng: 51.45 }));
ok("hasMapLink: neshan yes, news no", hasMapLink("https://neshan.org/maps/@35.7,51.4") === true && hasMapLink("https://example.com/news/1") === false);
ok("isForwardedMessage", isForwardedMessage({ forward_from_chat: {} }) === true && isForwardedMessage({ text: "hi" }) === false);

// ---------- pure: ports / hours / name / dup ----------
ok("ports CCS2+Type2", JSON.stringify(extractPortsFromText("شارژر CCS2 و Type 2 دارد")) === JSON.stringify(["CCS2", "Type 2"]));
ok("ports GB/T fast fa", JSON.stringify(extractPortsFromText("جی‌بی‌تی سریع")) === JSON.stringify(["GB/T DC"]));
ok("ports type2+chademo fa", JSON.stringify(extractPortsFromText("تایپ ۲ و چادمو")) === JSON.stringify(["CHAdeMO", "Type 2"]));
ok("ports none -> []", extractPortsFromText("جایگاه خوبیه").length === 0);
ok("hours 24h", extractHoursFromText("شبانه‌روزی باز است") === "۲۴ ساعته");
ok("hours range with keyword", extractHoursFromText("ساعت کاری ۸ تا ۲۲") === "۸ تا ۲۲");
ok("hours range without keyword ignored", extractHoursFromText("۲ تا پورت دارد") === "");
ok("name first meaningful line", extractStationName("ایستگاه شارژ تهرانپارس\nhttps://maps.google.com/maps/@35.7,51.4") === "ایستگاه شارژ تهرانپارس");
ok("name fallback", extractStationName("https://maps.google.com/maps/@35.7,51.4") === "ایستگاه شارژ");
ok("dup within 150m", findDuplicateStation([{ latitude: 35.7, longitude: 51.4, name: "A" }], 35.7005, 51.4005, 150)?.name === "A");
ok("dup beyond 150m -> null", findDuplicateStation([{ latitude: 35.7, longitude: 51.4, name: "A" }], 35.703, 51.403, 150) === null);

// ---------- webhook: forward location + text -> full registration ----------
{
  reset(); stationList = [];
  const env = makeEnv();
  await driveWebhook(env, { message: fwdMsg({ location: { latitude: 35.7, longitude: 51.4 }, text: "ایستگاه شارژ تهرانپارس\nCCS2 و Type 2\nساعت کاری ۸ تا ۲۲" }) });
  const post = revApiCalls.find((c) => c.method === "POST" && c.path === "/api/admin/stations");
  ok("forward-location registers via admin stations", !!post);
  ok("payload name/connectors/address", post && post.body.name === "ایستگاه شارژ تهرانپارس" &&
    JSON.stringify(post.body.connectors) === JSON.stringify(["CCS2", "Type 2"]) &&
    post.body.latitude === 35.7 && post.body.longitude === 51.4 &&
    String(post.body.address).includes("۸ تا ۲۲"));
  ok("payload auth uses bearer token (not leaked in chat)", post && post.auth === "Bearer " + FAKE_TOKEN);
  ok("review approve called", revApiCalls.some((c) => c.method === "POST" && c.path.endsWith("/review") && c.body.approval_status === "approved"));
  const senderMsg = sent.find((s) => s.chat_id === 4242);
  ok("sender success msg with name+ports", !!senderMsg && senderMsg.text.includes("ایستگاه شارژ تهرانپارس") && senderMsg.text.includes("CCS2"));
  const mgr = sent.find((s) => s.chat_id === 999);
  ok("manager report with delete button", !!mgr && JSON.stringify(mgr.reply_markup).includes("delst:"));
  ok("no token leakage in chat", noLeak());
  const rl = await env.BOT_KV.get("fwdrl:4242", "json");
  ok("rate record incremented once", rl && rl.count === 1);
}

// ---------- webhook: forward google-maps link ----------
{
  reset(); stationList = [];
  const env = makeEnv();
  await driveWebhook(env, { message: fwdMsg({ text: "جایگاه جدید\nhttps://www.google.com/maps/@35.710000,51.410000,15z" }) });
  const post = revApiCalls.find((c) => c.method === "POST" && c.path === "/api/admin/stations");
  ok("forward maps link registers with url coords", !!post && post.body.latitude === 35.71 && post.body.longitude === 51.41);
}

// ---------- webhook: short link resolved ----------
{
  reset(); stationList = [];
  const env = makeEnv();
  await driveWebhook(env, { message: fwdMsg({ text: "جایگاه\nhttps://n.sh/abc123" }) });
  const post = revApiCalls.find((c) => c.method === "POST" && c.path === "/api/admin/stations");
  ok("short link resolved then registered", !!post && post.body.latitude === 35.7 && post.body.longitude === 51.4);
}

// ---------- webhook: forward without location/link -> hint, no registration ----------
{
  reset(); stationList = [];
  const env = makeEnv();
  await driveWebhook(env, { message: fwdMsg({ text: "سلام این یه خبر جالبه" }) });
  ok("stray forward -> hint, no post", revApiCalls.filter((c) => c.method === "POST").length === 0 &&
    sent.some((s) => s.chat_id === 4242 && s.text.includes("به نظر نمی‌رسد")));
}

// ---------- webhook: duplicate -> no registration ----------
{
  reset(); stationList = [{ id: "old", latitude: 35.7, longitude: 51.4, name: "قدیمی" }];
  const env = makeEnv();
  await driveWebhook(env, { message: fwdMsg({ location: { latitude: 35.7005, longitude: 51.4005 }, text: "تکراری" }) });
  ok("duplicate -> no post + already-on-map msg", revApiCalls.filter((c) => c.method === "POST").length === 0 &&
    sent.some((s) => s.text.includes("از قبل روی نقشه هست")));
}

// ---------- webhook: link without coords -> ask for location ----------
{
  reset(); stationList = [];
  const env = makeEnv();
  await driveWebhook(env, { message: fwdMsg({ text: "جایگاه\nhttps://www.google.com/search?q=شارژر" }) });
  ok("coordless link -> ask location, no post", revApiCalls.filter((c) => c.method === "POST").length === 0 &&
    sent.some((s) => s.text.includes("لوکیشن بله را هم بفرست")));
}

// ---------- webhook: missing admin token -> honest error ----------
{
  reset(); stationList = [];
  const env = makeEnv({ REV_API_ADMIN_TOKEN: "" });
  await driveWebhook(env, { message: fwdMsg({ location: { latitude: 35.7, longitude: 51.4 }, text: "ایستگاه" }) });
  ok("missing token -> honest error, no post", revApiCalls.filter((c) => c.method === "POST").length === 0 &&
    sent.some((s) => s.text.includes("REV_API_ADMIN_TOKEN")));
}

// ---------- webhook: rate limit ----------
{
  reset(); stationList = [];
  const env = makeEnv();
  await env.BOT_KV.put("fwdrl:4242", JSON.stringify({ count: 5, start: Date.now() }));
  await driveWebhook(env, { message: fwdMsg({ location: { latitude: 35.7, longitude: 51.4 }, text: "ایستگاه" }) });
  ok("rate limit -> rejected, no post", revApiCalls.filter((c) => c.method === "POST").length === 0 &&
    sent.some((s) => s.text.includes("سقف ثبت ساعتی")));
}

// ---------- webhook: review failure -> sender warned, manager flagged ----------
{
  reset(); stationList = []; reviewShouldFail = true;
  const env = makeEnv();
  await driveWebhook(env, { message: fwdMsg({ location: { latitude: 35.7, longitude: 51.4 }, text: "ایستگاه" }) });
  reviewShouldFail = false;
  ok("review failure -> sender warned", sent.some((s) => s.chat_id === 4242 && s.text.includes("انتشار نهایی ناموفق")));
  ok("review failure -> manager flagged", sent.some((s) => s.chat_id === 999 && s.text.includes("انتشار نهایی ناموفق")));
}

// ---------- webhook: no regression ----------
{
  reset(); stationList = [];
  const env = makeEnv();
  await driveWebhook(env, { message: { message_id: 1, chat: { id: 4242, type: "private" }, text: "/start" } });
  ok("ordinary /start still works", sent.some((s) => s.chat_id === 4242 && s.text.includes("بازوی رانش EV")));
  reset();
  await driveWebhook(env, { message: { message_id: 2, chat: { id: 4242, type: "private" }, location: { latitude: 35.7, longitude: 51.4 } } });
  ok("ordinary location still goes to nearby flow", sent.some((s) => s.text.includes("نزدیک‌ترین شارژرها") || s.text.includes("پیدا نکردم")));
  reset();
  await env.BOT_KV.put("ses:4242", JSON.stringify({ flow: "tow_name" }));
  await driveWebhook(env, { message: fwdMsg({ text: "علی رضایی" }) });
  ok("forward during active flow keeps old behavior", !sent.some((s) => s.text.includes("به نظر نمی‌رسد")) &&
    sent.some((s) => s.chat_id === 4242));
}

// ---------- webhook: manager one-tap delete ----------
{
  reset();
  const env = makeEnv();
  await driveWebhook(env, { callback_query: { id: "cb1", data: "delst:rev-bot-abc123", message: { message_id: 9, chat: { id: 999 } } } });
  ok("owner delete -> DELETE called", revApiCalls.some((c) => c.method === "DELETE" && c.path.includes("rev-bot-abc123")));
  ok("owner delete -> confirm edit", edits.some((e) => e.text.includes("حذف شد")));
  reset();
  await driveWebhook(env, { callback_query: { id: "cb2", data: "delst:rev-bot-abc123", message: { message_id: 9, chat: { id: 4242 } } } });
  ok("non-owner delete -> no DELETE", !revApiCalls.some((c) => c.method === "DELETE"));
}

console.log(`\n${pass} PASS`);
