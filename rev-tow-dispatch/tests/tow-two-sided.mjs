// Integration tests for two-sided tow cancellation (feature/tow-two-sided-cancellation).
// Runs the real worker.js against an in-memory D1 shim implementing exactly the
// SQL statements the worker uses. No production data, no network, no Cloudflare.
// Usage: node tests/tow-two-sided.mjs   (from rev-tow-dispatch/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../worker.mjs";

// ---------- minimal D1 shim ----------
class D1 {
  constructor() { this.rows = new Map(); }
  prepare(sql) {
    const self = this;
    return {
      bind(...p) {
        return {
          async run() {
            if (sql.startsWith("INSERT INTO rev_tow_kv")) {
              self.rows.set(p[0], { value: p[1], expires_at: p[2] });
              return { meta: { changes: 1 } };
            }
            if (sql.startsWith("DELETE FROM rev_tow_kv")) {
              return { meta: { changes: self.rows.delete(p[0]) ? 1 : 0 } };
            }
            if (sql.startsWith("UPDATE rev_tow_kv")) {
              const row = self.rows.get(p[1]);
              if (row && row.value === p[2]) { row.value = p[0]; return { meta: { changes: 1 } }; }
              return { meta: { changes: 0 } };
            }
            throw new Error("unhandled run: " + sql);
          },
          async first() {
            if (sql.startsWith("SELECT value, expires_at")) {
              const row = self.rows.get(p[0]);
              return row ? { value: row.value, expires_at: row.expires_at } : null;
            }
            throw new Error("unhandled first: " + sql);
          },
          async all() {
            if (sql.startsWith("SELECT key FROM rev_tow_kv")) {
              const prefix = p[0].replace(/%$/, "");
              const keys = [...self.rows.keys()].filter((k) => k.startsWith(prefix) && k > p[1]).sort().slice(0, 1000);
              return { results: keys.map((k) => ({ key: k })) };
            }
            throw new Error("unhandled all: " + sql);
          },
        };
      },
    };
  }
}

const env = { TOW_DB: new D1(), ADMIN_KEY: "test-admin" };
const ADMIN = { "x-admin-key": "test-admin" };
let pass = 0;
const ok = (name, cond, extra = "") => {
  assert.ok(cond, name + " " + extra);
  pass++;
  console.log("PASS " + name);
};
async function call(path, { method = "GET", body, headers = {} } = {}) {
  const req = new Request("http://localhost" + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env);
  let j = null;
  try { j = await res.json(); } catch { /* empty */ }
  return { status: res.status, ...j };
}
function row(key) { const r = env.TOW_DB.rows.get(key); return r ? JSON.parse(r.value) : null; }
function setRow(key, obj) { env.TOW_DB.rows.set(key, { value: JSON.stringify(obj), expires_at: null }); }
async function makeDriver(name, phone, lat, lng) {
  const r = await call("/api/driver/register", { method: "POST", body: { name, phone, password: "password123", lat, lng, radius: 100 } });
  assert.equal(r.ok, true, "register " + name + " " + JSON.stringify(r));
  const ap = await call("/api/admin/driver/approve", { method: "POST", body: { id: r.id, approved: true }, headers: ADMIN });
  assert.equal(ap.ok, true, "approve " + name);
  const sh = await call("/api/driver/shift", { method: "POST", body: { token: r.token, onShift: true } });
  assert.equal(sh.ok, true, "shift " + name);
  return r;
}
async function makeRequest(phone = "09123456789", extra = {}) {
  const r = await call("/api/tow/request", { method: "POST", body: {
    name: "مشتری تست", phone, car: "KMC E50A", problem: "باتری خالی",
    loc: "تهران", gps: { lat: 35.7, lng: 51.4 }, ...extra,
  } });
  assert.equal(r.ok, true, "create request " + JSON.stringify(r));
  return r;
}

// ---------- setup: two drivers ----------
const d1 = await makeDriver("راننده یک", "09111111111", 35.7, 51.4);
const d2 = await makeDriver("راننده دو", "09222222222", 35.71, 51.41);

