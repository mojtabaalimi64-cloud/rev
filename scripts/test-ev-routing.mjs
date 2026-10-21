import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("trip-app.js", "utf8");
const match = source.match(/function estimateArrivalSoc\\(currentSoc, legKm, consumption, battery\\) \\{[\\s\\S]*?\\n\\}/);
assert.ok(match, "estimateArrivalSoc must exist in the route planner source");
assert.ok(
  source.includes("const arrivalSoc=estimateArrivalSoc(currentSoc,legKm,consumption,battery);"),
  "charging-stop planning must use the tested battery estimate"
);
const estimateArrivalSoc = vm.runInNewContext("(" + match[0] + ")");
assert.equal(estimateArrivalSoc(90, 100, 18, 60), 60);
assert.equal(estimateArrivalSoc(90, 150, 18, 60), 45);
assert.equal(estimateArrivalSoc(80, 100, 20, 80), 55);
assert.ok(Number.isNaN(estimateArrivalSoc(90, 100, 18, 0)));
assert.ok(Number.isNaN(estimateArrivalSoc(101, 100, 18, 60)));
console.log("EV routing tests passed: arrival battery percentage and invalid inputs.");
