/* =========================================
   scripts/money-tracker.js
   Hybrid OpenFEC Money Tracker
   - Primary candidate selection
   - Compare button toggles "pick opponent" mode
   - Two cards side-by-side with Chart.js breakdown per candidate
   - Optional "By PAC" drilldown per candidate card
   - IndexedDB caching to reduce API calls

   FIXES:
   - If Chart.js fails to load, totals still render (chart errors isolated)
   - Optional auto-load Chart.js if missing
   - Better "no totals yet" handling
========================================= */

/* ---------- CONFIG ---------- */
const CONFIG = {
  API_KEY: "DEMO_KEY", // <-- put your OpenFEC key here
  API_BASE: "https://api.open.fec.gov/v1",

  // Chart.js CDN fallback (used only if Chart isn't found)
  CHARTJS_CDN: "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.0/chart.min.js",

  // caching
  CACHE_TTL_SEARCH_MS: 1000 * 60 * 10,
  CACHE_TTL_TOTALS_MS: 1000 * 60 * 60 * 12,
  CACHE_TTL_COMM_MS:   1000 * 60 * 60 * 24,
  CACHE_TTL_PAC_MS:    1000 * 60 * 60 * 24,

  // list
  PER_PAGE: 20,

  // Schedule A PAC breakdown limits
  SCHED_A_PER_PAGE: 100,
  SCHED_A_MAX_PAGES: 15,

  // PAC UI paging
  PAC_TOP_DEFAULT: 10,
  PAC_TOP_STEP: 10,

  // images
  IMG_BASE: "assets/images/candidates",
  IMG_FALLBACK: "assets/images/candidates/placeholder.jpg",
};

// Totals endpoint strategy:
// - "candidate_id_path" uses /candidate/{candidate_id}/totals/?cycle=YYYY
// - "candidates_totals_query" uses /candidates/totals/?candidate_id=...&cycle=YYYY
const TOTALS_MODE = "candidate_id_path";

/* ---------- DOM ---------- */
const els = {
  cycle: document.getElementById("cycle"),
  office: document.getElementById("office"),
  search: document.getElementById("search"),
  refresh: document.getElementById("refresh"),

  panelHint: document.getElementById("panelHint"),
  status: document.getElementById("status"),
  candidateList: document.getElementById("candidateList"),

  compareToggle: document.getElementById("compareToggle"),
  clearCompare: document.getElementById("clearCompare"),

  compareEmpty: document.getElementById("compareEmpty"),
  emptyText: document.getElementById("emptyText"),
  compareCards: document.getElementById("compareCards"),

  compareTableWrap: document.getElementById("compareTableWrap"),
  compareThead: document.getElementById("compareThead"),
  compareTbody: document.getElementById("compareTbody"),
};

/* ---------- STATE ---------- */
let lastSearchAbort = null;

let primary = null;
let secondary = null;
let compareMode = false;

let lastSearchResults = [];

const pacUiState = new Map(); // candidate_id -> { shown }
const charts = new Map();     // candidate_id -> Chart instance

/* ---------- UTILS ---------- */
function setStatus(msg) {
  if (els.status) els.status.textContent = msg || "";
}

function setHint(msg) {
  if (els.panelHint) els.panelHint.textContent = msg || "";
}