// 1. create + idempotent replay
const req1 = await makeRequest("09123456789", { idempotencyKey: "k-1" });
ok("create returns cancelToken", typeof req1.cancelToken === "string" && req1.cancelToken.length >= 64);
ok("create returns customerUrl with token", req1.customerUrl.includes("/tow/customer?id=") && req1.customerUrl.includes("cancelToken="));
ok("first offer goes to nearest driver", (await call(`/api/driver/offers?token=${d1.token}`)).offer?.reqId === req1.id);
const replay = await makeRequest("09123456789", { idempotencyKey: "k-1" });
ok("idempotent replay returns same id", replay.id === req1.id && replay.idempotentReplay === true);
const adminList1 = await call("/api/admin/requests", { headers: ADMIN });
ok("replay created no duplicate mission", adminList1.requests.filter((x) => x.phone === "09123456789").length === 1);

// 2. cancel authorization
const badToken = await call("/api/tow/cancel", { method: "POST", body: { id: req1.id, phone: "09123456789", cancelToken: "wrong", reason: "x" } });
ok("cancel with wrong token -> 403", badToken.status === 403);
const badPhone = await call("/api/tow/cancel", { method: "POST", body: { id: req1.id, phone: "09999999999", cancelToken: req1.cancelToken, reason: "x" } });
ok("cancel with wrong phone -> 404", badPhone.status === 404);
const noTok = await call("/api/tow/my-requests?id=" + req1.id);
ok("my-requests without token -> 403", noTok.status === 403);
const withTok = await call("/api/tow/my-requests?id=" + req1.id + "&cancelToken=" + req1.cancelToken);
ok("my-requests with token returns only that request", withTok.ok === true && withTok.requests.length === 1 && withTok.requests[0].id === req1.id);

// 3. legacy request (no cancelToken) cannot be cancelled by customer, but operator can
const legacy = await makeRequest("09333333333");
const legacyRow = row("req:" + legacy.id);
delete legacyRow.cancelToken;
setRow("req:" + legacy.id, legacyRow);
const legacyCancel = await call("/api/tow/cancel", { method: "POST", body: { id: legacy.id, phone: "09333333333", reason: "x" } });
ok("legacy request customer cancel -> 403", legacyCancel.status === 403);
const opCancel = await call("/api/admin/request/cancel", { method: "POST", body: { id: legacy.id, reason: "درخواست قدیمی" }, headers: ADMIN });
ok("operator cancels legacy request", opCancel.ok === true && opCancel.status === "لغو شد");
const opCancelDone = await call("/api/admin/request/cancel", { method: "POST", body: { id: legacy.id }, headers: ADMIN });
ok("operator cancel of cancelled is idempotent 200", opCancelDone.ok === true);

// 4. authorized customer cancel is idempotent and deletes the offer
const c1 = await call("/api/tow/cancel", { method: "POST", body: { id: req1.id, phone: "09123456789", cancelToken: req1.cancelToken, reason: "مشکل برطرف شد" } });
ok("authorized customer cancel -> 200", c1.ok === true);
const c2 = await call("/api/tow/cancel", { method: "POST", body: { id: req1.id, phone: "09123456789", cancelToken: req1.cancelToken, reason: "again" } });
ok("duplicate customer cancel -> 200, single log entry", c2.ok === true && row("req:" + req1.id).log.filter((e) => e.ev.includes("توسط درخواست‌کننده لغو شد")).length === 1);
ok("cancelled mission has no live offer", (await call(`/api/driver/offers?token=${d1.token}`)).offer === null);
const afterCancelRespond = await call("/api/driver/respond", { method: "POST", body: { token: d1.token, reqId: req1.id, accept: true } });
ok("accept after customer cancel -> 410", afterCancelRespond.status === 410);

// 5. status privacy gating (fresh mission, driver accepts)
const req2 = await makeRequest("09444444444");
await call("/api/driver/respond", { method: "POST", body: { token: d1.token, reqId: req2.id, accept: true } });
const stBare = await call("/api/tow/status?id=" + req2.id);
ok("tokenless status hides serviceCode and driver phone", stBare.serviceCode === null && stBare.driver && stBare.driver.phone === undefined && stBare.status === "راننده در راه");
const stFull = await call("/api/tow/status?id=" + req2.id + "&cancelToken=" + req2.cancelToken);
ok("token status shows serviceCode and driver phone", typeof stFull.serviceCode === "string" && stFull.serviceCode.length === 4 && stFull.driver.phone === "09111111111");

