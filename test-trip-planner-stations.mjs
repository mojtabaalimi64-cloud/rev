import assert from "node:assert/strict";
import fs from "node:fs";

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
console.log("REV trip planner station-source checks passed.");
