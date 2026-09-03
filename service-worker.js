/* Spoon service worker (Phase 3).

   Caches the static shell so the app installs and opens offline. Data
   (api.github.com) always hits the network - the app's own localStorage cache
   is the offline data store. Bump VERSION on every deploy so the old cache is
   cleared and the "new version" toast fires.

   On the local dev server this file is a kill switch instead: it wipes every
   cache and unregisters itself. app.js also refuses to register on localhost,
   but that guard is unreachable once an old SW is serving a stale app.js -
   the browser always re-fetches THIS file from the network, so the teardown
   has to live here to be able to break a browser out of a stale shell.
*/

const VERSION = "v9.21";
const CACHE = `kave-food-${VERSION}`;

const IS_LOCAL_DEV = ["localhost", "127.0.0.1"].includes(self.location.hostname);

if (IS_LOCAL_DEV) {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (e) => {
    e.waitUntil(
      caches.keys()
        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .then(() => self.registration.unregister())
        .then(() => self.clients.matchAll({ type: "window" }))
        .then((cs) => cs.forEach((c) => c.navigate(c.url)))
    );
  });
} else {

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

// The page asks for the running VERSION (shown in Settings > Update) and can
// tell a worker stuck in "waiting" to take over. install() already calls
// skipWaiting, so the second case is a belt-and-braces path for a browser
// that held the new worker back anyway.
self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type === "version" && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ version: VERSION });
  }
  if (d.type === "skipWaiting") self.skipWaiting();
});

// Precache with cache: "reload" on every request. c.addAll() would go through
// the browser's HTTP cache, and GitHub Pages serves the shell with a 10 minute
// max-age - so a VERSION bump right after a deploy can fill the brand new
// cache with the files it was meant to replace. That is what happened on the
// v6 deploy: index.html and app.js came through fresh, styles.css did not.
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(
        SHELL.map((u) => fetch(new Request(u, { cache: "reload" }))
          .then((res) => {
            if (!res || !res.ok) throw new Error(`precache ${u}: ${res && res.status}`);
            return c.put(u, res);
          }))
      ))
      .then(() => self.skipWaiting())
  );
});

// Claim BEFORE deleting the old caches, not after. The outgoing worker keeps
// handling fetches until this worker claims its clients, and its
// stale-while-revalidate does caches.open(<its own CACHE>) - which recreates
// the cache we just deleted. Observed on the v8 deploy: kave-food-v7 came back
// from the dead moments after activate cleaned it up.
self.addEventListener("activate", (e) => {
  e.waitUntil(
    self.clients.claim()
      .then(() => caches.keys())
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // GitHub API and any other host: straight to the network, never cached
  if (url.origin !== self.location.origin && !FONT_HOSTS.includes(url.hostname)) return;

  // navigation: network first so a new shell always wins, cache as the
  // offline fallback. Cache-only here strands the browser on an old
  // index.html that no amount of reloading can replace.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("index.html", copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((c) => c || caches.match("index.html")))
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

}