function setEmptyText(msg) {
  if (els.emptyText) els.emptyText.textContent = msg || "";
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(n) {
  const v = Number(n || 0);
  return v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function getCycle() {
  return els.cycle?.value || "2026";
}

function getOffice() {
  return els.office?.value || "";
}

function getSearch() {
  return els.search?.value || "";
}

function officeLabel(office) {
  if (!office) return "Unknown";
  const o = String(office).toLowerCase();
  if (o === "h" || o === "house") return "House";
  if (o === "s" || o === "senate") return "Senate";
  if (o === "p" || o === "president") return "President";
  return office;
}

function officeQueryValue(uiOffice) {
  if (!uiOffice) return "";
  if (uiOffice === "house") return "H";
  if (uiOffice === "senate") return "S";
  if (uiOffice === "president") return "P";
  return "";
}

function candidateImageUrl(candidateId) {
  return `${CONFIG.IMG_BASE}/${candidateId}.jpg`;
}

/* ---------- CHART.JS SAFETY / AUTO-LOADER ---------- */
function hasChartJs() {
  return typeof window.Chart !== "undefined";
}

function loadChartJsIfMissing() {
  return new Promise((resolve) => {
    if (hasChartJs()) return resolve(true);

    // Attempt to load Chart.js dynamically (in case CDN failed earlier)
    const s = document.createElement("script");
    s.src = CONFIG.CHARTJS_CDN;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

/* ---------- INDEXEDDB CACHE ---------- */
const DB = {
  name: "money_tracker_cache_v6",
  store: "kv",
  dbp: null,

  async open() {
    if (this.dbp) return this.dbp;
    this.dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(this.store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbp;
  },

  async get(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store, "readonly");
      const req = tx.objectStore(this.store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async set(key, value) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store, "readwrite");
      const req = tx.objectStore(this.store).put(value, key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  },

  async del(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store, "readwrite");
      const req = tx.objectStore(this.store).delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }
};

async function cachedFetchJson(cacheKey, ttlMs, fetcher) {
  const now = Date.now();
  const cached = await DB.get(cacheKey);
  if (cached && cached.savedAt && (now - cached.savedAt) < ttlMs) {
    return { data: cached.data, fromCache: true };
  }
  const data = await fetcher();
  await DB.set(cacheKey, { savedAt: now, data });
  return { data, fromCache: false };
}

/* ---------- FETCH HELPERS ---------- */
function urlWithKey(path, params = {}) {
  const url = new URL(CONFIG.API_BASE + path);
  url.searchParams.set("api_key", CONFIG.API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function fetchJson(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}\n${text}`);
  }
  return res.json();
}

/* ---------- OPENFEC: SEARCH ---------- */
async function searchCandidates({ q, office, cycle, signal }) {
  const officeCode = officeQueryValue(office);
  const url = urlWithKey("/candidates/search/", {
    name: q,
    office: officeCode,
    election_year: cycle,
    per_page: CONFIG.PER_PAGE
  });

  const cacheKey = `cand_search:${cycle}:${office || "all"}:${(q || "").toLowerCase()}`;
  return cachedFetchJson(cacheKey, CONFIG.CACHE_TTL_SEARCH_MS, async () => fetchJson(url, signal));
}

/* ---------- OPENFEC: TOTALS ---------- */
function totalsUrlCandidatePath(candidateId, cycle) {
  return urlWithKey(`/candidate/${candidateId}/totals/`, { cycle });
}
function totalsUrlQuery(candidateId, cycle) {
  return urlWithKey(`/candidates/totals/`, { candidate_id: candidateId, cycle });
}

// Best-effort totals: try primary mode endpoint, fall back to the other
async function getCandidateTotalsBestEffort(candidateId, cycle) {
  const cacheKey = `totals:${cycle}:${candidateId}:${TOTALS_MODE}`;
  return cachedFetchJson(cacheKey, CONFIG.CACHE_TTL_TOTALS_MS, async () => {
    try {
      const url = (TOTALS_MODE === "candidate_id_path")
        ? totalsUrlCandidatePath(candidateId, cycle)
        : totalsUrlQuery(candidateId, cycle);
      const json = await fetchJson(url);
      if (Array.isArray(json?.results) && json.results.length) return json;

      // fallback
      const fallbackUrl = (TOTALS_MODE === "candidate_id_path")
        ? totalsUrlQuery(candidateId, cycle)
        : totalsUrlCandidatePath(candidateId, cycle);
      return fetchJson(fallbackUrl);
    } catch (e) {
      // fallback if primary failed
      const fallbackUrl = (TOTALS_MODE === "candidate_id_path")
        ? totalsUrlQuery(candidateId, cycle)
        : totalsUrlCandidatePath(candidateId, cycle);
      return fetchJson(fallbackUrl);
    }
  });
}

function pickBestTotalsRow(apiJson) {
  const results = Array.isArray(apiJson?.results) ? apiJson.results : [];
  if (!results.length) return null;

  return [...results].sort((a, b) => {
    const da = Date.parse(a.coverage_end_date || "") || 0;
    const db = Date.parse(b.coverage_end_date || "") || 0;
    return db - da;
  })[0];
}

function normalizedBreakdown(t) {
  const individuals = Number(t.individual_contributions ?? t.individual_itemized_contributions ?? 0);
  const pacs = Number(t.pac_contributions ?? t.other_political_committee_contributions ?? 0);
  const selfFunding = Number(t.candidate_contribution ?? t.candidate_loans ?? 0);
  const transfers = Number(t.transfers_from_affiliates ?? t.transfers_from_other_authorized_committee ?? 0);

  const refundsRaw = Number(t.refunds ?? t.refunded_individual_contributions ?? 0);
  const refundsOut = refundsRaw ? Math.abs(refundsRaw) : 0;

  const receipts = Number(t.receipts ?? t.total_receipts ?? 0);
  const known = individuals + pacs + selfFunding + transfers;
  const other = receipts > 0 ? Math.max(0, receipts - known) : 0;

  return {
    receipts,
    cashOnHand: Number(t.cash_on_hand_end_period ?? t.cash_on_hand ?? 0),
    buckets: [
      { label: "Individuals", value: individuals },
      { label: "PACs / Committees", value: pacs },
      { label: "Self funding", value: selfFunding },
      { label: "Transfers", value: transfers },
      ...(refundsOut ? [{ label: "Refunds out", value: refundsOut }] : []),
      ...(other ? [{ label: "Other", value: other }] : [])
    ].filter(x => Number(x.value || 0) > 0)
  };
}

/* ---------- OPENFEC: COMMITTEES + PACS ---------- */
async function getCandidateCommittees(candidateId, cycle) {
  const url = urlWithKey(`/candidate/${candidateId}/committees/`, {
    cycle,
    designation: "P",
    per_page: 100
  });
  const cacheKey = `cand_committees:${cycle}:${candidateId}`;
  return cachedFetchJson(cacheKey, CONFIG.CACHE_TTL_COMM_MS, async () => fetchJson(url));
}

function buildScheduleAUrl({ committeeIds, cycle, paging }) {
  const url = new URL(CONFIG.API_BASE + "/schedules/schedule_a/");
  url.searchParams.set("api_key", CONFIG.API_KEY);
  url.searchParams.set("two_year_transaction_period", String(cycle));
  url.searchParams.set("contributor_type", "committee");
  url.searchParams.set("sort", "-contribution_receipt_date");
  url.searchParams.set("per_page", String(CONFIG.SCHED_A_PER_PAGE));
  committeeIds.forEach(id => url.searchParams.append("committee_id", id));

  if (paging?.last_index) url.searchParams.set("last_index", paging.last_index);
  if (paging?.last_contribution_receipt_date) url.searchParams.set("last_contribution_receipt_date", paging.last_contribution_receipt_date);
  if (paging?.sort_null_only) url.searchParams.set("sort_null_only", "true");

  return url.toString();
}

async function getPacBreakdownForCommittees({ committeeIds, cycle }) {
  const agg = new Map();
  let paging = { last_index: null, last_contribution_receipt_date: null, sort_null_only: null };

  for (let page = 0; page < CONFIG.SCHED_A_MAX_PAGES; page++) {
    const json = await fetchJson(buildScheduleAUrl({ committeeIds, cycle, paging }));
    const rows = Array.isArray(json?.results) ? json.results : [];
    if (!rows.length) break;

    for (const r of rows) {
      const donorId = r.contributor_id || r.contributor_committee_id || null;
      const donorName = r.contributor_name || r.contributor_committee_name || "Unknown committee";
      const amt = Number(r.contribution_receipt_amount || 0);
      if (!donorId || !amt) continue;

      const cur = agg.get(donorId) || { donorId, donorName, total: 0 };
      cur.total += amt;
      if (donorName && donorName.length > (cur.donorName || "").length) cur.donorName = donorName;
      agg.set(donorId, cur);
    }

    const li = json?.pagination?.last_indexes || {};
    paging.last_index = li.last_index || null;
    paging.last_contribution_receipt_date = li.last_contribution_receipt_date || null;
    paging.sort_null_only = li.sort_null_only ? true : null;

    if (!paging.last_index) break;
  }

  return [...agg.values()].sort((a, b) => b.total - a.total);
}

async function getPacBreakdown(candidateId, cycle) {
  const cacheKey = `pac_breakdown:${cycle}:${candidateId}`;
  return cachedFetchJson(cacheKey, CONFIG.CACHE_TTL_PAC_MS, async () => {
    const { data: committeesJson } = await getCandidateCommittees(candidateId, cycle);
    const committees = Array.isArray(committeesJson?.results) ? committeesJson.results : [];
    const committeeIds = committees.map(c => c.committee_id).filter(Boolean);
    if (!committeeIds.length) return { committeeIds: [], pacs: [] };

    const pacs = await getPacBreakdownForCommittees({ committeeIds, cycle });
    return { committeeIds, pacs };
  });
}

/* ---------- RENDER: CANDIDATE LIST ---------- */
function renderCandidateList(results) {
  lastSearchResults = results || [];
  if (!els.candidateList) return;
  els.candidateList.innerHTML = "";

  lastSearchResults.forEach((c) => {
    const li = document.createElement("li");
    li.className = "candidateRow";

    if (primary && c.candidate_id === primary.candidate_id) li.classList.add("isPrimary");
    if (secondary && c.candidate_id === secondary.candidate_id) li.classList.add("isSecondary");

    const img = document.createElement("img");
    img.src = candidateImageUrl(c.candidate_id);
    img.alt = `${c.name || "Candidate"} photo`;
    img.loading = "lazy";
    img.onerror = () => { img.src = CONFIG.IMG_FALLBACK; };

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.appendChild(img);

    const meta = document.createElement("div");
    meta.className = "candMeta";
    meta.innerHTML = `
      <div class="name">${escapeHtml(c.name || "Unknown")}</div>
      <div class="sub">
        ${officeLabel(c.office)} • ${escapeHtml(c.party_full || c.party || "—")}
        ${c.state ? ` • ${escapeHtml(c.state)}` : ""}${c.district ? `-${escapeHtml(String(c.district))}` : ""}
      </div>
    `;

    const btn = document.createElement("button");
    btn.className = "addBtn";
    btn.type = "button";

    const isPrimary = primary && c.candidate_id === primary.candidate_id;
    const isSecondary = secondary && c.candidate_id === secondary.candidate_id;

    if (!primary || (!compareMode && !secondary)) {
      btn.textContent = isPrimary ? "Selected" : "Select";
      btn.disabled = isPrimary;
    } else if (compareMode) {
      btn.textContent = isSecondary ? "Opponent" : (isPrimary ? "Primary" : "Pick Opponent");
      btn.disabled = isPrimary || isSecondary;
    } else {
      btn.textContent = isPrimary ? "Selected" : "Select";
      btn.disabled = isPrimary;
    }

    btn.addEventListener("click", () => onCandidatePick(c));

    li.appendChild(avatar);
    li.appendChild(meta);
    li.appendChild(btn);

    els.candidateList.appendChild(li);
  });
}

function onCandidatePick(c) {
  const cand = {
    candidate_id: c.candidate_id,
    name: c.name,
    office: c.office,
    party: c.party_full || c.party,
    state: c.state,
    district: c.district
  };

  if (!primary) {
    primary = cand;
    secondary = null;
    compareMode = false;
    updateCompareButton();
    updateHints();
    renderCompareArea();
    renderCandidateList(lastSearchResults);
    return;
  }

  if (compareMode) {
    if (cand.candidate_id === primary.candidate_id) return;
    secondary = cand;
    compareMode = false;
    updateCompareButton();
    updateHints();
    renderCompareArea();
    renderCandidateList(lastSearchResults);
    return;
  }

  if (cand.candidate_id !== primary.candidate_id) {
    primary = cand;
    secondary = null;
    compareMode = false;
    updateCompareButton();
    updateHints();
    renderCompareArea();
    renderCandidateList(lastSearchResults);
  }
}

/* ---------- COMPARE BUTTON + HINTS ---------- */
function updateCompareButton() {
  if (!els.compareToggle) return;

  if (!primary) {
    els.compareToggle.textContent = "Compare";
    els.compareToggle.disabled = true;
    return;
  }

  els.compareToggle.disabled = false;
  els.compareToggle.textContent = compareMode ? "Cancel" : "Compare";
}

function updateHints() {
  if (!primary) {
    setHint("Select a candidate to view totals. Click Compare to pick an opponent.");
    setEmptyText("Select a candidate to begin. Then click Compare to select an opponent.");
    return;
  }

  if (primary && !secondary && !compareMode) {
    setHint("Primary selected. Click Compare to select an opponent.");
    setEmptyText("Primary selected. Click Compare to select an opponent.");
    return;
  }

  if (compareMode) {
    setHint("Compare mode: select an opponent from the list.");
    setEmptyText("Compare mode: select an opponent from the list.");
    return;
  }

  if (primary && secondary) {
    setHint("Two candidates selected. Use Clear to start over.");
    setEmptyText("");
  }
}

/* ---------- RENDER: COMPARE AREA ---------- */
function renderCompareArea() {
  const hasAny = Boolean(primary || secondary);

  if (els.compareEmpty && els.compareCards) {
    if (!hasAny) els.compareEmpty.classList.remove("hidden");
    else els.compareEmpty.classList.add("hidden");
  }

  if (els.compareTableWrap) {
    if (primary && secondary) els.compareTableWrap.classList.remove("hidden");
    else els.compareTableWrap.classList.add("hidden");
  }

  if (els.compareCards) els.compareCards.innerHTML = "";
  cleanupChartsNotInSelection();

  if (primary) els.compareCards.appendChild(buildCandidateCard(primary, "Primary"));
  if (secondary) els.compareCards.appendChild(buildCandidateCard(secondary, "Opponent"));

  if (primary) loadCardData(primary.candidate_id);
  if (secondary) loadCardData(secondary.candidate_id);

  if (primary && secondary) renderCompareTable();
  else {
    if (els.compareThead) els.compareThead.innerHTML = "";
    if (els.compareTbody) els.compareTbody.innerHTML = "";
  }

  bindPacToggles();
}

/* ---------- BUILD CARD ---------- */
function buildCandidateCard(c, roleLabel) {
  const card = document.createElement("article");
  card.className = "card";

  const top = document.createElement("div");
  top.className = "card__top";

  const img = document.createElement("img");
  img.src = candidateImageUrl(c.candidate_id);
  img.alt = `${c.name || "Candidate"} photo`;
  img.loading = "lazy";
  img.onerror = () => { img.src = CONFIG.IMG_FALLBACK; };

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.appendChild(img);

  const title = document.createElement("div");
  title.innerHTML = `
    <div class="title">${escapeHtml(c.name || "Candidate")}</div>
    <div class="subtitle">${escapeHtml(roleLabel)} • ${officeLabel(c.office)} • ${escapeHtml(c.party || "—")}</div>
  `;

  const topRight = document.createElement("div");
  topRight.className = "card__topRight";

  const toggle = document.createElement("label");
  toggle.className = "toggle";
  toggle.innerHTML = `
    <input type="checkbox" class="pacToggle" data-candidate-id="${escapeHtml(c.candidate_id)}">
    <span>By PAC</span>
  `;

  const remove = document.createElement("button");
  remove.className = "removeBtn";
  remove.type = "button";
  remove.textContent = "✕";
  remove.title = "Remove";
  remove.addEventListener("click", () => {
    if (primary && c.candidate_id === primary.candidate_id) {
      clearAll();
    } else if (secondary && c.candidate_id === secondary.candidate_id) {
      secondary = null;
      compareMode = false;
      updateCompareButton();
      updateHints();
      renderCompareArea();
      renderCandidateList(lastSearchResults);
    }
  });

  topRight.appendChild(toggle);
  topRight.appendChild(remove);

  top.appendChild(avatar);
  top.appendChild(title);
  top.appendChild(topRight);

  const body = document.createElement("div");
  body.className = "card__body";
  body.innerHTML = `
    <div class="kpis">
      <div class="kpi">
        <div class="label">Candidate ID</div>
        <div class="value">${escapeHtml(c.candidate_id)}</div>
      </div>
      <div class="kpi">
        <div class="label">Cycle</div>
        <div class="value">${escapeHtml(getCycle())}</div>
      </div>
    </div>

    <div class="chartBox">
      <canvas id="chart_${escapeHtml(c.candidate_id)}" aria-label="Contribution breakdown chart"></canvas>
      <div class="muted small" id="chartMsg_${escapeHtml(c.candidate_id)}" style="margin-top:.35rem;"></div>
    </div>

    <div class="breakdown" id="bd_${escapeHtml(c.candidate_id)}">
      <div class="row"><span class="muted">Loading totals…</span><span></span></div>
    </div>

    <div class="pacPanel hidden" id="pacPanel_${escapeHtml(c.candidate_id)}"></div>
  `;

  card.appendChild(top);
  card.appendChild(body);
  return card;
}

/* ---------- LOAD TOTALS + RENDER ---------- */
async function loadCardData(candidateId) {
  const bd = document.getElementById(`bd_${candidateId}`);
  const canvas = document.getElementById(`chart_${candidateId}`);
  const chartMsg = document.getElementById(`chartMsg_${candidateId}`);
  if (!bd || !canvas) return;

  // 1) Totals FIRST (chart errors must not stop totals)
  let norm = null;

  try {
    const cycle = getCycle();
    const { data, fromCache } = await getCandidateTotalsBestEffort(candidateId, cycle);
    const row = pickBestTotalsRow(data);

    if (!row) {
      bd.innerHTML = `
        <div class="row"><strong>Receipts</strong><strong>${money(0)}</strong></div>
        <div class="row"><span class="muted">No filings found for this cycle yet.</span><span class="muted small">—</span></div>
      `;
      destroyChart(candidateId);
      if (chartMsg) chartMsg.textContent = "No chart (no totals filed yet).";
      return;
    }

    norm = normalizedBreakdown(row);
    const stamp = fromCache ? "cached" : "live";

    bd.innerHTML = `
      <div class="row"><strong>Receipts</strong><strong>${money(norm.receipts)}</strong></div>
      <div class="row"><span class="muted">Cash on hand</span><span>${money(norm.cashOnHand)}</span></div>
      ${norm.buckets.map(x => `
        <div class="row">
          <span class="muted">${escapeHtml(x.label)}</span>
          <span>${money(x.value)}</span>
        </div>
      `).join("")}
      <div class="row"><span class="muted small">Totals source</span><span class="muted small">${stamp}</span></div>
    `;
  } catch (err) {
    bd.innerHTML = `
      <div class="row"><span class="muted">Totals error</span><span class="muted small">${escapeHtml(err.message)}</span></div>
    `;
    destroyChart(candidateId);
    if (chartMsg) chartMsg.textContent = "Chart unavailable (totals failed).";
    return;
  }

  // 2) Chart SECOND (isolated)
  try {
    if (!hasChartJs()) {
      const ok = await loadChartJsIfMissing();
      if (!ok || !hasChartJs()) {
        destroyChart(candidateId);
        if (chartMsg) chartMsg.textContent = "Chart.js failed to load (CDN blocked/offline).";
        return;
      }
    }

    if (!norm || !norm.buckets.length) {
      destroyChart(candidateId);
      if (chartMsg) chartMsg.textContent = "No chart (no breakdown buckets).";
      return;
    }

    if (chartMsg) chartMsg.textContent = "";
    renderBreakdownChart(candidateId, canvas, norm.buckets);

  } catch (err) {
    // IMPORTANT: do NOT affect totals
    console.warn("Chart render error:", err);
    destroyChart(candidateId);
    if (chartMsg) chartMsg.textContent = "Chart error (see console).";
  }
}

function renderBreakdownChart(candidateId, canvasEl, buckets) {
  const ctx = canvasEl.getContext("2d");
  if (!ctx) return;

  destroyChart(candidateId);

  const labels = buckets.map(b => b.label);
  const values = buckets.map(b => Number(b.value || 0));
  if (!labels.length || values.reduce((a, b) => a + b, 0) <= 0) return;

  // Small palette for readability
  const backgroundColor = [
    "rgba(0, 168, 75, 0.35)",
    "rgba(255, 215, 0, 0.35)",
    "rgba(0, 128, 55, 0.35)",
    "rgba(17, 17, 17, 0.18)",
    "rgba(110, 110, 110, 0.22)",
    "rgba(0, 168, 75, 0.18)",
  ];
  const borderColor = [
    "rgba(0, 168, 75, 0.7)",
    "rgba(255, 215, 0, 0.7)",
    "rgba(0, 128, 55, 0.7)",
    "rgba(17, 17, 17, 0.35)",
    "rgba(110, 110, 110, 0.35)",
    "rgba(0, 168, 75, 0.35)",
  ];

  const chart = new window.Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: labels.map((_, i) => backgroundColor[i % backgroundColor.length]),
        borderColor: labels.map((_, i) => borderColor[i % borderColor.length]),
        borderWidth: 1,
        hoverOffset: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: "bottom" },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.label || ""}: ${money(ctx.parsed || 0)}`
          }
        }
      }
    }
  });

  charts.set(candidateId, chart);
}

