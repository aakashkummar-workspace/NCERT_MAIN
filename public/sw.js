/*
 * Sahayak's service worker. Deliberately small, and the smallness is the design.
 *
 * WHAT IT CACHES: the build's own static files (/_next/static — content-hashed,
 * so a cached copy can never be stale), the home-screen icons, and ONE page:
 * /offline/, which says what is safe and what to do.
 *
 * WHAT IT NEVER CACHES: a page, an API response, or anything else that carries
 * a person's data. A large share of students sign in on a phone that is not
 * theirs, and a cached dashboard is one the next person to pick the phone up
 * can open with the connection off and nobody signed in. Offline answers are
 * already kept safely — the exam player, practice and the Mistake Bank write
 * each answer to the device before sending it — so the only thing a page cache
 * would add is that risk.
 *
 * Navigations go to the network. If the network fails, the offline page is
 * shown instead of the browser's dinosaur, and it says the one true thing a
 * student needs to hear: answers already given are on this device and go up
 * by themselves.
 */

const CACHE = "sahayak-static-v1";
const OFFLINE_URL = "/offline/";
const ICONS = ["/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(ICONS);
      const response = await fetch(OFFLINE_URL, { cache: "reload", credentials: "omit" });
      if (!response.ok) return;
      // The offline page's own stylesheet and scripts, so it renders styled
      // with the connection gone. They are content-hashed static files.
      const html = await response.clone().text();
      const assets = [...html.matchAll(/(?:href|src)="(\/_next\/static\/[^"]+)"/g)].map((match) => match[1]);
      await cache.put(OFFLINE_URL, response);
      await Promise.all(
        [...new Set(assets)].map((url) => cache.add(url).catch(() => undefined)),
      );
    })(),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match(OFFLINE_URL);
        return cached ?? Response.error();
      }),
    );
    return;
  }

  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE);
          cache.put(request, response.clone());
        }
        return response;
      })(),
    );
  }
  // Everything else — pages' data, API calls, logos — is not touched at all.
});
