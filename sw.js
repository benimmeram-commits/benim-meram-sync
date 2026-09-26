// Benim Meram — basit servis çalışanı (service worker).
// Amaç: uygulamayı "Ana Ekrana Ekle / Yükle" ile telefonda gerçek bir
// uygulama gibi açılabilir hale getirmek. Veriler her zaman canlı sunucudan
// gelir (kv/get, kv/set, api/* asla önbelleğe alınmaz) — sadece uygulama
// kabuğu (index.html, ikonlar) hızlı açılış ve temel çevrimdışı erişim için
// önbelleğe alınır.

const CACHE_NAME = "benim-meram-shell-v1";
const SHELL_FILES = ["/", "/index.html", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Canlı veri/API istekleri asla önbellekten karşılanmaz.
  if (url.pathname.startsWith("/kv/") || url.pathname.startsWith("/api/") || url.pathname === "/health") {
    return;
  }

  if (event.request.method !== "GET") return;

  // Uygulama kabuğu: önce ağ, olmazsa önbellek (böylece güncellemeler hemen yansır,
  // internet yokken de son bilinen sürüm açılır).
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match("/index.html")))
  );
});
