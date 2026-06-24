import "./style.css";

const CATEGORY_LABELS = {
  politics: "Politics & national",
  business: "Business",
  technology: "Tech",
  sports: "Sports",
  entertainment: "Entertainment",
  health: "Health",
  crime: "Crime",
  world: "World & regional"
};

const TAG_COLORS = {
  politics: "var(--tag-politics)",
  business: "var(--tag-business)",
  technology: "var(--tag-tech)",
  sports: "var(--tag-sports)",
  entertainment: "var(--tag-entertainment)",
  health: "var(--tag-health)",
  crime: "var(--tag-crime)",
  world: "var(--tag-regional)"
};

let currentCategory = "politics";

// Per-category accumulated state: articles seen so far + the nextPage cursor
// to fetch more. NewsData.io paginates via an opaque cursor string, not a
// page number — we just pass back whatever it gave us last time.
const state = {}; // { [category]: { articles: [], nextPage: string|null } }

const listEl = document.getElementById("article-list");
const statusEl = document.getElementById("status-text");
const refreshBtn = document.getElementById("refresh-btn");
const clockLine = document.getElementById("clock-line");
const loadMoreRow = document.getElementById("load-more-row");
const loadMoreBtn = document.getElementById("load-more-btn");

function updateClock() {
  const now = new Date();
  clockLine.textContent = now.toLocaleString("en-IN", {
    weekday: "short", year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}
updateClock();
setInterval(updateClock, 30000);

function timeAgo(dateStr) {
  // NewsData.io returns pubDate as "YYYY-MM-DD HH:MM:SS" in UTC, no timezone
  // marker — converting to a proper ISO string with "Z" avoids browsers
  // misreading it as local time.
  const isoSafe = dateStr.includes("T") ? dateStr : dateStr.replace(" ", "T") + "Z";
  const diffMs = Date.now() - new Date(isoSafe).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.floor(hrs / 24) + "d ago";
}

function renderSkeletons(count) {
  listEl.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const sk = document.createElement("div");
    sk.className = "skeleton";
    sk.innerHTML = `
      <div class="skeleton-box" style="width:64px;height:64px;"></div>
      <div>
        <div class="skeleton-box" style="width:40%;height:14px;margin-bottom:8px;"></div>
        <div class="skeleton-box" style="width:90%;height:16px;margin-bottom:6px;"></div>
        <div class="skeleton-box" style="width:70%;height:13px;"></div>
      </div>`;
    listEl.appendChild(sk);
  }
}

function renderArticles(articles, category) {
  listEl.innerHTML = "";
  if (!articles || articles.length === 0) {
    listEl.innerHTML = `<div class="empty-state">No headlines came back for this category right now. Try refresh in a bit.</div>`;
    return;
  }
  articles.forEach(a => {
    const link = document.createElement("a");
    link.className = "article";
    link.href = a.link;
    link.target = "_blank";
    link.rel = "noopener noreferrer";

    const thumb = a.image_url
      ? `<img class="article-thumb" src="${a.image_url}" alt="" onerror="this.outerHTML='<div class=&quot;article-thumb-fallback&quot;>NO IMAGE</div>'" />`
      : `<div class="article-thumb-fallback">NO IMAGE</div>`;

    link.innerHTML = `
      ${thumb}
      <div class="article-body">
        <div class="article-eyebrow">
          <span class="cat-tag" style="background:${TAG_COLORS[category]}">${CATEGORY_LABELS[category]}</span>
          <span class="source-name">${a.source_id || "unknown source"}</span>
        </div>
        <div class="article-title">${a.title || "Untitled"}</div>
        <div class="article-desc">${a.description || ""}</div>
        <div class="article-time">${a.pubDate ? timeAgo(a.pubDate) : ""}</div>
      </div>
    `;
    listEl.appendChild(link);
  });
}

function updateLoadMoreVisibility(category) {
  const hasMore = !!state[category]?.nextPage;
  loadMoreRow.style.display = hasMore ? "flex" : "none";
}

async function fetchPage(category, page) {
  const params = new URLSearchParams({ category });
  if (page) params.set("page", page);
  const res = await fetch(`https://news-telegram-bot-39hv.onrender.com/api/news?${params.toString()}`);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "Failed to load news");
  }
  return data; // { results, nextPage, totalResults }
}

async function loadCategory(category, { force = false } = {}) {
  const existing = state[category];
  if (!force && existing && existing.articles.length > 0) {
    statusEl.textContent = `${CATEGORY_LABELS[category]} · ${existing.articles.length} headlines loaded`;
    renderArticles(existing.articles, category);
    updateLoadMoreVisibility(category);
    return;
  }

  renderSkeletons(6);
  statusEl.textContent = `Loading ${CATEGORY_LABELS[category].toLowerCase()}…`;
  refreshBtn.disabled = true;
  loadMoreBtn.disabled = true;

  try {
    const data = await fetchPage(category, null);
    state[category] = { articles: data.results, nextPage: data.nextPage };
    statusEl.textContent = `${CATEGORY_LABELS[category]} · ${data.results.length} headlines · updated just now`;
    renderArticles(data.results, category);
    updateLoadMoreVisibility(category);
  } catch (err) {
    listEl.innerHTML = `<div class="error-state">Couldn't load news: ${err.message}.<br/>Check that the backend server is running and its .env has a valid NewsData.io key.</div>`;
    statusEl.textContent = "Error loading headlines";
    loadMoreRow.style.display = "none";
  } finally {
    refreshBtn.disabled = false;
    loadMoreBtn.disabled = false;
  }
}

async function loadMore(category) {
  const existing = state[category];
  if (!existing || !existing.nextPage) return;

  loadMoreBtn.disabled = true;
  loadMoreBtn.textContent = "Loading…";

  try {
    const data = await fetchPage(category, existing.nextPage);
    const combined = existing.articles.concat(data.results);
    state[category] = { articles: combined, nextPage: data.nextPage };
    statusEl.textContent = `${CATEGORY_LABELS[category]} · ${combined.length} headlines loaded`;
    renderArticles(combined, category);
    updateLoadMoreVisibility(category);
  } catch (err) {
    statusEl.textContent = `Couldn't load more: ${err.message}`;
  } finally {
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = "Load more";
  }
}

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    currentCategory = tab.dataset.cat;
    loadCategory(currentCategory);
  });
});

refreshBtn.addEventListener("click", () => loadCategory(currentCategory, { force: true }));
loadMoreBtn.addEventListener("click", () => loadMore(currentCategory));

// initial load
loadCategory(currentCategory);
