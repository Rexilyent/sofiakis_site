// ============================================================
//  ARTICLE RENDERING  —  functions/_lib/article-render.ts
// ============================================================
//
//  Shared by:
//    functions/api/admin-articles.ts   (preview + validation)
//    functions/news/[slug].ts          (public page rendering)
//    functions/api/news.ts             (index listing)
//
//  Files under functions/_lib/ are not routed by Pages (leading
//  underscore, same convention as _middleware.ts) but are still
//  bundled, so they can be imported normally.
//
//  ── SECURITY MODEL ────────────────────────────────────────
//
//  Articles are authored by logged-in staff, but "trusted author"
//  is not a security model — a stolen session would otherwise mean
//  stored XSS on the public site, hitting every visitor.
//
//  So the markdown converter NEVER passes source text through as
//  HTML. Every character of author input is HTML-escaped FIRST,
//  and only then are markdown constructs replaced with a fixed set
//  of tags this file emits itself. There is no path by which an
//  author-supplied "<script>" reaches the output as markup.
//
//  URLs in links and images are additionally checked against a
//  scheme allow-list, because escaping alone does not stop
//  `[click](javascript:alert(1))`.
//
// ============================================================

export interface Article {
  slug:         string;
  title:        string;
  summary:      string | null;
  body_md:      string;
  category:     string | null;
  author:       string | null;
  image:        string | null;
  featured:     number;
  status:       string;
  published_at: string | null;
  created_at:   string | null;
  updated_at:   string | null;
}

const SITE_ORIGIN = "https://alexandriasofiakis.com";
const SITE_NAME   = "Alexandria Sofiakis for IL-10";

// ============================================================
//  ESCAPING
// ============================================================

export function escapeHtml(input: string): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape a value for use inside a double-quoted HTML attribute. */
function escapeAttr(input: string): string {
  return escapeHtml(input);
}

/**
 * Only allow URLs that cannot execute script. Relative paths and
 * anchors are fine; http/https/mailto/tel are fine; everything else
 * (javascript:, data:, vbscript:, file:) is rejected.
 *
 * Note the check runs on a lowercased, whitespace-stripped copy —
 * "java\nscript:" and "JaVaScRiPt:" are both caught.
 */
