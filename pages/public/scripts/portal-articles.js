// ============================================================
//  STAFF PORTAL — ARTICLES  —  portal-articles.js
// ============================================================
//
//  Write, edit, preview and publish news articles from the portal,
//  replacing the desktop news_publisher.py workflow. Nothing here
//  touches git: articles are stored in D1 and rendered by
//  functions/news/[slug].ts.
//
//  Depends on window.PortalCore (portal.js) for the session,
//  authenticated fetch and toasts.
//
//  ── AUDIENCE ──────────────────────────────────────────────
//  The people using this are the candidate and campaign staff,
//  not developers. So:
//    • the toolbar inserts markdown for them — nobody has to
//      learn syntax to write a heading or a link
//    • the URL is derived from the headline automatically, and
//      only editable behind an explicit "edit"
//    • the preview shows the real rendered output as they type
//    • publishing is a distinct, deliberate action, separate
//      from saving a draft
//
//  ── PREVIEW FIDELITY ──────────────────────────────────────
//  The live preview uses a local markdown renderer that mirrors
//  functions/_lib/article-render.ts. It exists for responsiveness
//  while typing, and is NOT the security boundary — the server
//  re-renders from the stored markdown on every page request, so
//  a tampered client can't inject anything into the public page.
//  "Full preview" opens the genuine server-rendered page.
//
// ============================================================