// 6. driver cancel -> reassign to next driver, first driver never re-offered
const dc = await call("/api/driver/cancel", { method: "POST", body: { token: d1.token, reqId: req2.id, reason: "خرابی خودرو" } });
ok("driver cancel -> reassigned", dc.ok === true && dc.status === "در انتظار پذیرش راننده");
const r2 = row("req:" + req2.id);
ok("driver cancel records reason and skips driver", r2.log.some((e) => e.ev.includes("خرابی خودرو")) && r2.skipped.includes(d1.id));
ok("reassigned mission clears stale cancel/service fields", r2.cancelledBy === undefined && r2.serviceCode === undefined && r2.currentOffer.driverId === d2.id);
ok("second driver now holds the offer", (await call(`/api/driver/offers?token=${d2.token}`)).offer?.reqId === req2.id);
ok("cancelled driver is not re-offered", (await call(`/api/driver/offers?token=${d1.token}`)).offer === null);

// 7. no replacement driver -> operator status
const solo = await makeDriver("راننده تنها", "09555555555", 36.5, 52.5);
// only solo driver can serve a far-away request
const reqFar = await call("/api/tow/request", { method: "POST", body: {
  name: "مشتری دور", phone: "09777777777", car: "X", problem: "سایر", loc: "دور",
  gps: { lat: 36.5, lng: 52.5 },
} });
ok("far request offered to solo driver", (await call(`/api/driver/offers?token=${solo.token}`)).offer?.reqId === reqFar.id);
await call("/api/driver/respond", { method: "POST", body: { token: solo.token, reqId: reqFar.id, accept: true } });
const soloCancel = await call("/api/driver/cancel", { method: "POST", body: { token: solo.token, reqId: reqFar.id, reason: "دور بود" } });
ok("driver cancel with no replacement -> operator status", soloCancel.ok === true && soloCancel.status === "در انتظار اپراتور");

// 8. completion + cancel-after-complete + idempotent completion
await call("/api/driver/respond", { method: "POST", body: { token: d2.token, reqId: req2.id, accept: true } });
const done = await call("/api/driver/complete", { method: "POST", body: { token: d2.token, reqId: req2.id } });
ok("completion -> 200", done.ok === true && done.status === "انجام شد");
const doneAgain = await call("/api/driver/complete", { method: "POST", body: { token: d2.token, reqId: req2.id } });
ok("duplicate completion -> 200 idempotent", doneAgain.ok === true);
const cancelDone = await call("/api/tow/cancel", { method: "POST", body: { id: req2.id, phone: "09444444444", cancelToken: req2.cancelToken, reason: "x" } });
ok("cancel completed mission -> 409", cancelDone.status === 409);

// 9. expired offer can never be accepted afterwards; it reassigns
const req4 = await makeRequest("09888888888");
const offer4 = row("offer:" + req4.id);
offer4.expiresAt = Date.now() - 1000;
setRow("offer:" + req4.id, offer4);
const lateAccept = await call("/api/driver/respond", { method: "POST", body: { token: d1.token, reqId: req4.id, accept: true } });
ok("accept of expired offer -> 410", lateAccept.status === 410);
ok("expired offer reassigned to next driver", (await call(`/api/driver/offers?token=${d2.token}`)).offer?.reqId === req4.id);

// 10. race: two concurrent accepts by the same driver -> exactly one wins
const req5 = await makeRequest("09900000000");
const [a1, a2] = await Promise.all([
  call("/api/driver/respond", { method: "POST", body: { token: d1.token, reqId: req5.id, accept: true } }),
  call("/api/driver/respond", { method: "POST", body: { token: d1.token, reqId: req5.id, accept: true } }),
]);
ok("concurrent double accept -> one 200 one 409", [a1.ok, a2.ok].filter(Boolean).length === 1 && [a1.status, a2.status].includes(409));
const r5 = row("req:" + req5.id);
ok("double accept final state consistent", r5.status === "راننده در راه" && r5.assignedDriver === d1.id);

