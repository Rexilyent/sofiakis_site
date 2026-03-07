document.addEventListener("DOMContentLoaded", async () => {

  if (!document.body.classList.contains("page-news")) return;

  const list = document.getElementById("news-list");

  if (!list) return;

  const res = await fetch("/news/articles.json");

  if (!res.ok) {
    list.innerHTML = `<p style="opacity:.8;">Failed to load articles.</p>`;
    return;
  }

  const articles = await res.json();

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