function destroyChart(candidateId) {
  const ch = charts.get(candidateId);
  if (ch) {
    ch.destroy();
    charts.delete(candidateId);
  }
}

function cleanupChartsNotInSelection() {
  const keep = new Set();
  if (primary) keep.add(primary.candidate_id);
  if (secondary) keep.add(secondary.candidate_id);

  for (const [cid] of charts.entries()) {
    if (!keep.has(cid)) destroyChart(cid);
  }
}

/* ---------- COMPARE TABLE ---------- */
async function renderCompareTable() {
  if (!els.compareThead || !els.compareTbody) return;
  if (!primary || !secondary) return;

  const cycle = getCycle();
  const ids = [primary.candidate_id, secondary.candidate_id];
  const names = [primary.name || ids[0], secondary.name || ids[1]];

  const totalsById = {};
  for (const id of ids) {
    try {
      const { data } = await getCandidateTotalsBestEffort(id, cycle);
      totalsById[id] = pickBestTotalsRow(data) || {};
    } catch {
      totalsById[id] = {};
    }
  }

  const metrics = [
    { label: "Receipts", get: (t) => t.receipts ?? t.total_receipts ?? 0 },
    { label: "Individuals", get: (t) => t.individual_contributions ?? t.individual_itemized_contributions ?? 0 },
    { label: "PACs / Committees", get: (t) => t.pac_contributions ?? t.other_political_committee_contributions ?? 0 },
    { label: "Self funding", get: (t) => t.candidate_contribution ?? t.candidate_loans ?? 0 },
    { label: "Transfers", get: (t) => t.transfers_from_affiliates ?? t.transfers_from_other_authorized_committee ?? 0 },
    { label: "Cash on hand", get: (t) => t.cash_on_hand_end_period ?? t.cash_on_hand ?? 0 },
  ];

  els.compareThead.innerHTML = `
    <tr>
      <th>Metric</th>
      <th>${escapeHtml(names[0])}</th>
      <th>${escapeHtml(names[1])}</th>
    </tr>
  `;

  els.compareTbody.innerHTML = metrics.map(m => {
    const a = money(m.get(totalsById[ids[0]] || {}));
    const b = money(m.get(totalsById[ids[1]] || {}));
    return `<tr><td><strong>${escapeHtml(m.label)}</strong></td><td>${a}</td><td>${b}</td></tr>`;
  }).join("");
}