export function safeUrl(raw: string): string | null {
  if (!raw) return null;
  const cleaned = raw.trim();
  const probe = cleaned.replace(/[\s\u0000-\u001F]/g, "").toLowerCase();

  if (/^(javascript|data|vbscript|file|blob):/.test(probe)) return null;

  // Relative, root-relative, anchor or query — no scheme, so safe
  if (/^[/#?]/.test(cleaned)) return cleaned;
  if (/^(https?:|mailto:|tel:)/.test(probe)) return cleaned;

  // Bare domain or relative path with no scheme
  if (!probe.includes(":")) return cleaned;

  return null;
}

// ============================================================
//  MARKDOWN → HTML
// ============================================================

/**
 * Convert a constrained markdown subset to HTML.
 *
 * Supported: headings (##–######), bold, italic, inline code,
 * fenced code blocks, links, images, blockquotes, ordered and
 * unordered lists, horizontal rules, paragraphs.
 *
 * H1 is deliberately NOT supported: the page template already
 * emits the article title as the single H1, and a second one
 * would break the heading outline for screen readers.
 */
export function markdownToHtml(markdown: string): string {
  if (!markdown) return "";

  const src = String(markdown).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // ── Pull fenced code blocks out first ────────────────────
  // They're stored as placeholders so their contents can't be
  // reinterpreted as markdown further down.
  const codeBlocks: string[] = [];
  let text = src.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const cls = lang ? ` class="language-${escapeAttr(lang)}"` : "";
    codeBlocks.push(`<pre><code${cls}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000CODEBLOCK${codeBlocks.length - 1}\u0000`;
  });

  // ── Escape EVERYTHING before any markup is generated ─────
  text = escapeHtml(text);

  // ── Inline code (after escaping, before other inline) ────
  const inlineCode: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    inlineCode.push(`<code>${code}</code>`);
    return `\u0000INLINE${inlineCode.length - 1}\u0000`;
  });

  // ── Images: ![alt](url) ──────────────────────────────────
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) => {
    const safe = safeUrl(unescapeForUrl(url));
    if (!safe) return alt;                     // drop the image, keep the alt text
    return `<img src="${escapeAttr(safe)}" alt="${escapeAttr(unescapeForUrl(alt))}" loading="lazy">`;
  });

  // ── Links: [text](url) ──────────────────────────────────
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    const safe = safeUrl(unescapeForUrl(url));
    if (!safe) return label;                   // unsafe scheme → render as plain text
    const external = /^https?:/i.test(safe) && !safe.startsWith(SITE_ORIGIN);
    const attrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
    return `<a href="${escapeAttr(safe)}"${attrs}>${label}</a>`;
  });

  // ── Bold / italic ───────────────────────────────────────
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  text = text.replace(/(^|[^\w])_([^_\n]+)_(?![\w])/g, "$1<em>$2</em>");

  // ── Block level ─────────────────────────────────────────
  const lines = text.split("\n");
  const out: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let inQuote = false;
  let paragraph: string[] = [];

  const closeParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.join("<br>")}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };
  const closeQuote = () => {
    if (inQuote) { out.push("</blockquote>"); inQuote = false; }
  };
  const closeAll = () => { closeParagraph(); closeList(); closeQuote(); };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (!line.trim()) { closeAll(); continue; }

    // Code block placeholder — emit as its own block
    if (/^\u0000CODEBLOCK\d+\u0000$/.test(line.trim())) {
      closeAll();
      out.push(line.trim());
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      closeAll(); out.push("<hr>"); continue;
    }

    // Heading (h2–h6; h1 reserved for the page title)
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeAll();
      const level = Math.min(Math.max(heading[1].length, 2), 6);
      const id = slugifyHeading(heading[2]);
      out.push(`<h${level} id="${escapeAttr(id)}">${heading[2].trim()}</h${level}>`);
      continue;
    }

    // Blockquote
    const quote = line.match(/^&gt;\s?(.*)$/);
    if (quote) {
      closeParagraph(); closeList();
      if (!inQuote) { out.push("<blockquote>"); inQuote = true; }
      out.push(`<p>${quote[1]}</p>`);
      continue;
    }
    if (inQuote) closeQuote();

    // Unordered list
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      closeParagraph();
      if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
      out.push(`<li>${ul[1]}</li>`);
      continue;
    }

    // Ordered list
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      closeParagraph();
      if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
      out.push(`<li>${ol[1]}</li>`);
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }
  closeAll();

  let html = out.join("\n");

  // ── Restore placeholders ────────────────────────────────
  html = html.replace(/\u0000INLINE(\d+)\u0000/g, (_m, i) => inlineCode[Number(i)] ?? "");
  html = html.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_m, i) => codeBlocks[Number(i)] ?? "");

  return html;
}

/** Markdown URLs are read from already-escaped text; undo that for parsing. */
function unescapeForUrl(value: string): string {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function slugifyHeading(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z]+;/gi, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "section";
}

// ============================================================
//  SLUGS
// ============================================================

export function slugify(title: string): string {
  return String(title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")   // strip accents
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Slugs become URLs and filenames — keep them strictly bounded. */
export function isValidSlug(slug: string): boolean {
  return typeof slug === "string" &&
         /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) &&
         slug.length >= 3 && slug.length <= 80;
}

// ============================================================
//  READING TIME
// ============================================================

export function readingTime(markdown: string): string {
  const words = String(markdown ?? "").trim().split(/\s+/).filter(Boolean).length;
  const mins  = Math.max(1, Math.round(words / 200));
  return `${mins} minute${mins === 1 ? "" : "s"}`;
}

// ============================================================
//  DATE FORMATTING
// ============================================================

export function formatLongDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC"
  });
}

