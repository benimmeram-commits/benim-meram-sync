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
app.use(express.json({ limit: "9.6mb" }));

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_UPSTASH = !!(UPSTASH_URL && UPSTASH_TOKEN);

// ---------------------------------------------------------------------
// Anlık telefon bildirimleri (Web Push): favorilenen bir ilanın fiyatı
// düştüğünde veya bir nakliyeci konum bildirdiğinde, uygulama kapalı olsa
// bile kullanıcının telefonuna bildirim gitmesini sağlar.
//
// KALICILIK UYARISI: Bildirim anahtarları (VAPID) her yeniden başlatmada
// AYNI kalmalıdır — değişirse önceden kaydedilmiş tüm abonelikler geçersiz
// olur. Kalıcı olması için Render panelinde bu servisin "Environment"
// sekmesine şu iki değişkeni ekleyin (aşağıdaki loglardan kopyalayabilirsiniz):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
// Eklenmezse sunucu her açılışta GEÇİCİ anahtarlar üretir (test için
// yeterlidir ama her "yeniden başlatma"da mevcut abonelikler bozulur).
// ---------------------------------------------------------------------
let webpush = null;
try {
  webpush = require("web-push");
} catch (e) {
  console.warn("UYARI: 'web-push' paketi bulunamadı — anlık bildirimler devre dışı. (package.json güncellenip yeniden deploy edilmesi gerekebilir.)");
}
let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
if (webpush) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    const generated = webpush.generateVAPIDKeys();
    VAPID_PUBLIC_KEY = generated.publicKey;
    VAPID_PRIVATE_KEY = generated.privateKey;
    console.warn("UYARI: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY tanımlı değil — geçici anahtarlar üretildi.");
    console.warn("Kalıcı olması için Render > Environment sekmesine şu değerleri ekleyin:");
    console.warn("VAPID_PUBLIC_KEY=" + VAPID_PUBLIC_KEY);
    console.warn("VAPID_PRIVATE_KEY=" + VAPID_PRIVATE_KEY);
  }
  webpush.setVapidDetails("mailto:benimmeram@gmail.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

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

async function getSharedJSON(key, fallback) {
  const raw = await rawGet(`shared:${key}`);
  if (raw === undefined || raw === null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
async function setSharedJSON(key, value) {
  await rawSet(`shared:${key}`, JSON.stringify(value));
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------------------------------------------------------------------
// YAPAY ZEKA ASİSTANI (Claude API)
// -----------------------------------------------------------------------
// Kullanmak için:
//   1) console.anthropic.com üzerinden bir API anahtarı oluşturun
//   2) Render panelinde bu servisin "Environment" sekmesine
//      ANTHROPIC_API_KEY adıyla ekleyin, sonra "Manual Deploy" yapın
// Anahtar tanımlı değilse asistan endpoint'i nazikçe hata döner ve
// uygulamanın geri kalanı hiç etkilenmez.
// ---------------------------------------------------------------------

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = "claude-sonnet-5";

const ASSISTANT_TOOLS = [
  {
    name: "create_listing",
    description: "Giriş yapmış ve belgesi onaylı bir satıcı adına yeni bir satılık hayvan ilanı yayınlar.",
    input_schema: {
      type: "object",
      properties: {
        mainCategory: { type: "string", enum: ["buyukbas", "kucukbas"] },
        subCategory: { type: "string", description: "Örn. Düve, Tosun, Koç, Keçi" },
        breed: { type: "string", description: "Irk, örn. Simental, Akkaraman" },
        age: { type: "string", description: "Örn. '18 Ay'" },
        gender: { type: "string", enum: ["Erkek", "Dişi"] },
        price: { type: "number" },
        earTag: { type: "string", description: "Hayvan küpe numarası — zorunlu" },
        weight: { type: "number", description: "Kilogram, opsiyonel" },
        description: { type: "string", description: "Opsiyonel açıklama" },
      },
      required: ["mainCategory", "subCategory", "breed", "age", "gender", "price", "earTag"],
    },
  },
  {
    name: "create_buy_request",
    description: "Giriş yapmış kullanıcı adına 'Hayvan Arıyorum' alım talebi yayınlar.",
    input_schema: {
      type: "object",
      properties: {
        budget: { type: "number" },
        category: { type: "string", description: "Örn. Düve, Koç" },
        breed: { type: "string", description: "Tercih edilen ırk, opsiyonel" },
      },
      required: ["budget", "category"],
    },
  },
  {
    name: "search_listings",
    description: "Platformdaki mevcut ilanları filtreleyip özetler. Kullanıcı 'ne var', 'fiyatlar ne kadar' gibi sorular sorduğunda kullanın.",
    input_schema: {
      type: "object",
      properties: {
        mainCategory: { type: "string", enum: ["buyukbas", "kucukbas"] },
        subCategory: { type: "string" },
        breed: { type: "string" },
        maxPrice: { type: "number" },
        minPrice: { type: "number" },
      },
    },
  },
  {
    name: "get_my_listings",
    description: "Giriş yapmış kullanıcının kendi ilanlarını listeler.",
    input_schema: { type: "object", properties: {} },
  },
];

async function executeAssistantTool(name, input, user) {
  if (name === "search_listings") {
    const listings = await getSharedJSON("listings", []);
    let matches = listings.filter((l) => l.status !== "kaldirildi");
    if (input.mainCategory) matches = matches.filter((l) => l.mainCategory === input.mainCategory);
    if (input.subCategory) matches = matches.filter((l) => l.subCategory === input.subCategory);
    if (input.breed) matches = matches.filter((l) => (l.breed || "").toLowerCase().includes(String(input.breed).toLowerCase()));
    if (input.maxPrice) matches = matches.filter((l) => l.price <= input.maxPrice);
    if (input.minPrice) matches = matches.filter((l) => l.price >= input.minPrice);
    matches = matches.slice(0, 12);
    if (matches.length === 0) return "Bu kriterlere uyan ilan bulunamadı.";
    return matches.map((l) => `- ${l.breed} ${l.subCategory}, ${l.age}, ${l.price} TL, satıcı: ${l.sellerName}`).join("\n");
  }

  if (name === "get_my_listings") {
    if (!user) return "Kullanıcı giriş yapmamış.";
    const listings = await getSharedJSON("listings", []);
    const mine = listings.filter((l) => l.sellerName === user.name);
    if (mine.length === 0) return "Kullanıcının hiç ilanı yok.";
    return mine.map((l) => `- ${l.breed} ${l.subCategory}, ${l.price} TL, durum: ${l.status}`).join("\n");
  }

  if (name === "create_listing") {
    if (!user) return "HATA: Kullanıcı giriş yapmamış, ilan veremez. Kullanıcıya giriş yapması gerektiğini söyle.";
    if (user.profileType === "alici") return "HATA: Bu kullanıcı 'sadece alıcı' hesabı, satılık ilan veremez.";
    if (!user.isApprovedSeller) return "HATA: Kullanıcının satıcı belgesi henüz onaylanmamış, bu yüzden ilan veremez. Belge onayının yönetim panelinden yapıldığını söyle.";
    const listings = await getSharedJSON("listings", []);
    const dup = listings.find((l) => l.earTag && input.earTag && l.earTag.trim().toUpperCase() === String(input.earTag).trim().toUpperCase() && l.status !== "kaldirildi");
    if (dup) return `HATA: Bu küpe numarası zaten ${dup.sellerName} adlı kullanıcının ilanında kayıtlı. Aynı hayvan iki kez ilan edilemez.`;
    const listing = {
      id: uid(),
      mainCategory: input.mainCategory, subCategory: input.subCategory, breed: input.breed,
      age: input.age, gender: input.gender, price: Number(input.price),
      earTag: String(input.earTag), weight: input.weight ? Number(input.weight) : null,
      purpose: null, vaccinated: null, isPregnant: null, dailyMilkLiters: null,
      description: input.description || "", mediaUrls: [],
      sellerName: user.name, profileType: user.profileType, status: "yayinda", createdAt: Date.now(),
    };
    listings.push(listing);
    await setSharedJSON("listings", listings);
    return `İlan başarıyla yayınlandı: ${listing.breed} ${listing.subCategory}, ${listing.price} TL.`;
  }

  if (name === "create_buy_request") {
    if (!user) return "HATA: Kullanıcı giriş yapmamış, talep oluşturamaz.";
    const requests = await getSharedJSON("requests", []);
    const request = {
      id: uid(), budget: Number(input.budget), category: input.category, breed: input.breed || "",
      buyerName: user.name, status: "acik", createdAt: Date.now(),
    };
    requests.push(request);
    await setSharedJSON("requests", requests);
    return `Alım talebi yayınlandı: ${request.budget} TL bütçe ile ${request.category}.`;
  }

  return "HATA: Bilinmeyen araç.";
}

const ASSISTANT_SYSTEM_PROMPT = `Sen "Benim Meram" adlı büyükbaş/küçükbaş hayvan alım-satım platformunun uygulama içi yapay zeka asistanısın.
Görevin, kullanıcıyı yormadan işleri SENİN yapmandır — kullanıcıya adım adım talimat vermek yerine, elindeki bilgiyle doğrudan aracı (tool) çağırarak işlemi gerçekleştir.
Eksik zorunlu bilgi varsa (örn. ilan için küpe numarası, fiyat) kısa ve net şekilde SADECE o eksik bilgiyi sor, gereksiz soru sorma.
İşlemi tamamladığında kullanıcıya kısa, sıcak bir onay cümlesi söyle. Türkçe, samimi ve kısa konuş — uzun paragraflar yazma.
Kullanıcının giriş yapıp yapmadığı ve satıcı onay durumu sana her mesajda bildirilecek; buna göre hareket et.`;

app.post("/assistant/chat", async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "Yapay zeka asistanı henüz yapılandırılmamış (ANTHROPIC_API_KEY tanımlı değil)." });
  }
  try {
    const { messages, user } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages gerekli" });
    }

    const userContextLine = user
      ? `Giriş yapmış kullanıcı: ${user.name}, profil tipi: ${user.profileType}, satıcı onayı: ${user.isApprovedSeller ? "onaylı" : "onaylı değil / bekliyor"}.`
      : "Kullanıcı giriş yapmamış (misafir). İlan/talep oluşturma gibi işlemler için önce giriş yapması gerektiğini söyle.";

    let convo = messages.map((m) => ({ role: m.role, content: m.content }));
    let finalText = "";
    let actionsPerformed = [];

    for (let i = 0; i < 4; i++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 700,
          system: `${ASSISTANT_SYSTEM_PROMPT}\n\n${userContextLine}`,
          tools: ASSISTANT_TOOLS,
          messages: convo,
        }),
      });

      if (!r.ok) {
        const errText = await r.text();
        console.error("Anthropic API hatası:", r.status, errText);
        return res.status(502).json({ error: "Yapay zeka servisi yanıt vermedi." });
      }
      const data = await r.json();
      const toolUses = (data.content || []).filter((b) => b.type === "tool_use");
      const textBlocks = (data.content || []).filter((b) => b.type === "text");
      finalText = textBlocks.map((b) => b.text).join("\n");

      if (toolUses.length === 0 || data.stop_reason !== "tool_use") {
        break;
      }

      convo.push({ role: "assistant", content: data.content });
      const toolResults = [];
      for (const tu of toolUses) {
        const result = await executeAssistantTool(tu.name, tu.input, user);
        actionsPerformed.push(tu.name);
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
      }
      convo.push({ role: "user", content: toolResults });
    }

    res.json({ reply: finalText || "Anlayamadım, tekrar eder misiniz?", actionsPerformed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "sunucu hatası" });
  }
});

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

