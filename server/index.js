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
//
// IMPORTANT: NewsData.io caps qInTitle at 100 characters total — a longer
// string fails EVERY request with "Query length cannot be greater than 100"
// (this previously broke all 7 categories, not just one). Keep this short.
const INDIA_ANCHOR_TERMS =
  '(India OR Indian OR Delhi OR Mumbai OR Bengaluru OR Chennai OR Kolkata OR Hyderabad)';

// "ai" has no native NewsData.io category (their real list is business,
// crime, domestic, education, entertainment, environment, food, health,
// lifestyle, other, politics, science, sports, technology, top, tourism,
// world — no "ai"), so it's targeted via qInTitle instead, same idea as
// "regional". Since qInTitle can only hold ~100 chars, this uses the AI
// terms here and relies on country=in (not qInTitle) for India relevance —
// combining both AI and India terms in one field would be too cramped.
const AI_ANCHOR_TERMS =
  '(AI OR "artificial intelligence" OR ChatGPT OR "machine learning")';

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
  ai: "🤖 AI News",
  sports: "⚽ Sports",
  entertainment: "🎬 Entertainment",
  health: "🏥 Health",
  crime: "🚨 Crime",
  regional: "📍 Regional (India)"
};

// Simple in-memory cache to prevent burning up upstream API limits
const cache = new Map(); 
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Tracks, per chat + category, how far a person has paged through results —
// so clicking the same genre button again shows the NEXT 5 headlines instead
// of repeating the same 5. Keyed by `${chatId}:${category}`.
// Shape: { articles: [...all fetched so far], offset: number, nextPage: token|null }
const chatPaginationState = new Map();

// Tracks, per chat + category, which article index the user is currently on
// and the full article list fetched so far. Lets repeat clicks on the same
// button show the NEXT batch of headlines instead of repeating the same 5 —
// without this, two clicks within the 5-minute cache window returned an
// identical message (the original bug report).
const userPagination = new Map(); // key: `${chatId}:${category}` -> { articles: [], offset: 0, nextPage: string|null }

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
    language: "en"
  });
  if (page) params.set("page", page);

  if (category === "regional") {
    // No category param here on purpose — NewsData's "world" category means
    // international by definition, which is exactly what caused this bug.
    params.set("qInTitle", INDIA_ANCHOR_TERMS);
    params.set("region", CATEGORY_REGIONS.regional);
  } else if (category === "ai") {
    // No native "ai" category exists — qInTitle carries the AI terms here
    // instead of the India terms (country=in already scopes this to India).
    params.set("qInTitle", AI_ANCHOR_TERMS);
  } else {
    // Real native categories (politics, business, technology, sports,
    // entertainment, health, crime, ...) — India relevance comes from both
    // country=in and the India anchor terms together.
    params.set("category", category);
    params.set("qInTitle", INDIA_ANCHOR_TERMS);
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
    const stateKey = `${chatId}:${category}`;
    let state = chatPaginationState.get(stateKey);

    // First click on this category for this chat — fetch fresh and start at 0.
    if (!state) {
      const data = await fetchNewsCategory(category);
      state = { articles: data.results || [], offset: 0, nextPage: data.nextPage || null };
      chatPaginationState.set(stateKey, state);
    } else if (state.offset >= state.articles.length) {
      // Ran out of already-fetched articles — get the next NewsData.io page
      // using its nextPage cursor, if one exists. If not, loop back to the
      // start rather than showing nothing on the next click.
      if (state.nextPage) {
        const data = await fetchNewsCategory(category, state.nextPage);
        state.articles = state.articles.concat(data.results || []);
        state.nextPage = data.nextPage || null;
      } else {
        state.offset = 0; // no more pages upstream — restart from the top
      }
    }

    const batch = state.articles.slice(state.offset, state.offset + 5);

    if (batch.length === 0) {
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

    batch.forEach((article, index) => {
      const cleanTitle = article.title.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      textMessage += `${state.offset + index + 1}. <a href="${article.link}">${cleanTitle}</a>\n\n`;
    });

    // Advance the offset so the NEXT click on this same category/chat shows
    // the next batch instead of repeating this one.
    state.offset += 5;

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