(function () {
  "use strict";

  const API = "/api/admin-articles";
  const core = () => window.PortalCore || {};

  let articles      = [];
  let statusFilter  = "";
  let editing       = null;   // slug being edited, or null for a new article
  let originalSlug  = null;
  let slugManual    = false;
  let dirty         = false;
  let initialised   = false;

  // ── DOM ────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  const listView    = $("art-list-view");
  const editorView  = $("art-editor-view");
  const listEl      = $("art-list");
  const loadingEl   = $("art-loading");
  const errorEl     = $("art-error");
  const errorMsgEl  = $("art-error-msg");
  const emptyEl     = $("art-empty");
  const summaryEl   = $("art-summary");
  const statsEl     = $("art-stats");
  const newBtn      = $("art-new-btn");
  const filtersEl   = $("art-filters");

  const titleEl     = $("art-title");
  const slugEl      = $("art-slug");
  const slugPreview = $("art-slug-preview");
  const slugEditBtn = $("art-edit-slug");
  const slugEditRow = $("art-slug-edit");
  const summaryIn   = $("art-summary-input");
  const summaryCnt  = $("art-summary-count");
  const bodyEl      = $("art-body");
  const previewEl   = $("art-preview");
  const wordCountEl = $("art-word-count");
  const readTimeEl  = $("art-read-time");
  const categoryEl  = $("art-category");
  const authorEl    = $("art-author");
  const dateEl      = $("art-date");
  const imageEl     = $("art-image");
  const featuredEl  = $("art-featured");

  const backBtn     = $("art-back-btn");
  const saveBtn     = $("art-save-btn");
  const saveLabel   = $("art-save-label");
  const publishBtn  = $("art-publish-btn");
  const publishLbl  = $("art-publish-label");
  const previewBtn  = $("art-preview-btn");
  const deleteBtn   = $("art-delete-btn");
  const dangerPanel = $("art-danger");
  const statusChip  = $("art-status-chip");
  const savedHint   = $("art-saved-hint");
  const successEl   = $("art-success");
  const successMsg  = $("art-success-msg");
  const viewLink    = $("art-view-link");
  const saveErrEl   = $("art-save-error");
  const saveErrMsg  = $("art-save-error-msg");
  const helpBtn     = $("art-help-btn");
  const helpEl      = $("art-help");

  // ============================================================
  //  BOOT
  // ============================================================

  document.addEventListener("portal:tab", e => {
    if (e.detail?.tab !== "articles") return;
    if (!initialised) { initialised = true; wire(); }
    if (!editing) fetchArticles();
  });

  function wire() {
    newBtn?.addEventListener("click", () => openEditor(null));
    backBtn?.addEventListener("click", leaveEditor);
    saveBtn?.addEventListener("click", () => save("draft"));
    publishBtn?.addEventListener("click", () => save("published"));
    previewBtn?.addEventListener("click", openFullPreview);
    deleteBtn?.addEventListener("click", remove);

    filtersEl?.querySelectorAll(".cal-pill").forEach(pill => {
      pill.addEventListener("click", () => {
        statusFilter = pill.dataset.status || "";
        filtersEl.querySelectorAll(".cal-pill")
          .forEach(p => p.classList.toggle("is-active", p === pill));
        renderList();
      });
    });

    // Headline drives the URL until someone edits the URL by hand
    titleEl?.addEventListener("input", () => {
      if (!slugManual) {
        const s = slugify(titleEl.value);
        slugEl.value = s;
        slugPreview.textContent = `/news/${s || "…"}`;
      }
      markDirty();
    });

    slugEditBtn?.addEventListener("click", () => {
      const showing = !slugEditRow.hidden;
      slugEditRow.hidden = showing;
      slugEditBtn.textContent = showing ? "edit" : "done";
      if (!showing) slugEl.focus();
    });

    slugEl?.addEventListener("input", () => {
      slugManual = true;
      slugEl.value = slugEl.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-{2,}/g, "-");
      slugPreview.textContent = `/news/${slugEl.value || "…"}`;
      markDirty();
    });

    summaryIn?.addEventListener("input", () => {
      summaryCnt.textContent = summaryIn.value.length;
      markDirty();
    });

    bodyEl?.addEventListener("input", () => { updatePreview(); markDirty(); });

    [categoryEl, authorEl, dateEl, imageEl, featuredEl]
      .forEach(el => el?.addEventListener("input", markDirty));

    // Toolbar
    document.querySelectorAll(".art-tool[data-md]").forEach(btn => {
      btn.addEventListener("click", () => applyFormat(btn.dataset.md));
    });

    helpBtn?.addEventListener("click", () => {
      helpEl.hidden = !helpEl.hidden;
      helpBtn.setAttribute("aria-expanded", String(!helpEl.hidden));
    });

    // Keyboard shortcuts inside the body field
    bodyEl?.addEventListener("keydown", e => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "b") { e.preventDefault(); applyFormat("bold"); }
      if (key === "i") { e.preventDefault(); applyFormat("italic"); }
      if (key === "k") { e.preventDefault(); applyFormat("link"); }
      if (key === "s") { e.preventDefault(); save(currentStatus()); }
    });

    // Losing unsaved work to a stray click or refresh is the worst
    // possible outcome for someone who just wrote 800 words.
    window.addEventListener("beforeunload", e => {
      if (dirty && !editorView.hidden) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  // ============================================================
  //  LIST
  // ============================================================

  async function fetchArticles() {
    show(loadingEl); hide(errorEl); hide(emptyEl); hide(statsEl);
    listEl.innerHTML = "";

    try {
      const res = await core().authFetch(API);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `Server returned ${res.status}`);
      }
      const data = await res.json();
      articles = data.articles || [];

      $("art-stat-total").textContent     = data.counts?.total ?? articles.length;
      $("art-stat-published").textContent = data.counts?.published ?? 0;
      $("art-stat-drafts").textContent    = data.counts?.drafts ?? 0;
      show(statsEl);

      renderList();
    } catch (err) {
      if (/Session expired/.test(err.message)) return;
      hide(loadingEl);
      errorMsgEl.textContent = err.message;
      show(errorEl);
    }
  }

  function renderList() {
    hide(loadingEl);
    const rows = statusFilter ? articles.filter(a => a.status === statusFilter) : articles;

    summaryEl.textContent = articles.length
      ? `${articles.length} article${articles.length === 1 ? "" : "s"}` +
        (statusFilter ? ` · showing ${rows.length} ${statusFilter}` : "")
      : "No articles yet.";

    listEl.innerHTML = "";
    if (!rows.length) { show(emptyEl); return; }
    hide(emptyEl);

    for (const a of rows) {
      const li = document.createElement("li");
      li.className = "art-item";
      li.innerHTML = `
        <div class="art-item-main">
          <div class="art-item-head">
            <span class="art-chip art-chip-${a.status}">${a.status === "published" ? "Published" : "Draft"}</span>
            ${a.featured ? '<span class="art-chip art-chip-featured">Featured</span>' : ""}
            <span class="art-item-cat">${esc(a.category || "Article")}</span>
          </div>
          <h3 class="art-item-title"></h3>
          <p class="art-item-summary"></p>
          <p class="art-item-meta">
            <code>/news/${esc(a.slug)}</code>
            · ${esc(a.author || "Campaign Team")}
            · ${esc(formatDate(a.published_at || a.created_at))}
            ${a.updated_by ? `· last edited by ${esc(a.updated_by)}` : ""}
          </p>
        </div>
        <div class="art-item-actions">
          <button class="art-btn art-btn-ghost art-edit" data-slug="${esc(a.slug)}">
            <i class="fas fa-pen" aria-hidden="true"></i> Edit
          </button>
          ${a.status === "published"
            ? `<a class="art-btn art-btn-ghost" href="/news/${esc(a.slug)}" target="_blank" rel="noopener">
                 <i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i> View
               </a>`
            : ""}
        </div>`;
      // textContent for author-supplied strings, so a headline can
      // never inject markup into the portal itself
      li.querySelector(".art-item-title").textContent = a.title;
      li.querySelector(".art-item-summary").textContent = a.summary || "";
      li.querySelector(".art-edit").addEventListener("click", () => openEditor(a.slug));
      listEl.appendChild(li);
    }
  }

  // ============================================================
  //  EDITOR
  // ============================================================

  async function openEditor(slug) {
    clearBanners();
    editing = slug;
    originalSlug = slug;
    slugManual = !!slug;
    dirty = false;

    if (!slug) {
      titleEl.value = ""; slugEl.value = ""; summaryIn.value = "";
      bodyEl.value = ""; imageEl.value = ""; featuredEl.checked = false;
      categoryEl.value = "Article";
      authorEl.value = "Campaign Team";
      dateEl.value = new Date().toISOString().slice(0, 10);
      slugPreview.textContent = "/news/…";
      setStatus("draft");
      hide(dangerPanel);
    } else {
      try {
        const res = await core().authFetch(`${API}?slug=${encodeURIComponent(slug)}`);
        if (!res.ok) throw new Error(`Could not load article (${res.status})`);
        const { article } = await res.json();

        titleEl.value    = article.title || "";
        slugEl.value     = article.slug || "";
        summaryIn.value  = article.summary || "";
        bodyEl.value     = article.body_md || "";
        categoryEl.value = article.category || "Article";
        authorEl.value   = article.author || "Campaign Team";
        imageEl.value    = article.image || "";
        featuredEl.checked = !!article.featured;
        dateEl.value = (article.published_at || article.created_at || "").slice(0, 10);
        slugPreview.textContent = `/news/${article.slug}`;
        setStatus(article.status);
        show(dangerPanel);
      } catch (err) {
        core().toast?.(err.message, "error", 8000);
        return;
      }
    }

    summaryCnt.textContent = summaryIn.value.length;
    slugEditRow.hidden = true;
    slugEditBtn.textContent = "edit";
    helpEl.hidden = true;
    updatePreview();

    hide(listView); show(editorView);
    titleEl.focus();
  }

  function leaveEditor() {
    if (dirty && !confirm("You have unsaved changes. Leave without saving?")) return;
    editing = null; originalSlug = null; dirty = false;
    hide(editorView); show(listView);
    clearBanners();
    fetchArticles();
  }

  function currentStatus() {
    return statusChip.dataset.status || "draft";
  }

  function setStatus(status) {
    statusChip.dataset.status = status;
    statusChip.textContent = status === "published" ? "Published" : "Draft";
    statusChip.className = `art-status-chip art-chip-${status}`;
    publishLbl.textContent = status === "published" ? "Update live article" : "Publish";
    saveLabel.textContent  = status === "published" ? "Revert to draft" : "Save draft";
  }

  function markDirty() {
    dirty = true;
    savedHint.textContent = "Unsaved changes";
    savedHint.className = "art-saved-hint is-dirty";
  }

  // ============================================================
  //  SAVE
  // ============================================================

  async function save(status) {
    clearBanners();

    const title = titleEl.value.trim();
    if (!title) { showSaveError("Give the article a headline before saving."); titleEl.focus(); return; }
    if (!bodyEl.value.trim()) { showSaveError("The article body is empty."); bodyEl.focus(); return; }

    if (status === "published" && !summaryIn.value.trim() &&
        !confirm("This article has no summary. It will look empty on the news page and in link previews. Publish anyway?")) {
      return;
    }

    const payload = {
      title,
      slug:        slugEl.value.trim() || slugify(title),
      summary:     summaryIn.value.trim(),
      body_md:     bodyEl.value,
      category:    categoryEl.value,
      author:      authorEl.value.trim(),
      image:       imageEl.value.trim(),
      featured:    featuredEl.checked,
      status,
      published_at: dateEl.value || null
    };

    setSaving(true);
    try {
      const isUpdate = !!originalSlug;
      if (isUpdate) payload.original_slug = originalSlug;

      const res = await core().authFetch(API, {
        method: isUpdate ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) { showSaveError(data.error || `Server returned ${res.status}`); return; }

      editing = data.slug;
      originalSlug = data.slug;
      slugEl.value = data.slug;
      slugPreview.textContent = `/news/${data.slug}`;
      setStatus(status);
      show(dangerPanel);
      dirty = false;
      savedHint.textContent = "All changes saved";
      savedHint.className = "art-saved-hint is-saved";

      successMsg.textContent = status === "published"
        ? "This article is live on the site now."
        : "Saved as a draft. It is not visible on the site yet.";
      if (status === "published") {
        viewLink.href = `/news/${data.slug}`;
        viewLink.hidden = false;
      } else {
        viewLink.hidden = true;
      }
      show(successEl);
      core().toast?.(status === "published" ? "Article published." : "Draft saved.");

    } catch (err) {
      if (/Session expired/.test(err.message)) return;
      showSaveError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!originalSlug) return;
    const published = currentStatus() === "published";
    const warning = published
      ? `Delete "${titleEl.value.trim()}"?\n\nIt is LIVE on the site. The page will stop working immediately and any shared links will break.\n\nThis cannot be undone.`
      : `Delete the draft "${titleEl.value.trim()}"?\n\nThis cannot be undone.`;
    if (!confirm(warning)) return;

    try {
      const res = await core().authFetch(`${API}?slug=${encodeURIComponent(originalSlug)}`,
        { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        showSaveError(d.error || `Could not delete (${res.status})`);
        return;
      }
      core().toast?.("Article deleted.");
      dirty = false;
      leaveEditor();
    } catch (err) {
      if (/Session expired/.test(err.message)) return;
      showSaveError("Couldn't reach the server.");
    }
  }

  function openFullPreview() {
    if (!originalSlug) {
      core().toast?.("Save the article once first, then you can see the full preview.", "warn");
      return;
    }
    // The preview endpoint needs the Authorization header, so fetch it
    // and open the result in a blank tab rather than linking directly.
    core().authFetch(`${API}?slug=${encodeURIComponent(originalSlug)}&preview=1`)
      .then(res => res.text())
      .then(html => {
        const w = window.open("", "_blank");
        if (!w) { core().toast?.("Allow pop-ups to use the full preview.", "warn"); return; }
        w.document.write(html);
        w.document.close();
      })
      .catch(() => core().toast?.("Preview failed.", "error"));
  }

  function setSaving(on) {
    [saveBtn, publishBtn, deleteBtn].forEach(b => { if (b) b.disabled = on; });
  }

  function showSaveError(msg) {
    saveErrMsg.textContent = msg;
    show(saveErrEl);
  }

  function clearBanners() {
    hide(successEl); hide(saveErrEl);
  }

  // ============================================================
  //  TOOLBAR
  // ============================================================

  function applyFormat(kind) {
    const el = bodyEl;
    const start = el.selectionStart, end = el.selectionEnd;
    const selected = el.value.slice(start, end);
    let before = "", after = "", placeholder = selected, lineMode = false;

    switch (kind) {
      case "bold":   before = "**"; after = "**"; placeholder = selected || "bold text"; break;
      case "italic": before = "*";  after = "*";  placeholder = selected || "italic text"; break;
      case "h2":     before = "## "; placeholder = selected || "Heading"; lineMode = true; break;
      case "quote":  before = "> ";  placeholder = selected || "Quoted text"; lineMode = true; break;
      case "ul":     return applyList("- ");
      case "ol":     return applyList("1. ");
      case "hr":     return insertBlock("\n---\n");
      case "link": {
        const url = prompt("Link address (for example https://example.com or /about):", "https://");
        if (!url) return;
        before = "["; after = `](${url})`; placeholder = selected || "link text";
        break;
      }
      case "image": {
        const url = prompt("Image path (for example /images/news/photo.jpg):", "/images/news/");
        if (!url) return;
        const alt = prompt("Describe the image for screen readers:", selected || "") || "";
        insertAt(start, end, `![${alt}](${url})`);
        return;
      }
      default: return;
    }

    if (lineMode) {
      const lineStart = el.value.lastIndexOf("\n", start - 1) + 1;
      const prefix = el.value.slice(lineStart, start);
      if (!prefix.trim()) {
        insertAt(lineStart, end, before + placeholder);
        return;
      }
      insertAt(start, end, "\n" + before + placeholder);
      return;
    }

    insertAt(start, end, before + placeholder + after,
             before.length, before.length + placeholder.length);
  }

  function applyList(marker) {
    const el = bodyEl;
    const start = el.selectionStart, end = el.selectionEnd;
    const selected = el.value.slice(start, end);

    if (selected.includes("\n")) {
      const lines = selected.split("\n").map((l, i) =>
        l.trim() ? (marker === "1. " ? `${i + 1}. ${l.trim()}` : `${marker}${l.trim()}`) : l);
      insertAt(start, end, lines.join("\n"));
      return;
    }
    const lineStart = el.value.lastIndexOf("\n", start - 1) + 1;
    const prefix = el.value.slice(lineStart, start);
    const text = selected || "List item";
    if (!prefix.trim()) insertAt(lineStart, end, marker + text);
    else insertAt(start, end, "\n" + marker + text);
  }

  function insertBlock(text) {
    const el = bodyEl;
    insertAt(el.selectionStart, el.selectionEnd, text);
  }

  function insertAt(start, end, text, selFrom, selTo) {
    const el = bodyEl;
    el.setRangeText(text, start, end, "end");
    if (selFrom !== undefined) {
      el.selectionStart = start + selFrom;
      el.selectionEnd   = start + (selTo ?? selFrom);
    }
    el.focus();
    updatePreview();
    markDirty();
  }

  // ============================================================
  //  LIVE PREVIEW
  // ============================================================

  function updatePreview() {
    const md = bodyEl.value;
    previewEl.innerHTML = markdownToHtml(md) ||
      '<p class="art-preview-empty">Your article will appear here as you type.</p>';

    // Count prose, not syntax. Raw splitting counts "##", "-" and "1."
    // as words, which overstates the length for anyone using headings
    // or lists and makes the reading-time estimate wrong.
    const words = countWords(md);
    wordCountEl.textContent = `${words} word${words === 1 ? "" : "s"}`;
    const mins = Math.max(1, Math.round(words / 200));
    readTimeEl.textContent = `${mins} minute${mins === 1 ? "" : "s"} read`;
  }

  // ============================================================
  //  MARKDOWN (preview only)
  // ============================================================
  //
  //  Mirrors functions/_lib/article-render.ts. Kept deliberately
  //  conservative: escape first, then emit only known tags. The
  //  server re-renders independently, so this is about matching
  //  what the reader will see, not about trust.

  function markdownToHtml(markdown) {
    if (!markdown) return "";
    let text = String(markdown).replace(/\r\n/g, "\n");

    const blocks = [];
    text = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      blocks.push(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
      return `\u0000B${blocks.length - 1}\u0000`;
    });

    text = esc(text);

    const inline = [];
    text = text.replace(/`([^`\n]+)`/g, (_m, c) => {
      inline.push(`<code>${c}</code>`);
      return `\u0000I${inline.length - 1}\u0000`;
    });

    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) =>
      safeUrl(url) ? `<img src="${esc(safeUrl(url))}" alt="${esc(alt)}" loading="lazy">` : alt);

    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) =>
      safeUrl(url) ? `<a href="${esc(safeUrl(url))}">${label}</a>` : label);

    text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    text = text.replace(/(^|[^\w])_([^_\n]+)_(?![\w])/g, "$1<em>$2</em>");

    const out = [];
    let list = null, quote = false, para = [];
    const closePara = () => { if (para.length) { out.push(`<p>${para.join("<br>")}</p>`); para = []; } };
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    const closeQuote = () => { if (quote) { out.push("</blockquote>"); quote = false; } };
    const closeAll = () => { closePara(); closeList(); closeQuote(); };

    for (const raw of text.split("\n")) {
      const line = raw.trimEnd();
      if (!line.trim()) { closeAll(); continue; }
      if (/^\u0000B\d+\u0000$/.test(line.trim())) { closeAll(); out.push(line.trim()); continue; }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { closeAll(); out.push("<hr>"); continue; }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeAll(); const lv = Math.min(Math.max(h[1].length, 2), 6);
               out.push(`<h${lv}>${h[2].trim()}</h${lv}>`); continue; }

      const q = line.match(/^&gt;\s?(.*)$/);
      if (q) { closePara(); closeList(); if (!quote) { out.push("<blockquote>"); quote = true; }
               out.push(`<p>${q[1]}</p>`); continue; }
      if (quote) closeQuote();

      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) { closePara(); if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
                out.push(`<li>${ul[1]}</li>`); continue; }

      const ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ol) { closePara(); if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
                out.push(`<li>${ol[1]}</li>`); continue; }

      closeList();
      para.push(line.trim());
    }
    closeAll();

    return out.join("\n")
      .replace(/\u0000I(\d+)\u0000/g, (_m, i) => inline[+i] ?? "")
      .replace(/\u0000B(\d+)\u0000/g, (_m, i) => blocks[+i] ?? "");
  }

  function safeUrl(raw) {
    if (!raw) return null;
    const v = String(raw).trim();
    const probe = v.replace(/[\s\u0000-\u001F]/g, "").toLowerCase();
    if (/^(javascript|data|vbscript|file|blob):/.test(probe)) return null;
    if (/^[/#?]/.test(v)) return v;
    if (/^(https?:|mailto:|tel:)/.test(probe)) return v;
    if (!probe.includes(":")) return v;
    return null;
  }

  // ============================================================
  //  HELPERS
  // ============================================================

  function countWords(md) {
    const prose = String(md || "")
      .replace(/```[\s\S]*?```/g, " ")        // code blocks
      .replace(/`[^`]*`/g, " ")                // inline code
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")   // images
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links -> keep the label
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")      // heading markers
      .replace(/^\s*[-*+]\s+/gm, "")           // bullet markers
      .replace(/^\s*\d+\.\s+/gm, "")          // numbered markers
      .replace(/^\s*>\s?/gm, "")               // quote markers
      .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, " ") // rules
      .replace(/[*_]{1,2}/g, "")               // emphasis marks
      .trim();
    return prose ? prose.split(/\s+/).filter(Boolean).length : 0;
  }

  function slugify(title) {
    return String(title || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  }

  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function formatDate(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleDateString("en-US",
        { month: "short", day: "numeric", year: "numeric" });
    } catch { return iso; }
  }

  const show = el => { if (el) el.hidden = false; };
  const hide = el => { if (el) el.hidden = true; };

})();