// ---------------------------------------------------------------------
// Sosyal medya paylaşım önizlemesi (Open Graph): bir ilan WhatsApp,
// Instagram, Facebook vb. yerlerde paylaşıldığında zengin bir önizleme
// kartı (fotoğraf + başlık + fiyat) çıkması için, bu platformların
// "crawler"ları sayfayı JavaScript ÇALIŞTIRMADAN okur — React uygulaması
// hiç devreye girmeden önce, HTML içinde hazır <meta property="og:..">
// etiketleri bulmaları gerekir. Bu yüzden ?ilan=<id> ile gelen istekte,
// index.html sunucu tarafında ilgili ilanın bilgileriyle değiştirilip
// öyle gönderilir.
// ---------------------------------------------------------------------
function escapeHtmlAttr(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Bir ilanın kapak fotoğrafını gerçek bir resim olarak (base64 değil) sunar —
// og:image için gerçek bir HTTP(S) URL gerekir, sosyal medya crawler'ları
// data: URI'leri okuyamaz.
app.get("/media/listing-image/:id", async (req, res) => {
  try {
    const listings = await getSharedJSON("listings", []);
    const item = listings.find((l) => l.id === req.params.id);
    const img = item && Array.isArray(item.mediaUrls)
      ? item.mediaUrls.find((m) => m.type === "image" && typeof m.dataUrl === "string")
      : null;
    if (!img) return res.status(404).end();
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(img.dataUrl);
    if (!match) return res.status(404).end();
    const buf = Buffer.from(match[2], "base64");
    res.set("Content-Type", match[1]);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch (e) {
    console.error("İlan fotoğrafı sunulamadı:", e);
    res.status(500).end();
  }
});

app.get("/", async (req, res, next) => {
  const ilanId = req.query.ilan;
  if (!ilanId) return next(); // normal ana sayfa isteği — statik dosya olarak devam
  try {
    const listings = await getSharedJSON("listings", []);
    const item = listings.find((l) => l.id === ilanId && l.status !== "kaldirildi");
    if (!item) return next();
    let html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    const origin = `${req.protocol}://${req.get("host")}`;
    const title = `${item.breed || ""} ${item.subCategory || ""}`.trim() || "İlan";
    const priceText = item.price ? `${Number(item.price).toLocaleString("tr-TR")} ₺` : "";
    const desc = [priceText, item.animalIl].filter(Boolean).join(" · ") + (priceText || item.animalIl ? " — " : "") + "Benim Meram'da incele.";
    const hasImage = Array.isArray(item.mediaUrls) && item.mediaUrls.some((m) => m.type === "image" && m.dataUrl);
    const imageUrl = hasImage ? `${origin}/media/listing-image/${item.id}` : `${origin}/icon-512.png`;
    const pageUrl = `${origin}/?ilan=${item.id}`;
    const pageTitle = `${title} — Benim Meram`;
    const ogBlock = `<!-- OG_TAGS_START -->
<meta name="description" content="${escapeHtmlAttr(desc)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Benim Meram" />
<meta property="og:title" content="${escapeHtmlAttr(pageTitle)}" />
<meta property="og:description" content="${escapeHtmlAttr(desc)}" />
<meta property="og:image" content="${escapeHtmlAttr(imageUrl)}" />
<meta property="og:url" content="${escapeHtmlAttr(pageUrl)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtmlAttr(pageTitle)}" />
<meta name="twitter:description" content="${escapeHtmlAttr(desc)}" />
<meta name="twitter:image" content="${escapeHtmlAttr(imageUrl)}" />
<!-- OG_TAGS_END -->`;
    html = html.replace(/<!-- OG_TAGS_START -->[\s\S]*?<!-- OG_TAGS_END -->/, ogBlock);
    html = html.replace("<title>Benim Meram</title>", `<title>${escapeHtmlAttr(pageTitle)}</title>`);
    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    console.error("İlan önizlemesi oluşturulamadı:", e);
    next();
  }
});

// Uygulamanın arayüzünü (index.html) doğrudan bu sunucudan servis eder.
// Sunucu kodu ve veri dosyası dışarıdan indirilemesin diye (express.static
// aksi halde bu klasördeki HER dosyayı, server.js dahil, herkese açık
// sunar) bu isimler engellenir.
app.use((req, res, next) => {
  if (/^\/(server\.js|package(-lock)?\.json|data\.json|\.env)$/i.test(req.path)) {
    return res.status(404).end();
  }
  next();
});
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

// ---------------------------------------------------------------------
// Push abonelik uçları ve bildirim gönderme yardımcıları.
// ---------------------------------------------------------------------
app.get("/push/public-key", (req, res) => {
  if (!webpush || !VAPID_PUBLIC_KEY) return res.status(503).json({ error: "bildirimler yapılandırılmamış" });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post("/push/subscribe", async (req, res) => {
  try {
    const { owner, memberName, subscription } = req.body || {};
    if (!owner || !subscription) return res.status(400).json({ error: "eksik veri" });
    const all = await getSharedJSON("pushSubscriptions", []);
    const filtered = all.filter((s) => s.owner !== owner);
    filtered.push({ owner, memberName: memberName || null, subscription, updatedAt: Date.now() });
    await setSharedJSON("pushSubscriptions", filtered);
    res.json({ ok: true });
  } catch (e) {
    console.error("Push aboneliği kaydedilemedi:", e);
    res.status(500).json({ error: "sunucu hatası" });
  }
});

app.post("/push/unsubscribe", async (req, res) => {
  try {
    const { owner } = req.body || {};
    if (!owner) return res.status(400).json({ error: "owner gerekli" });
    const all = await getSharedJSON("pushSubscriptions", []);
    await setSharedJSON("pushSubscriptions", all.filter((s) => s.owner !== owner));
    res.json({ ok: true });
  } catch (e) {
    console.error("Push aboneliği kaldırılamadı:", e);
    res.status(500).json({ error: "sunucu hatası" });
  }
});

// Belirli bir üyeye (isme) kayıtlı tüm cihazlarına bildirim gönderir.
// Artık geçerli olmayan (404/410) abonelikler otomatik temizlenir.
async function sendPushToMember(memberName, payload) {
  if (!webpush || !memberName) return;
  const all = await getSharedJSON("pushSubscriptions", []);
  const targets = all.filter((s) => s.memberName === memberName);
  if (targets.length === 0) return;
  let changed = false;
  for (const t of targets) {
    try {
      await webpush.sendNotification(t.subscription, JSON.stringify(payload));
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        const idx = all.indexOf(t);
        if (idx > -1) { all.splice(idx, 1); changed = true; }
      } else {
        console.error("Push gönderilemedi:", memberName, e && e.message);
      }
    }
  }
  if (changed) await setSharedJSON("pushSubscriptions", all);
}

function memberAllowsNotif(members, name, prefKey) {
  const m = members.find((mm) => mm.name === name);
  if (!m || !m.notifPrefs) return true; // tercih ayarlanmamışsa varsayılan: açık
  return m.notifPrefs[prefKey] !== false;
}

// "listings" verisi güncellendiğinde eski/yeni fiyatları karşılaştırır;
// düşen fiyatlar için o ilanı favorileyen kullanıcılara bildirim gönderir.
async function notifyPriceDrops(oldArr, newArr) {
  if (!Array.isArray(oldArr) || !Array.isArray(newArr)) return;
  const oldById = new Map(oldArr.map((l) => [l.id, l]));
  const drops = newArr.filter((l) => {
    const old = oldById.get(l.id);
    return old && Number(l.price) < Number(old.price) && l.status !== "kaldirildi";
  });
  if (drops.length === 0) return;
  const [favLog, members] = await Promise.all([
    getSharedJSON("favoritesLog", []),
    getSharedJSON("members", []),
  ]);
  for (const listing of drops) {
    const old = oldById.get(listing.id);
    const fans = favLog.filter((f) => f.listingId === listing.id).map((f) => f.userName);
    const uniqueFans = [...new Set(fans)].filter((n) => n && n !== listing.sellerName && memberAllowsNotif(members, n, "fiyatDususu"));
    if (uniqueFans.length === 0) continue;
    const title = "Favori ilanın fiyatı düştü";
    const body = `${listing.breed || ""} ${listing.subCategory || ""} — ${Number(old.price).toLocaleString("tr-TR")} ₺ → ${Number(listing.price).toLocaleString("tr-TR")} ₺`;
    await Promise.all(uniqueFans.map((name) => sendPushToMember(name, { title, body, url: `/?ilan=${listing.id}` })));
  }
}

// "messages" verisine YENİ eklenen mesajları bulur ve 1:1 sohbetin diğer
// tarafına, mesaj tipine göre uygun bildirimi gönderir. Bölge sohbetleri
// (herkese açık, çok kalabalık) bu bildirimlerin dışındadır — aksi halde
// her mesajda bölgedeki herkese bildirim gitmesi çok rahatsız edici olurdu.
async function notifyNewMessages(oldArr, newArr) {
  if (!Array.isArray(oldArr) || !Array.isArray(newArr)) return;
  const oldIds = new Set(oldArr.map((m) => m && m.id));
  const added = newArr.filter((m) => m && !oldIds.has(m.id));
  if (added.length === 0) return;
  const members = await getSharedJSON("members", []);
  for (const m of added) {
    if (!m.conversationId || m.conversationId.startsWith("bolge-sohbet:")) continue;
    const parts = m.conversationId.split("::");
    if (parts.length !== 3) continue;
    const [, nameA, nameB] = parts;
    const recipient = m.sender === nameA ? nameB : m.sender === nameB ? nameA : null;
    if (!recipient) continue;
    if (m.type === "location") {
      if (!memberAllowsNotif(members, recipient, "nakliyeKonum")) continue;
      await sendPushToMember(recipient, { title: "Nakliyeci konum bildirdi", body: m.text || "Hayvanınızın güncel konumu paylaşıldı.", url: "/" });
    } else if (m.type === "appointment") {
      if (!memberAllowsNotif(members, recipient, "randevu")) continue;
      await sendPushToMember(recipient, { title: "Randevu güncellendi", body: `${m.sender} bir randevu teklif etti veya güncelledi.`, url: "/" });
    } else if (m.type === undefined && m.text) {
      if (!memberAllowsNotif(members, recipient, "mesaj")) continue;
      const preview = String(m.text).length > 80 ? String(m.text).slice(0, 77) + "..." : m.text;
      await sendPushToMember(recipient, { title: `${m.sender}`, body: preview, url: "/" });
    }
  }
}

// "offers" (teklifler) verisindeki değişiklikleri karşılaştırır:
// (1) YENİ bir teklif eklendiyse ilanın sahibine (satıcıya) bildirim gider.
// (2) Var olan bir teklifin durumu değiştiyse (kabul/red/karşı teklif)
// teklifi verene (alıcıya) bildirim gider.
async function notifyOfferChanges(oldArr, newArr) {
  if (!Array.isArray(oldArr) || !Array.isArray(newArr)) return;
  const oldById = new Map(oldArr.map((o) => [o.id, o]));
  const members = await getSharedJSON("members", []);
  for (const offer of newArr) {
    const old = oldById.get(offer.id);
    if (!old) {
      // Yeni teklif
      if (offer.sellerName && memberAllowsNotif(members, offer.sellerName, "yeniTeklif")) {
        await sendPushToMember(offer.sellerName, {
          title: "Yeni teklif geldi",
          body: `${offer.buyerName || "Bir kullanıcı"} ${Number(offer.amount).toLocaleString("tr-TR")} ₺ teklif etti.`,
          url: `/?ilan=${offer.listingId}`,
        });
      }
    } else if (old.status !== offer.status && offer.buyerName && memberAllowsNotif(members, offer.buyerName, "teklifDurumu")) {
      const statusText = offer.status === "kabul" ? "kabul edildi ✓" : offer.status === "red" ? "reddedildi" : offer.status === "karsi_teklif" ? `karşı teklif geldi: ${Number(offer.counterAmount || 0).toLocaleString("tr-TR")} ₺` : offer.status;
      await sendPushToMember(offer.buyerName, {
        title: "Teklifiniz güncellendi",
        body: `Teklifiniz ${statusText}`,
        url: `/?ilan=${offer.listingId}`,
      });
    }
  }
}

// "members" verisindeki belge/doğrulama onay durumu değişikliklerini
// (beklemede -> onaylandı/reddedildi) yakalar ve ilgili kullanıcıya bildirim
// gönderir. newArr'ın kendisi zaten güncel tercihleri taşıdığı için ayrıca
// members çekmeye gerek yoktur.
async function notifyMemberStatusChanges(oldArr, newArr) {
  if (!Array.isArray(oldArr) || !Array.isArray(newArr)) return;
  const oldById = new Map(oldArr.map((m) => [`${m.name}::${m.joinedAt}`, m]));
  for (const member of newArr) {
    const old = oldById.get(`${member.name}::${member.joinedAt}`);
    if (!old) continue;
    if (!memberAllowsNotif(newArr, member.name, "belgeOnay")) continue;
    if (old.documentStatus !== member.documentStatus && (member.documentStatus === "onaylandi" || member.documentStatus === "reddedildi")) {
      await sendPushToMember(member.name, {
        title: member.documentStatus === "onaylandi" ? "Belgeniz onaylandı ✓" : "Belgeniz reddedildi",
        body: member.documentStatus === "onaylandi" ? "Artık ilan verebilirsiniz." : "Lütfen belgelerinizi kontrol edip tekrar başvurun.",
        url: "/",
      });
    }
    if (old.nakliyeVerification !== member.nakliyeVerification && (member.nakliyeVerification === "onaylandi" || member.nakliyeVerification === "reddedildi")) {
      await sendPushToMember(member.name, {
        title: member.nakliyeVerification === "onaylandi" ? "Nakliyeci doğrulamanız onaylandı ✓" : "Nakliyeci doğrulamanız reddedildi",
        body: member.nakliyeVerification === "onaylandi" ? "Doğrulanmış nakliyeci rozetiniz aktif." : "Lütfen belgelerinizi kontrol edip tekrar başvurun.",
        url: "/",
      });
    }
  }
}

// { key, shared, owner, value } -> { ok: true }
app.post("/kv/set", async (req, res) => {
  try {
    const { key, shared, owner, value } = req.body || {};
    if (!key) return res.status(400).json({ error: "key gerekli" });
    if (!shared && !owner) return res.status(400).json({ error: "personal veri için owner gerekli" });

    // Bildirim tetikleyicileri için, veri yazılmadan ÖNCE eski hali okunur
    // (neyin değiştiğini anlamak için). Bu, kayıt isteğinin süresini uzatmaz —
    // asıl bildirim gönderimi yanıt döndürüldükten SONRA arka planda yapılır.
    let notifyAfterWrite = null;
    if (shared && webpush && (key === "listings" || key === "messages" || key === "offers" || key === "members")) {
      try {
        const oldRaw = await rawGet(flatten(key, shared, owner));
        const oldArr = oldRaw ? JSON.parse(oldRaw) : [];
        const newArr = value ? JSON.parse(value) : [];
        if (key === "listings") notifyAfterWrite = () => notifyPriceDrops(oldArr, newArr);
        else if (key === "messages") notifyAfterWrite = () => notifyNewMessages(oldArr, newArr);
        else if (key === "offers") notifyAfterWrite = () => notifyOfferChanges(oldArr, newArr);
        else if (key === "members") notifyAfterWrite = () => notifyMemberStatusChanges(oldArr, newArr);
      } catch (e) {
        console.warn("Bildirim için fark hesaplanamadı:", e && e.message);
      }
    }

    await rawSet(flatten(key, shared, owner), value);
    res.json({ ok: true });
    if (notifyAfterWrite) {
      notifyAfterWrite().catch((e) => console.error("Bildirim gönderilemedi:", e));
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "sunucu hatası" });
  }
});

// ---------------------------------------------------------------------
// NVİ / KPSPublic — TC Kimlik No doğrulama (ücretsiz, açık, resmi devlet
// servisi). Sadece "bu TC + Ad + Soyad + Doğum Yılı birbiriyle uyumlu mu?"
// sorusuna true/false cevabı verir; adres/soykütük gibi hassas bilgi
// DÖNMEZ. Tarayıcıdan doğrudan çağrılamaz (CORS + SOAP), bu yüzden burada
// sunucu üzerinden proxy'leniyor.
// ---------------------------------------------------------------------
const NVI_SOAP_URL = "https://tckimlik.nvi.gov.tr/Service/KPSPublic.asmx";

// NVİ'nin genel kullanıma açık ücretsiz TCKimlikNoDogrula servisi resmi
// kurumlar dışında sık sık erişilemez hale geliyor (kapatıldı/kısıtlandı).
// ÖNEMLİ: Gerçek servise ulaşılamadığında "verified: true" DÖNDÜRÜLMEZ —
// çünkü TC Kimlik No'nun checksum (sağlama) kuralına uyması, o kimlik
// numarasının GİRİLEN ad/soyad ile eşleştiği anlamına gelmez; sadece
// numaranın biçimsel olarak geçerli olduğunu gösterir. Bu yüzden yanlış
// bilgiyle de "doğrulandı" görünmesine yol açan önceki davranış kaldırıldı.
// Gerçek servise ulaşılamazsa, kullanıcı kilitlenmesin diye kayda devam
// etmesine izin verilir ama "serviceUnavailable: true" ile işaretlenir ve
// bu hesap Süper Admin panelinde manuel incelemeye düşer (bkz. app.js
// pendingNviReviews / nviVerification alanı).
app.post("/api/nvi-verify", async (req, res) => {
  const { tcKimlikNo, ad, soyad, dogumYili } = req.body || {};
  if (!tcKimlikNo || !ad || !soyad || !dogumYili) {
    return res.status(400).json({ error: "tcKimlikNo, ad, soyad, dogumYili gerekli" });
  }
  const tcNum = String(tcKimlikNo).replace(/\D/g, "");
  const yil = String(dogumYili).replace(/\D/g, "");
  if (tcNum.length !== 11 || yil.length !== 4) {
    return res.status(400).json({ error: "geçersiz TC Kimlik No veya doğum yılı" });
  }
  const yilNum = Number(yil);
  const nowYear = new Date().getFullYear();
  if (yilNum < 1900 || yilNum > nowYear) {
    return res.status(400).json({ error: "geçersiz doğum yılı" });
  }
  const respondUnavailable = (reason) => {
    console.warn("NVİ gerçek servisine ulaşılamadı, manuel incelemeye düşürülüyor:", reason);
    return res.json({ verified: false, serviceUnavailable: true, detail: "NVİ resmi doğrulama servisine şu anda ulaşılamıyor. Bilgileriniz kaydedilecek ve yönetici tarafından manuel olarak incelenecek." });
  };
  const adUpper = String(ad).toLocaleUpperCase("tr-TR").trim();
  const soyadUpper = String(soyad).toLocaleUpperCase("tr-TR").trim();
  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <TCKimlikNoDogrula xmlns="http://tckimlik.nvi.gov.tr/WS">
      <TCKimlikNo>${tcNum}</TCKimlikNo>
      <Ad>${adUpper}</Ad>
      <Soyad>${soyadUpper}</Soyad>
      <DogumYili>${yil}</DogumYili>
    </TCKimlikNoDogrula>
  </soap:Body>
</soap:Envelope>`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  let r;
  try {
    r = await fetch(NVI_SOAP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": "http://tckimlik.nvi.gov.tr/WS/TCKimlikNoDogrula",
        "User-Agent": "Mozilla/5.0 (compatible; BenimMeram/1.0; +https://benim-meram-sync.onrender.com)",
        "Accept": "*/*",
      },
      body: soapBody,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    const detail = e.cause ? `${e.message} (${e.cause.code || e.cause.message || e.cause})` : (e.name === "AbortError" ? "zaman aşımı" : e.message);
    return respondUnavailable(detail);
  }
  clearTimeout(timeoutId);
  let text;
  try {
    text = await r.text();
  } catch (e) {
    return respondUnavailable("yanıt gövdesi okunamadı: " + e.message);
  }
  if (!r.ok) {
    return respondUnavailable(`HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  const faultMatch = text.match(/<faultstring>([\s\S]*?)<\/faultstring>/i);
  if (faultMatch) {
    return respondUnavailable("SOAP Fault: " + faultMatch[1]);
  }
  const match = text.match(/<TCKimlikNoDogrulaResult>(true|false)<\/TCKimlikNoDogrulaResult>/i);
  if (!match) {
    return respondUnavailable("beklenmedik yanıt formatı: " + text.slice(0, 300));
  }
  res.json({ verified: match[1].toLowerCase() === "true" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Benim Meram senkronizasyon sunucusu çalışıyor (${USE_UPSTASH ? "Upstash Redis" : "yerel dosya"}): http://localhost:${PORT}`));
