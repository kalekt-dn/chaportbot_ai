import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ===== ENV (isi di Railway Variables) =====
const CHAPORT_TOKEN = process.env.CHAPORT_TOKEN || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ""; // sementara kosongkan dulu
const SETUP_KEY = process.env.SETUP_KEY || "";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// ===== KEYWORDS =====
const DEPOSIT_KW = ["deposit", "depo", "top up", "topup", "isi saldo"];
const REGISTER_KW = ["daftar", "register", "buat akun"];
const RESET_KW = ["reset", "lupa password", "forgot password", "reset password"];

// ===== STATE =====
const chats = new Map();

function hasKeyword(text, keywords) {
  if (!text) return false;
  const t = text.toLowerCase();
  return keywords.some((k) => t.includes(k));
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
  });
}

async function chaportRequest(path, { method = "GET", body } = {}) {
  if (!CHAPORT_TOKEN) throw new Error("CHAPORT_TOKEN missing (isi di Railway Variables)");
  const url = `https://app.chaport.com/api/v1${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${CHAPORT_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await res.text();
  let json;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = { raw };
  }

  if (!res.ok) {
    throw new Error(`Chaport API ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function sendChaportMessage(visitorId, chatId, text) {
  return chaportRequest("/messages", {
    method: "POST",
    body: {
      visitor: { id: visitorId },
      chat: { id: chatId },
      message: { text },
    },
  });
}

// ===== Health check =====
app.get("/", (req, res) => {
  res.send("Chaport auto-reply bot is running");
});

// ===== Debug: lihat subscriptions yang kebentuk di Chaport =====
app.get("/debug/subscriptions", async (req, res) => {
  try {
    if (!SETUP_KEY) return res.status(400).send("SETUP_KEY belum di-set");
    if (req.query.key !== SETUP_KEY) return res.status(401).send("Unauthorized");
    const subs = await chaportRequest("/events/subscriptions");
    res.json(subs);
  } catch (e) {
    console.error("DEBUG SUBS ERR:", e);
    res.status(500).send(String(e.message || e));
  }
});

// ===== ONE-TIME SETUP: register hook via API =====
// Buka sekali saja:
//   https://DOMAIN_RAILWAY/setup?key=SETUP_KEY
app.get("/setup", async (req, res) => {
  try {
    if (!SETUP_KEY) return res.status(400).send("SETUP_KEY belum di-set di Railway Variables");
    if (req.query.key !== SETUP_KEY) return res.status(401).send("Unauthorized (key salah)");
    if (!PUBLIC_BASE_URL) return res.status(400).send("PUBLIC_BASE_URL belum di-set di Railway Variables");

    const targetUrl = `${PUBLIC_BASE_URL}/chaport/webhook`;
    const event = "chat.newEvent.visitorMessage"; // sesuai arahan CS Chaport

    const existing = await chaportRequest("/events/subscriptions");
    const found = existing?.result?.find((x) => x.event === event && x.targetUrl === targetUrl);

    if (found) {
      return res.send(`OK (already exists): ${found.id}`);
    }

    const created = await chaportRequest("/events/subscriptions", {
      method: "POST",
      body: { targetUrl, event, essential: true },
    });

    res.send(`OK (created): ${JSON.stringify(created)}`);
  } catch (e) {
    console.error("SETUP ERR:", e);
    res.status(500).send(String(e.message || e));
  }
});

// ===== Webhook receiver (dipanggil Chaport) =====
app.post("/chaport/webhook", async (req, res) => {
  try {
    // sementara: biarin WEBHOOK_SECRET kosong. Kalau kamu isi, pastikan Chaport bisa kirim header ini.
    if (WEBHOOK_SECRET && req.headers["x-webhook-secret"] !== WEBHOOK_SECRET) {
      console.log("WEBHOOK 401 (secret mismatch)");
      return res.sendStatus(401);
    }

    console.log("HOOK BODY:", JSON.stringify(req.body));

    // Banyak hook Chaport kirim "link" untuk ambil detail event
    const link = req.body?.link;
    let eventData = null;

    if (link && typeof link === "string") {
      const path = link.replace("/api/v1", "");
      const got = await chaportRequest(path);
      eventData = got?.result || got;
    } else {
      eventData = req.body;
    }

    console.log("EVENT DATA:", JSON.stringify(eventData));

    const visitorId =
      eventData?.extras?.visitorId ||
      eventData?.visitorId ||
      eventData?.visitor?.id;

    const chatId =
      eventData?.extras?.chatId ||
      eventData?.chatId ||
      eventData?.chat?.id;

    const text =
      eventData?.message?.text ||
      eventData?.text ||
      eventData?.extras?.text ||
      "";

    console.log("PARSED:", JSON.stringify({ visitorId, chatId, text }));

    if (!visitorId || !chatId) return res.sendStatus(200);

    const key = `${visitorId}:${chatId}`;
    if (!chats.has(key)) chats.set(key, { replied: false });
    const chat = chats.get(key);

    // Notif Telegram untuk daftar/reset
    if (hasKeyword(text, REGISTER_KW) || hasKeyword(text, RESET_KW)) {
      await sendTelegram(
        `🚨 CHAPORT ALERT\n\n"${text}"\nvisitorId: ${visitorId}\nchatId: ${chatId}`
      );
    }

    // Deposit -> auto reply 2 menit
    if (hasKeyword(text, DEPOSIT_KW)) {
      setTimeout(async () => {
        if (!chat.replied) {
          await sendChaportMessage(
            visitorId,
            chatId,
            "Siap, untuk deposit silakan kirim nominal dan metode pembayaran ya 🙏"
          );
          chat.replied = true;
        }
      }, 2 * 60 * 1000);
    }

    // Default -> auto reply 5 menit
    setTimeout(async () => {
      if (!chat.replied) {
        await sendChaportMessage(
          visitorId,
          chatId,
          "Maaf ya, chat kamu baru kebaca 🙏 Aku bantu cek sekarang."
        );
        chat.replied = true;
      }
    }, 5 * 60 * 1000);

    res.sendStatus(200);
  } catch (e) {
    console.error("WEBHOOK ERR:", e);
    res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log("Listening on", PORT);
});
