"""
Sofiakis Campaign — News Article Publisher
==========================================
Run with:  python3 news_publisher.py
Requires:  Python 3.8+  (no extra packages needed)

On first launch, go to Settings and set your local repo folder path.
"""

import tkinter as tk
from tkinter import ttk, messagebox, filedialog, simpledialog
import json
import os
import re
import subprocess
import webbrowser
import tempfile
import textwrap
from datetime import date
import configparser

# ─────────────────────────────────────────────────────────────────────────────
#  CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────

APP_TITLE  = "Sofiakis Campaign — News Publisher"
CONFIG_FILE = os.path.join(os.path.expanduser("~"), ".sofiakis_publisher.ini")
SITE_URL   = "https://alexandriasofiakis.com"
SITE_NAME  = "Alexandria Sofiakis for IL-10"

CATEGORIES    = ["Campaign", "Article", "Press Release", "Policy",
                 "Event", "Endorsement", "Community", "Announcement"]
ARTICLE_TYPES = ["article", "press-release", "announcement",
                 "event-recap", "endorsement", "policy-brief"]
DEFAULT_AUTHORS = ["Campaign Team", "Alexandria Sofiakis", "Campaign Staff"]

# Campaign green palette (matches site)
CLR_BG       = "#1a1a1a"
CLR_PANEL    = "#242424"
CLR_BORDER   = "#333333"
CLR_GREEN    = "#4caf50"
CLR_GREEN_HV = "#66bb6a"
CLR_TEXT     = "#f0f0f0"
CLR_MUTED    = "#888888"
CLR_INPUT_BG = "#2a2a2a"
CLR_TOOLBAR  = "#2e2e2e"
CLR_ACCENT   = "#81c784"
CLR_WARN     = "#ef9a9a"
CLR_BLUE     = "#64b5f6"

FONT_UI   = ("Segoe UI", 10)
FONT_MONO = ("Consolas", 11)
FONT_HEAD = ("Segoe UI", 13, "bold")
FONT_LABEL= ("Segoe UI", 9)
FONT_BTN  = ("Segoe UI", 10, "bold")


# ─────────────────────────────────────────────────────────────────────────────
#  CONFIG
# ─────────────────────────────────────────────────────────────────────────────

def load_config():
    cfg = configparser.ConfigParser()
    cfg.read(CONFIG_FILE)
    if "settings" not in cfg:
        cfg["settings"] = {}
    return cfg

def save_config(cfg):
    with open(CONFIG_FILE, "w") as f:
        cfg.write(f)

def get_setting(key, default=""):
    cfg = load_config()
    return cfg["settings"].get(key, default)

def set_setting(key, value):
    cfg = load_config()
    cfg["settings"][key] = value
    save_config(cfg)


# ─────────────────────────────────────────────────────────────────────────────
#  HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def slugify(text: str) -> str:
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"-+", "-", text)
    return text.strip("-")


def pretty_date(date_str: str) -> str:
    """YYYY-MM-DD  →  Month D, YYYY"""
    try:
        d = date.fromisoformat(date_str)
        day = d.day
        return d.strftime(f"%B {day}, %Y")
    except Exception:
        return date_str


def word_count(text: str) -> int:
    return len(text.split()) if text.strip() else 0


def reading_time(text: str) -> str:
    mins = max(1, round(word_count(text) / 200))
    return f"{mins} minute{'s' if mins != 1 else ''}"


# ─────────────────────────────────────────────────────────────────────────────
#  MARKUP → HTML CONVERSION
# ─────────────────────────────────────────────────────────────────────────────

def inline_markup(text: str) -> str:
    """Convert **bold**, _italic_, [link](url) inside a line."""
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"__(.+?)__",     r"<strong>\1</strong>", text)
    text = re.sub(r"\*(.+?)\*",     r"<em>\1</em>", text)
    text = re.sub(r"_(.+?)_",       r"<em>\1</em>", text)
    text = re.sub(r"\[(.+?)\]\((.+?)\)", r'<a href="\2">\1</a>', text)
    return text


def content_to_html(raw: str) -> str:
    """
    Convert plain-text article content to HTML.

    Rules (simple enough for non-technical writers):
      ## Heading     →  <h2>
      ### Heading    →  <h3>
      > Quote line   →  <blockquote>
      - Bullet item  →  <ul><li>
      blank line     →  closes / opens paragraphs
      everything else →  <p>
    """
    indent = "\t\t\t\t\t\t"
    lines = raw.splitlines()
    out = []
    in_ul = False
    in_bq = False
    para_buf = []

    def flush_para():
        nonlocal para_buf
        if para_buf:
            joined = inline_markup(" ".join(para_buf))
            out.append(f"{indent}<p>\n{indent}\t{joined}\n{indent}</p>")
            para_buf = []

    def close_ul():
        nonlocal in_ul
        if in_ul:
            out.append(f"{indent}</ul>")
            in_ul = False

    def close_bq():
        nonlocal in_bq
        if in_bq:
            out.append(f"{indent}</blockquote>")
            in_bq = False

    for line in lines:
        stripped = line.strip()

        if not stripped:
            flush_para()
            close_ul()
            close_bq()
            continue

        if stripped.startswith("### "):
            flush_para(); close_ul(); close_bq()
            out.append(f"{indent}<h3>{inline_markup(stripped[4:])}</h3>")
        elif stripped.startswith("## "):
            flush_para(); close_ul(); close_bq()
            out.append(f"{indent}<h2>{inline_markup(stripped[3:])}</h2>")
        elif stripped.startswith("> "):
            flush_para(); close_ul()
            if not in_bq:
                out.append(f"{indent}<blockquote>")
                in_bq = True
            out.append(f"{indent}\t<p>{inline_markup(stripped[2:])}</p>")
        elif stripped.startswith("- ") or stripped.startswith("* "):
            flush_para(); close_bq()
            if not in_ul:
                out.append(f"{indent}<ul>")
                in_ul = True
            out.append(f"{indent}\t<li>{inline_markup(stripped[2:])}</li>")
        else:
            close_ul(); close_bq()
            para_buf.append(stripped)

    flush_para()
    close_ul()
    close_bq()

    return "\n".join(out)


# ─────────────────────────────────────────────────────────────────────────────
#  HTML GENERATION
# ─────────────────────────────────────────────────────────────────────────────

def generate_html(d: dict) -> str:
    slug        = d["slug"]
    title       = d["title"]
    author      = d["author"]
    date_str    = d["date"]
    summary     = d["summary"]
    category    = d["category"]
    art_type    = d["article_type"]
    tags        = d["tags"]          # list[str]
    image       = d.get("image", "")
    location    = d.get("location", "Illinois' 10th Congressional District")
    featured    = d.get("featured", False)
    content_html= d["content_html"]
    read_time   = d["reading_time"]

    date_disp   = pretty_date(date_str)
    article_url = f"{SITE_URL}/news/{slug}/"

    tags_meta   = "\n\t".join(
        f'<meta name="article:tag" content="{t.strip()}">' for t in tags if t.strip()
    )
    image_meta  = f'<meta name="news:image" content="{image}" />' if image else ""
    og_image    = (f'<meta property="og:image" content="{image}" />'
                   if image else
                   f'<!-- <meta property="og:image" content="/assets/news/{slug}.jpg" /> -->')
    image_tag   = (f'\t\t\t\t\t\t<img src="{image}"\n'
                   f'\t\t\t\t\t\t     alt="{title}"\n'
                   f'\t\t\t\t\t\t     class="article-image">\n'
                   if image else "")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
\t<title>{title} | {SITE_NAME}</title>

\t<!-- Primary SEO Meta Tags -->
\t<meta name="description" content="{summary}" />
\t<meta name="author" content="{author}" />
\t<meta name="robots" content="index, follow">

\t<!-- News Meta Tags (Used by build-news-index.js) -->
\t<meta name="news:title" content="{title}" />
\t<meta name="news:date" content="{date_str}" />
\t<meta name="news:summary" content="{summary}" />
\t<meta name="news:author" content="{author}" />
\t<meta name="news:type" content="{art_type}" />
\t<meta name="news:category" content="{category}" />
\t<meta name="news:location" content="{location}" />
\t<meta name="news:reading-time" content="{read_time}" />
\t<meta name="news:featured" content="{'true' if featured else 'false'}" />
\t{image_meta}