/* ---------- PAC TOGGLE ---------- */
function bindPacToggles() {
  document.querySelectorAll(".pacToggle").forEach(cb => {
    cb.addEventListener("change", (e) => {
      const candidateId = e.target.dataset.candidateId;
      onPacToggle(candidateId, e.target.checked);
    });
  });
}

async function onPacToggle(candidateId, checked) {
  const panel = document.getElementById(`pacPanel_${candidateId}`);
  if (!panel) return;

  if (!checked) {
    panel.classList.add("hidden");
    panel.innerHTML = "";
    return;
  }

  panel.classList.remove("hidden");
  panel.innerHTML = `<div class="muted small">Loading PAC breakdown…</div>`;

  if (!pacUiState.has(candidateId)) pacUiState.set(candidateId, { shown: CONFIG.PAC_TOP_DEFAULT });

  try {
    const { data, fromCache } = await getPacBreakdown(candidateId, getCycle());
    renderPacPanel(candidateId, panel, data.pacs || [], fromCache);
  } catch (e) {
    panel.innerHTML = `<div class="muted small">PAC breakdown error: ${escapeHtml(e.message)}</div>`;
  }
}

function renderPacPanel(candidateId, panelEl, pacs, fromCache) {
  const st = pacUiState.get(candidateId) || { shown: CONFIG.PAC_TOP_DEFAULT };
  const shown = Math.min(st.shown, pacs.length);
  const slice = pacs.slice(0, shown);
  const hasMore = pacs.length > shown;

  panelEl.innerHTML = `
    <div class="pacHeader">
      <strong>By PAC / Committee (Top ${shown}${hasMore ? "+" : ""})</strong>
      <span class="muted small">${fromCache ? "cached" : "live"}</span>
    </div>

    ${slice.length ? `
      <ol class="pacList">
        ${slice.map(x => `
          <li class="pacRow">
            <span class="pacName" title="${escapeHtml(x.donorName)}">${escapeHtml(x.donorName)}</span>
            <span class="pacAmt">${money(x.total)}</span>
          </li>
        `).join("")}
      </ol>
    ` : `<div class="muted small">No committee-origin receipts found within the fetch limits.</div>`}

    <div class="pacActions">
      ${hasMore ? `<button class="pacBtn" type="button" data-action="more" data-candidate-id="${escapeHtml(candidateId)}">Load more</button>` : ""}
      ${pacs.length ? `<button class="pacBtn" type="button" data-action="top" data-candidate-id="${escapeHtml(candidateId)}">Top 10</button>` : ""}
    </div>
  `;

  panelEl.querySelectorAll(".pacBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      const cid = btn.dataset.candidateId;
      const cur = pacUiState.get(cid) || { shown: CONFIG.PAC_TOP_DEFAULT };

      if (action === "more") cur.shown += CONFIG.PAC_TOP_STEP;
      if (action === "top") cur.shown = CONFIG.PAC_TOP_DEFAULT;

      pacUiState.set(cid, cur);
      renderPacPanel(cid, panelEl, pacs, true);
    });
  });
}

