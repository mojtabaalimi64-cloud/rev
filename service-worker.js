const REV_CACHE = "rev-trip-shell-v1";
const REV_SHELL = ["./trip.html", "./manifest.webmanifest", "./rev-app-icon.svg"];
self.addEventListener("install", event => { event.waitUntil(caches.open(REV_CACHE).then(cache => cache.addAll(REV_SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("rev-trip-shell-") && key !== REV_CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Do not cache APIs, shared URLs with query parameters, third-party services, or private pages.
  if (url.origin !== self.location.origin || url.search || /\\/api\\//i.test(url.pathname)) return;
  const isTripDocument = url.pathname.endsWith("/trip.html") || url.pathname.endsWith("/rev/");
  if (!isTripDocument) return;
  event.respondWith(fetch(request).then(response => {
    if (response && response.ok && response.type === "basic") { const copy = response.clone(); caches.open(REV_CACHE).then(cache => cache.put("./trip.html", copy)); }
    return response;
  }).catch(async () => { const cache = await caches.open(REV_CACHE); return (await cache.match("./trip.html")) || Response.error(); }));
});