\t<!-- Article SEO -->
\t<meta name="article:published_time" content="{date_str}">
\t<meta name="article:author" content="{author}">
\t<meta name="article:section" content="{category} News">
\t{tags_meta}

\t<!-- Social / OpenGraph -->
\t<meta property="og:type" content="article" />
\t<meta property="og:title" content="{title}" />
\t<meta property="og:description" content="{summary}" />
\t<meta property="og:url" content="/news/{slug}/" />
\t{og_image}

\t<!-- Twitter -->
\t<meta name="twitter:card" content="summary_large_image" />
\t<meta name="twitter:title" content="{title}" />
\t<meta name="twitter:description" content="{summary}" />

\t<!-- Fonts & Styles -->
\t<link rel="stylesheet"
\t\thref="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
\t<link rel="stylesheet"
\t\thref="https://fonts.googleapis.com/css2?family=Lexend:wght@300;400;500;600;700&display=swap">
\t<link rel="stylesheet" href="/styles/base.css" />
\t<link rel="stylesheet" href="/styles/news.css" />

\t<script type="application/ld+json">
\t{{
\t\t"@context": "https://schema.org",
\t\t"@type": "NewsArticle",
\t\t"headline": "{title}",
\t\t"datePublished": "{date_str}",
\t\t"author": {{
\t\t\t"@type": "Person",
\t\t\t"name": "{author}"
\t\t}},
\t\t"publisher": {{
\t\t\t"@type": "Organization",
\t\t\t"name": "{SITE_NAME}"
\t\t}},
\t\t"mainEntityOfPage": "{article_url}"
\t}}
\t</script>

\t<script src="/scripts/base.js" defer></script>
</head>

<body class="page-news-article">
\t<!-- Shared site header -->
\t<header class="site-header">
\t\t<nav class="nav">
\t\t\t<div class="nav-left">
\t\t\t\t<a href="/index.html" class="nav-logo" aria-label="Alexandria Sofiakis Home">
\t\t\t\t\t<img src="/assets/images/sofiakis_logo_white_txt.png" alt="Alexandria Sofiakis Logo">
\t\t\t\t</a>
\t\t\t</div>

\t\t\t<button class="nav-toggle" onclick="toggleNav()" aria-label="Toggle Navigation">
\t\t\t\t☰
\t\t\t</button>

\t\t\t<div class="nav-links" id="nav-links">
\t\t\t\t<div class="nav-dropdown">
\t\t\t\t\t<a href="/about.html" class="nav-about">About</a>
\t\t\t\t\t<div class="dropdown-menu">
\t\t\t\t\t\t<a href="/news/index.html">News</a>
\t\t\t\t\t</div>
\t\t\t\t</div>
\t\t\t\t<a href="/issues.html">Issues</a>
\t\t\t\t<a href="/events.html">Events</a>
\t\t\t\t<a href="/il10.html">IL-10</a>
\t\t\t\t<div class="nav-dropdown">
\t\t\t\t\t<a href="/vote.html" class="nav-vote">Vote</a>
\t\t\t\t\t<div class="dropdown-menu">
\t\t\t\t\t\t<a href="/endorsements.html">Endorsements</a>
\t\t\t\t\t</div>
\t\t\t\t</div>
\t\t\t\t<a href="/volunteer.html">Volunteer</a>
\t\t\t</div>

\t\t\t<div class="nav-social">
\t\t\t\t<a href="https://www.facebook.com/people/Alexandria-Keating-Sofiakis-for-IL-10/61574599503560/"
\t\t\t\t\ttarget="_blank" aria-label="Facebook">
\t\t\t\t\t<i class="fab fa-facebook-f"></i>
\t\t\t\t</a>
\t\t\t\t<a href="https://x.com/SofiakisGreen" target="_blank" aria-label="Twitter">
\t\t\t\t\t<i class="fab fa-twitter"></i>
\t\t\t\t</a>
\t\t\t\t<a href="https://www.instagram.com/alexandriakeatingsofiakis/" target="_blank" aria-label="Instagram">
\t\t\t\t\t<i class="fab fa-instagram"></i>
\t\t\t\t</a>
\t\t\t\t<a href="https://www.youtube.com/@AlexandriaKeating-Sofiakis" target="_blank" aria-label="YouTube">
\t\t\t\t\t<i class="fab fa-youtube"></i>
\t\t\t\t</a>
\t\t\t\t<a href="https://bsky.app/profile/keating-sofiakis.bsky.social" target="_blank" aria-label="Bluesky">
\t\t\t\t\t<img src="/assets/images/icons/Bluesky_Logo.svg" alt="Bluesky Icon" class="bluesky-icon">
\t\t\t\t</a>
\t\t\t\t<a href="https://www.discord.com/alexandriaforil" target="_blank" aria-label="Discord">
\t\t\t\t\t<i class="fab fa-discord"></i>
\t\t\t\t</a>
\t\t\t</div>
\t\t</nav>
\t</header>

\t<main id="main-content" class="news-content" role="main">
\t\t<section class="news-hero" aria-labelledby="article-title">
\t\t\t<div class="news-hero-container">
\t\t\t\t<h1 id="article-title" class="article-title">
\t\t\t\t\t{title}
\t\t\t\t</h1>

\t\t\t\t<div class="article-meta">
\t\t\t\t\t<p class="news-meta">
\t\t\t\t\t\t<time datetime="{date_str}">{date_disp}</time>
\t\t\t\t\t</p>
\t\t\t\t\t<p class="news-author">
\t\t\t\t\t\tBy {author}
\t\t\t\t\t</p>
\t\t\t\t</div>

\t\t\t\t<div class="article-share">
\t\t\t\t\t<span class="share-label">Share</span>
\t\t\t\t\t<div class="share-buttons" role="group" aria-label="Share Article">
\t\t\t\t\t\t<a class="share-btn share-facebook"
\t\t\t\t\t\t   target="_blank" rel="noopener noreferrer"
\t\t\t\t\t\t   aria-label="Share this article on Facebook">
\t\t\t\t\t\t\t<i class="fab fa-facebook-f" aria-hidden="true"></i>
\t\t\t\t\t\t</a>
\t\t\t\t\t\t<a class="share-btn share-twitter"
\t\t\t\t\t\t   target="_blank" rel="noopener noreferrer"
\t\t\t\t\t\t   aria-label="Share this article on Twitter">
\t\t\t\t\t\t\t<i class="fab fa-twitter" aria-hidden="true"></i>
\t\t\t\t\t\t</a>
\t\t\t\t\t\t<a class="share-btn share-linkedin"
\t\t\t\t\t\t   target="_blank" rel="noopener noreferrer"
\t\t\t\t\t\t   aria-label="Share this article on LinkedIn">
\t\t\t\t\t\t\t<i class="fab fa-linkedin-in" aria-hidden="true"></i>
\t\t\t\t\t\t</a>
\t\t\t\t\t\t<a class="share-btn share-email"
\t\t\t\t\t\t   href="mailto:?subject=Check out this article: {title}&body=I thought you might be interested in this article: {article_url}"
\t\t\t\t\t\t   aria-label="Share this article via Email">
\t\t\t\t\t\t\t<i class="fas fa-envelope" aria-hidden="true"></i>
\t\t\t\t\t\t\t<span class="share-text">Email</span>
\t\t\t\t\t\t</a>
\t\t\t\t\t\t<button class="share-btn share-copy"
\t\t\t\t\t\t\tonclick="copyArticleLink()"
\t\t\t\t\t\t\taria-label="Copy article link to clipboard">
\t\t\t\t\t\t\t<i class="fas fa-link" aria-hidden="true"></i>
\t\t\t\t\t\t\t<span class="share-text">Copy Link</span>
\t\t\t\t\t\t</button>
\t\t\t\t\t</div>
\t\t\t\t</div>
\t\t\t</div>
\t\t</section>

\t\t<section class="article-content" aria-label="Article Content">
\t\t\t<article class="article-body">
{image_tag}{content_html}
\t\t\t</article>
\t\t</section>
\t</main>

