/* Kave Food service worker (Phase 3).

   Caches the static shell so the app installs and opens offline. Data
   (api.github.com) always hits the network - the app's own localStorage cache
   is the offline data store. Bump VERSION on every deploy so the old cache is
   cleared and the "new version" toast fires.
*/

const VERSION = "v1";
const CACHE = `kave-food-${VERSION}`;

const SHELL = [
  "./",
  "index.html",
  "app.js",
  "github.js",
  "pixel-icons.js",
  "styles.css",
  "manifest.json",
  "icon-192.png",
  "icon-512.png",
  "icon-512-maskable.png",
  "apple-touch-icon.png",
];

const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // GitHub API and any other host: straight to the network, never cached
  if (url.origin !== self.location.origin && !FONT_HOSTS.includes(url.hostname)) return;

  // navigation: always the app shell
  if (req.mode === "navigate") {
    e.respondWith(
      caches.match(req)
        .then((c) => c || caches.match("index.html"))
        .then((c) => c || fetch(req))
        .catch(() => caches.match("index.html"))
    );
    return;
  }

  // shell assets + fonts: stale-while-revalidate
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const fresh = fetch(req)
          .then((res) => {
            if (res && res.ok && (res.type === "basic" || res.type === "cors")) {
              cache.put(req, res.clone());
            }
            return res;
          })
          .catch(() => cached);
        return cached || fresh;
      })
    )
  );
});
