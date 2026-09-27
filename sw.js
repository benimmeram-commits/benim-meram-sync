// Benim Meram — basit servis çalışanı (service worker).
// Amaç: uygulamayı "Ana Ekrana Ekle / Yükle" ile telefonda gerçek bir
// uygulama gibi açılabilir hale getirmek. Veriler her zaman canlı sunucudan
// gelir (kv/get, kv/set, api/* asla önbelleğe alınmaz) — sadece uygulama
// kabuğu (index.html, ikonlar) hızlı açılış ve temel çevrimdışı erişim için
// önbelleğe alınır.

const CACHE_NAME = "benim-meram-shell-v1";
const SHELL_FILES = ["/", "/index.html", "/manifest.json", "/icon-192.png", "/icon-512.png"];

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

// Anlık bildirimler (Web Push): sunucu bir "push" olayı gönderdiğinde
// (favori ilanın fiyatı düştü, nakliyeci konum bildirdi vb.) uygulama
// kapalı/arka planda olsa bile telefonun bildirim çekmecesinde gösterilir.
self.addEventListener("push", (event) => {
  let data = { title: "Benim Meram", body: "Yeni bir bildiriminiz var.", url: "/" };
  try {
    if (event.data) data = Object.assign(data, event.data.json());
  } catch (e) { /* düz metinse varsayılan kullanılır */ }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      badge: "/icon-192.png",
      data: { url: data.url || "/" },
    })
  );
});

// Bildirime dokunulduğunda uygulamayı (açıksa) öne getirir, değilse yeni
// sekmede ilgili sayfayı (örn. ?ilan=<id>) açar.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        if ("focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
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
