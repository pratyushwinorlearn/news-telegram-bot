import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import cron from "node-cron";

dotenv.config();

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3001;
const NEWSDATA_API_KEY = process.env.NEWSDATA_API_KEY;

if (!NEWSDATA_API_KEY) {
  console.error(
    "Missing NEWSDATA_API_KEY. Copy server/.env.example to server/.env and add your real key."
  );
  process.exit(1);
}

// Simple in-memory cache so multiple desk members hitting the same category
// within a few minutes don't each burn a separate NewsData.io request.
const cache = new Map(); // key: `${category}:${page||''}` -> { data, fetchedAt }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetches one category page from NewsData.io, with caching. Used both by the
 * /api/news route (for the dashboard) and the Telegram digest job (below).
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
    category,
    language: "en"
  });
  if (page) params.set("page", page);

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

/**
 * GET /api/news?category=politics&page=<nextPage token, optional>
 *
 * The frontend never sees the NewsData.io key — this server holds it via
 * process.env.NEWSDATA_API_KEY (loaded from server/.env, which is gitignored)
 * and is the only thing that talks to newsdata.io directly.
 */
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

// Manual trigger — useful for testing the digest without waiting for the
// scheduled time, or for a "send now" button later if you want one.
app.post("/api/digest/send-now", async (req, res) => {
  const { sendDailyDigest } = await import("./telegram.js");
  const result = await sendDailyDigest();
  res.status(result.ok ? 200 : 502).json(result);
});

// Scheduled digest — runs automatically, no one needs to click anything.
// Default: every day at 8:00 AM IST. Change the cron expression in .env
// (DIGEST_CRON_SCHEDULE) if the desk wants a different time.
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
// Add these helper mappings at the top of your backend file
const GENRES = {
  politics: "🏛️ Politics & National",
  business: "💼 Business",
  technology: "💻 Tech & Gadgets",
  sports: "⚽ Sports",
  entertainment: "🎬 Entertainment",
  health: "🏥 Health",
  world: "🌐 World News"
};

// 1. The main Webhook handler endpoint
app.post("/api/telegram-webhook", async (req, res) => {
  // Always acknowledge the request immediately to Telegram
  res.sendStatus(200);

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
    const category = callback_query.data; // This is the category value passed by the button

    // Stop the loading spinner on the user's Telegram screen
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callback_query.id })
    });

    // Send a loading message or directly fetch the news
    await sendCategoryNews(chatId, category);
  }
});

// Helper Function: Sends the interactive category buttons
async function sendGenreMenu(chatId) {
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
}

// Helper Function: Fetches news and prints it out dynamically
// Hardened helper function to handle category news safely via HTML
async function sendCategoryNews(chatId, category) {
  try {
    const newsRes = await fetch(`https://newsdata.io/api/1/news?apikey=${process.env.NEWSDATA_API_KEY}&category=${category}&language=en`);
    const data = await newsRes.json();

    // 1. Safe check if results exist and have items
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

    // 2. Build the message clean using HTML formatting (much safer than Markdown)
    let textMessage = `<b>🔥 Top Headlines in ${GENRES[category] || category}</b>\n\n`;
    
    data.results.slice(0, 5).forEach((article, index) => {
      // Clean up the title to prevent basic HTML breaks
      const cleanTitle = article.title.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      textMessage += `${index + 1}. <a href="${article.link}">${cleanTitle}</a>\n\n`;
    });

    // 3. Send via HTML parse mode
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