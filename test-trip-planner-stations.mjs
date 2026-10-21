import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("trip-app.js", "utf8");
const start = source.indexOf("async function getIranStations(routeCoords,radiusKm){");
const end = source.indexOf("\n\nasync function renderFuelStations", start);
assert.ok(start >= 0 && end > start, "station loader must exist");
const loader = source.slice(start, end);
assert.ok(loader.includes("getRevStations(routeCoords,radiusKm)"), "loader must use the REV station API");
assert.ok(!loader.includes("queryOverpass"), "charging planner must not fall back to public OSM stations");
assert.ok(!loader.includes('fetch("./content.json'), "charging planner must not fetch unapproved seed data");
assert.ok(loader.includes("return []"), "API failure must not silently display unverified stations");
assert.ok(!source.includes("const ONLINE_STATIONS_API"), "unused external charging source should be removed");
assert.ok(source.includes("ایستگاه تأییدشده از بانک REV"), "route result must identify the approved REV station count");
assert.ok(source.includes("در بانک تأییدشده REV ایستگاهی در شعاع انتخاب‌شده از مسیر پیدا نشد"), "empty state must explain internal data coverage");
const vehicleCatalog = JSON.parse(fs.readFileSync("ev-vehicle-catalog.json", "utf8"));
assert.equal(vehicleCatalog.schemaVersion, 1, "vehicle catalog schema version must be explicit");
assert.ok(Array.isArray(vehicleCatalog.vehicles) && vehicleCatalog.vehicles.length > 0, "vehicle catalog must contain sourced profiles");
for (const vehicle of vehicleCatalog.vehicles) {
  assert.ok(vehicle.id && vehicle.label && vehicle.sourceUrl && vehicle.sourceLabel, "each vehicle must include identity and a source");
  assert.ok(vehicle.batteryKwh === null || (Number.isFinite(vehicle.batteryKwh) && vehicle.batteryKwh > 0), "battery capacity must be positive or unknown");
  assert.ok(vehicle.maxDcChargeKw === null || (Number.isFinite(vehicle.maxDcChargeKw) && vehicle.maxDcChargeKw > 0), "DC charge limit must be positive or unknown");
}
assert.ok(source.includes("async function loadEVVehicleCatalog()"), "trip planner must load vehicle profiles");
assert.ok(source.includes("./ev-vehicle-catalog.json"), "trip planner must load the dedicated catalog, not station seed data");
assert.ok(fs.readFileSync("trip.html", "utf8").includes('id="vehicleProfile"'), "trip planner must expose the vehicle profile selector");
assert.ok(source.includes("مصرف برق خودکار تغییر نکرده است"), "unknown consumption must not be guessed from a model profile");
console.log("REV trip planner station-source checks passed.");

const continuation = source.slice(source.indexOf("function continueToDriverProfile()"), source.indexOf("async function planTrip()"));
assert.ok(continuation.includes('get("from")==="rev-mobile"'), "planner must recognize the mobile-app handoff");
assert.ok(continuation.includes("stops:(revTimeline.stops||[])"), "saved trip must preserve planned charging stops");
assert.ok(continuation.includes("/rev-mobile/nearby-map.html?navstart=1"), "mobile handoff must return to the app map for navigation");

const estimatorStart = source.indexOf("function estimateChargingMinutes(");
const estimatorEnd = source.indexOf("function buildChargingPlan", estimatorStart);
assert.ok(estimatorStart >= 0 && estimatorEnd > estimatorStart, "charge time estimator must exist");
const estimatorSource = source.slice(estimatorStart, estimatorEnd);
const estimateChargingMinutes = vm.runInNewContext("(" + estimatorSource + ")");
assert.equal(estimateChargingMinutes(60, 20, 80, 120), 32);
assert.equal(estimateChargingMinutes(60, 20, 80, 30), 110);
assert.equal(estimateChargingMinutes(60, 80, 80, 120), null);
assert.equal(estimateChargingMinutes(60, 20, 80, 0), null);
assert.equal(estimateChargingMinutes(0, 20, 80, 120), null);
const powerStart = source.indexOf("function effectiveChargingPower(");
const powerEnd = source.indexOf("function estimateChargingMinutes", powerStart);
assert.ok(powerStart >= 0 && powerEnd > powerStart, "vehicle/charger power limiter must exist");
const effectiveChargingPower = vm.runInNewContext("(" + source.slice(powerStart, powerEnd) + ")");
assert.equal(effectiveChargingPower(50, 150), 50);
assert.equal(effectiveChargingPower(350, 150), 150);
assert.equal(effectiveChargingPower(350, 0), 350);
assert.equal(effectiveChargingPower(null, 150), null);
assert.ok(source.includes("maxChargePower"), "vehicle charge limit must feed the charging plan");
assert.ok(fs.readFileSync("trip.html", "utf8").includes('id="maxChargePower"'), "vehicle charge limit input must exist");
console.log("REV charging-time estimate regression checks passed.");