\t<!-- Shared site footer -->
\t<footer class="site-footer">
\t\t<div class="footer-social" aria-label="Footer Social Links">
\t\t\t<a href="https://www.facebook.com/people/Alexandria-Keating-Sofiakis-for-IL-10/61574599503560/"
\t\t\t\ttarget="_blank" rel="noopener noreferrer" aria-label="Facebook">
\t\t\t\t<i class="fab fa-facebook-f"></i>
\t\t\t</a>
\t\t\t<a href="https://x.com/SofiakisGreen" target="_blank" rel="noopener noreferrer" aria-label="Twitter">
\t\t\t\t<i class="fab fa-twitter"></i>
\t\t\t</a>
\t\t\t<a href="https://www.instagram.com/alexandriakeatingsofiakis/"
\t\t\t\ttarget="_blank" rel="noopener noreferrer" aria-label="Instagram">
\t\t\t\t<i class="fab fa-instagram"></i>
\t\t\t</a>
\t\t\t<a href="https://www.youtube.com/@AlexandriaKeating-Sofiakis"
\t\t\t\ttarget="_blank" rel="noopener noreferrer" aria-label="YouTube">
\t\t\t\t<i class="fab fa-youtube"></i>
\t\t\t</a>
\t\t\t<a href="https://bsky.app/profile/keating-sofiakis.bsky.social"
\t\t\t\ttarget="_blank" rel="noopener noreferrer" aria-label="Bluesky">
\t\t\t\t<img src="/assets/images/icons/Bluesky_Logo.svg" alt="Bluesky Icon" class="bluesky-icon">
\t\t\t</a>
\t\t\t<a href="https://www.discord.com/alexandriaforil"
\t\t\t\ttarget="_blank" rel="noopener noreferrer" aria-label="Discord">
\t\t\t\t<i class="fab fa-discord"></i>
\t\t\t</a>
\t\t</div>

\t\t<div class="footer-links">
\t\t\t<a href="/accessibility.html">Accessibility</a>
\t\t\t<a href="/privacy.html">Privacy Policy</a>
\t\t</div>

\t\t<div class="footer-paid-for">
\t\t\t<strong>Paid for by Alexandria Sofiakis</strong>
\t\t</div>
\t</footer>

\t<script src="/scripts/share.js" defer></script>
</body>
</html>"""


# ─────────────────────────────────────────────────────────────────────────────
#  GIT OPERATIONS
# ─────────────────────────────────────────────────────────────────────────────

def git_run(args: list, cwd: str) -> tuple[bool, str]:
    """Run a git command, return (success, output)."""
    try:
        result = subprocess.run(
            ["git"] + args,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=60,
        )
        output = (result.stdout + result.stderr).strip()
        return result.returncode == 0, output
    except FileNotFoundError:
        return False, "Git is not installed or not found in PATH."
    except subprocess.TimeoutExpired:
        return False, "Git command timed out after 60 seconds."
    except Exception as e:
        return False, str(e)


def push_to_github(repo_path: str, slug: str, title: str, branch: str = "main") -> tuple[bool, str]:
    """Stage, commit, and push the new article files."""
    log = []

    ok, out = git_run(["add", f"news/{slug}.html", "news/articles.json"], cwd=repo_path)
    log.append(f"git add → {out or 'OK'}")
    if not ok:
        # Try staging everything as a fallback
        ok2, out2 = git_run(["add", "."], cwd=repo_path)
        log.append(f"git add (fallback) → {out2 or 'OK'}")
        if not ok2:
            return False, "\n".join(log)

    commit_msg = f"news: publish '{title}'"
    ok, out = git_run(["commit", "-m", commit_msg], cwd=repo_path)
    log.append(f"git commit → {out or 'OK'}")
    if not ok:
        return False, "\n".join(log)

    ok, out = git_run(["push", "origin", branch], cwd=repo_path)
    log.append(f"git push → {out or 'OK'}")
    return ok, "\n".join(log)


# ─────────────────────────────────────────────────────────────────────────────
#  STYLED PREVIEW GENERATION
# ─────────────────────────────────────────────────────────────────────────────

# CSS files that live inside the repo, relative to the repo root.
# These match the <link> hrefs used in the real HTML output.
_LOCAL_CSS_FILES = [
    ("styles/base.css",  "/styles/base.css"),
    ("styles/news.css",  "/styles/news.css"),
]


def _read_css(repo_path: str, rel_path: str) -> str:
    """
    Try several common locations for a CSS file and return its text,
    or an empty string if it can't be found.
    """
    candidates = [
        os.path.join(repo_path, rel_path),
        # some repos keep styles at the root without a subfolder
        os.path.join(repo_path, os.path.basename(rel_path)),
    ]
    for path in candidates:
        if os.path.isfile(path):
            try:
                with open(path, encoding="utf-8") as f:
                    return f.read()
            except Exception:
                pass
    return ""


def generate_preview_html(data: dict, repo_path: str = "") -> str:
    """
    Generate a fully styled preview HTML page.

    - CDN links (Font Awesome, Google Fonts) are kept as-is — they load fine
      in any browser that has internet access.
    - The two local <link> stylesheet tags are replaced with inline <style>
      blocks so the preview works from a temp file path with no web server.
    - If the CSS files can't be found on disk (e.g. repo path not set yet),
      a minimal fallback style is injected so the page is still readable.
    - Image src attributes that start with '/' are rewritten to be relative
      to the repo root so logo/article images render in the preview.
    """
    html = generate_html(data)

    # ── 1. Inline the local CSS files ────────────────────────────────────────
    injected = []
    for rel_path, href in _LOCAL_CSS_FILES:
        css_text = _read_css(repo_path, rel_path) if repo_path else ""
        if css_text:
            # Remove the matching <link …> tag and replace with <style>
            # Match both single-line and the two-line variant used in the template
            pattern = (
                r'<link\s+rel="stylesheet"\s+href="'
                + re.escape(href)
                + r'"\s*/>'
            )
            block = f'<style>\n/* inlined from {rel_path} */\n{css_text}\n</style>'
            html, n = re.subn(pattern, block, html)
            if n:
                injected.append(rel_path)
        # If CSS wasn't found, the <link> tag stays — it just won't load from
        # a file:// URL, which is fine; the fallback below covers it.

    # ── 2. Fallback styles when CSS files weren't found ──────────────────────
    if not injected:
        fallback = """<style>
