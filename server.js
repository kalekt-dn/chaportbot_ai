import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const CHAPORT_TOKEN = process.env.CHAPORT_TOKEN || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const SETUP_KEY = process.env.SETUP_KEY || "";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

// keyword
const DEPOSIT_KW = ["deposit", "depo", "top up", "topup", "isi saldo"];
const REGISTER_KW = ["daftar", "register", "buat akun"];
const RESET_KW = ["reset", "lupa password", "forgot password", "reset password"];

// state
const chatState = new Map(); // key => { replied, timersSet, lastEventId }

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
  if (!CHAPORT_TOKEN) throw new Error("CHAPORT_TOKEN missing");
  const url = `https://app.chaport.com/api/v1${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${CHAPORT_TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const raw = await res.text();
  let json;
  try { json = raw ? JSON.parse(raw) : null; } catch { json = { raw }; }
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

app.get("/setup", async (req, res) => {
  try {
    if (!SETUP_KEY) return res.status(400).send("SETUP_KEY belum di-set");
    if (req.query.key !== SETUP_KEY) return res.status(401).send("Unauthorized");
    if (!PUBLIC_BASE_URL) return res.status(400).send("PUBLIC_BASE_URL belum di-set");

    const targetUrl = `${PUBLIC_BASE_URL}/chaport/webhook`;
    const event = "chat.started";

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

app.get("/debug/subscriptions", async (req, res) => {
  try {
    if (!SETUP_KEY || req.query.key !== SETUP_KEY) return res.status(401).send("Unauthorized");
    const subs = await chaportRequest("/events/subscriptions");
    res.json(subs);
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
});

// ambil pesan visitor terbaru dari events
async function fetchLatestVisitorText(visitorId, chatId, lastEventId) {
  const resp = await chaportRequest(`/visitors/${visitorId}/chats/${chatId}/events`);
  const events = resp?.result || [];

  // scan dari belakang biar dapat yang terbaru
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const evId = ev.id || ev._id || null;
    if (lastEventId && evId && evId === lastEventId) break;

    const text = ev?.message?.text || ev?.text || ev?.data?.text || "";
    const type = String(ev?.type || "").toLowerCase();

    // heuristik: event visitor message biasanya ada "visitor" di type atau punya message.text
    if (text && (type.includes("visitor") || type.includes("message"))) {
      return { text, lastEventId: evId || lastEventId };
    }
  }

  // kalau belum ketemu message
  const newest = events[events.length - 1];
  return { text: "", lastEventId: newest?.id || lastEventId || null };
}

function ensureTimers(visitorId, chatId, firstText) {
  const key = `${visitorId}:${chatId}`;
  const state = chatState.get(key);

  if (state.timersSet) return;
  state.timersSet = true;

  // deposit -> 2 menit
  if (hasKeyword(firstText, DEPOSIT_KW)) {
    setTimeout(async () => {
      if (!state.replied) {
        await sendChaportMessage(visitorId, chatId, "Siap, untuk deposit silakan kirim nominal dan metode pembayaran ya 🙏");
        state.replied = true;
      }
    }, 2 * 60 * 1000);
  }

  // default -> 5 menit
  setTimeout(async () => {
    if (!state.replied) {
      await sendChaportMessage(visitorId, chatId, "Maaf ya, chat kamu baru kebaca 🙏 Aku bantu cek sekarang.");
      state.replied = true;
    }
  }, 5 * 60 * 1000);
}

app.post("/chaport/webhook", async (req, res) => {
  try {
    console.log("HOOK BODY:", JSON.stringify(req.body));

    // ✅ dari payload kamu: extras.visitorId & extras.chatId
    const visitorId = req.body?.extras?.visitorId;
    const chatId = req.body?.extras?.chatId;

    if (!visitorId || !chatId) return res.sendStatus(200);

    const key = `${visitorId}:${chatId}`;
    if (!chatState.has(key)) chatState.set(key, { replied: false, timersSet: false, lastEventId: null });

    const state = chatState.get(key);

    // Poll events beberapa kali buat nangkep pesan pertama visitor
    let tries = 0;
    const interval = setInterval(async () => {
      try {
        tries++;
        const { text, lastEventId } = await fetchLatestVisitorText(visitorId, chatId, state.lastEventId);
        state.lastEventId = lastEventId;

        if (text) {
          console.log("VISITOR TEXT:", text);

          // telegram notif daftar/reset
          if (hasKeyword(text, REGISTER_KW) || hasKeyword(text, RESET_KW)) {
            await sendTelegram(`🚨 CHAPORT ALERT\n\n"${text}"\nvisitorId: ${visitorId}\nchatId: ${chatId}`);
          }

          // set timers berdasarkan pesan pertama
          ensureTimers(visitorId, chatId, text);

          // stop polling lebih cepat kalau sudah dapat text
          clearInterval(interval);
        }

        if (tries >= 30) {
          // setelah 60 detik (30x * 2 detik), tetap set default timer biar ga miss
          ensureTimers(visitorId, chatId, "");
          clearInterval(interval);
        }
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

app.get("/debug/events", async (req, res) => {
  try {
    if (!SETUP_KEY || req.query.key !== SETUP_KEY) return res.status(401).send("Unauthorized");
    const visitorId = req.query.visitorId;
    const chatId = req.query.chatId;
    if (!visitorId || !chatId) return res.status(400).send("need visitorId & chatId");

    const data = await chaportRequest(`/visitors/${visitorId}/chats/${chatId}/events`);
    res.json(data);
  } catch (e) {
    console.error("DEBUG EVENTS ERR:", e);
    res.status(500).send(String(e.message || e));
  }
});

app.get("/debug/send", async (req, res) => {
  try {
    if (!SETUP_KEY || req.query.key !== SETUP_KEY) return res.status(401).send("Unauthorized");
    const visitorId = req.query.visitorId;
    const chatId = req.query.chatId;
    const text = req.query.text || "✅ test send ok";
    if (!visitorId || !chatId) return res.status(400).send("need visitorId & chatId");

    const r = await sendChaportMessage(visitorId, chatId, text);
    res.json(r);
  } catch (e) {
    console.error("DEBUG SEND ERR:", e);
    res.status(500).send(String(e.message || e));
  }
});


app.listen(PORT, () => console.log("Listening on", PORT));
