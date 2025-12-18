import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// ===== ENV (Railway Variables) =====
const CHAPORT_TOKEN = process.env.CHAPORT_TOKEN || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const SETUP_KEY = process.env.SETUP_KEY || "";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// ===== KEYWORDS =====
const DEPOSIT_KW = ["deposit", "depo", "top up", "topup", "isi saldo"];
const REGISTER_KW = ["daftar", "register", "buat akun"];
const RESET_KW = ["reset", "lupa password", "forgot password", "reset password"];

// ===== STATE =====
const chatState = new Map(); // key: visitorId:chatId -> { replied, lastEventTs, timersSet }

function hasKeyword(text, keywords) {
  if (!text) return false;
  const t = String(text).toLowerCase();
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

  if (!res.ok) throw new Error(`Chaport API ${res.status}: ${JSON.stringify(json)}`);
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

app.get("/", (req, res) => res.send("Chaport auto-reply bot is running"));

// ===== Setup Hook: chat.started (supported event) =====
app.get("/setup", async (req, res) => {
  try {
    if (!SETUP_KEY) return res.status(400).send("SETUP_KEY belum di-set");
    if (req.query.key !== SETUP_KEY) return res.status(401).send("Unauthorized (key salah)");
    if (!PUBLIC_BASE_URL) return res.status(400).send("PUBLIC_BASE_URL belum di-set");

    const targetUrl = `${PUBLIC_BASE_URL}/chaport/webhook`;
    const event = "chat.started"; // ✅ event yang ada di docs “supported events” (bagian Events)

    const existing = await chaportRequest("/events/subscriptions");
    const found = existing?.result?.find((x) => x.event === event && x.targetUrl === targetUrl);

    if (found) return res.send(`OK (already exists): ${found.id}`);

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

// ===== Debug subscriptions =====
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

// ===== Polling chat events to detect visitor messages =====
async function pollChatEvents(visitorId, chatId) {
  const key = `${visitorId}:${chatId}`;
  const state = chatState.get(key) || { replied: false, lastEventTs: null, timersSet: false };
  chatState.set(key, state);

  // Ambil events (bisa juga pakai transcript=true, tapi kita keep simple)
  const eventsResp = await chaportRequest(`/visitors/${visitorId}/chats/${chatId}/events`);
  const events = eventsResp?.result || [];

  // Cari event visitor message terbaru (type biasanya ada “visitorMessage” di payload event)
  // Karena doc event types detail ada di schema, kita fallback ke deteksi field text juga.
  let latestMsg = null;

  for (const ev of events) {
    const ts = ev.timestamp || ev.createdAt || null;

    // skip kalau sudah pernah diproses
    if (state.lastEventTs && ts && ts <= state.lastEventTs) continue;

    const maybeText = ev?.message?.text || ev?.text || ev?.data?.text || "";
    const maybeType = String(ev?.type || "").toLowerCase();

    // heuristik: yang penting ada text dari visitor
    if (maybeText && (maybeType.includes("visitor") || maybeType.includes("message") || true)) {
      latestMsg = { text: maybeText, ts };
    }
  }

  if (latestMsg?.ts) state.lastEventTs = latestMsg.ts;

  if (latestMsg?.text) {
    const text = latestMsg.text;

    // notif TG untuk daftar/reset
    if (hasKeyword(text, REGISTER_KW) || hasKeyword(text, RESET_KW)) {
      await sendTelegram(`🚨 CHAPORT ALERT\n\n"${text}"\nvisitorId: ${visitorId}\nchatId: ${chatId}`);
    }

    // set timers sekali aja per chat
    if (!state.timersSet) {
      state.timersSet = true;

      // deposit -> 2 menit
      if (hasKeyword(text, DEPOSIT_KW)) {
        setTimeout(async () => {
          if (!state.replied) {
            await sendChaportMessage(
              visitorId,
              chatId,
              "Siap, untuk deposit silakan kirim nominal dan metode pembayaran ya 🙏"
            );
            state.replied = true;
          }
        }, 2 * 60 * 1000);
      }

      // default -> 5 menit
      setTimeout(async () => {
        if (!state.replied) {
          await sendChaportMessage(
            visitorId,
            chatId,
            "Maaf ya, chat kamu baru kebaca 🙏 Aku bantu cek sekarang."
          );
          state.replied = true;
        }
      }, 5 * 60 * 1000);
    }
  }
}

// ===== Webhook receiver (chat.started) =====
// Payload event chat.started berisi "link" ke chat (lihat contoh di docs Events chat.started)
app.post("/chaport/webhook", async (req, res) => {
  try {
    console.log("HOOK BODY:", JSON.stringify(req.body));

    const link = req.body?.link; // contoh: "/api/v1/visitors/.../chats"
    if (!link) return res.sendStatus(200);

    // ambil chat dari link itu -> dapet visitorId + chatId
    const path = link.replace("/api/v1", "");
    const chatResp = await chaportRequest(path);

    // chatResp.result biasanya Chat (id = chatId), dan kita butuh visitorId dari URL
    // visitorId bisa diextract dari link: /visitors/:visitorId/chats
    const m = String(path).match(/\/visitors\/([^/]+)\/chats/);
    const visitorId = m ? m[1] : null;

    const chat = chatResp?.result || chatResp;
    const chatId = chat?.id;

    console.log("CHAT STARTED:", JSON.stringify({ visitorId, chatId }));

    if (!visitorId || !chatId) return res.sendStatus(200);

    // polling singkat (misal 30x * 2 detik = 1 menit) buat nangkep pesan awal visitor
    let tries = 0;
    const interval = setInterval(async () => {
      try {
        tries += 1;
        await pollChatEvents(visitorId, chatId);
        if (tries >= 30) clearInterval(interval);
      } catch (e) {
        console.error("POLL ERR:", e);
        if (tries >= 30) clearInterval(interval);
      }
    }, 2000);

    res.sendStatus(200);
  } catch (e) {
    console.error("WEBHOOK ERR:", e);
    res.sendStatus(200);
  }
});

app.listen(PORT, () => console.log("Listening on", PORT));
