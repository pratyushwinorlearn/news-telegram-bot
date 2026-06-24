# OSINT desk — India news board (v2: real .env, key never reaches the browser)

## What changed from the single-file version
The old version was one HTML file with the API key sitting in plain text in
the page source — anyone could open dev tools and see it. This version splits
into two pieces:

- **server/** — a tiny Express backend. This is the ONLY thing that holds the
  real NewsData.io API key, read from `server/.env` (which is gitignored —
  never committed, never sent to a browser).
- **client/** — a Vite frontend. It calls our own backend at `/api/news`,
  never NewsData.io directly. It has no API key anywhere in it.

This also adds pagination — click "Load more" on any tab to fetch additional
articles beyond the first 10, using NewsData.io's `nextPage` cursor.

## One-time setup

### 1. Get your NewsData.io key (if you don't already have one)
https://newsdata.io/register — free, no credit card.

### 2. Install dependencies
```bash
cd server
npm install

cd ../client
npm install
```

### 3. Add your real key
```bash
cd server
cp .env.example .env
```
Open `server/.env` and replace the placeholder with your real key:
```
NEWSDATA_API_KEY=pub_yourrealkeyhere
PORT=3001
```
This file is gitignored — it will never get committed or pushed anywhere.

## Running it locally (two terminals)

**Terminal 1 — start the backend:**
```bash
cd server
npm start
```
You should see: `OSINT news server running on http://localhost:3001`

**Terminal 2 — start the frontend:**
```bash
cd client
npm run dev
```
Vite will print a local URL, typically `http://localhost:5173`. Open that in
your browser — the dashboard loads, and every request quietly goes through
your backend on port 3001, which holds the real key.

Both terminals need to stay running while you use the dashboard.

## Deploying so the whole desk can use it

This is now a real two-part deployment — not a single static file you can
drop on GitHub Pages anymore, since there's a backend that needs to run
somewhere.

**Backend (server/):**
- Render.com or Railway.app both have free tiers that can run a small Node
  app continuously. Push the `server/` folder to its own GitHub repo, connect
  it to Render/Railway, and set the `NEWSDATA_API_KEY` environment variable
  in their dashboard (not in a committed file — same idea as your local
  `.env`, just configured through their UI instead).

**Frontend (client/):**
- Run `npm run build` inside `client/` — this produces a `dist/` folder of
  static files.
- Deploy `dist/` to Vercel or GitHub Pages, same as before.
- One config change needed: in production, the frontend needs to know your
  backend's real deployed URL (not `localhost:3001`). Update the proxy target
  in `vite.config.js` before building, or set an environment variable Vite
  reads at build time — ask me when you're ready to deploy and I'll wire up
  whichever fits your hosting choice.

## Why this is worth the extra complexity
With the single-file version, your NewsData.io key was visible to literally
anyone who opened the page and hit F12. With this setup, the key lives only
on a server you control, never shipped to any browser. If the dashboard URL
ever got shared outside the desk, or someone poked around in dev tools,
there's nothing sensitive to find.

## Telegram digest — automatic news on phones, no dashboard needed

This server can also push a daily news digest straight to a Telegram group,
fully automatically, with no one clicking anything. This is separate from
the dashboard — both can run at once, or you can use just one.

### Why Telegram and not WhatsApp
WhatsApp has no free, official way to send fully automatic messages from a
personal account — only the paid Business API (needs Meta approval and
costs money per message), or unofficial libraries that violate WhatsApp's
terms and risk getting the number banned. Telegram's Bot API is official,
free, and built for exactly this — zero risk, zero cost.

### One-time setup (~5 minutes)

**1. Create the bot:**
- Open Telegram, search for `@BotFather` (verified, blue checkmark)
- Send `/newbot`, follow the prompts (pick a name and a username ending in "bot")
- BotFather gives you a token like `123456789:AAetc...` — copy it

**2. Create or use a group for the digest:**
- Make a Telegram group (or use an existing desk group)
- Add your new bot to the group as a member

**3. Get the group's chat ID:**
- Send any message in the group
- In a browser, visit:
  `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
  (replace `<YOUR_BOT_TOKEN>` with your real token)
- Look for `"chat":{"id":-100xxxxxxxxxx, ...}` in the response — that negative
  number is your group's chat ID

**4. Add both to `server/.env`:**
```
TELEGRAM_BOT_TOKEN=123456789:AAetc...
TELEGRAM_CHAT_ID=-100xxxxxxxxxx
DIGEST_CRON_SCHEDULE=0 8 * * *
```
The cron schedule above means "every day at 8:00 AM IST" — standard cron
syntax (minute hour day month weekday). Change it if the desk wants a
different time.

**5. Restart the server** (`npm start` in `server/`). You should see:
`Telegram digest scheduled: "0 8 * * *" (Asia/Kolkata)`
in the terminal, confirming it's active. If you see a message saying
Telegram isn't configured instead, double-check the two env vars above.

### Testing it without waiting until 8 AM
With the server running, in a second terminal:
```bash
curl -X POST http://localhost:3001/api/digest/send-now
```
This sends the digest immediately, using the exact same code path the
scheduled job uses — if this works, the automatic version will too.

### What the digest looks like
One message per few categories (Telegram caps messages at ~4096 characters,
so a long digest splits into 2-3 messages automatically), each with up to 5
headlines per category, clickable titles linking to the source article.

### Keeping this running long-term
Like the dashboard backend, this needs the server process running
continuously for the schedule to fire — same Render/Railway free-tier
hosting recommendation as the rest of the backend. If the server isn't
running at 8 AM, that day's digest simply won't send (no catch-up/backfill).


- Free NewsData.io tier: 200 requests/day, 10 articles per request (use
  "Load more" to fetch additional pages), ~12 hour article delay.
- The 5-minute server-side cache means multiple desk members hitting the same
  tab close together share one upstream request rather than each using their
  own quota.

## If something doesn't load
- Check Terminal 1 (the backend) for errors — if `server/.env` is missing or
  the key is wrong, it'll tell you on startup.
- Check the browser console / Network tab as before — but now requests go to
  `/api/news`, not directly to newsdata.io, so look for errors from your own
  backend rather than the API itself.
