// Offline support: app files cached on install; map tiles cached as you view them.
const APP = "tcs-app-v1", TILES = "tcs-tiles-v1", MAX_TILES = 3000;
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icon.svg",
  "data/stops.json", "data/loops.json", "data/meta.json",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== APP && k !== TILES).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (u.hostname === "brouter.de") return; // live routing, never cached
  if (u.hostname.endsWith("tile.openstreetmap.org")) {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      try {
        const r = await fetch(e.request);
        if (r.ok) { c.put(e.request, r.clone()); trim(c); }
        return r;
      } catch (err) { return hit || Response.error(); }
    }));
    return;
  }
  // app + data: network first so updates arrive, cache when offline
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) caches.open(APP).then((c) => c.put(e.request, r.clone()));
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
let trimming = false;
async function trim(c) {
  if (trimming) return; trimming = true;
  const ks = await c.keys();
  for (let i = 0; i < ks.length - MAX_TILES; i++) await c.delete(ks[i]);
  trimming = false;
}
