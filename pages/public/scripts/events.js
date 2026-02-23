/**
 * EVENTS PAGE SCRIPT (Free)
 * - Uses a PUBLIC Google Calendar ICS feed
 * - Parses VEVENT blocks client-side
 * - Shows events in FullCalendar
 * - Filters by title tag like: [Volunteer] Phonebank Night
 *
 * IMPORTANT:
 * Paste your public ICS URL into ICS_URL below.
 */

// ✅ PASTE your PUBLIC Google Calendar .ics link here
// Example: "https://calendar.google.com/calendar/ical/.../public/basic.ics"
const ICS_URL = "/api/calendar";

/**
 * Filter categories detected from bracket tags at the start of event titles.
 * Example: [Town Hall] Meet & Greet
 */
const FILTERS = {
  ALL: { tags: [] },
  TOWN_HALL: { tags: ["TOWN HALL", "TOWNHALL"] },
  VOLUNTEER: { tags: ["VOLUNTEER"] },
  FUNDRAISER: { tags: ["FUNDRAISER", "FUNDRAISING"] },
  CANVASS: { tags: ["CANVASS"] }
};

let currentFilterKey = "ALL";
let allEvents = [];
let calendar;

/* ---------------------------------------------------------
   Helpers
--------------------------------------------------------- */

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  }[c]));
}

function parseBracketTag(title) {
  // matches "[Something]" at the start
  const m = (title || "").match(/^\s*\[([^\]]+)\]\s*/);
  if (!m) return { tag: "", cleanTitle: title || "" };

  const tag = (m[1] || "").trim().toUpperCase();
  const cleanTitle = (title || "").replace(/^\s*\[[^\]]+\]\s*/, "");
  return { tag, cleanTitle };
}

function matchFilter(eventObj, filterKey) {
  if (filterKey === "ALL") return true;

  const filter = FILTERS[filterKey];
  if (!filter) return true;

  const eventTag = (eventObj.extendedProps?.categoryTag || "").toUpperCase();
  return filter.tags.some(t => t === eventTag);
}

function formatDateRange(event) {
  const optsDate = { weekday: "short", month: "short", day: "numeric", year: "numeric" };
  const optsTime = { hour: "numeric", minute: "2-digit" };

  const start = event.start;
  const end = event.end;

  if (event.allDay) {
    return start.toLocaleDateString(undefined, optsDate);
  }

  const startStr = `${start.toLocaleDateString(undefined, optsDate)} • ${start.toLocaleTimeString(undefined, optsTime)}`;
  if (!end) return startStr;

  const sameDay = start.toDateString() === end.toDateString();
  const endStr = sameDay
    ? end.toLocaleTimeString(undefined, optsTime)
    : `${end.toLocaleDateString(undefined, optsDate)} • ${end.toLocaleTimeString(undefined, optsTime)}`;

  return `${startStr} – ${endStr}`;
}

/* ---------------------------------------------------------
   ICS Load + Parse
--------------------------------------------------------- */

async function loadIcsEvents(icsUrl) {
  const res = await fetch(icsUrl);
  if (!res.ok) throw new Error("Could not load calendar feed.");
  const text = await res.text();

  // Split VEVENT blocks
  const blocks = text.split("BEGIN:VEVENT").slice(1);
  const events = [];

  for (const raw of blocks) {
    const chunk = raw.split("END:VEVENT")[0];

    const get = (key) => {
      const re = new RegExp("^" + key + "(?:;[^:]*)?:(.*)$", "m");
      const match = chunk.match(re);
      return match ? match[1].trim() : "";
    };

    const summaryRaw = get("SUMMARY");
    if (!summaryRaw) continue;

    const description = get("DESCRIPTION")
      .replace(/\\n/g, "\n")
      .replace(/\\,/g, ",")
      .replace(/\\;/g, ";");

    const location = get("LOCATION")
      .replace(/\\n/g, "\n")
      .replace(/\\,/g, ",")
      .replace(/\\;/g, ";");

    const dtStart = get("DTSTART");
    const dtEnd = get("DTEND");

    const parseIcsDate = (v) => {
      if (!v) return null;

      // all-day: YYYYMMDD
      if (/^\d{8}$/.test(v)) {
        const y = v.slice(0, 4), m = v.slice(4, 6), d = v.slice(6, 8);
        return new Date(`${y}-${m}-${d}T00:00:00`);
      }

      // timed: YYYYMMDDTHHMMSSZ (or without Z)
      const iso = v.replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/,
        "$1-$2-$3T$4:$5:$6Z"
      );
      return new Date(iso);
    };

    const start = parseIcsDate(dtStart);
    const end = parseIcsDate(dtEnd);

    if (!start) continue;

    const isAllDay = /^\d{8}$/.test(dtStart);
    const { tag, cleanTitle } = parseBracketTag(summaryRaw);

    events.push({
      title: cleanTitle || summaryRaw,
      start,
      end: end || null,
      allDay: isAllDay,
      extendedProps: {
        description,
        location,
        categoryTag: tag // for filtering
      }
    });
  }

  return events;
}

