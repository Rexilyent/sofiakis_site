// ============================================================
//  STAFF PORTAL — CALENDAR & MAP  —  portal-calendar.js
// ============================================================
//
//  Owns the Calendar tab:
//    • FullCalendar in month / week / day / list views
//    • A Leaflet map of event locations, clustered, with the
//      IL-10 boundary drawn for context
//    • The "New Event" form and the upcoming-events sidebar
//
//  Depends on window.PortalCore (from portal.js) for the session,
//  authenticated fetch, toasts and the shared focus trap.
//
//  ── INITIALISATION ────────────────────────────────────────
//  Everything is lazy. FullCalendar and Leaflet both measure the
//  DOM when they render, and both render incorrectly if their
//  container is hidden — so nothing is built until the Calendar
//  tab is first shown, and both are told to re-measure on every
//  subsequent switch back to the tab.
//
//  ── GEOCODING ─────────────────────────────────────────────
//  Google Calendar stores locations as free text, not coordinates,
//  so addresses are resolved client-side through Nominatim and
//  cached in localStorage. Nominatim's usage policy caps this at
//  one request per second, which is respected below.
//
//  This is fine for a staff calendar of a few dozen events, but it
//  is the weak point of this feature: results depend on how tidily
//  the address was typed, and the first load of a new set of
//  addresses is slow. If the campaign starts running many events,
//  move geocoding into the Worker and cache resolved coordinates
//  in D1 — swap out resolveLocation() below and nothing else here
//  needs to change.
//
// ============================================================