// ============================================================
//  FULL PAGE TEMPLATE
// ============================================================
//
//  Mirrors the existing hand-written articles in public/news/ so a
//  D1-backed article is indistinguishable from a static one: same
//  meta block, same OpenGraph/Twitter tags, same JSON-LD, same
//  header and footer markup, same stylesheet links.
//
//  The nav lives here in ONE place now. Previously it was
//  copy-pasted into every article file, so a nav change meant
//  editing every article.

export function renderArticlePage(article: Article): string {
  const url       = `${SITE_ORIGIN}/news/${article.slug}`;
  const title     = escapeHtml(article.title);
  const summary   = escapeHtml(article.summary ?? "");
  const author    = escapeHtml(article.author ?? "Campaign Team");
  const category  = escapeHtml(article.category ?? "Article");
  const date      = article.published_at ?? article.created_at ?? "";
  const dateOnly  = (date || "").slice(0, 10);
  const bodyHtml  = markdownToHtml(article.body_md);
  const image     = article.image ? safeUrl(article.image) : null;
  const imageAbs  = image
    ? (image.startsWith("http") ? image : `${SITE_ORIGIN}${image}`)
    : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="description" content="${summary}" />
  <meta name="author" content="${author}" />
  <title>${title} | ${SITE_NAME}</title>

  <!-- News Meta Tags -->
  <meta name="news:title" content="${title}" />
  <meta name="news:date" content="${escapeAttr(dateOnly)}" />
  <meta name="news:summary" content="${summary}" />
  <meta name="news:author" content="${author}" />
  <meta name="news:type" content="press-release" />
  <meta name="news:category" content="${category}" />
  <meta name="news:location" content="Illinois&rsquo; 10th Congressional District" />
  <meta name="news:reading-time" content="${escapeAttr(readingTime(article.body_md))}" />
  <meta name="news:featured" content="${article.featured ? "true" : "false"}" />
${imageAbs ? `  <meta name="news:image" content="${escapeAttr(image!)}" />\n` : ""}
  <!-- SEO Meta Tags -->
  <meta name="robots" content="index, follow">
  <meta name="article:published_time" content="${escapeAttr(dateOnly)}">
  <meta name="article:author" content="${author}">
  <meta name="article:section" content="Campaign News">

  <!-- Social / OpenGraph -->
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${summary}" />
  <meta property="og:url" content="${url}">
${imageAbs ? `  <meta property="og:image" content="${escapeAttr(imageAbs)}" />\n` : ""}
  <!-- Canonical Link -->
  <link rel="canonical" href="${url}">

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${summary}" />
${imageAbs ? `  <meta name="twitter:image" content="${escapeAttr(imageAbs)}" />\n` : ""}
  <!-- Fonts Styles -->
  <link rel="stylesheet"
    href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
  <link rel="stylesheet"
    href="https://fonts.googleapis.com/css2?family=Lexend:wght@300;400;500;600;700&display=swap">

  <!-- Shared Base styles -->
  <link rel="stylesheet" href="/styles/base.css" />
  <!-- Page-Specific Styles -->
  <link rel="stylesheet" href="/styles/news.css" />

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    "headline": ${JSON.stringify(article.title)},
    "datePublished": ${JSON.stringify(dateOnly)},
    "author": {
      "@type": "Person",
      "name": ${JSON.stringify(article.author ?? "Campaign Team")}
    },
    "publisher": {
      "@type": "Organization",
      "name": ${JSON.stringify(SITE_NAME)}
    },
    "mainEntityOfPage": ${JSON.stringify(url)}
  }
  </script>

  <!-- Base Scripts -->
  <script src="/scripts/base.js" defer></script>
  <script src="/scripts/share.js" defer></script>
</head>

