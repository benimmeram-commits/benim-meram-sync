// BENİM MERAM — Senkronizasyon Sunucusu
// -----------------------------------------------------------------------
// Bu sunucu, HTML uygulamasındaki window.storage API'sini taklit eder.
// Amaç: birden fazla kişi aynı HTML dosyasını farklı cihazlarda açtığında
// hepsi aynı ilanları, teklifleri, mesajları ve değerlendirmeleri görsün.
//
// KALICILIK: Render'ın ücretsiz planında yerel disk kalıcı DEĞİLDİR — sunucu
// uykuya geçip tekrar uyandığında dosya sıfırlanabilir. Bunu önlemek için bu
// sürüm, tanımlıysa Upstash Redis'i (ücretsiz, kalıcı) kullanır; tanımlı
// değilse eskisi gibi yerel dosyaya yazar (test/geliştirme için yeterli).
//
// Upstash kullanmak için (önerilir, veriler asla silinmez):
//   1) upstash.com adresinde ücretsiz hesap açın
//   2) "Create Database" ile bir Redis veritabanı oluşturun
//   3) "REST API" bölümünden UPSTASH_REDIS_REST_URL ve
//      UPSTASH_REDIS_REST_TOKEN değerlerini kopyalayın
//   4) Render panelinde bu servisin "Environment" sekmesine bu iki
//      değişkeni aynı isimlerle ekleyin, sonra "Manual Deploy" yapın
// -----------------------------------------------------------------------

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_UPSTASH = !!(UPSTASH_URL && UPSTASH_TOKEN);

// ---------------------------------------------------------------------
// Depolama katmanı: iki uyumlu backend — Upstash Redis (kalıcı) veya
// yerel dosya (data.json, kalıcı olmayabilir). rawGet/rawSet, çağıran
// koda göre hangisinin kullanıldığını fark ettirmez.
// ---------------------------------------------------------------------

const DB_FILE = path.join(__dirname, "data.json");

function loadLocalDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch { return { shared: {}, personal: {} }; }
}
function saveLocalDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
}

async function rawGet(flatKey) {
  if (USE_UPSTASH) {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(flatKey)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await r.json();
    return data.result == null ? undefined : data.result;
  }
  const db = loadLocalDB();
  const [scope, ...rest] = flatKey.split(":");
  if (scope === "shared") return db.shared[rest.join(":")];
  const [owner, ...keyParts] = rest;
  return (db.personal[owner] || {})[keyParts.join(":")];
}

async function rawSet(flatKey, value) {
  if (USE_UPSTASH) {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(flatKey)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      body: value,
    });
    return;
  }
  const db = loadLocalDB();
  const [scope, ...rest] = flatKey.split(":");
  if (scope === "shared") {
    db.shared[rest.join(":")] = value;
  } else {
    const [owner, ...keyParts] = rest;
    if (!db.personal[owner]) db.personal[owner] = {};
    db.personal[owner][keyParts.join(":")] = value;
  }
  saveLocalDB(db);
}

function flatten(key, shared, owner) {
  return shared ? `shared:${key}` : `personal:${owner}:${key}`;
}

// ---------------------------------------------------------------------
// GÜNLÜK SIFIRLAMA: sadece BÖLGE (grup) sohbetlerindeki mesajları temizler.
// Özel (birebir alıcı-satıcı) mesajlar bu işlemden ETKİLENMEZ, kalıcı kalır.
// ---------------------------------------------------------------------
async function resetRegionChatsIfNewDay() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const lastReset = await rawGet("shared:lastRegionResetDate");
  if (lastReset === today) return;

  const raw = await rawGet("shared:messages");
  if (typeof raw === "string") {
    let messages;
    try { messages = JSON.parse(raw); } catch { messages = null; }
    if (Array.isArray(messages)) {
      const kept = messages.filter((m) => !(m && typeof m.conversationId === "string" && m.conversationId.startsWith("bolge-sohbet:")));
      if (kept.length !== messages.length) {
        await rawSet("shared:messages", JSON.stringify(kept));
        console.log(`[günlük sıfırlama] ${messages.length - kept.length} bölge sohbeti mesajı temizlendi.`);
      }
    }
  }
  await rawSet("shared:lastRegionResetDate", today);
}
resetRegionChatsIfNewDay().catch((e) => console.error("Günlük sıfırlama hatası:", e));
setInterval(() => resetRegionChatsIfNewDay().catch((e) => console.error("Günlük sıfırlama hatası:", e)), 30 * 60 * 1000);

// Uygulamanın arayüzünü (index.html) doğrudan bu sunucudan servis eder.
app.use(express.static(__dirname));

app.get("/health", (req, res) => res.json({ ok: true, storage: USE_UPSTASH ? "upstash" : "local-file" }));

// { key, shared, owner } -> { value }  (value null ise kayıt yok demektir)
app.post("/kv/get", async (req, res) => {
  try {
    const { key, shared, owner } = req.body || {};
    if (!key) return res.status(400).json({ error: "key gerekli" });
    const value = await rawGet(flatten(key, shared, owner));
    res.json({ value: value === undefined ? null : value });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "sunucu hatası" });
  }
});

// { key, shared, owner, value } -> { ok: true }
app.post("/kv/set", async (req, res) => {
  try {
    const { key, shared, owner, value } = req.body || {};
    if (!key) return res.status(400).json({ error: "key gerekli" });
    if (!shared && !owner) return res.status(400).json({ error: "personal veri için owner gerekli" });
    await rawSet(flatten(key, shared, owner), value);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "sunucu hatası" });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Benim Meram senkronizasyon sunucusu çalışıyor (${USE_UPSTASH ? "Upstash Redis" : "yerel dosya"}): http://localhost:${PORT}`));