(function () {
  "use strict";

  const CALENDAR_API = "/api/admin-calendar";
  const GEO_CACHE_KEY = "portalGeocodeCache";
  const BOUNDARY_URL  = "/assets/geo/il-congressional-districts.geojson";

  // IL-10 sits in the northern Chicago suburbs. Biasing the geocoder
  // to this box stops "Main Street" resolving to a Main Street in
  // another state.
  const IL10_CENTER  = [42.0451, -87.6877];
  const IL10_VIEWBOX = "-88.6,42.6,-87.5,41.9";   // left,top,right,bottom

  const CATEGORIES = {
    TOWN_HALL:  { label: "Town Hall",  icon: "fas fa-landmark" },
    VOLUNTEER:  { label: "Volunteer",  icon: "fas fa-handshake" },
    FUNDRAISER: { label: "Fundraiser", icon: "fas fa-circle-dollar-sign" },
    CANVASS:    { label: "Canvassing", icon: "fas fa-map-location-dot" }
  };

  // ── State ──────────────────────────────────────────────────
  let initialised   = false;
  let calendar      = null;
  let map           = null;
  let clusterGroup  = null;
  let boundaryLayer = null;

  const eventsById   = new Map();   // id -> event object
  const fetchedKeys  = new Set();   // "from|to" ranges already loaded
  const markersById  = new Map();   // id -> Leaflet marker
  let activeCats     = new Set(["ALL"]);
  let geocodeQueued  = false;
  let upcomingEvents = [];   // raw sidebar list, before category filtering
  let readOnlyMode   = false; // showing published events, Google unavailable
  let modalEvent     = null;

  const core = () => window.PortalCore || {};

  // ── DOM refs ───────────────────────────────────────────────
  const calLoading    = document.getElementById("cal-calendar-loading");
  const calEl         = document.getElementById("portal-calendar");
  const mapEl         = document.getElementById("portal-event-map");
  const viewCount     = document.getElementById("cal-view-count");
  const mapCount      = document.getElementById("cal-map-count");
  const mapNote       = document.getElementById("cal-map-note");
  const mapNoteText   = document.getElementById("cal-map-note-text");
  const calRefreshBtn = document.getElementById("cal-calendar-refresh");
  const mapFitBtn     = document.getElementById("cal-map-fit");
  const filterHost    = document.getElementById("cal-filters");
  const upcomingCount = document.getElementById("cal-upcoming-count");
  const sourceEl      = document.getElementById("cal-source");
  const sourceTextEl  = document.getElementById("cal-source-text");

  // Event form (now inside a modal)
  const calFormOverlay = document.getElementById("cal-form-overlay");
  const calFormClose   = document.getElementById("cal-form-close");
  const calNewBtn      = document.getElementById("cal-new-event-btn");
  const calCategory    = document.getElementById("cal-category");
  const calTitle       = document.getElementById("cal-title");
  const calTitlePreviewWrap = document.getElementById("cal-title-preview-wrap");
  const calTitlePreview     = document.getElementById("cal-title-preview");
  const calStart       = document.getElementById("cal-start");
  const calEnd         = document.getElementById("cal-end");
  const calLocation    = document.getElementById("cal-location");
  const calDescription = document.getElementById("cal-description");
  const calAttendees   = document.getElementById("cal-attendees");
  const calVisibility  = document.getElementById("cal-visibility");
  const calSubmitBtn   = document.getElementById("cal-submit-btn");
  const calClearBtn    = document.getElementById("cal-clear-btn");
  const calSuccess     = document.getElementById("cal-success");
  const calSuccessMsg  = document.getElementById("cal-success-msg");
  const calEventLink   = document.getElementById("cal-event-link");
  const calError       = document.getElementById("cal-error");
  const calErrorMsg    = document.getElementById("cal-error-msg");

  // Upcoming list
  const calEventsLoading  = document.getElementById("cal-events-loading");
  const calEventsError    = document.getElementById("cal-events-error");
  const calEventsErrorMsg = document.getElementById("cal-events-error-msg");
  const calEventsList     = document.getElementById("cal-events-list");
  const calEventsEmpty    = document.getElementById("cal-events-empty");
  const calRefreshListBtn = document.getElementById("cal-refresh-btn");

  // Event detail modal
  const evModal      = document.getElementById("cal-modal-overlay");
  const evModalTitle = document.getElementById("cal-modal-title");
  const evModalBody  = document.getElementById("cal-modal-body");
  const evModalClose = document.getElementById("cal-modal-close");
  const evModalOpen  = document.getElementById("cal-modal-open");
  const evModalLocate = document.getElementById("cal-modal-locate");

  // ============================================================
  //  BOOT
  // ============================================================

  document.addEventListener("portal:tab", e => {
    if (e.detail?.tab !== "calendar") return;
    if (!initialised) {
      initialised = true;
      init();
    } else {
      // Re-measure: both libraries size themselves against a visible
      // container, and were hidden while the other tab was active.
      calendar?.updateSize();
      map?.invalidateSize();
    }
  });

  function init() {
    if (typeof FullCalendar === "undefined" || typeof L === "undefined") {
      showCalError("Calendar libraries failed to load. Check your connection and reload the page.");
      if (calLoading) calLoading.hidden = true;
      setMapNote("Map unavailable — Leaflet failed to load.", true);
      return;
    }

    buildCalendar();
    buildMap();
    wireFilters();
    wireForm();
    wireModal();

    calRefreshBtn?.addEventListener("click", () => refresh(true));
    calRefreshListBtn?.addEventListener("click", () => fetchUpcomingEvents());
    mapFitBtn?.addEventListener("click", fitMapToMarkers);

    fetchUpcomingEvents();
  }

  // Redraw when the appearance changes — Leaflet and FullCalendar
  // both bake colours in at render time.
  document.addEventListener("portal:themechange", () => {
    if (!initialised) return;
    calendar?.render();
    map?.invalidateSize();
  });

  // ============================================================
  //  CALENDAR
  // ============================================================

  function buildCalendar() {
    calendar = new FullCalendar.Calendar(calEl, {
      initialView: "dayGridMonth",
      height: "auto",
      firstDay: 0,
      nowIndicator: true,
      dayMaxEventRows: 4,
      headerToolbar: {
        left:   "prev,next today",
        center: "title",
        right:  "dayGridMonth,timeGridWeek,timeGridDay,listMonth"
      },
      buttonText: {
        today: "Today", month: "Month", week: "Week", day: "Day", list: "List"
      },
      views: {
        timeGridWeek: { slotMinTime: "06:00:00", slotMaxTime: "23:00:00" },
        timeGridDay:  { slotMinTime: "06:00:00", slotMaxTime: "23:00:00" }
      },
      noEventsText: "No events in this range.",
      // Fired whenever the visible range changes — including on first
      // render — so this is where the matching events get loaded.
      datesSet: info => loadRange(info.start, info.end),
      // Clicking an empty day is the natural "add an event here" gesture
      dateClick: info => openEventForm(info.date, calNewBtn),
      eventClick: info => {
        info.jsEvent.preventDefault();
        const ev = eventsById.get(info.event.id);
        if (ev) openEventModal(ev, info.el);
      }
    });

    calendar.render();
    if (calLoading) calLoading.hidden = true;
  }

  /** Fetch any events in [start, end) that aren't already loaded. */
  async function loadRange(start, end, force = false) {
    // Pad by a week each side so adjacent-month spillover cells fill in
    const from = new Date(start.getTime() - 7 * 86400000).toISOString();
    const to   = new Date(end.getTime()   + 7 * 86400000).toISOString();
    const key  = `${from}|${to}`;

    if (!force && fetchedKeys.has(key)) { applyEvents(); return; }

    try {
      const params = new URLSearchParams({ from, to, maxResults: "250" });
      const res = await core().authFetch(`${CALENDAR_API}?${params}`);

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));

        // Google rate limiting is exactly what events.json exists to
        // avoid, so use it here too rather than showing nothing.
        if (res.status === 429) {
          const loaded = await loadPublishedEvents(
            "The calendar service is rate limited right now.");
          if (!loaded) {
            if (viewCount) viewCount.textContent = "rate limited";
            setDataSource("error", "Rate limited by the calendar service.");
          }
          return;
        }

        if (res.status === 503) {
          // Fall back to the published schedule rather than showing an
          // empty calendar next to a file that already has the events.
          const detail = data.error || "";
          const loaded = await loadPublishedEvents(detail);
          if (!loaded) {
            setMapNote(detail || "Google Calendar is not available, and no published " +
                                 "schedule was found.", true);
            if (viewCount) viewCount.textContent = "unavailable";
            setDataSource("error", detail);
          }
          return;
        }
        throw new Error(data.error || `Server returned ${res.status}`);
      }

      const data = await res.json();
      fetchedKeys.add(key);

      // Reached the Google API successfully.
      if (!readOnlyMode) setDataSource("live");

      for (const ev of (data.events || [])) {
        if (!ev.start) continue;
        eventsById.set(ev.id, decorate(ev));
      }

      applyEvents();
      queueGeocode();

    } catch (err) {
      if (/Session expired/.test(err.message)) return;
      console.error("Calendar range load failed:", err);
      core().toast?.(`Could not load calendar events: ${err.message}`, "error", 8000);
    }
  }

  /** Split the bracket category out of the Google Calendar title. */
  function decorate(ev) {
    const m = (ev.title || "").match(/^\s*\[([^\]]+)\]\s*/);
    const cat = m ? normalizeCat(m[1]) : "";
    return {
      ...ev,
      category:   cat,
      cleanTitle: m ? ev.title.replace(/^\s*\[[^\]]+\]\s*/, "") : (ev.title || "(Untitled)")
    };
  }

  function normalizeCat(tag) {
    const t = (tag || "").trim().toUpperCase().replace(/[\s-]+/g, "_").replace(/^TOWNHALL$/, "TOWN_HALL");
    return CATEGORIES[t] ? t : "";
  }

  function visibleEvents() {
    const all = Array.from(eventsById.values());
    if (activeCats.has("ALL")) return all;
    return all.filter(ev => activeCats.has(ev.category || "NONE"));
  }

  /** Push the current filtered set into both the calendar and the map. */
  function applyEvents() {
    const list = visibleEvents();

    if (calendar) {
      calendar.removeAllEvents();
      calendar.addEventSource(list.map(ev => ({
        id:      ev.id,
        title:   ev.cleanTitle,
        start:   ev.start,
        end:     ev.end,
        allDay:  !!ev.all_day,
        classNames: [`cat-${ev.category || "NONE"}`]
      })));
    }

    if (viewCount) {
      viewCount.textContent = `${list.length} event${list.length === 1 ? "" : "s"} loaded`;
    }

    renderMarkers();
  }



  // ============================================================
  //  DATA SOURCE INDICATOR
  // ============================================================
  //
  //  A populated calendar does not tell you WHERE the events came
  //  from. Live Google data and the offline events.json copy look
  //  identical once rendered, so a silent fallback could sit there for
  //  weeks while everyone assumed the integration was fine — and any
  //  event created elsewhere would simply never appear.
  //
  //  Shown in every state, not only on failure.

  const SOURCE_STATES = {
    checking:  { text: "Checking…",          title: "Contacting Google Calendar" },
    live:      { text: "Google Calendar",     title: "Live data from the Google Calendar API" },
    published: { text: "Published schedule",  title: "Offline copy from events.json — " +
                                                     "the Google Calendar API is unavailable" },
    error:     { text: "Unavailable",         title: "No events could be loaded" }
  };

  function setDataSource(state, detail) {
    if (!sourceEl) return;
    const meta = SOURCE_STATES[state] || SOURCE_STATES.error;
    sourceEl.dataset.state = state;
    if (sourceTextEl) sourceTextEl.textContent = meta.text;
    sourceEl.title = detail ? `${meta.title}. ${detail}` : meta.title;
  }
  // ============================================================
  //  PUBLISHED-SCHEDULE FALLBACK
  // ============================================================
  //
  //  The site already ships /data/events.json, built from the ICS feed
  //  by backend/tools/build_events.py, precisely so the public Events
  //  page does not hammer the Google Calendar API. When the API is
  //  unavailable here — unconfigured, misconfigured, or rate limited —
  //  showing nothing wastes a perfectly good copy of the schedule.
  //
  //  It is READ-ONLY: creating an event still needs the API, so that is
  //  disabled and said so, rather than failing on submit.
  //
  //  These entries already carry geocoded coords, so the map works
  //  without any Nominatim lookups at all.

  const PUBLISHED_EVENTS_URL = "/data/events.json";

  async function loadPublishedEvents(reason) {
    try {
      const res = await fetch(PUBLISHED_EVENTS_URL);
      if (!res.ok) return false;
      const raw = await res.json();
      if (!Array.isArray(raw) || !raw.length) return false;

      readOnlyMode = true;

      // Seed coords straight into the geocode cache so renderMarkers
      // finds them without a lookup.
      try {
        const cache = loadCache();
        let changed = false;
        for (const e of raw) {
          if (e.location && e.coords && typeof e.coords.lat === "number") {
            if (!Object.prototype.hasOwnProperty.call(cache, e.location)) {
              cache[e.location] = { lat: e.coords.lat, lon: e.coords.lon };
              changed = true;
            }
          }
        }
        if (changed) saveCache(cache);
      } catch { /* cache is an optimisation, not a requirement */ }

      eventsById.clear();
      raw.forEach((e, i) => {
        if (!e.start) return;
        // build_events.py puts the category in its own field rather than
        // a [BRACKET] prefix, so map it across to the shared shape.
        const cat = normalizeCat(e.category || "");
        eventsById.set(`published-${i}`, {
          id: `published-${i}`,
          title: e.title || "(Untitled)",
          cleanTitle: e.title || "(Untitled)",
          category: cat,
          start: e.start,
          end: e.end || null,
          all_day: !String(e.start).includes("T"),
          location: e.location || null,
          description: e.description || null,
          html_link: e.url || null
        });
      });

      upcomingEvents = Array.from(eventsById.values())
        .filter(e => new Date(e.start) >= new Date())
        .sort((a, b) => String(a.start).localeCompare(String(b.start)))
        .slice(0, 20);

      applyEvents();
      renderUpcoming();
      showReadOnlyNotice(reason);
      setDataSource("published", reason);
      return true;

    } catch {
      return false;
    }
  }

  function showReadOnlyNotice(reason) {
    if (calNewBtn) {
      calNewBtn.disabled = true;
      calNewBtn.title = "Event creation needs the Google Calendar API";
    }
    if (calEventsEmpty) calEventsEmpty.hidden = true;
    if (calEventsError) {
      calEventsErrorMsg.textContent =
        "Showing the published schedule from the site’s events file. " +
        (reason ? reason + " " : "") +
        "Events cannot be created here until the Google Calendar connection works.";
      calEventsError.hidden = false;
    }
    if (viewCount) viewCount.textContent = "published schedule";
  }
  // ============================================================
  //  FILTER PILLS
  // ============================================================

  function wireFilters() {
    filterHost?.querySelectorAll(".cal-pill").forEach(pill => {
      pill.addEventListener("click", () => {
        const cat = pill.dataset.cat;

        if (cat === "ALL") {
          activeCats = new Set(["ALL"]);
        } else {
          activeCats.delete("ALL");
          if (activeCats.has(cat)) activeCats.delete(cat);
          else activeCats.add(cat);
          if (!activeCats.size) activeCats.add("ALL");
        }

        filterHost.querySelectorAll(".cal-pill").forEach(p => {
          p.classList.toggle("is-active", activeCats.has(p.dataset.cat));
        });

        applyEvents();
        renderUpcoming();
      });
    });
  }

  // ============================================================
  //  MAP
  // ============================================================

  function buildMap() {
    map = L.map(mapEl, { scrollWheelZoom: false }).setView(IL10_CENTER, 10);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);

    clusterGroup = L.markerClusterGroup({
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      disableClusteringAtZoom: 14
    });
    map.addLayer(clusterGroup);

    // Scroll-zoom is off by default so the page still scrolls over the
    // map; clicking gives it focus and enables the wheel.
    map.on("click", () => map.scrollWheelZoom.enable());
    map.on("mouseout", () => map.scrollWheelZoom.disable());

    loadBoundary();
  }

  async function loadBoundary() {
    try {
      const res = await fetch(BOUNDARY_URL);
      if (!res.ok) return;
      const geojson = await res.json();
      boundaryLayer = L.geoJSON(geojson, {
        filter: f => f.properties?.CD119FP === "10",
        style: { color: "#215e0e", weight: 3, fillColor: "#215e0e", fillOpacity: 0.06 },
        interactive: false
      }).addTo(map);
      map.fitBounds(boundaryLayer.getBounds(), { padding: [30, 30] });
    } catch {
      /* boundary is decorative — a failure here shouldn't break the map */
    }
  }

  function renderMarkers() {
    if (!clusterGroup) return;

    clusterGroup.clearLayers();
    markersById.clear();

    const list = visibleEvents();
    let plotted = 0, pending = 0, unlocatable = 0;

    list.forEach((ev, i) => {
      if (!ev.location) return;
      if (isVirtual(ev.location)) { unlocatable++; return; }

      const coords = getCached(ev.location);
      if (coords === undefined) { pending++; return; }
      if (coords === null)      { unlocatable++; return; }

      const marker = L.marker([coords.lat, coords.lon], {
        icon: L.divIcon({
          className: "",
          html: `<div class="cal-marker cat-${ev.category || "NONE"}"><span>${i + 1}</span></div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 26]
        }),
        title: ev.cleanTitle
      });

      marker.bindPopup(popupHtml(ev));
      clusterGroup.addLayer(marker);
      markersById.set(ev.id, marker);
      plotted++;
    });

    if (mapCount) {
      mapCount.textContent = plotted ? `${plotted} located` : "";
    }

    // Say plainly what is and isn't on the map — a silently incomplete
    // map is worse than none for someone planning a day of canvassing.
    const bits = [];
    if (plotted)     bits.push(`${plotted} event${plotted === 1 ? "" : "s"} mapped`);
    if (pending)     bits.push(`${pending} still resolving`);
    if (unlocatable) bits.push(`${unlocatable} without a mappable address`);
    setMapNote(bits.length ? bits.join(" · ") : "No events with locations in this range.", pending === 0 && unlocatable > 0);

    if (plotted) fitMapToMarkers();
  }

  function fitMapToMarkers() {
    const markers = Array.from(markersById.values());
    if (!markers.length) {
      if (boundaryLayer) map.fitBounds(boundaryLayer.getBounds(), { padding: [30, 30] });
      else map.setView(IL10_CENTER, 10);
      return;
    }
    if (markers.length === 1) {
      map.setView(markers[0].getLatLng(), 13);
      return;
    }
    map.fitBounds(L.featureGroup(markers).getBounds(), { padding: [40, 40] });
  }

  function popupHtml(ev) {
    const esc = core().esc || (s => String(s ?? ""));
    const meta = CATEGORIES[ev.category];
    return `
      ${meta ? `<span class="cal-map-popup-cat cat-${ev.category}"
                       style="background:var(--cat-${ev.category.toLowerCase().replace(/_/g, "-")})">${esc(meta.label)}</span><br>` : ""}
      <strong>${esc(ev.cleanTitle)}</strong><br>
      <span class="cal-map-popup-meta">${esc(formatEventDate(ev.start))}</span><br>
      <span class="cal-map-popup-meta">${esc(ev.location)}</span>`;
  }

  function setMapNote(text, warn) {
    if (!mapNoteText) return;
    mapNoteText.textContent = text;
    mapNote?.classList.toggle("is-warn", !!warn);
  }

  // ============================================================
  //  GEOCODING
  // ============================================================
  //
  //  Cache shape: { "<address>": {lat, lon} | null }
  //  null means "looked up and genuinely not found", which stops
  //  the same dud address being retried on every page load.

  function loadCache() {
    try { return JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || "{}"); }
    catch { return {}; }
  }

  function saveCache(cache) {
    try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(cache)); }
    catch { /* quota or private mode — geocoding just won't persist */ }
  }

  /** undefined = not yet looked up, null = not found, object = coords */
  function getCached(address) {
    const cache = loadCache();
    return Object.prototype.hasOwnProperty.call(cache, address) ? cache[address] : undefined;
  }

  /** Zoom links, phone numbers and "TBD" are never worth geocoding. */
  function isVirtual(loc) {
    return /^https?:\/\//i.test(loc) ||
           /\b(zoom|meet\.google|teams|webex|virtual|online|tbd|tba)\b/i.test(loc);
  }

  function queueGeocode() {
    if (geocodeQueued) return;
    geocodeQueued = true;
    setTimeout(runGeocodeQueue, 0);
  }

  async function runGeocodeQueue() {
    const cache = loadCache();
    const todo = [];

    for (const ev of eventsById.values()) {
      if (!ev.location || isVirtual(ev.location)) continue;
      if (Object.prototype.hasOwnProperty.call(cache, ev.location)) continue;
      if (!todo.includes(ev.location)) todo.push(ev.location);
    }

    if (!todo.length) {
      // Nothing to look up (every address already cached), but events
      // may have been added since the last paint — redraw before
      // bailing out rather than leaving them off the map.
      geocodeQueued = false;
      renderMarkers();
      return;
    }

    for (let i = 0; i < todo.length; i++) {
      setMapNote(`Locating addresses… ${i + 1} of ${todo.length}`, false);
      const coords = await resolveLocation(todo[i]);

      const fresh = loadCache();
      fresh[todo[i]] = coords;
      saveCache(fresh);

      renderMarkers();

      // Nominatim's usage policy allows at most one request a second.
      if (i < todo.length - 1) await sleep(1100);
    }

    geocodeQueued = false;
    renderMarkers();
  }

  /**
   * Resolve a free-text address to coordinates.
   * Returns {lat, lon} or null. Never throws.
   *
   * This is the single seam to replace if geocoding moves server-side.
   */
  async function resolveLocation(address) {
    try {
      const params = new URLSearchParams({
        format: "jsonv2",
        q: address,
        limit: "1",
        countrycodes: "us",
        viewbox: IL10_VIEWBOX,
        bounded: "0"           // prefer the viewbox but don't hard-restrict
      });
      const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: { "Accept": "application/json" }
      });
      if (!res.ok) return null;
      const results = await res.json();
      if (!Array.isArray(results) || !results.length) return null;
      const { lat, lon } = results[0];
      const latN = parseFloat(lat), lonN = parseFloat(lon);
      if (isNaN(latN) || isNaN(lonN)) return null;
      return { lat: latN, lon: lonN };
    } catch {
      return null;
    }
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ============================================================
  //  EVENT DETAIL MODAL
  // ============================================================

  function wireModal() {
    evModalClose?.addEventListener("click", closeEventModal);
    evModal?.addEventListener("click", e => { if (e.target === evModal) closeEventModal(); });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && evModal && !evModal.hidden) closeEventModal();
    });

    evModalLocate?.addEventListener("click", () => {
      if (!modalEvent) return;
      const marker = markersById.get(modalEvent.id);
      closeEventModal();
      if (!marker) return;
      // Zoom in far enough that the cluster breaks apart, then open it
      map.setView(marker.getLatLng(), 15);
      setTimeout(() => marker.openPopup(), 350);
      mapEl.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  let evModalReturnFocus = null;

  function openEventModal(ev, returnFocusTo) {
    const esc = core().esc || (s => String(s ?? ""));
    modalEvent = ev;
    evModalReturnFocus = returnFocusTo || null;

    const meta = CATEGORIES[ev.category];
    evModalTitle.textContent = ev.cleanTitle;

    const rows = [
      row("Category", meta
        ? `<span class="cal-preview-tag" style="--tag-color:var(--cat-${ev.category.toLowerCase().replace(/_/g, "-")})"><i class="${meta.icon}" aria-hidden="true"></i>${esc(meta.label)}</span>`
        : `<span class="portal-null">Uncategorised</span>`),
      row("Starts", esc(formatEventDate(ev.start))),
      row("Ends",   ev.end ? esc(formatEventDate(ev.end)) : `<span class="portal-null">—</span>`),
      row("Location", ev.location
        ? esc(ev.location)
        : `<span class="portal-null">No location set</span>`),
      row("Description", ev.description
        ? esc(ev.description).replace(/\n/g, "<br>")
        : `<span class="portal-null">—</span>`)
    ];
    evModalBody.innerHTML = rows.join("");

    const marker = markersById.get(ev.id);
    if (evModalLocate) evModalLocate.hidden = !marker;

    if (evModalOpen) {
      if (ev.html_link) { evModalOpen.href = ev.html_link; evModalOpen.hidden = false; }
      else evModalOpen.hidden = true;
    }

    evModal.hidden = false;
    document.body.style.overflow = "hidden";
    core().trapFocus?.(evModal);
    evModalClose.focus();
  }

  function closeEventModal() {
    if (!evModal || evModal.hidden) return;
    evModal.hidden = true;
    document.body.style.overflow = "";
    core().releaseFocus?.(evModal);
    if (evModalReturnFocus && document.body.contains(evModalReturnFocus)) {
      evModalReturnFocus.focus();
    }
    evModalReturnFocus = null;
    modalEvent = null;
  }

  function row(label, valueHtml) {
    return `
      <div class="modal-field">
        <span class="modal-field-label">${label}</span>
        <span class="modal-field-value">${valueHtml}</span>
      </div>`;
  }

  // ============================================================
  //  CREATE EVENT FORM
  // ============================================================

  function wireForm() {
    // ── Modal plumbing ────────────────────────────────────
    calNewBtn?.addEventListener("click", () => openEventForm(null, calNewBtn));
    calFormClose?.addEventListener("click", closeEventForm);
    calFormOverlay?.addEventListener("click", e => {
      if (e.target === calFormOverlay) closeEventForm();
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && calFormOverlay && !calFormOverlay.hidden) closeEventForm();
    });

    if (calSubmitBtn) calSubmitBtn.addEventListener("click", handleCreateEvent);
    if (calClearBtn)  calClearBtn.addEventListener("click", clearCalForm);
    if (calCategory)  calCategory.addEventListener("change", updateTitlePreview);
    if (calTitle)     calTitle.addEventListener("input", updateTitlePreview);

    // Picking a start time pre-fills a sensible end time — staff were
    // otherwise typing the same date twice for every event.
    if (calStart) {
      calStart.addEventListener("change", () => {
        if (!calStart.value || calEnd.value) return;
        const d = new Date(calStart.value);
        if (isNaN(d.getTime())) return;
        d.setHours(d.getHours() + 2);
        calEnd.value = toLocalInput(d);
      });
    }
  }

  let formReturnFocus = null;

  function openEventForm(prefillDate, trigger) {
    if (!calFormOverlay) return;
    clearCalBanners();
    // Prefer an explicitly passed trigger: document.activeElement only
    // holds the button if the click actually focused it, which varies
    // by browser and doesn't happen at all for programmatic clicks.
    formReturnFocus = trigger || calNewBtn || document.activeElement;

    // Clicking an empty day on the calendar opens the form already
    // dated, which is the common case for scheduling.
    // Duck-typed rather than `instanceof Date`: that check fails for a
    // Date created in a different JS realm (an iframe, or a test host),
    // and silently skipping the prefill would be a confusing bug.
    const isDate = prefillDate && typeof prefillDate.getTime === "function" &&
                   !isNaN(prefillDate.getTime());
    if (isDate && calStart && !calStart.value) {
      const d = new Date(prefillDate);
      if (d.getHours() === 0 && d.getMinutes() === 0) d.setHours(18, 0, 0, 0);
      calStart.value = toLocalInput(d);
      const end = new Date(d.getTime() + 2 * 3600000);
      if (calEnd) calEnd.value = toLocalInput(end);
    }

    calFormOverlay.hidden = false;
    document.body.style.overflow = "hidden";
    core().trapFocus?.(calFormOverlay);
    (calCategory || calFormClose)?.focus();
  }

  function closeEventForm() {
    if (!calFormOverlay || calFormOverlay.hidden) return;
    calFormOverlay.hidden = true;
    document.body.style.overflow = "";
    core().releaseFocus?.(calFormOverlay);
    if (formReturnFocus && document.body.contains(formReturnFocus)) formReturnFocus.focus();
    formReturnFocus = null;
  }

  function toLocalInput(d) {
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function updateTitlePreview() {
    if (!calTitlePreview || !calTitlePreviewWrap) return;
    const esc = core().esc || (s => String(s ?? ""));
    const cat   = calCategory ? calCategory.value : "";
    const title = calTitle    ? calTitle.value.trim() : "";

    if (!cat && !title) { calTitlePreviewWrap.hidden = true; return; }

    const meta = CATEGORIES[cat];
    calTitlePreviewWrap.hidden = false;
    calTitlePreview.innerHTML = meta
      ? `<span class="cal-preview-tag" style="--tag-color:var(--cat-${cat.toLowerCase().replace(/_/g, "-")})"><i class="${meta.icon}" aria-hidden="true"></i>${esc(meta.label)}</span> ${esc(title || "…")}`
      : `${esc(cat ? `[${cat}] ` : "")}${esc(title || "…")}`;
  }

  async function handleCreateEvent() {
    clearCalBanners();

    if (readOnlyMode) {
      showCalError(
        "The calendar is showing the published schedule because the Google " +
        "Calendar connection is unavailable. Events can’t be created until " +
        "that is working.");
      return;
    }
    const esc = core().esc || (s => String(s ?? ""));

    const category = calCategory ? calCategory.value : "";
    const title    = calTitle.value.trim();
    const start    = calStart.value;
    const end      = calEnd.value;

    const VALID_CATEGORIES = ["TOWN_HALL", "VOLUNTEER", "FUNDRAISER", "CANVASS"];
    let valid = true;

    [calCategory, calTitle, calStart, calEnd].forEach(el => el && el.classList.remove("invalid"));

    if (!category || !VALID_CATEGORIES.includes(category)) {
      if (calCategory) calCategory.classList.add("invalid");
      valid = false;
    }
    if (!title) { calTitle.classList.add("invalid"); valid = false; }
    if (!start) { calStart.classList.add("invalid"); valid = false; }
    if (!end)   { calEnd.classList.add("invalid");   valid = false; }

    if (!valid) {
      showCalError("Please fill in all required fields: category, title, start, and end date/time.");
      return;
    }

    const fullTitle = `[${category}] ${title}`;

    if (new Date(end) <= new Date(start)) {
      calEnd.classList.add("invalid");
      showCalError("End date/time must be after the start date/time.");
      return;
    }

    // Warn (but don't block) on events created in the past — usually a typo
    if (new Date(start) < new Date()) {
      const ok = window.confirm("This event starts in the past. Create it anyway?");
      if (!ok) return;
    }

    const attendeeRaw = calAttendees ? calAttendees.value.trim() : "";
    const attendeeParts = attendeeRaw ? attendeeRaw.split(",").map(e => e.trim()).filter(Boolean) : [];
    const attendees = attendeeParts.filter(e => e.includes("@"));
    const rejected  = attendeeParts.filter(e => !e.includes("@"));

    if (rejected.length) {
      showCalError(`These don't look like email addresses and would be dropped: ${rejected.join(", ")}`);
      calAttendees.classList.add("invalid");
      return;
    }

    setCalLoading(true);

    try {
      const res = await core().authFetch(CALENDAR_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: fullTitle,
          category,
          start,
          end,
          location:    calLocation    ? calLocation.value.trim()    : "",
          description: calDescription ? calDescription.value.trim() : "",
          attendees,
          visibility:  calVisibility  ? calVisibility.value         : "default"
        })
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        showCalError(data.error || `Server error (${res.status}). Please try again.`);
        return;
      }

      // Reset the form FIRST: clearCalForm() clears the banners, so
      // showing the success banner before it would immediately hide
      // it again and staff would never see the confirmation.
      clearCalForm();

      calSuccessMsg.textContent =
        `"${title}" has been added to the campaign calendar as a ${CATEGORIES[category]?.label || category} event.`;
      if (data.html_link) {
        calEventLink.href = data.html_link;
        calEventLink.hidden = false;
      } else {
        calEventLink.hidden = true;
      }
      calSuccess.hidden = false;
      core().toast?.("Event created.");

      refresh(true);

    } catch (err) {
      if (/Session expired/.test(err.message)) return;
      console.error("Calendar create error:", err);
      showCalError("Unable to reach the server. Check your connection and try again.");
    } finally {
      setCalLoading(false);
    }
  }

  function showCalError(msg) {
    if (!calErrorMsg) return;
    calErrorMsg.textContent = msg;
    calError.hidden = false;
  }

  function clearCalBanners() {
    if (calSuccess) calSuccess.hidden = true;
    if (calError)   calError.hidden   = true;
    document.querySelectorAll(".cal-input.invalid, .cal-textarea.invalid")
      .forEach(el => el.classList.remove("invalid"));
  }

  function clearCalForm() {
    if (calCategory)    calCategory.value    = "";
    if (calTitle)       calTitle.value       = "";
    if (calStart)       calStart.value       = "";
    if (calEnd)         calEnd.value         = "";
    if (calLocation)    calLocation.value    = "";
    if (calDescription) calDescription.value = "";
    if (calAttendees)   calAttendees.value   = "";
    if (calVisibility)  calVisibility.value  = "default";
    if (calTitlePreviewWrap) calTitlePreviewWrap.hidden = true;
    clearCalBanners();
  }

  function setCalLoading(on) {
    if (!calSubmitBtn) return;
    calSubmitBtn.disabled = on;
    const btnText    = calSubmitBtn.querySelector(".cal-btn-text");
    const btnSpinner = calSubmitBtn.querySelector(".cal-btn-spinner");
    if (btnText)    btnText.hidden    = on;
    if (btnSpinner) btnSpinner.hidden = !on;
  }

  // ============================================================
  //  UPCOMING EVENTS SIDEBAR
  // ============================================================

  async function fetchUpcomingEvents() {
    if (!calEventsLoading) return;
    const esc = core().esc || (s => String(s ?? ""));

    calEventsLoading.hidden = false;
    calEventsError.hidden   = true;
    calEventsEmpty.hidden   = true;
    calEventsList.innerHTML = "";
    calRefreshListBtn?.classList.add("spinning");

    try {
      const res = await core().authFetch(`${CALENDAR_API}?upcoming=1`);
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 503) {
          // loadRange handles the fallback; if it already succeeded the
          // list is populated, so don’t overwrite it with an error.
          if (!readOnlyMode) {
            const loaded = await loadPublishedEvents(data.error || "");
            if (!loaded) {
              calEventsEmpty.hidden = false;
              calEventsEmpty.textContent = data.error ||
                "Google Calendar is not available and no published schedule was found.";
            }
          }
        } else {
          calEventsErrorMsg.textContent = data.error || `Failed to load events (${res.status}).`;
          calEventsError.hidden = false;
        }
        return;
      }

      upcomingEvents = (data.events || []).map(decorate);

      // Keep the shared store in sync so the modal and map can use these
      let merged = 0;
      for (const ev of upcomingEvents) {
        if (!eventsById.has(ev.id)) { eventsById.set(ev.id, ev); merged++; }
      }

      renderUpcoming();

      // The upcoming fetch usually brings in events the calendar's
      // date-range query missed. Without repainting, those stayed
      // invisible on the map until some unrelated click forced a
      // re-render — so the map silently under-reported on first load.
      if (merged) applyEvents();

      queueGeocode();

    } catch (err) {
      if (/Session expired/.test(err.message)) return;
      console.error("Calendar fetch error:", err);
      calEventsErrorMsg.textContent = "Unable to reach the server.";
      calEventsError.hidden = false;
    } finally {
      calEventsLoading.hidden = true;
      calRefreshListBtn?.classList.remove("spinning");
    }
  }

  /**
   * Paint the sidebar list from the events already fetched, honouring
   * the category pills. Kept separate from the fetch so clicking a
   * filter re-renders instantly instead of hitting the API again — and
   * so the list can't drift out of step with the calendar and map,
   * which are filtered from the same activeCats set.
   */
  function renderUpcoming() {
    if (!calEventsList) return;
    const esc = core().esc || (s => String(s ?? ""));

    calEventsList.innerHTML = "";
    calEventsEmpty.hidden = true;

    const list = activeCats.has("ALL")
      ? upcomingEvents
      : upcomingEvents.filter(ev => activeCats.has(ev.category || "NONE"));

    if (!list.length) {
      calEventsEmpty.hidden = false;
      calEventsEmpty.textContent = upcomingEvents.length
        ? `No upcoming ${activeCatLabel()} events.`
        : "No upcoming events found on the campaign calendar.";
      updateUpcomingCount(0);
      return;
    }
    updateUpcomingCount(list.length);

    {
      for (const ev of list) {
        const li = document.createElement("li");
        li.className = "cal-event-item";

        const startLabel = formatEventDate(ev.start);
        const endLabel   = ev.end ? formatEventDate(ev.end) : null;
        const timeRange  = endLabel && endLabel !== startLabel
          ? `${startLabel} → ${endLabel}` : startLabel;

        const meta = CATEGORIES[ev.category];
        const colorVar = ev.category ? `var(--cat-${ev.category.toLowerCase().replace(/_/g, "-")})` : "";

        li.innerHTML = `
          <span class="cal-event-dot" aria-hidden="true" style="${colorVar ? `background:${colorVar}` : ""}"></span>
          <div class="cal-event-body">
            ${meta ? `<div class="cal-event-cat-row"><span class="cal-preview-tag" style="--tag-color:${colorVar}"><i class="${meta.icon}" aria-hidden="true"></i>${esc(meta.label)}</span></div>` : ""}
            <div class="cal-event-title" title="${esc(ev.title)}">${esc(ev.cleanTitle)}</div>
            <div class="cal-event-meta">
              <span><i class="fas fa-clock" aria-hidden="true"></i>${esc(timeRange)}</span>
              ${ev.location ? `<span><i class="fas fa-location-dot" aria-hidden="true"></i>${esc(ev.location)}</span>` : ""}
            </div>
          </div>
          <button class="cal-event-link" data-id="${esc(ev.id)}">Details</button>
        `;
        li.querySelector(".cal-event-link").addEventListener("click", e => {
          openEventModal(eventsById.get(ev.id) || ev, e.currentTarget);
        });
        calEventsList.appendChild(li);
      }
    }
  }

  /** Human-readable name for whatever the pills are currently showing. */
  function activeCatLabel() {
    const names = [...activeCats]
      .filter(c => c !== "ALL")
      .map(c => (CATEGORIES[c]?.label || c).toLowerCase());
    if (!names.length) return "";
    if (names.length === 1) return names[0];
    return names.slice(0, -1).join(", ") + " or " + names[names.length - 1];
  }

  function updateUpcomingCount(n) {
    if (!upcomingCount) return;
    upcomingCount.textContent = n ? `${n} shown` : "";
  }

  /** Re-pull everything currently in view. */
  function refresh(force) {
    if (force) fetchedKeys.clear();
    const view = calendar?.view;
    if (view) loadRange(view.activeStart, view.activeEnd, force);
    fetchUpcomingEvents();
  }

  // ============================================================
  //  HELPERS
  // ============================================================

  function formatEventDate(iso) {
    if (!iso) return "—";
    try {
      const d = new Date(iso);
      if (!iso.includes("T")) {
        return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      }
      return d.toLocaleString("en-US", {
        weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit"
      });
    } catch { return iso; }
  }

})();