<body class="page-news-article">
${renderHeader()}

  <main id="main-content" class="news-content" role="main">
    <section class="news-hero" aria-labelledby="article-title">
      <div class="news-hero-container">
        <h1 id="article-title" class="article-title">${title}</h1>

        <div class="article-meta">
          <p class="news-meta">
            <time datetime="${escapeAttr(dateOnly)}">${escapeHtml(formatLongDate(dateOnly))}</time>
          </p>
          <p class="news-author">By ${author}</p>
        </div>

        <div class="article-share">
          <span class="share-label">Share</span>
          <div class="share-buttons" role="group" aria-label="Share Article">
            <a class="share-btn share-facebook" target="_blank" rel="noopener noreferrer"
               aria-label="Share this article on Facebook">
              <i class="fab fa-facebook-f" aria-hidden="true"></i>
            </a>
            <a class="share-btn share-twitter" target="_blank" rel="noopener noreferrer"
               aria-label="Share this article on Twitter">
              <i class="fab fa-twitter" aria-hidden="true"></i>
            </a>
            <a class="share-btn share-linkedin" target="_blank" rel="noopener noreferrer"
               aria-label="Share this article on LinkedIn">
              <i class="fab fa-linkedin-in" aria-hidden="true"></i>
            </a>
            <a class="share-btn share-email"
               href="mailto:?subject=Check out this article: ${encodeURIComponent(article.title)}&body=I thought you might be interested in this article: ${url}"
               aria-label="Share this article via Email">
              <i class="fas fa-envelope" aria-hidden="true"></i>
              <span class="share-text">Email</span>
            </a>
            <button class="share-btn share-copy" type="button" aria-label="Copy link to this article">
              <i class="fas fa-link" aria-hidden="true"></i>
              <span class="share-text">Copy Link</span>
            </button>
          </div>
        </div>
      </div>
    </section>

    <article class="article-body">
${indent(bodyHtml, 6)}
    </article>
  </main>

${renderFooter()}
</body>
</html>
`;
}

function indent(html: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return html.split("\n").map(l => (l ? pad + l : l)).join("\n");
}

/**
 * Site header. Kept identical to the static pages so the nav looks
 * and behaves the same; base.js attaches the mobile drawer and the
 * accessibility trigger to .nav-social exactly as elsewhere.
 */
function renderHeader(): string {
  return `  <header class="site-header">
    <nav class="nav">
      <div class="nav-left">
        <a href="/" class="nav-logo" aria-label="Alexandria Sofiakis Home">
          <img src="/assets/images/sofiakis_logo_white_txt.png" alt="Alexandria Sofiakis Logo">
        </a>
      </div>

      <button class="nav-toggle" aria-label="Toggle Navigation">&#9776;</button>

      <div class="nav-links" id="nav-links">
        <div class="nav-dropdown">
          <a href="/about" class="nav-about">About</a>
          <div class="dropdown-menu">
            <a href="/news/">News</a>
          </div>
        </div>
        <a href="/issues">Issues</a>
        <a href="/events">Events</a>
        <a href="/il10">IL-10</a>
        <div class="nav-dropdown">
          <a href="/vote" class="nav-vote">Vote</a>
          <div class="dropdown-menu">
            <a href="/endorsements">Endorsements</a>
          </div>
        </div>
        <a href="/volunteer">Volunteer</a>
      </div>

      <div class="nav-social">
        <a href="https://www.facebook.com/people/Alexandria-Keating-Sofiakis-for-IL-10/61574599503560/"
           target="_blank" aria-label="Facebook"><i class="fab fa-facebook-f"></i></a>
        <a href="https://x.com/SofiakisGreen" target="_blank" aria-label="Twitter">
          <i class="fab fa-twitter"></i></a>
      </div>
    </nav>
  </header>`;
}

function renderFooter(): string {
  const year = new Date().getFullYear();
  return `  <footer class="site-footer">
    <div class="footer-inner">
      <p class="footer-disclaimer">Paid for by Alexandria Sofiakis for IL-10</p>
      <nav class="footer-links" aria-label="Footer">
        <a href="/about">About</a>
        <a href="/issues">Issues</a>
        <a href="/news/">News</a>
        <a href="/events">Events</a>
        <a href="/volunteer">Volunteer</a>
        <a href="/contact">Contact</a>
        <a href="/accessibility">Accessibility</a>
        <a href="/privacy">Privacy</a>
      </nav>
      <p class="footer-copy">&copy; ${year} Alexandria Sofiakis for IL-10. All rights reserved.</p>
    </div>
  </footer>`;
}