// 11. race: customer cancel vs driver accept -> exactly one wins, no resurrection
const req6 = await makeRequest("09911111111");
const [cc, aa] = await Promise.all([
  call("/api/tow/cancel", { method: "POST", body: { id: req6.id, phone: "09911111111", cancelToken: req6.cancelToken, reason: "race" } }),
  call("/api/driver/respond", { method: "POST", body: { token: d1.token, reqId: req6.id, accept: true } }),
]);
ok("cancel-vs-accept race -> exactly one 200", [cc.ok, aa.ok].filter(Boolean).length === 1);
const st6a = await call("/api/tow/status?id=" + req6.id);
const st6b = await call("/api/tow/status?id=" + req6.id);
const r6 = row("req:" + req6.id);
ok("cancel-vs-accept final state stable, no resurrection", st6a.status === st6b.status && ["لغو شد", "راننده در راه"].includes(r6.status));
if (r6.status === "لغو شد") ok("cancelled race winner holds no offer", row("offer:" + req6.id) === null);

// 12. race: two concurrent sweeps of one expired offer -> single reassignment, single log
const req7 = await makeRequest("09922222222");
const offer7 = row("offer:" + req7.id);
offer7.expiresAt = Date.now() - 1000;
setRow("offer:" + req7.id, offer7);
await Promise.all([call("/api/tow/status?id=" + req7.id), call("/api/tow/status?id=" + req7.id)]);
const r7 = row("req:" + req7.id);
ok("concurrent sweeps -> single timeout log entry", r7.log.filter((e) => e.ev.includes("پاسخ نداد")).length === 1);
ok("concurrent sweeps -> exactly one live offer", row("offer:" + req7.id) !== null && r7.currentOffer !== null);

// 13. reject moves to next driver (regression; record-level check because a
// driver may legitimately hold several live offers at once)
const req8 = await makeRequest("09933333333");
await call("/api/driver/respond", { method: "POST", body: { token: d1.token, reqId: req8.id, accept: false } });
ok("reject moves to next driver", row("req:" + req8.id).currentOffer?.driverId === d2.id && row("offer:" + req8.id) !== null);

// 14. UI static checks (no live browser in this environment)
const src = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
ok("customer page strips token from URL", src.includes('history.replaceState(null,"",location.pathname+"?id="'));
ok("customer page has confirm + reason select", src.includes('confirm("آیا از لغو مأموریت مطمئن هستید؟")') && src.includes('id="reason"'));
ok("driver page has reason prompt + confirm + double-submit guard", src.includes('prompt("دلیل لغو مأموریت را وارد کنید:")') && src.includes("b.disabled=true"));
ok("both pages declare mobile viewport", (src.match(/width=device-width,initial-scale=1/g) || []).length >= 2);

// ---------- notify harness (sections 15+) ----------
const notifyCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  let body = null;
  try { body = JSON.parse(opts.body || "null"); } catch { /* ignore */ }
  notifyCalls.push({ url: String(url), body });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
};
env.INTERNAL_KEY = "test-internal";
const towOfferCalls = () => notifyCalls.filter((c) => c.body && c.body.type === "tow_offer");
const towStatusCalls = () => notifyCalls.filter((c) => c.body && c.body.type === "tow_status");

// 15. driver link-chat + offer push (secret set)
const d9 = await makeDriver("راننده نه", "09199999991", 36.0, 52.0);
const linkBad = await call("/api/driver/link-chat", { method: "POST", body: { token: "NOPE", chatId: 777 } });
ok("link-chat with bad token -> 401", linkBad.status === 401 && linkBad.err === "توکن راننده معتبر نیست");
const linkBadChat = await call("/api/driver/link-chat", { method: "POST", body: { token: d9.token, chatId: 0 } });
ok("link-chat with bad chatId -> 400", linkBadChat.status === 400);
const linkOk = await call("/api/driver/link-chat", { method: "POST", body: { token: d9.token, chatId: 777 } });
ok("link-chat ok", linkOk.ok === true);
const reqN1 = await call("/api/tow/request", { method: "POST", body: {
  name: "مشتری تست", phone: "09150000001", car: "", problem: "سایر", loc: "تست",
  gps: { lat: 36.0, lng: 52.0 },
} });
ok("notify-test request created", reqN1.ok === true);
ok("offer goes to linked driver d9", row("req:" + reqN1.id).currentOffer?.driverId === d9.id);
ok("offer push sent to linked chat", towOfferCalls().some((c) => c.body.chatId === 777));