/* ---------- SEARCH + CONTROLS ---------- */
async function runSearch() {
  const q = getSearch().trim();

  if (lastSearchAbort) lastSearchAbort.abort();
  lastSearchAbort = new AbortController();

  if (q.length < 2) {
    setStatus("Type at least 2 characters to search.");
    if (els.candidateList) els.candidateList.innerHTML = "";
    return;
  }

  try {
    setStatus("Searching…");
    const { data, fromCache } = await searchCandidates({
      q,
      office: getOffice(),
      cycle: getCycle(),
      signal: lastSearchAbort.signal
    });

    const results = Array.isArray(data?.results) ? data.results : [];
    setStatus(`${results.length} result(s) • ${fromCache ? "cached" : "live"}`);
    renderCandidateList(results);

  } catch (err) {
    if (String(err?.name) === "AbortError") return;
    setStatus(`Search error: ${err.message}`);
  }
}

async function hardRefreshCache() {
  const cycle = getCycle();
  setStatus("Refreshing cached data…");

  const ids = new Set();
  if (primary) ids.add(primary.candidate_id);
  if (secondary) ids.add(secondary.candidate_id);

  for (const id of ids) {
    await DB.del(`totals:${cycle}:${id}:${TOTALS_MODE}`);
    await DB.del(`cand_committees:${cycle}:${id}`);
    await DB.del(`pac_breakdown:${cycle}:${id}`);
  }

  renderCompareArea();
  setStatus("Refresh complete.");
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---------- CLEAR / TOGGLE COMPARE ---------- */
function clearAll() {
  primary = null;
  secondary = null;
  compareMode = false;
  pacUiState.clear();
  cleanupChartsNotInSelection();

  updateCompareButton();
  updateHints();
  renderCompareArea();
  renderCandidateList(lastSearchResults);
}

function toggleCompareMode() {
  if (!primary) return;

  compareMode = !compareMode;
  if (compareMode) secondary = null;

  updateCompareButton();
  updateHints();
  renderCompareArea();
  renderCandidateList(lastSearchResults);
}

/* ---------- INIT ---------- */
async function init() {
  if (!els.search || !els.cycle || !els.office || !els.candidateList) {
    console.warn("Money Tracker: required controls not found.");
    return;
  }

  // If Chart.js is blocked, we’ll still work (totals only).
  // Try loading it once here so charts work if CDN was slow.
  await loadChartJsIfMissing();

  updateCompareButton();
  updateHints();
  renderCompareArea();
  setStatus("Type a candidate name to begin.");

  els.search.addEventListener("input", debounce(runSearch, 250));
  els.office.addEventListener("change", runSearch);

  els.cycle.addEventListener("change", () => {
    pacUiState.clear();
    cleanupChartsNotInSelection();
    renderCompareArea();
    runSearch();
  });

  if (els.refresh) els.refresh.addEventListener("click", hardRefreshCache);
  if (els.clearCompare) els.clearCompare.addEventListener("click", clearAll);
  if (els.compareToggle) els.compareToggle.addEventListener("click", toggleCompareMode);
}

document.addEventListener("DOMContentLoaded", init);
