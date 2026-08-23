document.addEventListener("DOMContentLoaded", async () => {

  if (!document.body.classList.contains("page-news")) return;

  const list = document.getElementById("news-list");

  if (!list) return;

  // Articles now come from /api/news, which merges articles published
  // through the staff portal (stored in D1) with the legacy static
  // index. If that endpoint is unavailable — an older deployment, or
  // a Worker problem — fall back to the static file so the news page
  // degrades to its previous behaviour instead of showing an error.
  const articles = await loadArticles();

  if (articles === null) {
    list.innerHTML = `<p style="opacity:.8;">Failed to load articles.</p>`;
    return;
  }

  if (!articles.length) {
    list.innerHTML = `<p style="opacity:.8;">No news articles yet.</p>`;
    return;
  }

  articles
    .sort((a,b)=> new Date(b.date)-new Date(a.date))
    .forEach(a => {

      const link = document.createElement("a");
      link.href = `/news/${a.slug}`;
      link.className = "news-card-link";

      const niceDate = new Date(a.date).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric"
      });

      link.innerHTML = `
        <article class="news-item">
          ${a.category ? `<div class="news-kicker">${escapeHtml(a.category)}</div>` : ""}
          <h2>${escapeHtml(a.title)}</h2>
          <p class="news-date">${escapeHtml(niceDate)}</p>
          ${a.summary ? `<p>${escapeHtml(a.summary)}</p>` : ""}
          <span class="read-more">
            Read More <i class="fas fa-arrow-right"></i>
          </span>
        </article>
      `;

      list.appendChild(link);

    });

  /**
   * Try the API first, then the static index. Returns null only if
   * BOTH are unavailable, so a Worker outage doesn't blank the page.
   */
  async function loadArticles() {
    for (const url of ["/api/news", "/news/articles.json"]) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const data = await res.json();
        if (Array.isArray(data)) return data;
      } catch {
        // Network or parse failure — try the next source
      }
    }
    return null;
  }

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    }[c]));
  }

});