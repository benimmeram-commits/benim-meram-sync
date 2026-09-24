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

// ---------------------------------------------------------------------
// NVİ / KPSPublic — TC Kimlik No doğrulama (ücretsiz, açık, resmi devlet
// servisi). Sadece "bu TC + Ad + Soyad + Doğum Yılı birbiriyle uyumlu mu?"
// sorusuna true/false cevabı verir; adres/soykütük gibi hassas bilgi
// DÖNMEZ. Tarayıcıdan doğrudan çağrılamaz (CORS + SOAP), bu yüzden burada
// sunucu üzerinden proxy'leniyor.
// ---------------------------------------------------------------------
const NVI_SOAP_URL = "https://tckimlik.nvi.gov.tr/Service/KPSPublic.asmx";
app.post("/api/nvi-verify", async (req, res) => {
  try {
    const { tcKimlikNo, ad, soyad, dogumYili } = req.body || {};
    if (!tcKimlikNo || !ad || !soyad || !dogumYili) {
      return res.status(400).json({ error: "tcKimlikNo, ad, soyad, dogumYili gerekli" });
    }
    const tcNum = String(tcKimlikNo).replace(/\D/g, "");
    const yil = String(dogumYili).replace(/\D/g, "");
    if (tcNum.length !== 11 || yil.length !== 4) {
      return res.status(400).json({ error: "geçersiz TC Kimlik No veya doğum yılı" });
    }
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
    const timeoutId = setTimeout(() => controller.abort(), 12000);
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
    } finally {
      clearTimeout(timeoutId);
    }
    const text = await r.text();
    if (!r.ok) {
      console.error(`NVİ HTTP ${r.status}:`, text.slice(0, 500));
      return res.status(502).json({ error: `NVİ servisi HTTP ${r.status} döndürdü`, detail: text.slice(0, 300) || "(boş yanıt gövdesi)" });
    }
    const faultMatch = text.match(/<faultstring>([\s\S]*?)<\/faultstring>/i);
    if (faultMatch) {
      console.error("NVİ SOAP Fault:", faultMatch[1]);
      return res.status(502).json({ error: "NVİ servisi hata döndürdü (SOAP Fault)", detail: faultMatch[1].slice(0, 300) });
    }
    const match = text.match(/<TCKimlikNoDogrulaResult>(true|false)<\/TCKimlikNoDogrulaResult>/i);
    if (!match) {
      console.error("NVİ yanıtı beklenmedik formatta:", text.slice(0, 500));
      return res.status(502).json({ error: "NVİ servisinden geçerli bir yanıt alınamadı", detail: text.slice(0, 300) || "(boş yanıt gövdesi, HTTP " + r.status + ")" });
    }
    res.json({ verified: match[1].toLowerCase() === "true" });
  } catch (e) {
    console.error("NVİ doğrulama hatası:", e);
    const detail = e.cause ? `${e.message} (${e.cause.code || e.cause.message || e.cause})` : (e.name === "AbortError" ? "zaman aşımı (12sn)" : e.message);
    res.status(502).json({ error: "NVİ servisine ulaşılamadı", detail });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Benim Meram senkronizasyon sunucusu çalışıyor (${USE_UPSTASH ? "Upstash Redis" : "yerel dosya"}): http://localhost:${PORT}`));
