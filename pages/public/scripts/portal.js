// ============================================================
//  STAFF PORTAL  —  portal.js
// ============================================================
//
//  Security flow:
//    1. On load — read session from sessionStorage.
//       If missing or expired, redirect to /login.html immediately.
//    2. Every API call sends the Bearer token in the Authorization
//       header. A 401 response means the session was invalidated
//       server-side — redirect to login.
//    3. A countdown timer shows the remaining session time and
//       warns when fewer than 10 minutes remain.
//    4. Logout calls DELETE /api/admin-auth to invalidate the
//       session server-side, then clears sessionStorage and
//       redirects to /login.html.
//
//  This file owns the portal shell (session, tabs, appearance,
//  toasts) and the Volunteers tab. The Calendar tab lives in
//  portal-calendar.js and talks to this file through
//  window.PortalCore.
//
//  ── SCOPE NOTE ────────────────────────────────────────────
//  Search and sorting operate on the records currently loaded
//  (one page). They are deliberately client-side: the volunteer
//  API paginates server-side and has no sort/search parameters,
//  so sorting across the whole result set would mean pulling
//  every record into the browser. "Export all matching records"
//  does page through everything, because that is an explicit,
//  user-initiated action with a progress indicator.
//
// ============================================================

(function () {
  "use strict";

  const LOGIN_URL        = "/login.html";
  const VOLUNTEERS_API   = "/api/admin-volunteers";
  const AUTH_API         = "/api/admin-auth";
  const SESSION_KEY      = "staffSession";
  const WARN_MINS_LEFT   = 10;    // show warning bar when session has this many minutes left
  const PAGE_LIMIT       = 50;
  const EXPORT_PAGE_SIZE = 200;   // page size used when exporting every matching record
  const MAX_EXPORT_PAGES = 100;   // hard stop so a bad pagination response can't loop forever

  // ── State ──────────────────────────────────────────────────
  let session       = null;
  let currentPage   = 1;
  let currentPagination = null;
  let activeFilters = {};
  let lastData      = [];     // records for the current page (unsorted, unfiltered)
  let viewData      = [];     // what is actually on screen after search + sort
  let lastViewedBy  = null;
  let pageLimit     = PAGE_LIMIT;
  let searchTerm    = "";
  let sortKey       = null;
  let sortDir       = "asc";
  let modalReturnFocus = null;

  // ── DOM refs ───────────────────────────────────────────────
  const usernameEl       = document.getElementById("portal-username");
  const logoutBtn        = document.getElementById("portal-logout-btn");
  const sessionBar       = document.getElementById("portal-session-bar");
  const sessionCountdown = document.getElementById("portal-session-countdown");
  const recordSummary    = document.getElementById("portal-record-summary");
  const exportBtn        = document.getElementById("portal-export-btn");
  const exportMenu       = document.getElementById("portal-export-menu");
  const exportPageBtn    = document.getElementById("export-page");
  const exportAllBtn     = document.getElementById("export-all");
  const exportPageCount  = document.getElementById("export-page-count");
  const exportAllCount   = document.getElementById("export-all-count");
  const loadingEl        = document.getElementById("portal-loading");
  const errorEl          = document.getElementById("portal-fetch-error");
  const errorMsgEl       = document.getElementById("portal-fetch-error-msg");
  const retryBtn         = document.getElementById("portal-retry-btn");
  const emptyEl          = document.getElementById("portal-empty");
  const tableWrap        = document.getElementById("portal-table-wrap");
  const tbody            = document.getElementById("portal-tbody");
  const paginationEl     = document.getElementById("portal-pagination");
  const pagPrev          = document.getElementById("pag-prev");
  const pagNext          = document.getElementById("pag-next");
  const pagInfo          = document.getElementById("pag-info");

  // Stats
  const statsEl      = document.getElementById("portal-stats");
  const statTotal    = document.getElementById("stat-total");
  const statVerified = document.getElementById("stat-verified");
  const statPending  = document.getElementById("stat-pending");
  const statRecent   = document.getElementById("stat-recent");

  // Filter controls
  const filterSource   = document.getElementById("filter-source");
  const filterVerified = document.getElementById("filter-verified");
  const filterSince    = document.getElementById("filter-since");
  const filterUntil    = document.getElementById("filter-until");
  const filterApply    = document.getElementById("filter-apply");
  const filterReset    = document.getElementById("filter-reset");
  const filterSearch   = document.getElementById("filter-search");
  const filterSearchClear = document.getElementById("filter-search-clear");
  const filterPageSize = document.getElementById("filter-pagesize");

  // Modal
  const modalOverlay  = document.getElementById("portal-modal-overlay");
  const modalClose    = document.getElementById("modal-close");
  const modalBody     = document.getElementById("modal-body");
  const modalWatermark = document.getElementById("modal-watermark");

  // Toasts
  const toastHost = document.getElementById("portal-toasts");

  // ── 1. SESSION GUARD ───────────────────────────────────────

  function loadSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed?.token || !parsed?.expires_at) return null;
      if (new Date(parsed.expires_at) <= new Date()) {
        sessionStorage.removeItem(SESSION_KEY);
        return null;
      }
      return parsed;
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
  }

  session = loadSession();
  if (!session) {
    // ── Dev fixtures ──────────────────────────────────────────
    // dev-fixtures.js only defines __DEV_FIXTURES__ when the page
    // is served from localhost AND ?dev=1 has been set. On any other
    // host it defines nothing at all, so this branch is dead code in
    // production and we redirect to login exactly as before.
    if (window.__DEV_FIXTURES__) {
      session = window.__DEV_FIXTURES__.session;
    } else {
      window.location.replace(LOGIN_URL);
      throw new Error("Redirecting to login.");
    }
  }

  // ── 2. APPEARANCE ─────────────────────────────────────────
  //  The portal uses the SAME accessibility panel as the public site:
  //  base.js injects #a11y-trigger into .nav-social in the header and
  //  owns all the preference state. Nothing is reimplemented here —
  //  that panel offers display modes, text sizing, dyslexia-friendly
  //  fonts, colour-vision filters, tints, motion and focus options,
  //  and persists them site-wide under its own storage key.
  //
  //  All this needs to do is notice when a mode changes, because
  //  FullCalendar and Leaflet both bake colours in at render time and
  //  have to be told to repaint.

  const themeObserver = new MutationObserver(() => {
    document.dispatchEvent(new CustomEvent("portal:themechange", {
      detail: { classes: document.documentElement.className }
    }));
  });
  themeObserver.observe(document.documentElement, {
    attributes: true, attributeFilter: ["class"]
  });

  function closeAllMenus() {
    if (exportMenu) { exportMenu.hidden = true; exportBtn?.setAttribute("aria-expanded", "false"); }
  }

  document.addEventListener("click", closeAllMenus);

  // ── 3. INIT UI ─────────────────────────────────────────────

  usernameEl.textContent = session.username;
  startCountdown();
  fetchVolunteers();

  // ── 3b. TAB SWITCHING ──────────────────────────────────────

  const tabs = document.querySelectorAll(".portal-tab");

  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;

      tabs.forEach(t => {
        t.classList.toggle("active", t.dataset.tab === target);
        t.setAttribute("aria-selected", t.dataset.tab === target ? "true" : "false");
      });

      // Driven off the tab list rather than named consts, so adding a
      // tab is a markup change only.
      tabs.forEach(t => {
        const section = document.getElementById(`section-${t.dataset.tab}`);
        if (section) section.hidden = t.dataset.tab !== target;
      });

      // portal-calendar.js listens for this to lazy-initialise itself.
      // Firing on every switch (not just the first) lets it re-measure
      // the map and calendar, which mis-render if sized while hidden.
      document.dispatchEvent(new CustomEvent("portal:tab", { detail: { tab: target } }));
    });
  });

  // ── 4. COUNTDOWN TIMER ────────────────────────────────────

  let warnedAboutExpiry = false;

  function startCountdown() {
    updateCountdown();
    setInterval(updateCountdown, 30_000); // update every 30 s
  }

  function updateCountdown() {
    const expiresMs  = new Date(session.expires_at).getTime();
    const remainingMs = expiresMs - Date.now();

    if (remainingMs <= 0) {
      // Session expired mid-session
      sessionStorage.removeItem(SESSION_KEY);
      window.location.replace(LOGIN_URL + "?reason=expired");
      return;
    }

    const remainingMins = Math.ceil(remainingMs / 60_000);

    if (remainingMins <= WARN_MINS_LEFT) {
      sessionBar.hidden = false;
      sessionCountdown.textContent =
        `Session expires in ${remainingMins} minute${remainingMins === 1 ? "" : "s"} — save any work and refresh if needed.`;
      sessionBar.classList.toggle("urgent", remainingMins <= 3);

      if (!warnedAboutExpiry) {
        warnedAboutExpiry = true;
        toast(`Your session ends in about ${remainingMins} minutes. Finish any exports before then.`, "warn", 12000);
      }
    } else {
      sessionBar.hidden = true;
    }
  }

  // ── 5. LOGOUT ─────────────────────────────────────────────

  logoutBtn.addEventListener("click", async () => {
    logoutBtn.disabled = true;
    logoutBtn.textContent = "Signing out…";
    try {
      await fetch(AUTH_API, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.token}` }
      });
    } catch { /* best-effort */ }
    sessionStorage.removeItem(SESSION_KEY);
    window.location.replace(LOGIN_URL);
  });

  // ── 6. FILTERS ────────────────────────────────────────────

  filterApply.addEventListener("click", () => {
    currentPage = 1;
    activeFilters = buildFilters();
    fetchVolunteers();
  });

  filterReset.addEventListener("click", () => {
    filterSource.value   = "";
    filterVerified.value = "";
    filterSince.value    = "";
    filterUntil.value    = "";
    if (filterSearch) filterSearch.value = "";
    searchTerm    = "";
    sortKey       = null;
    updateSortIndicators();
    activeFilters = {};
    currentPage   = 1;
    fetchVolunteers();
  });

  function buildFilters() {
    const f = {};
    if (filterSource.value)   f.source_form = filterSource.value;
    if (filterVerified.value) f.verified     = filterVerified.value;
    if (filterSince.value)    f.since        = filterSince.value;
    if (filterUntil.value)    f.until        = filterUntil.value;
    return f;
  }

  // Date sanity check — a reversed range silently returns nothing otherwise
  [filterSince, filterUntil].forEach(el => {
    el?.addEventListener("change", () => {
      if (filterSince.value && filterUntil.value && filterSince.value > filterUntil.value) {
        toast("The “From” date is after the “To” date — no records will match.", "warn");
      }
    });
  });

  if (filterPageSize) {
    filterPageSize.addEventListener("change", () => {
      pageLimit   = parseInt(filterPageSize.value, 10) || PAGE_LIMIT;
      currentPage = 1;
      fetchVolunteers();
    });
  }

  // ── 7. SEARCH (client-side, current page) ──────────────────

  if (filterSearch) {
    let debounce;
    filterSearch.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        searchTerm = filterSearch.value.trim().toLowerCase();
        filterSearchClear.hidden = !searchTerm;
        renderRows();
      }, 150);
    });
  }

  filterSearchClear?.addEventListener("click", () => {
    filterSearch.value = "";
    searchTerm = "";
    filterSearchClear.hidden = true;
    renderRows();
    filterSearch.focus();
  });

  // "/" focuses search from anywhere that isn't already a text field
  document.addEventListener("keydown", e => {
    if (e.key === "/" && !isTypingTarget(e.target) && filterSearch &&
        !document.getElementById("section-volunteers").hidden) {
      e.preventDefault();
      filterSearch.focus();
      filterSearch.select();
    }
  });

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  // ── 8. SORTING (client-side, current page) ─────────────────

  document.querySelectorAll(".portal-th-sort").forEach(th => {
    th.querySelector(".portal-sort-btn")?.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (sortKey === key) {
        sortDir = sortDir === "asc" ? "desc" : "asc";
      } else {
        sortKey = key;
        sortDir = "asc";
      }
      updateSortIndicators();
      renderRows();
    });
  });

  function updateSortIndicators() {
    document.querySelectorAll(".portal-th-sort").forEach(th => {
      const icon = th.querySelector("i");
      if (th.dataset.sort === sortKey) {
        th.setAttribute("aria-sort", sortDir === "asc" ? "ascending" : "descending");
        if (icon) icon.className = sortDir === "asc" ? "fas fa-sort-up" : "fas fa-sort-down";
      } else {
        th.setAttribute("aria-sort", "none");
        if (icon) icon.className = "fas fa-sort";
      }
    });
  }

  function sortRows(rows) {
    if (!sortKey) return rows;
    const dir = sortDir === "asc" ? 1 : -1;
    return rows.slice().sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      // Nulls always sort last regardless of direction — staff are
      // looking for populated values, not a block of dashes.
      const aNull = av === null || av === undefined || av === "";
      const bNull = bv === null || bv === undefined || bv === "";
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      if (sortKey === "verified") return (Number(av) - Number(bv)) * dir;
      if (sortKey === "created_at") return (String(av).localeCompare(String(bv))) * dir;
      return String(av).localeCompare(String(bv), undefined, { sensitivity: "base" }) * dir;
    });
  }

  // ── 9. PAGINATION ─────────────────────────────────────────

  pagPrev.addEventListener("click", () => {
    if (currentPage > 1) { currentPage--; fetchVolunteers(); }
  });

  pagNext.addEventListener("click", () => {
    if (currentPagination?.has_next) { currentPage++; fetchVolunteers(); }
  });

  retryBtn.addEventListener("click", () => fetchVolunteers());

  // ── 10. AUTHENTICATED FETCH ───────────────────────────────
  //  Retries transient failures (network drop, 5xx, 429) with
  //  backoff. Never retries a 401 — that is a real answer.

  async function authFetch(url, options = {}, { retries = 2 } = {}) {
    const opts = {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${session.token}`
      }
    };

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, opts);

        if (res.status === 401) {
          sessionStorage.removeItem(SESSION_KEY);
          window.location.replace(LOGIN_URL + "?reason=session_invalid");
          throw new Error("Session expired");
        }

        // Retry server-side hiccups and rate limits
        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          await sleep(backoffMs(attempt, res));
          continue;
        }
        return res;

      } catch (err) {
        lastErr = err;
        if (/Session expired/.test(err.message)) throw err;
        if (attempt < retries) {
          await sleep(backoffMs(attempt));
          continue;
        }
      }
    }
    throw lastErr || new Error("Request failed");
  }

  function backoffMs(attempt, res) {
    const retryAfter = res?.headers?.get?.("Retry-After");
    if (retryAfter) {
      const secs = parseInt(retryAfter, 10);
      if (secs > 0 && secs <= 30) return secs * 1000;
    }
    return 400 * Math.pow(2, attempt);   // 400ms, 800ms
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── 11. FETCH VOLUNTEERS ──────────────────────────────────

  async function fetchVolunteers() {
    showState("loading");

    if (!navigator.onLine) {
      errorMsgEl.textContent = "You appear to be offline. Reconnect and try again.";
      showState("error");
      return;
    }

    const params = new URLSearchParams({
      page:  String(currentPage),
      limit: String(pageLimit),
      ...activeFilters
    });

    try {
      const res = await authFetch(`${VOLUNTEERS_API}?${params}`);

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Server returned ${res.status}`);
      }

      const data = await res.json();
      renderVolunteers(data);

    } catch (err) {
      if (/Session expired/.test(err.message)) return;   // already redirecting
      console.error("Failed to fetch volunteers:", err);
      errorMsgEl.textContent = err.message || "An unexpected error occurred.";
      showState("error");
    }
  }

  // ── 12. RENDER ────────────────────────────────────────────

  function renderVolunteers(data) {
    const { volunteers, pagination, _viewed_by } = data;
    currentPagination = pagination;
    lastData     = volunteers || [];
    lastViewedBy = _viewed_by;

    if (!lastData.length) {
      showState("empty");
      recordSummary.textContent = "No records found.";
      statsEl.hidden  = true;
      exportBtn.hidden = true;
      return;
    }

    renderStats();

    // Pagination controls
    pagInfo.textContent = `Page ${pagination.page} of ${pagination.total_pages}`;
    pagPrev.disabled    = !pagination.has_prev;
    pagNext.disabled    = !pagination.has_next;

    renderRows();
  }

  /** Applies search + sort to the loaded page and paints the table. */
  function renderRows() {
    if (!lastData.length) return;

    let rows = lastData;

    if (searchTerm) {
      rows = rows.filter(v => searchBlob(v).includes(searchTerm));
    }
    rows = sortRows(rows);
    viewData = rows;

    const total = currentPagination?.total ?? lastData.length;

    // Summary line — states plainly what is on screen vs. what matched
    let summary = `Showing ${lastData.length.toLocaleString()} of ${total.toLocaleString()} matching record${total === 1 ? "" : "s"}`;
    if (searchTerm) summary += ` · ${rows.length} match “${filterSearch.value.trim()}” on this page`;
    if (sortKey)    summary += ` · sorted by ${sortLabel(sortKey)} (${sortDir === "asc" ? "A→Z" : "Z→A"}), this page only`;
    recordSummary.textContent = summary;

    exportBtn.hidden = false;
    if (exportPageCount) exportPageCount.textContent = `${lastData.length} record${lastData.length === 1 ? "" : "s"} on screen`;
    if (exportAllCount)  exportAllCount.textContent  = `${total.toLocaleString()} record${total === 1 ? "" : "s"} across all pages`;

    if (!rows.length) {
      showState("empty");
      emptyEl.querySelector("p").textContent =
        `No records on this page match “${filterSearch.value.trim()}”.`;
      return;
    }
    emptyEl.querySelector("p").textContent = "No volunteer records match the current filters.";

    tbody.innerHTML = "";

    for (const v of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="td-name">
          <span class="portal-cell-truncate" title="${esc(v.name)}">${val(v.name, true)}</span>
        </td>
        <td class="td-email">
          <span class="portal-cell-truncate" title="${esc(v.email)}">${val(v.email, true)}</span>
        </td>
        <td class="td-phone">${val(v.phone, true)}</td>
        <td class="td-zip">${val(v.zip, true)}</td>
        <td class="td-interests">${renderInterests(v.interests)}</td>
        <td>${esc(v.source_form || "—")}</td>
        <td>${renderStatus(v.verified)}</td>
        <td style="white-space:nowrap;font-size:0.8rem;color:var(--muted)">
          ${formatDate(v.created_at)}
        </td>
        <td class="portal-th-action">
          <button class="portal-view-btn" data-id="${esc(v.volunteer_id)}">
            View
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll(".portal-view-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const v  = rows.find(x => x.volunteer_id === id);
        if (v) openModal(v, lastViewedBy, btn);
      });
    });

    paginationEl.hidden = (currentPagination?.total_pages ?? 1) <= 1;
    showState("table");
  }

  function searchBlob(v) {
    return [
      v.name, v.email, v.phone, v.zip, v.source_form,
      (v.interests || []).join(" ")
    ].filter(Boolean).join(" ").toLowerCase();
  }

  function sortLabel(key) {
    return ({
      name: "name", email: "email", zip: "ZIP",
      source_form: "source", verified: "status", created_at: "date submitted"
    })[key] || key;
  }

  function renderStats() {
    const total    = currentPagination?.total ?? lastData.length;
    const verified = lastData.filter(v => Number(v.verified) === 1).length;
    const weekAgo  = Date.now() - 7 * 86400000;
    const recent   = lastData.filter(v => {
      const t = Date.parse(v.created_at);
      return !isNaN(t) && t >= weekAgo;
    }).length;

    statTotal.textContent    = total.toLocaleString();
    statVerified.textContent = verified.toLocaleString();
    statPending.textContent  = (lastData.length - verified).toLocaleString();
    statRecent.textContent   = recent.toLocaleString();
    statsEl.hidden = false;
  }

  // ── 13. MODAL ─────────────────────────────────────────────

  function openModal(v, viewedBy, returnFocusTo) {
    modalBody.innerHTML = [
      field("Volunteer ID", `<code style="font-size:0.78rem">${esc(v.volunteer_id)}</code>`),
      field("Name",        val(v.name)),
      field("Email",       v.email ? `<a href="mailto:${esc(v.email)}">${esc(v.email)}</a>` : nullVal()),
      field("Phone",       val(v.phone)),
      field("ZIP Code",    val(v.zip)),
      field("Interests",   v.interests?.length
              ? v.interests.map(i => `<span class="portal-interest-chip">${esc(i)}</span>`).join(" ")
              : nullVal()),
      field("Source Form", esc(v.source_form || "—")),
      field("Status",      renderStatus(v.verified)),
      field("Submitted",   esc(formatDate(v.created_at))),
      field("Updated",     esc(formatDate(v.updated_at))),
    ].join("");

    if (viewedBy) {
      modalWatermark.textContent =
        `Viewed by ${viewedBy.username} (${viewedBy.role}) · ${new Date(viewedBy.viewed_at).toLocaleString()}`;
    }

    modalReturnFocus = returnFocusTo || null;
    modalOverlay.hidden = false;
    document.body.style.overflow = "hidden";
    trapFocus(modalOverlay);
    modalClose.focus();
  }

  function closeModal() {
    modalOverlay.hidden = true;
    document.body.style.overflow = "";
    releaseFocus(modalOverlay);
    // Return focus to the row button that opened it, so keyboard
    // users aren't dumped back at the top of the document.
    if (modalReturnFocus && document.body.contains(modalReturnFocus)) {
      modalReturnFocus.focus();
    }
    modalReturnFocus = null;
  }

  modalClose.addEventListener("click", closeModal);

  modalOverlay.addEventListener("click", e => {
    if (e.target === modalOverlay) closeModal();
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !modalOverlay.hidden) closeModal();
  });

  // ── Shared focus trap (also used by the calendar modal) ────

  const trapHandlers = new WeakMap();

  function trapFocus(container) {
    const handler = e => {
      if (e.key !== "Tab") return;
      const focusables = container.querySelectorAll(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
      );
      const visible = Array.from(focusables).filter(el => el.offsetParent !== null || el === document.activeElement);
      if (!visible.length) return;
      const first = visible[0];
      const last  = visible[visible.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    };
    trapHandlers.set(container, handler);
    container.addEventListener("keydown", handler);
  }

  function releaseFocus(container) {
    const handler = trapHandlers.get(container);
    if (handler) {
      container.removeEventListener("keydown", handler);
      trapHandlers.delete(container);
    }
  }

  // ── 14. CSV EXPORT ────────────────────────────────────────

  const CSV_HEADERS = ["volunteer_id","name","email","phone","zip","interests","source_form","verified","created_at"];

  exportBtn.addEventListener("click", e => {
    e.stopPropagation();
    const open = exportMenu.hidden;
    closeAllMenus();
    exportMenu.hidden = !open;
    exportBtn.setAttribute("aria-expanded", String(open));
  });

  exportPageBtn?.addEventListener("click", () => {
    closeAllMenus();
    const rows = viewData.length ? viewData : lastData;
    if (!rows.length) return;
    downloadCsv(rows, `volunteers-page${currentPage}-${todayStamp()}.csv`);
    toast(`Exported ${rows.length} record${rows.length === 1 ? "" : "s"}.`);
  });

  exportAllBtn?.addEventListener("click", async () => {
    closeAllMenus();
    const total = currentPagination?.total ?? 0;
    if (!total) return;

    exportAllBtn.disabled = true;
    const t = toast(`Exporting 0 of ${total.toLocaleString()} records…`, "info", 0);

    try {
      const all = [];
      let page = 1;

      while (page <= MAX_EXPORT_PAGES) {
        const params = new URLSearchParams({
          page: String(page), limit: String(EXPORT_PAGE_SIZE), ...activeFilters
        });
        const res = await authFetch(`${VOLUNTEERS_API}?${params}`);
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const data = await res.json();

        all.push(...(data.volunteers || []));
        t.update(`Exporting ${all.length.toLocaleString()} of ${total.toLocaleString()} records…`);

        if (!data.pagination?.has_next) break;
        page++;
      }

      if (!all.length) throw new Error("No records returned");

      downloadCsv(all, `volunteers-all-${todayStamp()}.csv`);
      t.close();
      toast(`Exported ${all.length.toLocaleString()} records.`);

    } catch (err) {
      t.close();
      if (!/Session expired/.test(err.message)) {
        console.error("Export failed:", err);
        toast(`Export failed: ${err.message}`, "error", 8000);
      }
    } finally {
      exportAllBtn.disabled = false;
    }
  });

  function downloadCsv(records, filename) {
    const rows = records.map(v => [
      v.volunteer_id,
      v.name         ?? "",
      v.email        ?? "",
      v.phone        ?? "",
      v.zip          ?? "",
      (v.interests   || []).join("; "),
      v.source_form  ?? "",
      v.verified ? "verified" : "unverified",
      v.created_at   ?? ""
    ].map(csvEscape).join(","));

    const csv  = [CSV_HEADERS.join(","), ...rows].join("\r\n");
    // BOM so Excel opens UTF-8 names correctly instead of mangling accents
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function todayStamp() {
    return new Date().toISOString().slice(0, 10);
  }

  // ── 15. TOASTS ────────────────────────────────────────────

  /**
   * Show a toast. Returns a handle with update()/close() so
   * long-running jobs can report progress in place.
   * duration = 0 keeps it open until closed explicitly.
   */
  function toast(message, kind = "info", duration = 5000) {
    if (!toastHost) return { update() {}, close() {} };

    const el = document.createElement("div");
    el.className = `portal-toast is-${kind}`;
    const icon = kind === "error" ? "fa-circle-exclamation"
               : kind === "warn"  ? "fa-triangle-exclamation"
               : "fa-circle-info";
    el.innerHTML = `
      <i class="fas ${icon}" aria-hidden="true"></i>
      <span class="portal-toast-msg"></span>
      <button class="portal-toast-close" aria-label="Dismiss">
        <i class="fas fa-xmark" aria-hidden="true"></i>
      </button>`;
    el.querySelector(".portal-toast-msg").textContent = message;

    const close = () => el.remove();
    el.querySelector(".portal-toast-close").addEventListener("click", close);
    toastHost.appendChild(el);

    let timer = duration > 0 ? setTimeout(close, duration) : null;

    return {
      update(msg) { el.querySelector(".portal-toast-msg").textContent = msg; },
      close() { if (timer) clearTimeout(timer); close(); }
    };
  }

  // Connection status — staff on venue wifi lose it constantly
  window.addEventListener("offline", () => toast("Connection lost. Changes won't save until you're back online.", "warn", 0));
  window.addEventListener("online",  () => toast("Back online."));

  // ── HELPERS ───────────────────────────────────────────────

  function showState(state) {
    loadingEl.hidden    = state !== "loading";
    errorEl.hidden      = state !== "error";
    emptyEl.hidden      = state !== "empty";
    tableWrap.hidden    = state !== "table";
    paginationEl.hidden = state !== "table";
    if (state !== "table") exportBtn.hidden = true;
    if (state === "loading" || state === "error") statsEl.hidden = true;
  }

  function esc(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Escape, then wrap search matches in <mark>. Escaping happens
   *  first so the highlight can never inject markup. */
  function highlight(str) {
    const safe = esc(str);
    if (!searchTerm) return safe;
    const re = new RegExp(`(${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    return safe.replace(re, '<mark class="portal-mark">$1</mark>');
  }

  function val(v, doHighlight) {
    if (v === null || v === undefined) return nullVal();
    if (v === "[decryption error]") return `<span class="portal-decrypt-err">⚠ decrypt error</span>`;
    return `<span>${doHighlight ? highlight(v) : esc(v)}</span>`;
  }

  function nullVal() {
    return `<span class="portal-null">—</span>`;
  }

  function renderStatus(verified) {
    return verified
      ? `<span class="portal-badge-verified verified"><i class="fas fa-circle-check" aria-hidden="true"></i> Verified</span>`
      : `<span class="portal-badge-verified unverified"><i class="fas fa-circle" aria-hidden="true"></i> Pending</span>`;
  }

  function renderInterests(interests) {
    if (!interests?.length) return nullVal();
    return `<div class="portal-interests">${
      interests.map(i => `<span class="portal-interest-chip">${esc(i)}</span>`).join("")
    }</div>`;
  }

  function formatDate(iso) {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric"
      });
    } catch { return iso; }
  }

  function field(label, valueHtml) {
    return `
      <div class="modal-field">
        <span class="modal-field-label">${label}</span>
        <span class="modal-field-value">${valueHtml}</span>
      </div>`;
  }

  function csvEscape(value) {
    const str = String(value);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  // ── SHARED API for portal-calendar.js ─────────────────────

  window.PortalCore = {
    session,
    authFetch,
    toast,
    esc,
    trapFocus,
    releaseFocus,
    closeAllMenus,
    isTypingTarget
  };

})();
