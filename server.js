import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

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
const chatState = new Map(); // key -> { replied, timersSet, lastSeenEventId }
let LAST_HOOK = null;
let LAST_EVENTS = null;
let LAST_ERROR = null;

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
  if (!CHAPORT_TOKEN) throw new Error("CHAPORT_TOKEN missing (set di Railway Variables)");

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

// ===== ROUTES =====
app.get("/", (req, res) => res.send("Chaport auto-reply bot is running"));
app.get("/debug/ping", (req, res) => res.send("debug ok"));

app.get("/debug/last", (req, res) => {
  if (!SETUP_KEY || req.query.key !== SETUP_KEY) return res.status(401).send("Unauthorized");
  res.json({ LAST_HOOK, LAST_EVENTS, LAST_ERROR });
});

app.get("/debug/subscriptions", async (req, res) => {
  try {
    if (!SETUP_KEY || req.query.key !== SETUP_KEY) return res.status(401).send("Unauthorized");
    const subs = await chaportRequest("/events/subscriptions");
    res.json(subs);
  } catch (e) {
    LAST_ERROR = String(e.message || e);
    res.status(500).send(LAST_ERROR);
  }
});

app.get("/setup", async (req, res) => {
  try {
    if (!SETUP_KEY) return res.status(400).send("SETUP_KEY belum di-set");
    if (req.query.key !== SETUP_KEY) return res.status(401).send("Unauthorized (key salah)");
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
    LAST_ERROR = String(e.message || e);
    console.error("SETUP ERR:", e);
    res.status(500).send(LAST_ERROR);
  }
});

function ensureTimers(visitorId, chatId, firstText) {
  const key = `${visitorId}:${chatId}`;
  const state = chatState.get(key);
  if (!state || state.timersSet) return;

  state.timersSet = true;

  // deposit -> 2 menit
  if (hasKeyword(firstText, DEPOSIT_KW)) {
    setTimeout(async () => {
      try {
        if (!state.replied) {
          await sendChaportMessage(visitorId, chatId, "Siap, untuk deposit silakan kirim nominal dan metode pembayaran ya 🙏");
          state.replied = true;
        }
      } catch (e) {
        LAST_ERROR = String(e.message || e);
        console.error("SEND DEPOSIT ERR:", e);
      }
    }, 2 * 60 * 1000);
  }

  // default -> 5 menit
  setTimeout(async () => {
    try {
      if (!state.replied) {
        await sendChaportMessage(visitorId, chatId, "Maaf ya, chat kamu baru kebaca 🙏 Aku bantu cek sekarang.");
        state.replied = true;
      }
    } catch (e) {
      LAST_ERROR = String(e.message || e);
      console.error("SEND DEFAULT ERR:", e);
    }
  }, 5 * 60 * 1000);
}

async function pollEventsOnce(visitorId, chatId) {
  const key = `${visitorId}:${chatId}`;
  const state = chatState.get(key) || { replied: false, timersSet: false, lastSeenEventId: null };
  chatState.set(key, state);

  const resp = await chaportRequest(`/visitors/${visitorId}/chats/${chatId}/events`);
  const events = resp?.result || [];
  LAST_EVENTS = events.slice(-10); // simpan 10 event terakhir buat debug

  // cari text visitor terbaru
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const evId = ev?.id || ev?._id || null;

    if (state.lastSeenEventId && evId && evId === state.lastSeenEventId) break;

    const text = ev?.message?.text || ev?.text || ev?.data?.text || "";
    const type = String(ev?.type || "").toLowerCase();

    if (text && (type.includes("visitor") || type.includes("message"))) {
      state.lastSeenEventId = evId || state.lastSeenEventId;

      // notif telegram daftar/reset
      if (hasKeyword(text, REGISTER_KW) || hasKeyword(text, RESET_KW)) {
        await sendTelegram(`🚨 CHAPORT ALERT\n\n"${text}"\nvisitorId: ${visitorId}\nchatId: ${chatId}`);
      }

      // set timers berdasarkan pesan pertama
      ensureTimers(visitorId, chatId, text);

      return { gotText: true, text };
    }
  }

  // update lastSeenEventId ke event terakhir biar gak scan ulang panjang
  const last = events[events.length - 1];
  if (last?.id) state.lastSeenEventId = last.id;

  return { gotText: false, text: "" };
}

app.post("/chaport/webhook", async (req, res) => {
  try {
    LAST_HOOK = req.body;
    LAST_ERROR = null;

    console.log("HOOK BODY:", JSON.stringify(req.body));

    // payload kamu terbukti punya extras.visitorId & extras.chatId
    const visitorId = req.body?.extras?.visitorId;
    const chatId = req.body?.extras?.chatId;

    if (!visitorId || !chatId) return res.sendStatus(200);

    // polling sampai 60 detik untuk nangkep pesan pertama visitor
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      try {
        const r = await pollEventsOnce(visitorId, chatId);
        if (r.gotText) {
          console.log("VISITOR TEXT:", r.text);
          clearInterval(timer);
        }
        if (tries >= 30) {
          // kalau 60 detik gak ketemu text, tetap set default timer biar gak miss
          ensureTimers(visitorId, chatId, "");
          clearInterval(timer);
        }
      } catch (e) {
        LAST_ERROR = String(e.message || e);
        console.error("POLL ERR:", e);
        if (tries >= 30) clearInterval(timer);
      }
    }, 2000);

    res.sendStatus(200);
  } catch (e) {
    LAST_ERROR = String(e.message || e);
    console.error("WEBHOOK ERR:", e);
    res.sendStatus(200);
  }
});

app.listen(PORT, () => console.log("Listening on", PORT));