/* ---------------------------------------------------------
   Details Rendering
--------------------------------------------------------- */

function resetDetails() {
  const details = document.getElementById("details");
  details.innerHTML = `<p class="empty">Select an event to see more information.</p>`;
}

function renderDetails(event) {
  const { description, location, categoryTag } = event.extendedProps || {};
  const details = document.getElementById("details");

  details.innerHTML = `
    <h4 class="detail-title">${escapeHtml(event.title)}</h4>
    <div class="detail-meta">
      ${escapeHtml(formatDateRange(event))}
      ${location ? ` • ${escapeHtml(location)}` : ""}
      ${categoryTag ? ` • ${escapeHtml(categoryTag)}` : ""}
    </div>

    ${
      description
        ? `<div class="detail-desc">${escapeHtml(description)}</div>`
        : `<div class="detail-desc empty">No description provided.</div>`
    }

    <div class="detail-actions">
      <button class="btn" type="button" id="copyBtn">Copy details</button>
    </div>
  `;

  const copyBtn = document.getElementById("copyBtn");
  copyBtn.addEventListener("click", async () => {
    const text = [
      event.title,
      formatDateRange(event),
      location ? `Location: ${location}` : "",
      categoryTag ? `Category: ${categoryTag}` : "",
      description ? `\n${description}` : ""
    ].filter(Boolean).join("\n");

    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy details"), 900);
    } catch {
      copyBtn.textContent = "Copy failed";
      setTimeout(() => (copyBtn.textContent = "Copy details"), 900);
    }
  });
}

/* ---------------------------------------------------------
   Filtering
--------------------------------------------------------- */

function applyFilter(filterKey) {
  currentFilterKey = filterKey;

  // Update pill UI
  document.querySelectorAll(".page-events .filter-pill").forEach(btn => {
    btn.classList.toggle("is-active", btn.dataset.filter === filterKey);
  });

  // Filter events
  const filtered = allEvents.filter(e => matchFilter(e, filterKey));

  // Replace sources
  calendar.getEventSources().forEach(src => src.remove());
  calendar.addEventSource(filtered);

  resetDetails();
}

/* ---------------------------------------------------------
   Boot
--------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", async () => {
  const calendarEl = document.getElementById("calendar");
  const subscribeBtn = document.getElementById("subscribeBtn");
	const popup = document.getElementById("eventPopup");
	document.addEventListener("click", (e) => {
		if (!popup.contains(e.target) && !e.target.closest(".fc-event")) {
			popup.classList.add("hidden");
		}
	});

  // Subscribe button opens ICS feed for users to add to their calendar app
  if (subscribeBtn) {
    subscribeBtn.addEventListener("click", () => {
      if (!ICS_URL || ICS_URL.includes("PASTE_")) {
        alert("ICS URL not configured yet.");
        return;
      }
      window.open(ICS_URL, "_blank", "noopener");
    });
  }

  // FullCalendar init
  calendar = new FullCalendar.Calendar(calendarEl, {
    initialView: "dayGridMonth",
    height: "auto",
    headerToolbar: {
      left: "prev,next today",
      center: "title",
      right: "dayGridMonth,timeGridWeek,listMonth"
    },
    nowIndicator: true,
    eventClick: (info) => {
      info.jsEvent.preventDefault();
      
			const popup = document.getElementById("eventPopup");
			const body = document.getElementById("popupBody");

			const { description, location, categoryTag } = info.event.extendedProps || {};

			body.innerHTML = `
				<h4>${escapeHtml(info.event.title)}</h4>
				<p>${escapeHtml(formatDateRange(info.event))}</p>
				${location ? `<p><strong>Location:</strong> ${escapeHtml(location)}</p>` : ""}
				${categoryTag ? `<p><strong>Category:</strong> ${escapeHtml(categoryTag)}</p>` : ""}
				${description ? `<p>${escapeHtml(description)}</p>` : ""}
			`;

			popup.style.top = info.jsEvent.pageY + "px";
			popup.style.left = info.jsEvent.pageX + "px";
			popup.classList.remove("hidden");
    }
  });

  calendar.render();

  // Bind filter buttons
  document.querySelectorAll(".page-events .filter-pill").forEach(btn => {
    btn.addEventListener("click", () => applyFilter(btn.dataset.filter));
  });

  // Load events
  try {
    if (!ICS_URL || ICS_URL.includes("PASTE_")) {
      const details = document.getElementById("details");
      details.innerHTML =
        `<p class="empty">To activate the calendar, paste your public Google Calendar ICS link into <strong>ICS_URL</strong> in <strong>scripts/events.js</strong>.</p>`;
      return;
    }

    allEvents = await loadIcsEvents(ICS_URL);

    // Optional default: if no [Tag], keep it untagged (still shows in "All")
    // If you want untagged items to appear under a specific filter, set it here.

    applyFilter("ALL");
  } catch (err) {
    console.error(err);
    const details = document.getElementById("details");
    details.innerHTML =
      `<p class="empty">We couldn’t load the events calendar. Please try again later.</p>`;
  }
});
