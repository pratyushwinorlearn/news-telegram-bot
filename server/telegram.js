import fetch from "node-fetch";
import { fetchNewsCategory } from "./index.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CATEGORY_LABELS = {
  politics: "Politics & national",
  business: "Business",
  technology: "Tech",
  sports: "Sports",
  entertainment: "Entertainment",
  health: "Health",
  crime: "Crime",
  world: "Regional"
};

// Telegram messages are capped at 4096 characters — keep digests well under
// that by limiting how many articles per category go into the message.
const ARTICLES_PER_CATEGORY_IN_DIGEST = 5;

/**
 * Escapes characters that have special meaning in Telegram's MarkdownV2
 * format. Without this, article titles containing characters like ".", "-",
 * "(", ")" etc. will silently break formatting or cause sendMessage to fail.
 */
function escapeMarkdownV2(text) {
  if (!text) return "";
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

/**
 * Telegram caps messages at 4096 characters. Splits a long digest into
 * multiple messages along category boundaries rather than truncating mid-way
 * or letting sendMessage fail outright on an oversized payload.
 */
function splitDigestIntoChunks(categoryResults) {
  const now = new Date();
  const dateStr = now.toLocaleString("en-IN", {
    weekday: "long", year: "numeric", month: "long", day: "numeric"
  });
  const header = `*OSINT Desk — India News Digest*\n${escapeMarkdownV2(dateStr)}\n`;

  const MAX_LEN = 3800; // leave headroom under the 4096 hard cap
  const chunks = [header];

  for (const [category, articles] of Object.entries(categoryResults)) {
    if (!articles || articles.length === 0) continue;

    let section = `\n*${escapeMarkdownV2(CATEGORY_LABELS[category] || category)}*\n`;
    articles.slice(0, ARTICLES_PER_CATEGORY_IN_DIGEST).forEach(a => {
      const title = escapeMarkdownV2(a.title || "Untitled");
      const source = escapeMarkdownV2(a.source_id || "");
      section += `• [${title}](${a.link}) _${source}_\n`;
    });

    if (chunks[chunks.length - 1].length + section.length > MAX_LEN) {
      chunks.push(section);
    } else {
      chunks[chunks.length - 1] += section;
    }
  }

  return chunks;
}

/**
 * Fetches all categories and sends one combined digest message to the
 * configured Telegram chat/group. Designed to be called on a schedule
 * (see the cron job in index.js) or manually via a one-off script.
 */
export async function sendDailyDigest() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error(
      "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env — skipping digest send."
    );
    return { ok: false, error: "Telegram not configured" };
  }

  const categories = Object.keys(CATEGORY_LABELS);
  const categoryResults = {};

  for (const category of categories) {
    try {
      const data = await fetchNewsCategory(category);
      categoryResults[category] = data.results;
    } catch (err) {
      console.error(`Failed to fetch ${category} for digest:`, err.message);
      categoryResults[category] = [];
    }
  }

  const chunks = splitDigestIntoChunks(categoryResults);

  for (let i = 0; i < chunks.length; i++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: chunks[i],
          parse_mode: "MarkdownV2",
          disable_web_page_preview: false
        })
      });
      const data = await res.json();

      if (!data.ok) {
        console.error(`Telegram sendMessage failed on chunk ${i + 1}/${chunks.length}:`, data.description);
        return { ok: false, error: data.description };
      }

      // Small delay between messages so a multi-chunk digest doesn't trip
      // Telegram's per-second rate limit, and arrives in readable order.
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 400));
      }
    } catch (err) {
      console.error(`Error sending chunk ${i + 1}/${chunks.length} to Telegram:`, err.message);
      return { ok: false, error: err.message };
    }
  }

  console.log(`Digest sent to Telegram successfully (${chunks.length} message${chunks.length > 1 ? "s" : ""}).`);
  return { ok: true, messageCount: chunks.length };
}
