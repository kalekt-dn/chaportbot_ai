import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ================== ENV ==================
const CHAPORT_TOKEN = process.env.CHAPORT_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// ================== KEYWORDS ==================
const DEPOSIT_KW = ["deposit", "depo", "top up", "topup", "isi saldo"];
const REGISTER_KW = ["daftar", "register", "buat akun"];
const RESET_KW = ["reset", "lupa password", "forgot password"];

// ================== MEMORY ==================
const chats = new Map();

// ================== HELPERS ==================
function hasKeyword(text, keywords) {
  if (!text) return false;
  return keywords.some(k => text.toLowerCase().includes(k));
}

// ================== TELEGRAM ==================
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text
    })
  });
}

// ================== CHAPORT ==================
async function sendChaportMessage(visitorId, chatId, text) {
  await fetch("https://app.chaport.com/api/v1/messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${CHAPORT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      visitor: { id: visitorId },
      chat: { id: chatId },
      message: { text }
    })
  });
}

// ================== WEBHOOK ==================
app.post("/chaport/webhook", async (req, res) => {
  try {
    // cek secret
    if (WEBHOOK_SECRET) {
      if (req.headers["x-webhook-secret"] !== WEBHOOK_SECRET) {
        return res.sendStatus(401);
      }
    }

    const visitorId = req.body?.visitor?.id;
    const chatId = req.body?.chat?.id;
    const text = req.body?.message?.text || "";

    if (!visitorId || !chatId) {
      return res.sendStatus(200);
    }

    const key = `${visitorId}:${chatId}`;

    if (!chats.has(key)) {
      chats.set(key, { replied: false });
    }

    const chat = chats.get(key);

    // ===== REGISTER / RESET → TELEGRAM =====
    if (hasKeyword(text, REGISTER_KW) || hasKeyword(text, RESET_KW)) {
      await sendTelegram(
        `🚨 CHAPORT ALERT\n\nPesan:\n"${text}"\n\nVisitor ID: ${visitorId}`
      );
    }

    // ===== DEPOSIT → AUTO REPLY 2 MENIT =====
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

    // ===== BELUM DIBALES → AUTO REPLY 5 MENIT =====
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
  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
});

// ================== HEALTH CHECK ==================
app.get("/", (req, res) => {
  res.send("Chaport auto-reply bot is running");
});

app.listen(PORT, () => {
  console.log("Bot running on port", PORT);
});