// 16. no secret -> dispatch intact, no push attempted
const callsBefore = notifyCalls.length;
delete env.INTERNAL_KEY;
const reqN2 = await call("/api/tow/request", { method: "POST", body: {
  name: "مشتری تست", phone: "09150000002", car: "", problem: "سایر", loc: "تست",
  gps: { lat: 36.0, lng: 52.0 },
} });
ok("dispatch without secret still creates offer", reqN2.ok === true && row("req:" + reqN2.id).currentOffer !== null);
ok("no push attempted without secret", notifyCalls.length === callsBefore);
env.INTERNAL_KEY = "test-internal";

// 17. customer push on accept / complete / driver-cancel (baleChatId only)
const reqC1 = await call("/api/tow/request", { method: "POST", body: {
  name: "مشتری تست", phone: "09150000003", car: "", problem: "سایر", loc: "تست",
  gps: { lat: 36.0, lng: 52.0 }, baleChatId: 555,
} });
await call("/api/driver/respond", { method: "POST", body: { token: d9.token, reqId: reqC1.id, accept: true } });
ok("customer push on accept", towStatusCalls().some((c) => c.body.chatId === 555 && c.body.text.includes("قبول کرد")));
await call("/api/driver/complete", { method: "POST", body: { token: d9.token, reqId: reqC1.id } });
ok("customer push on complete", towStatusCalls().some((c) => c.body.chatId === 555 && c.body.text.includes("انجام شد")));
const reqC2 = await call("/api/tow/request", { method: "POST", body: {
  name: "مشتری تست", phone: "09150000004", car: "", problem: "سایر", loc: "تست",
  gps: { lat: 36.0, lng: 52.0 }, baleChatId: 556,
} });
await call("/api/driver/respond", { method: "POST", body: { token: d9.token, reqId: reqC2.id, accept: true } });
const dc2 = await call("/api/driver/cancel", { method: "POST", body: { token: d9.token, reqId: reqC2.id, reason: "خرابی خودرو" } });
ok("driver cancel reassigns (flag true)", dc2.ok === true && dc2.reassigned === true && dc2.status === "در انتظار پذیرش راننده");
ok("customer push on driver cancel (reassigned)", towStatusCalls().some((c) => c.body.chatId === 556 && c.body.text.includes("راننده بعدی")));
const dSolo = await makeDriver("راننده تنها", "09199999992", 30.0, 50.0);
const reqC3 = await call("/api/tow/request", { method: "POST", body: {
  name: "مشتری تست", phone: "09150000005", car: "", problem: "سایر", loc: "تست",
  gps: { lat: 30.0, lng: 50.0 }, baleChatId: 557,
} });
await call("/api/driver/respond", { method: "POST", body: { token: dSolo.token, reqId: reqC3.id, accept: true } });
const dc3 = await call("/api/driver/cancel", { method: "POST", body: { token: dSolo.token, reqId: reqC3.id, reason: "دور بود" } });
ok("driver cancel with no replacement -> operator + flag false", dc3.ok === true && dc3.reassigned === false && dc3.status === "در انتظار اپراتور");
ok("customer push on driver cancel (operator)", towStatusCalls().some((c) => c.body.chatId === 557 && c.body.text.includes("اپراتور")));
const statusBefore = towStatusCalls().length;
const reqC4 = await call("/api/tow/request", { method: "POST", body: {
  name: "مشتری تست", phone: "09150000006", car: "", problem: "سایر", loc: "تست",
  gps: { lat: 36.0, lng: 52.0 },
} });
await call("/api/driver/respond", { method: "POST", body: { token: d9.token, reqId: reqC4.id, accept: true } });
ok("no customer push without baleChatId", towStatusCalls().length === statusBefore);
ok("every push carries a numeric chatId", notifyCalls.every((c) => typeof c.body.chatId === "number"));

