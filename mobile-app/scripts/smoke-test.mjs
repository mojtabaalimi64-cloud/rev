import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const appDir = path.join(root, "mobile-app");
const htmlPath = path.join(appDir, "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
const required = [
  "mobile-app/index.html",
  "mobile-app/manifest.webmanifest",
  "mobile-app/sw.js",
  "trip.html",
  "safety-checklist.html",
  "travel-plans.html",
  "businesses.html",
  "driver-profile.html",
  "article-ev.html",
  "news.html",
  "account.html"
];

const failures = [];
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) failures.push("Missing required file: " + file);
}

const hrefs = [...html.matchAll(/\bhref\s*=\s*["']([^"'#]+)["']/gi)].map(match => match[1]);
for (const href of hrefs) {
  if (/^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(href)) continue;
  const target = path.resolve(appDir, href.split("?")[0]);
  if (!target.startsWith(root + path.sep) && target !== root) {
    failures.push("Local link escapes repository: " + href);
    continue;
  }
  if (!fs.existsSync(target)) failures.push("Broken local link: " + href + " -> " + path.relative(root, target));
}

if (!html.includes('dir="rtl"')) failures.push("Expected Persian RTL document direction.");
if (!html.includes('name="viewport"')) failures.push("Missing responsive viewport.");
if (!html.includes('register("./sw.js")')) failures.push("Scoped service worker registration missing.");

const sw = fs.readFileSync(path.join(appDir, "sw.js"), "utf8");
if (sw.includes("caches.match(request)") || sw.includes("cache.put(request")) {
  failures.push("Review caching policy: request/API responses must not be cached broadly.");
}

if (failures.length) {
  console.error("REV mobile prototype checks failed:");
  for (const failure of failures) console.error(" - " + failure);
  process.exit(1);
}

console.log("REV mobile prototype checks passed.");
console.log("Required files: " + required.length + "; local links checked: " + hrefs.length);
