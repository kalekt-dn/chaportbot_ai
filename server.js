import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ================== ENV ==================
const EGqQElPUyA2pCyoWLIoXYRcLUsjdMel4BGQ3qe4IHdeau93RqdlBDGzTl5v7u2XBXxsoaXWrQP970AjuKnBOJuB2qm4zoYgrcG3L5eReTTP8aBrO8rh1OavHWpMB0elN7PTIiL7u51PxxD6uIV4rslgtQvMdbEeZxhvqSM9phzshWSifPGT6eBxUEBexXZum3n0a2G6QtQ5qjS4xGKByrHAJRchIX7lFjkqN6MNVk9R7y2NkEhlBrkFDNW9kWbLr = process.env.EGqQElPUyA2pCyoWLIoXYRcLUsjdMel4BGQ3qe4IHdeau93RqdlBDGzTl5v7u2XBXxsoaXWrQP970AjuKnBOJuB2qm4zoYgrcG3L5eReTTP8aBrO8rh1OavHWpMB0elN7PTIiL7u51PxxD6uIV4rslgtQvMdbEeZxhvqSM9phzshWSifPGT6eBxUEBexXZum3n0a2G6QtQ5qjS4xGKByrHAJRchIX7lFjkqN6MNVk9R7y2NkEhlBrkFDNW9kWbLr;
const 8254210520:AAEmP_hKQN1qLkKkHSig9j3l5b8qT9OF9sc = process.env.8254210520:AAEmP_hKQN1qLkKkHSig9j3l5b8qT9OF9sc;
const @chaportai_bot = process.env.@chaportai_bot;
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
  if (!8254210520:AAEmP_hKQN1qLkKkHSig9j3l5b8qT9OF9sc || !@chaportai_bot) return;

  await fetch(`https://api.telegram.org/bot${8254210520:AAEmP_hKQN1qLkKkHSig9j3l5b8qT9OF9sc}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: @chaportai_bot,
      text
    })
  });
}

// ================== CHAPORT ==================
async function sendChaportMessage(visitorId, chatId, text) {
  await fetch("https://app.chaport.com/api/v1/messages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${EGqQElPUyA2pCyoWLIoXYRcLUsjdMel4BGQ3qe4IHdeau93RqdlBDGzTl5v7u2XBXxsoaXWrQP970AjuKnBOJuB2qm4zoYgrcG3L5eReTTP8aBrO8rh1OavHWpMB0elN7PTIiL7u51PxxD6uIV4rslgtQvMdbEeZxhvqSM9phzshWSifPGT6eBxUEBexXZum3n0a2G6QtQ5qjS4xGKByrHAJRchIX7lFjkqN6MNVk9R7y2NkEhlBrkFDNW9kWbLr}`,
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
