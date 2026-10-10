// Keeps the app's own files on the device, so it opens without internet and
// saved games can be looked at offline. Reading photos (Gemini) and Lichess
// always need the network and are never cached.
//
// Network first: online, the newest files are always used (and stored);
// offline, the stored copy is used. Bump VERSION when files are added or
// removed, so old copies are cleaned up.
const VERSION = "v5";
const CACHE = "protokoll-" + VERSION;
const NETWORK_TIMEOUT_MS = 4000;

const PIECES = ["K", "Q", "R", "B", "N", "P"].flatMap((p) => ["w" + p, "b" + p]).map((c) => `pieces/${c}.svg`);
const ASSETS = [
  "./", "index.html", "bulk.html", "style.css", "app.js", "bulk.js", "settings.js", "key.js", "ui.js", "lichess.js", "games.js", "photos.js", "demo.json", "manifest.webmanifest",
  "core/gemini.js", "core/notation.js", "core/notations.js", "core/pgn.js", "core/pipeline.js", "core/reading.js", "core/resolver.js", "core/grouping.js", "core/studies.js",
  "vendor/chess.js",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/favicon-32.png",
  ...PIECES,
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("protokoll-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;  // Gemini, Lichess: straight to the network
  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, fail) => setTimeout(() => fail(new Error("slow network")), NETWORK_TIMEOUT_MS)),
    ]);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (e) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === "navigate") {
      const page = await cache.match("index.html");
      if (page) return page;
    }
    throw e;
  }
}
