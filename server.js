// BENİM MERAM — Senkronizasyon Sunucusu
// -----------------------------------------------------------------------
// Bu sunucu, HTML uygulamasındaki window.storage API'sini taklit eder.
// Amaç: birden fazla kişi aynı HTML dosyasını farklı cihazlarda açtığında
// hepsi aynı ilanları, teklifleri, mesajları ve değerlendirmeleri görsün.
//
// "shared" veri  -> herkesin gördüğü ortak veri (ilanlar, teklifler, mesajlar...)
// "personal" veri -> her cihaza özel veri (hesap bilgisi, favoriler...),
//                    cihazlar "owner" kimliğiyle birbirinden ayrılır.
//
// Basitlik için tek bir JSON dosyasına yazar. Küçük/orta ölçekli bir
// prototip için yeterlidir; ciddi trafik beklerseniz gerçek bir veritabanına
// (ör. teslim edilen PostgreSQL şeması) geçmeniz önerilir.
// -----------------------------------------------------------------------

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const DB_FILE = path.join(__dirname, "data.json");

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return { shared: {}, personal: {} };
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
}

// Uygulamanın arayüzünü (public/index.html) doğrudan bu sunucudan servis eder.
// Böylece kimsenin dosya indirip açmasına gerek kalmaz — sadece link paylaşılır.
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => res.json({ ok: true }));

// { key, shared, owner } -> { value }  (value null ise kayıt yok demektir)
app.post("/kv/get", (req, res) => {
  const { key, shared, owner } = req.body || {};
  if (!key) return res.status(400).json({ error: "key gerekli" });
  const db = loadDB();
  const store = shared ? db.shared : db.personal[owner] || {};
  const value = store[key];
  res.json({ value: value === undefined ? null : value });
});

// { key, shared, owner, value } -> { ok: true }
app.post("/kv/set", (req, res) => {
  const { key, shared, owner, value } = req.body || {};
  if (!key) return res.status(400).json({ error: "key gerekli" });
  if (!shared && !owner) return res.status(400).json({ error: "personal veri için owner gerekli" });
  const db = loadDB();
  if (shared) {
    db.shared[key] = value;
  } else {
    if (!db.personal[owner]) db.personal[owner] = {};
    db.personal[owner][key] = value;
  }
  saveDB(db);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Benim Meram senkronizasyon sunucusu çalışıyor: http://localhost:${PORT}`));
