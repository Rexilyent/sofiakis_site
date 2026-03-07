document.addEventListener("DOMContentLoaded", () => {
  // ZIP: numeric-only, max 5 digits
  const zipInput = document.getElementById("joinZip");
  if (zipInput) {
    zipInput.addEventListener("input", () => {
      zipInput.value = zipInput.value.replace(/\D/g, "").slice(0, 5);
    });
  }

  // HOME: conditional sticky header only after passing the join section
  const body = document.body;
  if (!body.classList.contains("page-home")) return;

  const join = document.querySelector(".home-join-header");
  const header = document.querySelector(".site-header");
  if (!join || !header) return;

  function setHeaderHeightVar() {
    const h = header.getBoundingClientRect().height;
    body.style.setProperty("--home-header-h", `${Math.ceil(h)}px`);
  }

  setHeaderHeightVar();
  window.addEventListener("resize", setHeaderHeightVar);

  const io = new IntersectionObserver(
    ([entry]) => {
      const joinVisible = entry.isIntersecting;
      header.classList.toggle("is-sticky", !joinVisible);
      body.classList.toggle("has-sticky-header", !joinVisible);
    },
    { threshold: 0.01 }
  );

  io.observe(join);

  /* =============================
     NEWS SCROLL BUTTONS
  ============================= */

  const container = document.querySelector(".news-articles");

  document.querySelector(".news-scroll.left")?.addEventListener("click", () => {
    container.scrollBy({ left: -300, behavior: "smooth" });
  });

  document.querySelector(".news-scroll.right")?.addEventListener("click", () => {
    container.scrollBy({ left: 300, behavior: "smooth" });
  });

	/* ==============================
     HOMEPAGE NEWS LOADER
  ============================== */

  async function loadHomepageNews() {

    const container = document.getElementById("homepage-news");

    if (!container) return;

    const res = await fetch("/news/articles.json");
    const articles = await res.json();

    articles
      .sort((a,b)=> new Date(b.date)-new Date(a.date))
      .slice(0,3)
      .forEach(article => {

        const el = document.createElement("article");
        el.className = "news-article";

        el.innerHTML = `
          <h3>${article.title}</h3>
          <p class="news-category">${article.category || ""}</p>
          <p class="news-date">${new Date(article.date).toLocaleDateString()}</p>
          <p class="news-summary">${article.summary || ""}</p>
          <a href="/news/${article.slug}" class="read-more">Read More</a>
        `;

        container.appendChild(el);

      });

  }

  loadHomepageNews();

});