/* ── Preview fallback — shown when repo CSS files are not found ── */
:root {
    --primary: #008037;
    --accent:  #FFD700;
    --text:    #111111;
    --muted:   #6E6E6E;
    --bg:      #f5f5f5;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: "Lexend", system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.7;
}
.site-header {
    background: rgba(17,110,48,0.9);
    padding: 1rem 1.5rem;
    color: white;
}
.site-header nav { max-width: 1100px; margin: 0 auto; }
.site-footer {
    background: #1a3a22;
    color: #ccc;
    text-align: center;
    padding: 2rem 1.5rem;
    font-size: 0.85rem;
}
.news-hero {
    background: rgba(17,110,48,0.85);
    padding: 4rem 1.5rem;
    color: white;
}
.news-hero-container { max-width: 800px; margin: 0 auto; }
.article-title {
    font-size: clamp(2rem, 5vw, 3rem);
    font-weight: 700;
    margin-bottom: 1rem;
    line-height: 1.2;
}
.article-meta, .article-share { font-size: 0.95rem; margin-bottom: 0.5rem; }
.article-content {
    max-width: 800px;
    margin: 2.5rem auto 4rem;
    padding: 0 1.5rem;
    color: var(--text);
    line-height: 1.8;
}
.article-body p   { margin-bottom: 1.2rem; }
.article-body h2  { font-size: 1.6rem; font-weight: 700; margin: 2rem 0 0.75rem; color: var(--primary); }
.article-body h3  { font-size: 1.25rem; font-weight: 600; margin: 1.6rem 0 0.6rem; color: var(--primary); }
.article-body ul  { padding-left: 1.4rem; margin-bottom: 1.2rem; }
.article-body li  { margin-bottom: 0.4rem; }
.article-body blockquote {
    border-left: 4px solid var(--primary);
    padding: 0.6rem 1rem;
    margin: 1.2rem 0;
    background: rgba(0,128,55,0.07);
    color: var(--muted);
    font-style: italic;
}
.article-body strong { font-weight: 700; }
.article-body em     { font-style: italic; }
.article-body a      { color: var(--primary); text-decoration: underline; }
.article-image {
    width: 100%;
    max-height: 480px;
    object-fit: cover;
    border-radius: 12px;
    margin-bottom: 1.5rem;
}
.nav-toggle, .nav-links, .nav-social,
.share-buttons, .footer-social, .footer-links { display: none; }
</style>"""
        # Inject fallback before closing </head>
        html = html.replace("</head>", fallback + "\n</head>", 1)

    # ── 3. Rewrite absolute image src paths to repo-relative file:// URLs ────
    if repo_path:
        repo_uri = repo_path.replace("\\", "/")
        if not repo_uri.startswith("/"):
            repo_uri = "/" + repo_uri  # Windows drive letter edge case

        def _fix_src(m):
            src = m.group(1)
            if src.startswith("/"):
                abs_path = os.path.join(repo_path, src.lstrip("/\\"))
                if os.path.isfile(abs_path):
                    return f'src="file://{abs_path.replace(chr(92), "/")}"'
            return m.group(0)

        html = re.sub(r'src="(/[^"]+)"', _fix_src, html)

    # ── 4. Inject a small preview banner at the top of <body> ────────────────
    banner = """
    <!-- PREVIEW BANNER (not in published HTML) -->
    <div style="
        position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
        background: #1a1a1a; color: #f0f0f0;
        font-family: 'Segoe UI', system-ui, sans-serif;
        font-size: 13px; padding: 8px 16px;
        display: flex; align-items: center; justify-content: space-between;
        border-bottom: 2px solid #4caf50; box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    ">
        <span>
            <strong style="color:#4caf50;">📰 PREVIEW MODE</strong>
            &nbsp;·&nbsp; This is how the article will look on the site.
            Changes made here are <em>not</em> saved — go back to the publisher to edit.
        </span>
        <span style="color:#888;">CSS: """ + (", ".join(injected) if injected else "fallback styles") + """</span>
    </div>
    <div style="height: 38px;"></div>"""

    html = html.replace("<body", banner + "\n<body", 1)
    # Move banner inside body (it ended up before the opening tag)
    html = html.replace(banner + "\n<body", "<body", 1)
    html = html.replace("<body class=\"page-news-article\">",
                        "<body class=\"page-news-article\">\n" + banner, 1)

    return html


# ─────────────────────────────────────────────────────────────────────────────
#  SETTINGS WINDOW
# ─────────────────────────────────────────────────────────────────────────────

class SettingsWindow(tk.Toplevel):
    def __init__(self, parent):
        super().__init__(parent)
        self.title("Settings")
        self.configure(bg=CLR_BG)
        self.geometry("560x380")
        self.resizable(False, False)
        self.grab_set()

        self._build()
        self._load()

    def _build(self):
        pad = dict(padx=18, pady=8)

        tk.Label(self, text="Publisher Settings", font=FONT_HEAD,
                 bg=CLR_BG, fg=CLR_GREEN).pack(anchor="w", **pad)

        # Repo path
        f1 = tk.Frame(self, bg=CLR_BG)
        f1.pack(fill="x", padx=18, pady=4)
        tk.Label(f1, text="Local Repository Folder", font=FONT_LABEL,
                 bg=CLR_BG, fg=CLR_MUTED).pack(anchor="w")
        row = tk.Frame(f1, bg=CLR_BG)
        row.pack(fill="x")
        self.repo_var = tk.StringVar()
        tk.Entry(row, textvariable=self.repo_var, font=FONT_UI,
                 bg=CLR_INPUT_BG, fg=CLR_TEXT, relief="flat",
                 insertbackground=CLR_TEXT, width=48).pack(side="left", ipady=4)
        tk.Button(row, text="Browse", font=FONT_LABEL, bg=CLR_TOOLBAR,
                  fg=CLR_TEXT, relief="flat", cursor="hand2",
                  command=self._browse_repo).pack(side="left", padx=(6, 0), ipady=3, ipadx=6)

        # Branch
        f2 = tk.Frame(self, bg=CLR_BG)
        f2.pack(fill="x", padx=18, pady=4)
        tk.Label(f2, text="Git Branch (usually: main)", font=FONT_LABEL,
                 bg=CLR_BG, fg=CLR_MUTED).pack(anchor="w")
        self.branch_var = tk.StringVar(value="main")
        tk.Entry(f2, textvariable=self.branch_var, font=FONT_UI,
                 bg=CLR_INPUT_BG, fg=CLR_TEXT, relief="flat",
                 insertbackground=CLR_TEXT, width=24).pack(anchor="w", ipady=4)

        # News subfolder
        f3 = tk.Frame(self, bg=CLR_BG)
        f3.pack(fill="x", padx=18, pady=4)
        tk.Label(f3, text="News subfolder inside repo (e.g. news)", font=FONT_LABEL,
                 bg=CLR_BG, fg=CLR_MUTED).pack(anchor="w")
        self.news_dir_var = tk.StringVar(value="news")
        tk.Entry(f3, textvariable=self.news_dir_var, font=FONT_UI,
                 bg=CLR_INPUT_BG, fg=CLR_TEXT, relief="flat",
                 insertbackground=CLR_TEXT, width=24).pack(anchor="w", ipady=4)

        # Default author
        f4 = tk.Frame(self, bg=CLR_BG)
        f4.pack(fill="x", padx=18, pady=4)
        tk.Label(f4, text="Default Author Name", font=FONT_LABEL,
                 bg=CLR_BG, fg=CLR_MUTED).pack(anchor="w")
        self.def_author_var = tk.StringVar(value="Campaign Team")
        tk.Entry(f4, textvariable=self.def_author_var, font=FONT_UI,
                 bg=CLR_INPUT_BG, fg=CLR_TEXT, relief="flat",
                 insertbackground=CLR_TEXT, width=32).pack(anchor="w", ipady=4)

        # Info label
        info = ("Tip: Make sure you have already run `git clone` and\n"
                "authenticated with GitHub (SSH key or credential helper).")
        tk.Label(self, text=info, font=FONT_LABEL, bg=CLR_BG,
                 fg=CLR_MUTED, justify="left").pack(anchor="w", padx=18, pady=(8, 0))

        # Buttons
        bf = tk.Frame(self, bg=CLR_BG)
        bf.pack(side="bottom", fill="x", padx=18, pady=14)
        tk.Button(bf, text="Save Settings", font=FONT_BTN,
                  bg=CLR_GREEN, fg="white", relief="flat", cursor="hand2",
                  command=self._save, padx=16, pady=6).pack(side="right")
        tk.Button(bf, text="Cancel", font=FONT_BTN,
                  bg=CLR_TOOLBAR, fg=CLR_TEXT, relief="flat", cursor="hand2",
                  command=self.destroy, padx=16, pady=6).pack(side="right", padx=(0, 8))

    def _browse_repo(self):
        path = filedialog.askdirectory(title="Select your local repo folder")
        if path:
            self.repo_var.set(path)

    def _load(self):
        self.repo_var.set(get_setting("repo_path"))
        self.branch_var.set(get_setting("branch", "main"))
        self.news_dir_var.set(get_setting("news_dir", "news"))
        self.def_author_var.set(get_setting("default_author", "Campaign Team"))

    def _save(self):
        set_setting("repo_path",      self.repo_var.get().strip())
        set_setting("branch",         self.branch_var.get().strip() or "main")
        set_setting("news_dir",       self.news_dir_var.get().strip() or "news")
        set_setting("default_author", self.def_author_var.get().strip() or "Campaign Team")
        messagebox.showinfo("Saved", "Settings saved!", parent=self)
        self.destroy()


# ─────────────────────────────────────────────────────────────────────────────
#  HELP / MARKUP GUIDE WINDOW
# ─────────────────────────────────────────────────────────────────────────────

class HelpWindow(tk.Toplevel):
    def __init__(self, parent):
        super().__init__(parent)
        self.title("Formatting Guide")
        self.configure(bg=CLR_BG)
        self.geometry("500x480")
        self.resizable(False, False)

        tk.Label(self, text="Formatting Guide", font=FONT_HEAD,
                 bg=CLR_BG, fg=CLR_GREEN).pack(anchor="w", padx=18, pady=12)

        guide = textwrap.dedent("""\
            PARAGRAPHS
            ──────────
            Just type normally. Leave a blank line between
            paragraphs — they'll become separate <p> blocks.

            HEADINGS
            ────────
            ## My Section Title      → big heading (H2)
            ### My Sub-Section       → smaller heading (H3)
            (Use the toolbar buttons — no need to type ## yourself)

            BOLD & ITALIC
            ─────────────
            **this text is bold**
            _this text is italic_
            (Select text and click Bold / Italic in the toolbar)

            BULLET LISTS
            ────────────
            - First item
            - Second item
            - Third item

            BLOCK QUOTES
            ────────────
            > This becomes a styled pull-quote block.

            LINKS
            ─────
            [link text](https://example.com)
            (Use the Link button in the toolbar)

            IMAGES
            ──────
            Fill in the "Header Image" field in the article
            details panel — images go in:
            /assets/images/news/your-image.jpg
        """)

        txt = tk.Text(self, bg=CLR_INPUT_BG, fg=CLR_TEXT, font=FONT_MONO,
                      relief="flat", padx=14, pady=10, wrap="word",
                      state="normal", width=56, height=22)
        txt.insert("1.0", guide)
        txt.configure(state="disabled")
        txt.pack(padx=18, pady=(0, 10), fill="both", expand=True)

        tk.Button(self, text="Got it!", font=FONT_BTN,
                  bg=CLR_GREEN, fg="white", relief="flat", cursor="hand2",
                  command=self.destroy, padx=20, pady=6).pack(pady=10)


# ─────────────────────────────────────────────────────────────────────────────
#  PUBLISH RESULT WINDOW
# ─────────────────────────────────────────────────────────────────────────────

class ResultWindow(tk.Toplevel):
    def __init__(self, parent, title: str, body: str, success: bool):
        super().__init__(parent)
        self.title(title)
        self.configure(bg=CLR_BG)
        self.geometry("520x340")
        self.resizable(True, True)
        self.grab_set()

        color = CLR_GREEN if success else CLR_WARN
        icon  = "✓" if success else "✗"

        tk.Label(self, text=f"{icon}  {title}", font=FONT_HEAD,
                 bg=CLR_BG, fg=color).pack(anchor="w", padx=18, pady=12)

        txt = tk.Text(self, bg=CLR_INPUT_BG, fg=CLR_TEXT, font=FONT_MONO,
                      relief="flat", padx=12, pady=8, wrap="word")
        txt.insert("1.0", body)
        txt.configure(state="disabled")
        txt.pack(fill="both", expand=True, padx=18, pady=(0, 10))

        tk.Button(self, text="Close", font=FONT_BTN,
                  bg=CLR_TOOLBAR, fg=CLR_TEXT, relief="flat", cursor="hand2",
                  command=self.destroy, padx=20, pady=6).pack(pady=10)


# ─────────────────────────────────────────────────────────────────────────────
#  MAIN APPLICATION WINDOW
# ─────────────────────────────────────────────────────────────────────────────

class NewsPublisher(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(APP_TITLE)
        self.configure(bg=CLR_BG)
        self.geometry("1180x800")
        self.minsize(900, 640)

        self._slug_auto = True   # whether slug is being auto-generated from title

        self._build_menubar()
        self._build_titlebar()
        self._build_main()
        self._build_statusbar()

        self._set_today()
        self._update_counts()

    # ── Menubar ───────────────────────────────────────────────────────────────

    def _build_menubar(self):
        mb = tk.Menu(self, bg=CLR_PANEL, fg=CLR_TEXT,
                     activebackground=CLR_GREEN, activeforeground="white",
                     relief="flat")
        self.config(menu=mb)

        file_m = tk.Menu(mb, tearoff=0, bg=CLR_PANEL, fg=CLR_TEXT,
                         activebackground=CLR_GREEN, activeforeground="white")
        file_m.add_command(label="New Article",       command=self._clear_form,
                           accelerator="Ctrl+N")
        file_m.add_separator()
        file_m.add_command(label="Save HTML Only",    command=self._save_only,
                           accelerator="Ctrl+S")
        file_m.add_command(label="Save + Push to GitHub", command=self._save_and_push,
                           accelerator="Ctrl+Shift+P")
        file_m.add_separator()
        file_m.add_command(label="Settings",          command=self._open_settings)
        file_m.add_separator()
        file_m.add_command(label="Quit",              command=self.quit)
        mb.add_cascade(label="File", menu=file_m)

        help_m = tk.Menu(mb, tearoff=0, bg=CLR_PANEL, fg=CLR_TEXT,
                         activebackground=CLR_GREEN, activeforeground="white")
        help_m.add_command(label="Formatting Guide", command=self._open_help)
        mb.add_cascade(label="Help", menu=help_m)

        self.bind("<Control-n>", lambda e: self._clear_form())
        self.bind("<Control-s>", lambda e: self._save_only())
        self.bind("<Control-P>", lambda e: self._save_and_push())  # Ctrl+Shift+P

    # ── Title bar ─────────────────────────────────────────────────────────────

    def _build_titlebar(self):
        bar = tk.Frame(self, bg=CLR_GREEN, height=52)
        bar.pack(fill="x")
        bar.pack_propagate(False)

        tk.Label(bar, text="📰  News Article Publisher",
                 font=("Segoe UI", 14, "bold"),
                 bg=CLR_GREEN, fg="white").pack(side="left", padx=18)

        tk.Button(bar, text="⚙  Settings", font=FONT_LABEL,
                  bg=CLR_GREEN, fg="white", relief="flat", cursor="hand2",
                  activebackground=CLR_GREEN_HV, activeforeground="white",
                  command=self._open_settings).pack(side="right", padx=12)

        tk.Button(bar, text="? Formatting Guide", font=FONT_LABEL,
                  bg=CLR_GREEN, fg="white", relief="flat", cursor="hand2",
                  activebackground=CLR_GREEN_HV, activeforeground="white",
                  command=self._open_help).pack(side="right", padx=4)

    # ── Main two-column layout ─────────────────────────────────────────────────

    def _build_main(self):
        main = tk.Frame(self, bg=CLR_BG)
        main.pack(fill="both", expand=True)

        # Left panel — article details
        left = tk.Frame(main, bg=CLR_PANEL, width=330)
        left.pack(side="left", fill="y")
        left.pack_propagate(False)
        self._build_left_panel(left)

        # Divider
        tk.Frame(main, bg=CLR_BORDER, width=1).pack(side="left", fill="y")

        # Right panel — content editor
        right = tk.Frame(main, bg=CLR_BG)
        right.pack(side="left", fill="both", expand=True)
        self._build_right_panel(right)

    # ── Left panel: metadata fields ───────────────────────────────────────────

    def _build_left_panel(self, parent):
        canvas = tk.Canvas(parent, bg=CLR_PANEL, highlightthickness=0)
        scrollbar = tk.Scrollbar(parent, orient="vertical", command=canvas.yview)
        canvas.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side="right", fill="y")
        canvas.pack(side="left", fill="both", expand=True)

        inner = tk.Frame(canvas, bg=CLR_PANEL)
        win_id = canvas.create_window((0, 0), window=inner, anchor="nw")

        def _resize(e):
            canvas.itemconfig(win_id, width=e.width)
        canvas.bind("<Configure>", _resize)

        inner.bind("<Configure>",
                   lambda e: canvas.configure(scrollregion=canvas.bbox("all")))

        def _on_mousewheel(e):
            canvas.yview_scroll(int(-1 * (e.delta / 120)), "units")
        canvas.bind_all("<MouseWheel>", _on_mousewheel)

        P = dict(padx=16, pady=4)
        lbl_cfg = dict(bg=CLR_PANEL, fg=CLR_MUTED, font=FONT_LABEL)
        ent_cfg = dict(bg=CLR_INPUT_BG, fg=CLR_TEXT, font=FONT_UI,
                       relief="flat", insertbackground=CLR_TEXT,
                       highlightthickness=1, highlightcolor=CLR_GREEN,
                       highlightbackground=CLR_BORDER)

        tk.Label(inner, text="ARTICLE DETAILS", bg=CLR_PANEL,
                 fg=CLR_GREEN, font=("Segoe UI", 9, "bold")).pack(
                 anchor="w", padx=16, pady=(14, 2))
        tk.Frame(inner, bg=CLR_BORDER, height=1).pack(fill="x", padx=16, pady=(0, 8))

        # Title
        tk.Label(inner, text="Headline / Title *", **lbl_cfg).pack(anchor="w", **P)
        self.title_var = tk.StringVar()
        self.title_var.trace_add("write", self._on_title_change)
        tk.Entry(inner, textvariable=self.title_var, **ent_cfg).pack(
            fill="x", padx=16, ipady=5)

        # Slug
        tk.Label(inner, text="URL Slug  (auto-generated from title)", **lbl_cfg).pack(
            anchor="w", **P)
        self.slug_var = tk.StringVar()
        slug_e = tk.Entry(inner, textvariable=self.slug_var, **ent_cfg)
        slug_e.pack(fill="x", padx=16, ipady=5)
        slug_e.bind("<FocusIn>",  lambda e: setattr(self, "_slug_auto", False))
        tk.Label(inner, text="URL will be: /news/<slug>.html",
                 bg=CLR_PANEL, fg=CLR_MUTED, font=("Segoe UI", 8)).pack(
                 anchor="w", padx=16)

        # Author
        tk.Label(inner, text="Author *", **lbl_cfg).pack(anchor="w", **P)
        self.author_var = tk.StringVar(value=get_setting("default_author", "Campaign Team"))
        author_combo = ttk.Combobox(inner, textvariable=self.author_var,
                                    values=DEFAULT_AUTHORS, font=FONT_UI,
                                    state="normal")
        self._style_combo(author_combo)
        author_combo.pack(fill="x", padx=16, ipady=4)

        # Date
        tk.Label(inner, text="Publication Date *  (YYYY-MM-DD)", **lbl_cfg).pack(
            anchor="w", **P)
        self.date_var = tk.StringVar()
        tk.Entry(inner, textvariable=self.date_var, **ent_cfg).pack(
            fill="x", padx=16, ipady=5)
        tk.Button(inner, text="Set to Today", font=FONT_LABEL, bg=CLR_TOOLBAR,
                  fg=CLR_TEXT, relief="flat", cursor="hand2",
                  command=self._set_today).pack(anchor="w", padx=16, pady=(2, 0),
                                                ipady=2, ipadx=8)

        # Category
        tk.Label(inner, text="Category *", **lbl_cfg).pack(anchor="w", **P)
        self.category_var = tk.StringVar(value="Campaign")
        cat_combo = ttk.Combobox(inner, textvariable=self.category_var,
                                 values=CATEGORIES, font=FONT_UI, state="readonly")
        self._style_combo(cat_combo)
        cat_combo.pack(fill="x", padx=16, ipady=4)

        # Article type
        tk.Label(inner, text="Article Type *", **lbl_cfg).pack(anchor="w", **P)
        self.type_var = tk.StringVar(value="article")
        type_combo = ttk.Combobox(inner, textvariable=self.type_var,
                                  values=ARTICLE_TYPES, font=FONT_UI, state="readonly")
        self._style_combo(type_combo)
        type_combo.pack(fill="x", padx=16, ipady=4)

        # Location
        tk.Label(inner, text="Location (for meta tag)", **lbl_cfg).pack(anchor="w", **P)
        self.location_var = tk.StringVar(value="Illinois' 10th Congressional District")
        tk.Entry(inner, textvariable=self.location_var, **ent_cfg).pack(
            fill="x", padx=16, ipady=5)

        # Tags
        tk.Label(inner, text="Tags  (comma-separated)", **lbl_cfg).pack(anchor="w", **P)
        self.tags_var = tk.StringVar()
        tk.Entry(inner, textvariable=self.tags_var, **ent_cfg).pack(
            fill="x", padx=16, ipady=5)
        tk.Label(inner, text='e.g.  Campaign, Illinois, Economy',
                 bg=CLR_PANEL, fg=CLR_MUTED, font=("Segoe UI", 8)).pack(
                 anchor="w", padx=16)

        # Summary
        tk.Label(inner, text="Summary / Excerpt *  (1–2 sentences)", **lbl_cfg).pack(
            anchor="w", **P)
        self.summary_text = tk.Text(inner, height=3, **ent_cfg, wrap="word")
        self.summary_text.pack(fill="x", padx=16, pady=(0, 2))
        self.summary_chars = tk.Label(inner, text="0 / 160 chars", bg=CLR_PANEL,
                                      fg=CLR_MUTED, font=("Segoe UI", 8))
        self.summary_chars.pack(anchor="e", padx=16)
        self.summary_text.bind("<KeyRelease>", self._update_counts)

        # Image
        tk.Label(inner, text="Header Image Path (optional)", **lbl_cfg).pack(
            anchor="w", **P)
        img_row = tk.Frame(inner, bg=CLR_PANEL)
        img_row.pack(fill="x", padx=16)
        self.image_var = tk.StringVar()
        tk.Entry(img_row, textvariable=self.image_var, **ent_cfg).pack(
            side="left", fill="x", expand=True, ipady=5)
        tk.Button(img_row, text="…", font=FONT_LABEL, bg=CLR_TOOLBAR,
                  fg=CLR_TEXT, relief="flat", cursor="hand2",
                  command=self._browse_image, width=3).pack(side="left", padx=(4, 0))
        tk.Label(inner, text='Path relative to site root, e.g.\n/assets/images/news/my-image.jpg',
                 bg=CLR_PANEL, fg=CLR_MUTED, font=("Segoe UI", 8), justify="left").pack(
                 anchor="w", padx=16)

        # Featured
        self.featured_var = tk.BooleanVar(value=False)
        feat_row = tk.Frame(inner, bg=CLR_PANEL)
        feat_row.pack(fill="x", padx=16, pady=8)
        tk.Checkbutton(feat_row, text="Mark as Featured Article",
                       variable=self.featured_var,
                       bg=CLR_PANEL, fg=CLR_TEXT,
                       selectcolor=CLR_INPUT_BG,
                       activebackground=CLR_PANEL,
                       font=FONT_UI).pack(anchor="w")

        # Action buttons
        tk.Frame(inner, bg=CLR_BORDER, height=1).pack(fill="x", padx=16, pady=8)

        tk.Button(inner, text="🔍  Preview in Browser",
                  font=FONT_BTN, bg=CLR_BLUE, fg="white",
                  relief="flat", cursor="hand2",
                  command=self._preview, padx=12, pady=7).pack(
                  fill="x", padx=16, pady=(0, 6))

        tk.Button(inner, text="💾  Save HTML File",
                  font=FONT_BTN, bg=CLR_TOOLBAR, fg=CLR_TEXT,
                  relief="flat", cursor="hand2",
                  command=self._save_only, padx=12, pady=7).pack(
                  fill="x", padx=16, pady=(0, 6))

        tk.Button(inner, text="🚀  Save + Push to GitHub",
                  font=FONT_BTN, bg=CLR_GREEN, fg="white",
                  relief="flat", cursor="hand2",
                  command=self._save_and_push, padx=12, pady=7).pack(
                  fill="x", padx=16, pady=(0, 6))

        tk.Button(inner, text="🗑  Clear / New Article",
                  font=FONT_LABEL, bg=CLR_BG, fg=CLR_MUTED,
                  relief="flat", cursor="hand2",
                  command=self._clear_form, padx=12, pady=5).pack(
                  fill="x", padx=16, pady=(0, 16))

    # ── Right panel: content editor ───────────────────────────────────────────

    def _build_right_panel(self, parent):
        # Header label
        header = tk.Frame(parent, bg=CLR_PANEL)
        header.pack(fill="x")

        tk.Label(header, text="ARTICLE CONTENT",
                 bg=CLR_PANEL, fg=CLR_GREEN,
                 font=("Segoe UI", 9, "bold")).pack(side="left", padx=18, pady=10)

        self.wc_label = tk.Label(header, text="0 words · 0 min read",
                                 bg=CLR_PANEL, fg=CLR_MUTED, font=FONT_LABEL)
        self.wc_label.pack(side="right", padx=18)

        # Toolbar
        toolbar = tk.Frame(parent, bg=CLR_TOOLBAR)
        toolbar.pack(fill="x")

        def tb_btn(label, tip, cmd, color=CLR_TOOLBAR):
            b = tk.Button(toolbar, text=label, font=("Segoe UI", 9),
                          bg=color, fg=CLR_TEXT, relief="flat",
                          cursor="hand2", command=cmd,
                          activebackground=CLR_BORDER,
                          padx=10, pady=5)
            b.pack(side="left")
            b.bind("<Enter>", lambda e, b=b: self._status(tip))
            b.bind("<Leave>", lambda e: self._status(""))
            return b

        tb_btn("B",         "Bold — wrap selected text",           self._fmt_bold)
        tb_btn("I",         "Italic — wrap selected text",          self._fmt_italic)
        tk.Frame(toolbar, bg=CLR_BORDER, width=1).pack(side="left", fill="y", pady=4, padx=2)
        tb_btn("H2",        "Heading 2 — prefix selected line",     self._fmt_h2)
        tb_btn("H3",        "Heading 3 — prefix selected line",     self._fmt_h3)
        tk.Frame(toolbar, bg=CLR_BORDER, width=1).pack(side="left", fill="y", pady=4, padx=2)
        tb_btn("❝ Quote",   "Block quote — prefix selected line",   self._fmt_quote)
        tb_btn("• List",    "Bullet list — prefix selected line",   self._fmt_bullet)
        tk.Frame(toolbar, bg=CLR_BORDER, width=1).pack(side="left", fill="y", pady=4, padx=2)
        tb_btn("🔗 Link",   "Insert a hyperlink",                   self._fmt_link)
        tk.Frame(toolbar, bg=CLR_BORDER, width=1).pack(side="left", fill="y", pady=4, padx=2)
        tb_btn("Undo",      "Undo last change  (Ctrl+Z)",           lambda: self.editor.edit_undo())
        tb_btn("Redo",      "Redo  (Ctrl+Y)",                       lambda: self.editor.edit_redo())

        # Hint bar
        hint = tk.Frame(parent, bg=CLR_INPUT_BG)
        hint.pack(fill="x")
        tk.Label(hint,
                 text=("  ℹ  Start typing your article below. "
                       "Leave a blank line between paragraphs. "
                       "Select text then click a toolbar button to format it. "
                       "Click  ? Formatting Guide  (top right) for full help."),
                 bg=CLR_INPUT_BG, fg=CLR_MUTED,
                 font=("Segoe UI", 8), anchor="w").pack(fill="x", pady=4)

        # Editor
        editor_frame = tk.Frame(parent, bg=CLR_BG)
        editor_frame.pack(fill="both", expand=True)

        vsb = tk.Scrollbar(editor_frame, orient="vertical")
        vsb.pack(side="right", fill="y")

        self.editor = tk.Text(
            editor_frame,
            undo=True, maxundo=200,
            bg=CLR_INPUT_BG, fg=CLR_TEXT,
            font=FONT_MONO,
            relief="flat",
            wrap="word",
            padx=20, pady=16,
            insertbackground=CLR_TEXT,
            selectbackground=CLR_GREEN,
            selectforeground="white",
            spacing1=2, spacing3=4,
            yscrollcommand=vsb.set,
        )
        self.editor.pack(side="left", fill="both", expand=True)
        vsb.config(command=self.editor.yview)

        self.editor.bind("<KeyRelease>", self._update_counts)

        # Syntax highlighting (simple)
        self._setup_tags()
        self.editor.bind("<KeyRelease>", self._on_editor_key)

    # ── Editor tags (minimal syntax colouring) ────────────────────────────────

    def _setup_tags(self):
        self.editor.tag_configure("heading",
            foreground=CLR_GREEN, font=("Consolas", 13, "bold"))
        self.editor.tag_configure("bold_tag",
            foreground=CLR_ACCENT, font=("Consolas", 11, "bold"))
        self.editor.tag_configure("italic_tag",
            foreground="#ce93d8", font=("Consolas", 11, "italic"))
        self.editor.tag_configure("quote_tag",
            foreground=CLR_MUTED, font=("Consolas", 11))
        self.editor.tag_configure("bullet_tag",
            foreground=CLR_BLUE)
        self.editor.tag_configure("link_tag",
            foreground=CLR_BLUE)

    def _highlight(self):
        """Apply simple syntax highlighting to the editor content."""
        content = self.editor.get("1.0", "end")
        for tag in ("heading", "bold_tag", "italic_tag",
                    "quote_tag", "bullet_tag", "link_tag"):
            self.editor.tag_remove(tag, "1.0", "end")

        patterns = [
            (r"^#{2,3} .+$",      "heading",   re.M),
            (r"\*\*.+?\*\*",      "bold_tag",  0),
            (r"__.+?__",          "bold_tag",  0),
            (r"\*.+?\*",          "italic_tag",0),
            (r"_.+?_",            "italic_tag",0),
            (r"^\>.+$",           "quote_tag", re.M),
            (r"^[-\*] .+$",       "bullet_tag",re.M),
            (r"\[.+?\]\(.+?\)",   "link_tag",  0),
        ]
        for pattern, tag, flags in patterns:
            for m in re.finditer(pattern, content, flags | re.MULTILINE):
                start = f"1.0 + {m.start()} chars"
                end   = f"1.0 + {m.end()} chars"
                self.editor.tag_add(tag, start, end)

    def _on_editor_key(self, _event=None):
        self._update_counts()
        self.after(50, self._highlight)

    # ── Toolbar actions ───────────────────────────────────────────────────────

    def _wrap_selection(self, prefix: str, suffix: str):
        """Wrap selected text (or insert placeholders if nothing selected)."""
        try:
            sel = self.editor.get(tk.SEL_FIRST, tk.SEL_LAST)
            self.editor.delete(tk.SEL_FIRST, tk.SEL_LAST)
            self.editor.insert(tk.INSERT, f"{prefix}{sel}{suffix}")
        except tk.TclError:
            self.editor.insert(tk.INSERT, f"{prefix}text here{suffix}")

    def _prefix_line(self, prefix: str):
        """Add a prefix to the current line."""
        idx = self.editor.index(tk.INSERT)
        row = idx.split(".")[0]
        line_start = f"{row}.0"
        line_end   = f"{row}.end"
        current    = self.editor.get(line_start, line_end)
        if current.startswith(prefix):
            self.editor.delete(line_start, line_end)
            self.editor.insert(line_start, current[len(prefix):])
        else:
            self.editor.insert(line_start, prefix)

    def _fmt_bold(self):   self._wrap_selection("**", "**")
    def _fmt_italic(self): self._wrap_selection("_", "_")
    def _fmt_h2(self):     self._prefix_line("## ")
    def _fmt_h3(self):     self._prefix_line("### ")
    def _fmt_quote(self):  self._prefix_line("> ")
    def _fmt_bullet(self): self._prefix_line("- ")

    def _fmt_link(self):
        url = simpledialog.askstring("Insert Link", "Enter the URL:", parent=self)
        if not url:
            return
        try:
            sel = self.editor.get(tk.SEL_FIRST, tk.SEL_LAST)
            self.editor.delete(tk.SEL_FIRST, tk.SEL_LAST)
            self.editor.insert(tk.INSERT, f"[{sel}]({url})")
        except tk.TclError:
            text = simpledialog.askstring("Insert Link", "Link display text:", parent=self)
            self.editor.insert(tk.INSERT, f"[{text or 'click here'}]({url})")

    # ── Status bar ────────────────────────────────────────────────────────────

    def _build_statusbar(self):
        bar = tk.Frame(self, bg=CLR_PANEL, height=26)
        bar.pack(fill="x", side="bottom")
        bar.pack_propagate(False)
        self.status_var = tk.StringVar(value="Ready")
        tk.Label(bar, textvariable=self.status_var, bg=CLR_PANEL,
                 fg=CLR_MUTED, font=("Segoe UI", 9),
                 anchor="w").pack(side="left", padx=12, fill="y")

    def _status(self, msg: str):
        self.status_var.set(msg)

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _style_combo(self, combo: ttk.Combobox):
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TCombobox",
                         fieldbackground=CLR_INPUT_BG,
                         background=CLR_INPUT_BG,
                         foreground=CLR_TEXT,
                         arrowcolor=CLR_TEXT,
                         bordercolor=CLR_BORDER,
                         lightcolor=CLR_BORDER,
                         darkcolor=CLR_BORDER)

    def _set_today(self):
        self.date_var.set(date.today().isoformat())

    def _on_title_change(self, *_):
        if self._slug_auto:
            self.slug_var.set(slugify(self.title_var.get()))
        self._update_counts()

    def _update_counts(self, _event=None):
        content = self.editor.get("1.0", "end-1c")
        wc = word_count(content)
        rt = reading_time(content)
        self.wc_label.config(text=f"{wc:,} words · {rt}")

        summary = self.summary_text.get("1.0", "end-1c")
        sc = len(summary)
        color = CLR_WARN if sc > 160 else CLR_MUTED
        self.summary_chars.config(text=f"{sc} / 160 chars", fg=color)

    def _browse_image(self):
        path = filedialog.askopenfilename(
            title="Select Header Image",
            filetypes=[("Images", "*.jpg *.jpeg *.png *.webp *.gif"), ("All", "*.*")]
        )
        if path:
            # suggest a /assets/images/news/... path
            name = os.path.basename(path)
            self.image_var.set(f"/assets/images/news/{name}")

    def _open_settings(self):
        SettingsWindow(self)

    def _open_help(self):
        HelpWindow(self)

    def _clear_form(self):
        if messagebox.askyesno("New Article",
                               "Clear the form and start a new article?",
                               parent=self):
            self.title_var.set("")
            self.slug_var.set("")
            self._slug_auto = True
            self.author_var.set(get_setting("default_author", "Campaign Team"))
            self._set_today()
            self.category_var.set("Campaign")
            self.type_var.set("article")
            self.tags_var.set("")
            self.summary_text.delete("1.0", "end")
            self.image_var.set("")
            self.featured_var.set(False)
            self.location_var.set("Illinois' 10th Congressional District")
            self.editor.delete("1.0", "end")
            self._update_counts()
            self._status("New article started.")

    # ── Validation & data assembly ────────────────────────────────────────────

    def _collect_data(self):
        """Validate fields and return a data dict, or None on error."""
        title   = self.title_var.get().strip()
        slug    = self.slug_var.get().strip()
        author  = self.author_var.get().strip()
        date_s  = self.date_var.get().strip()
        summary = self.summary_text.get("1.0", "end-1c").strip()
        content = self.editor.get("1.0", "end-1c").strip()

        errors = []
        if not title:   errors.append("• Headline / Title is required.")
        if not slug:    errors.append("• URL Slug is required.")
        if not author:  errors.append("• Author is required.")
        if not date_s:  errors.append("• Publication Date is required.")
        if not summary: errors.append("• Summary is required.")
        if not content: errors.append("• Article content cannot be empty.")

        if date_s and not re.match(r"^\d{4}-\d{2}-\d{2}$", date_s):
            errors.append("• Date must be in YYYY-MM-DD format (e.g. 2026-05-20).")

        if errors:
            messagebox.showerror("Please fix these issues",
                                 "\n".join(errors), parent=self)
            return None

        tags_raw = self.tags_var.get().strip()
        tags = [t.strip() for t in tags_raw.split(",") if t.strip()]

        content_html = content_to_html(content)

        return {
            "title":        title,
            "slug":         slug,
            "author":       author,
            "date":         date_s,
            "summary":      summary,
            "category":     self.category_var.get(),
            "article_type": self.type_var.get(),
            "location":     self.location_var.get().strip(),
            "tags":         tags,
            "image":        self.image_var.get().strip(),
            "featured":     self.featured_var.get(),
            "reading_time": reading_time(content),
            "content_html": content_html,
        }

    # ── File operations ───────────────────────────────────────────────────────

    def _write_files(self, data: dict, repo_path: str) -> tuple[str, str]:
        """
        Write the HTML file and update articles.json.
        Returns (html_path, json_path).
        """
        news_dir = get_setting("news_dir", "news")
        news_folder = os.path.join(repo_path, news_dir)
        os.makedirs(news_folder, exist_ok=True)

        html_path = os.path.join(news_folder, f"{data['slug']}.html")
        html_content = generate_html(data)
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(html_content)

        # Update articles.json
        json_path = os.path.join(news_folder, "articles.json")
        articles = []
        if os.path.exists(json_path):
            try:
                with open(json_path, "r", encoding="utf-8") as f:
                    articles = json.load(f)
            except Exception:
                articles = []

        # Remove any existing entry with same slug (overwrite)
        articles = [a for a in articles if a.get("slug") != data["slug"]]

        articles.insert(0, {
            "slug":     data["slug"],
            "title":    data["title"],
            "date":     data["date"],
            "summary":  data["summary"],
            "category": data["category"],
            "featured": data["featured"],
            "image":    data["image"],
            "author":   data["author"],
        })

        # Sort newest first
        articles.sort(key=lambda a: a.get("date", ""), reverse=True)

        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(articles, f, indent=2)

        return html_path, json_path

    # ── Actions ───────────────────────────────────────────────────────────────

    def _preview(self):
        data = self._collect_data()
        if not data:
            return

        repo_path = get_setting("repo_path").strip()

        if not repo_path:
            messagebox.showinfo(
                "Preview — Limited Styling",
                "No repo folder is set in Settings, so the preview will use\n"
                "fallback styles instead of the real site CSS.\n\n"
                "Go to Settings and set your repo folder for a pixel-perfect preview.",
                parent=self
            )

        html = generate_preview_html(data, repo_path)

        with tempfile.NamedTemporaryFile(
            "w", suffix=".html", delete=False, encoding="utf-8"
        ) as f:
            f.write(html)
            tmp = f.name

        webbrowser.open(f"file://{tmp}")
        css_note = "with real site CSS" if repo_path else "with fallback styles"
        self._status(f"Preview opened ({css_note}): {tmp}")

    def _save_only(self):
        data = self._collect_data()
        if not data:
            return

        repo_path = get_setting("repo_path").strip()
        if not repo_path:
            messagebox.showerror(
                "No Repo Folder Set",
                "Please go to Settings and set your local repository folder first.",
                parent=self
            )
            return

        try:
            html_path, json_path = self._write_files(data, repo_path)
            msg = (f"HTML saved:\n  {html_path}\n\n"
                   f"articles.json updated:\n  {json_path}\n\n"
                   f"Files are saved but NOT yet pushed to GitHub.\n"
                   f"Use  'Save + Push to GitHub'  when ready to publish.")
            ResultWindow(self, "File Saved", msg, success=True)
            self._status(f"Saved → {html_path}")
        except Exception as e:
            ResultWindow(self, "Save Error", str(e), success=False)

    def _save_and_push(self):
        data = self._collect_data()
        if not data:
            return

        repo_path = get_setting("repo_path").strip()
        if not repo_path:
            messagebox.showerror(
                "No Repo Folder Set",
                "Please go to Settings and set your local repository folder first.",
                parent=self
            )
            return

        confirm = messagebox.askyesno(
            "Publish Article?",
            f"This will:\n\n"
            f"  1. Save  news/{data['slug']}.html\n"
            f"  2. Update  news/articles.json\n"
            f"  3. Git commit and push to GitHub\n\n"
            f'Publish  "{data["title"]}"  now?',
            parent=self
        )
        if not confirm:
            return

        self._status("Saving and pushing to GitHub…")
        self.update()

        try:
            html_path, json_path = self._write_files(data, repo_path)
        except Exception as e:
            ResultWindow(self, "Save Error", str(e), success=False)
            return

        branch = get_setting("branch", "main")
        ok, log = push_to_github(repo_path, data["slug"], data["title"], branch)

        if ok:
            msg = (f"✓  Article published successfully!\n\n"
                   f"File:  {html_path}\n"
                   f"URL:   {SITE_URL}/news/{data['slug']}/\n\n"
                   f"─── Git log ───\n{log}")
            ResultWindow(self, "Published!", msg, success=True)
            self._status(f"Published → {SITE_URL}/news/{data['slug']}/")
        else:
            msg = (f"Files were saved locally but the GitHub push failed.\n\n"
                   f"File:  {html_path}\n\n"
                   f"─── Git output ───\n{log}\n\n"
                   f"You can push manually:\n"
                   f"  cd \"{repo_path}\"\n"
                   f"  git add .\n"
                   f"  git commit -m \"news: {data['slug']}\"\n"
                   f"  git push")
            ResultWindow(self, "Push Failed — Files Saved Locally", msg, success=False)
            self._status("Push failed — see details window.")


# ─────────────────────────────────────────────────────────────────────────────
#  ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app = NewsPublisher()
    app.mainloop()