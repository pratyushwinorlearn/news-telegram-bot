import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import cron from "node-cron";

dotenv.config();

const app = express();

// 🏛️ Middleware Setup (Crucial order for processing requests)
app.use(cors());
app.use(express.json()); // 🔥 FIX: This parses incoming JSON from Telegram webhooks!

const PORT = process.env.PORT || 3001;
const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY;

if (!NEWSDATA_API_KEY) {
  console.error(
    "Missing NEWSDATA_API_KEY. Copy server/.env.example to server/.env and add your real key."
  );
  process.exit(1);
}

// country=in alone isn't a strict filter — NewsData.io can still surface
// globally-relevant English stories (US politics, US business news, etc.)
// that happen to appear in Indian-source feeds. qInTitle anchors results to
// ones that actually mention India or a major Indian city in the headline.
const INDIA_ANCHOR_TERMS =
  '(India OR Indian OR Bharat OR Modi OR Delhi OR Mumbai OR Bengaluru OR Chennai OR Kolkata OR Hyderabad OR Pune)';

// "regional" has no real NewsData.io category — it's targeted via the
// region param (Indian states) instead, with no category param at all,
// since NewsData's actual "world" category means international by
// definition and is exactly what was leaking non-Indian news through.
const CATEGORY_REGIONS = {
  regional: "Maharashtra,Delhi,Karnataka,Tamil Nadu,Uttar Pradesh"
};

// Global category mapping for Telegram interactive menus
const GENRES = {
  politics: "🏛️ Politics & National",
  business: "💼 Business",
  technology: "💻 Tech & Gadgets",
  sports: "⚽ Sports",
  entertainment: "🎬 Entertainment",
  health: "🏥 Health",
  regional: "📍 Regional (India)"
};

// Simple in-memory cache to prevent burning up upstream API limits
const cache = new Map(); 
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetches one category page from NewsData.io, with caching.
 */
export async function fetchNewsCategory(category, page = null) {
  const cacheKey = `${category}:${page || ""}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const params = new URLSearchParams({
    apikey: NEWSDATA_API_KEY,
    country: "in",
    language: "en",
    qInTitle: INDIA_ANCHOR_TERMS
  });
  if (page) params.set("page", page);

  if (category === "regional") {
    // No category param here on purpose — NewsData's "world" category means
    // international by definition, which is exactly what caused this bug.
    params.set("region", CATEGORY_REGIONS.regional);
  } else {
    params.set("category", category);
  }

  const upstreamUrl = `https://newsdata.io/api/1/latest?${params.toString()}`;
  const upstreamRes = await fetch(upstreamUrl);
  const data = await upstreamRes.json();

  if (data.status !== "success") {
    throw new Error(data.results?.message || data.message || "NewsData.io returned an error");
  }

  const payload = {
    results: data.results || [],
    nextPage: data.nextPage || null,
    totalResults: data.totalResults || 0
  };

  cache.set(cacheKey, { data: payload, fetchedAt: Date.now() });
  return payload;
}

/* =========================================
   CORE DASHBOARD API ROUTES
   ========================================= */

app.get("/api/news", async (req, res) => {
  const { category, page } = req.query;

  if (!category) {
    return res.status(400).json({ error: "Missing required 'category' query param" });
  }

  try {
    const payload = await fetchNewsCategory(category, page);
    res.json(payload);
  } catch (err) {
    console.error("Error fetching from NewsData.io:", err.message);
    res.status(502).json({ error: err.message || "Failed to fetch news from upstream provider" });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post("/api/digest/send-now", async (req, res) => {
  const { sendDailyDigest } = await import("./telegram.js");
  const result = await sendDailyDigest();
  res.status(result.ok ? 200 : 502).json(result);
});

/* =========================================
   TELEGRAM INTERACTIVE WEBHOOK HANDLING
   ========================================= */

// The main Webhook handler endpoint
app.post("/api/telegram-webhook", async (req, res) => {
  // Always acknowledge the request immediately to Telegram
  res.sendStatus(200);

  try {
    const { message, callback_query } = req.body;

    // Case A: Handling normal text messages or mentions
    if (message && message.text) {
      const chatId = message.chat.id;
      const text = message.text.toLowerCase();

      // Check if user says hello, triggers a command, or tags the bot
      if (text.includes("hello") || text.includes("hi") || text.startsWith("/") || text.includes("bot")) {
        await sendGenreMenu(chatId);
      }
    }

    // Case B: Handling interactive button clicks
    if (callback_query) {
      const chatId = callback_query.message.chat.id;
      const category = callback_query.data;

      // Stop the loading spinner on the user's Telegram screen
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callback_query.id })
      });

      // Send the category news via HTML
      await sendCategoryNews(chatId, category);
    }
  } catch (error) {
    console.error("Error processing incoming webhook:", error);
  }
});

// Helper Function: Sends the interactive category buttons
async function sendGenreMenu(chatId) {
  try {
    const keyboard = {
      inline_keyboard: Object.entries(GENRES).map(([key, label]) => [
        { text: label, callback_data: key }
      ])
    };

    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: "Select a genre below to see the latest headlines:",
        reply_markup: keyboard
      })
    });
  } catch (err) {
    console.error("Error sending genre menu:", err);
  }
}

// Helper Function: Fetches news and prints it out dynamically via safe HTML format
async function sendCategoryNews(chatId, category) {
  try {
    // Route through the shared fetchNewsCategory function instead of calling
    // NewsData.io directly here — this was the actual cause of international
    // stories leaking through in the interactive bot flow: this function
    // used to bypass India-anchoring/region filtering entirely and hit a
    // different (incorrect) endpoint with no qInTitle/region params at all.
    const data = await fetchNewsCategory(category);

    if (!data || !data.results || data.results.length === 0) {
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `• No recent headlines found for this category right now.`
        })
      });
      return;
    }

    let textMessage = `<b>🔥 Top Headlines in ${GENRES[category] || category}</b>\n\n`;

    data.results.slice(0, 5).forEach((article, index) => {
      const cleanTitle = article.title.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      textMessage += `${index + 1}. <a href="${article.link}">${cleanTitle}</a>\n\n`;
    });

    const telegramRes = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: textMessage,
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });

    const telegramData = await telegramRes.json();
    if (!telegramData.ok) {
      console.error("Telegram API rejection payload:", telegramData);
    }
  } catch (err) {
    console.error("Critical error in sendCategoryNews process:", err);
  }
}

/* =========================================
   CHRON JOB TIMERS & SERVER INITIALIZATION
   ========================================= */

const DIGEST_CRON_SCHEDULE = process.env.DIGEST_CRON_SCHEDULE || "0 8 * * *";
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
  cron.schedule(DIGEST_CRON_SCHEDULE, async () => {
    console.log("Running scheduled Telegram digest...");
    const { sendDailyDigest } = await import("./telegram.js");
    await sendDailyDigest();
  }, { timezone: "Asia/Kolkata" });
  console.log(`Telegram digest scheduled: "${DIGEST_CRON_SCHEDULE}" (Asia/Kolkata)`);
} else {
  console.log(
    "Telegram not configured (missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) — automatic digest disabled."
  );
}

app.listen(PORT, () => {
  console.log(`OSINT news server running on http://localhost:${PORT}`);
});