// 18. operator redispatch
const parked = await call("/api/tow/request", { method: "POST", body: {
  name: "مشتری تست", phone: "09150000007", car: "", problem: "سایر", loc: "تست",
  gps: { lat: 25.0, lng: 45.0 },
} });
ok("far request parks in operator queue", row("req:" + parked.id).status === "در انتظار اپراتور" && row("req:" + parked.id).currentOffer === null);
const rdNoKey = await call("/api/admin/request/redispatch", { method: "POST", body: { id: parked.id } });
ok("redispatch without admin key -> 401", rdNoKey.status === 401);
const rdWrong = await call("/api/admin/request/redispatch", { method: "POST", body: { id: reqC2.id }, headers: ADMIN });
ok("redispatch on non-parked request -> 409", rdWrong.status === 409);
const rdStill = await call("/api/admin/request/redispatch", { method: "POST", body: { id: parked.id }, headers: ADMIN });
ok("redispatch with no driver stays parked", rdStill.ok === true && rdStill.status === "در انتظار اپراتور");
const dNew = await makeDriver("راننده تازه", "09199999993", 25.0, 45.0);
await call("/api/driver/link-chat", { method: "POST", body: { token: dNew.token, chatId: 888 } });
const rdOk = await call("/api/admin/request/redispatch", { method: "POST", body: { id: parked.id }, headers: ADMIN });
ok("redispatch offers to new driver", rdOk.ok === true && rdOk.status === "در انتظار پذیرش راننده" && rdOk.currentOffer?.driverId === dNew.id);
ok("redispatch push sent to new driver chat", towOfferCalls().some((c) => c.body.chatId === 888));
// skipped list preserved: solo driver rejects, then redispatch must not re-offer them
const reqS = await call("/api/tow/request", { method: "POST", body: {
  name: "مشتری تست", phone: "09150000008", car: "", problem: "سایر", loc: "تست",
  gps: { lat: 30.0, lng: 50.0 },
} });
await call("/api/driver/respond", { method: "POST", body: { token: dSolo.token, reqId: reqS.id, accept: false } });
ok("solo reject parks request with skipped driver", row("req:" + reqS.id).status === "در انتظار اپراتور" && row("req:" + reqS.id).skipped.includes(dSolo.id));
const rdSk = await call("/api/admin/request/redispatch", { method: "POST", body: { id: reqS.id }, headers: ADMIN });
ok("redispatch respects skipped list", rdSk.ok === true && rdSk.status === "در انتظار اپراتور" && row("req:" + reqS.id).skipped.includes(dSolo.id));

// 19. operator cancel from admin UI endpoint (parked request)
const oc = await call("/api/admin/request/cancel", { method: "POST", body: { id: reqS.id, reason: "تست مدیر" }, headers: ADMIN });
ok("admin cancel works", oc.ok === true && oc.status === "لغو شد" && row("req:" + reqS.id).log.some((e) => e.ev.includes("اپراتور")));

// 20. driver token error texts (no bare 401/404)
for (const [p, m] of [
  ["/api/driver/history?token=NOPE", "GET"],
  ["/api/driver/offers?token=NOPE", "GET"],
]) {
  const r = await call(p, { method: m });
  ok("bad token error text on " + p, r.status === 401 && r.err === "توکن راننده معتبر نیست");
}
for (const [p, b] of [
  ["/api/driver/heartbeat", { token: "NOPE", lat: 1, lng: 1 }],
  ["/api/driver/respond", { token: "NOPE", reqId: "x", accept: true }],
  ["/api/driver/complete", { token: "NOPE", reqId: "x" }],
]) {
  const r = await call(p, { method: "POST", body: b });
  ok("bad token error text on " + p, r.status === 401 && r.err === "توکن راننده معتبر نیست");
}

// 21. driver page complete button (static)
ok("driver page has complete button with confirm", src.includes('"/api/driver/complete"') && src.includes('اتمام مأموریت') && src.includes('confirm("مأموریت انجام شد؟")'));

// 22. legacy compat: old-style request/driver (no baleChatId, no chatId) still flow
const legacyReq = await makeRequest("09150000009");
ok("legacy request still dispatches", row("req:" + legacyReq.id).currentOffer !== null);

// 23. no data loss: every created request still present
const adminList2 = await call("/api/admin/requests", { headers: ADMIN });
ok("no request records lost", adminList2.requests.length >= 8);

console.log(`\nALL ${pass} INTEGRATION CHECKS PASSED`);
