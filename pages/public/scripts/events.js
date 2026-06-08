/* =========================================================
   Utilities
========================================================= */

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[c]));
}

function normalizeTag(tag) {

  if (!tag) return "";

  return tag
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_")     // space or hyphen → underscore
    .replace(/^TOWNHALL$/, "TOWN_HALL"); // alias
}

function parseBracketTag(title) {
  const m = (title || "").match(/^\s*\[([^\]]+)\]\s*/);
  if (!m) return { tag: "", cleanTitle: title || "" };

  return {
    tag: normalizeTag(m[1]),
    cleanTitle: title.replace(/^\s*\[[^\]]+\]\s*/, "")
  };
}

function formatDateRange(event) {
  const optsDate = { weekday: "short", month: "short", day: "numeric", year: "numeric" };
  const optsTime = { hour: "numeric", minute: "2-digit" };

  const start = new Date(event.start);
  const end = event.end ? new Date(event.end) : null;

  const startStr = `${start.toLocaleDateString(undefined, optsDate)} • ${start.toLocaleTimeString(undefined, optsTime)}`;

  if (!end) return startStr;

  const sameDay = start.toDateString() === end.toDateString();
  const endStr = sameDay
    ? end.toLocaleTimeString(undefined, optsTime)
    : `${end.toLocaleDateString(undefined, optsDate)} • ${end.toLocaleTimeString(undefined, optsTime)}`;

  return `${startStr} – ${endStr}`;
}

/* =========================================================
   Load Static Events
========================================================= */

async function loadEvents() {
  const res = await fetch("/data/events.json");
  if (!res.ok) throw new Error("Events unavailable");

  const raw = await res.json();

  return raw.map(e => {
    // New format: build_events.py pre-parses category into its own field.
    // Legacy format: bracket prefix is still embedded in the title.
    // Support both so either format works without re-running the build script.
    let tag, cleanTitle;
    if (e.category) {
      tag        = normalizeTag(e.category);
      cleanTitle = e.title;
    } else {
      ({ tag, cleanTitle } = parseBracketTag(e.title));
    }

    return {
      title: cleanTitle,
      start: e.start,
      end: e.end,
      allDay: !e.start.includes("T"),
      extendedProps: {
        description: e.description,
        location: e.location,
        categoryTag: tag,
        coords: e.coords
      }
    };
  });
}

/* =========================================================
   Filtering
========================================================= */

let activeFilters = new Set(["ALL"]);
let allEvents = [];
let calendar;
let map;
let markerClusterGroup;
let districtLayer;

function matchFilter(eventObj) {

  if (activeFilters.has("ALL")) return true;

  const eventTag = (eventObj.extendedProps?.categoryTag || "").toUpperCase();

  return activeFilters.has(eventTag);
}

async function updateCalendarView() {

  const filtered = allEvents.filter(e => matchFilter(e));

  calendar.removeAllEvents();
  calendar.addEventSource(filtered);

  await updateMap(filtered);
}

function toggleFilter(filterKey) {

  if (filterKey === "ALL") {
    activeFilters = new Set(["ALL"]);
  } else {

    activeFilters.delete("ALL");

    if (activeFilters.has(filterKey)) {
      activeFilters.delete(filterKey);
    } else {
      activeFilters.add(filterKey);
    }

    if (activeFilters.size === 0) {
      activeFilters.add("ALL");
    }
  }

  updateCalendarView();
}

/* =========================================================
   Map
========================================================= */

async function updateMap(events) {
  markerClusterGroup.clearLayers();
  const markers = [];

  for (const event of events) {
    const coords = event.extendedProps?.coords;
    const location = event.extendedProps?.location;

    if (!coords || coords.lat == null || coords.lon == null) continue;

    const marker = L.marker([coords.lat, coords.lon]);

    marker.bindPopup(`
      <strong>${escapeHtml(event.title)}</strong><br>
      ${escapeHtml(formatDateRange(event))}<br>
      ${escapeHtml(location)}
    `);

    markerClusterGroup.addLayer(marker);
    markers.push(marker);
  }

	if (markers.length === 0) {
    // default district view
    map.setView([42.0451, -87.6877], 10);
    return;
  }

  if (markers.length === 1) {
    // moderate zoom instead of extreme zoom
    const pos = markers[0].getLatLng();
    map.setView(pos, 11);
    return;
  }

  const group = L.featureGroup(markers);
  map.fitBounds(group.getBounds(), { padding: [40, 40] });
}

/* =========================================================
   IL-10 Boundary
========================================================= */

async function loadIL10Boundary() {
  const res = await fetch("/assets/geo/il-congressional-districts.geojson");
  if (!res.ok) return;

  const geojson = await res.json();

  districtLayer = L.geoJSON(geojson, {
    filter: f => f.properties?.CD119FP === "10",
    style: {
      color: "#215e0e",
      weight: 3,
      fillColor: "#215e0e",
      fillOpacity: 0.06
    }
  }).addTo(map);

  map.fitBounds(districtLayer.getBounds(), { padding: [40, 40] });
}

/* =========================================================
   Boot
========================================================= */

document.addEventListener("DOMContentLoaded", async () => {

  calendar = new FullCalendar.Calendar(
    document.getElementById("calendar"),
    {
      initialView: "dayGridMonth",
      height: "auto",
      headerToolbar: {
        left: "prev,next today",
        center: "title",
        right: "dayGridMonth,timeGridWeek,listMonth"
      },
      nowIndicator: true
    }
  );

  calendar.render();

  map = L.map("eventMap").setView([42.0451, -87.6877], 10);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  markerClusterGroup = L.markerClusterGroup({
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    disableClusteringAtZoom: 14
  });

  map.addLayer(markerClusterGroup);

  await loadIL10Boundary();

  document.querySelectorAll(".filter-pill").forEach(btn => {

  btn.addEventListener("click", () => {

    const filter = btn.dataset.filter;

    toggleFilter(filter);

    if (filter === "ALL") {
      document.querySelectorAll(".filter-pill")
        .forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      return;
    }

    btn.classList.toggle("is-active");

    document.querySelector('[data-filter="ALL"]').classList.remove("is-active");
  });
});

allEvents = await loadEvents();
await updateCalendarView();

});