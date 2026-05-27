#!/usr/bin/env python3
"""
=================================================
Build Static Events JSON (Pre-Geocoded)
-------------------------------------------------
- Fetch Google Calendar ICS
- Parse events (with RFC 5545 line-unfolding)
- Geocode unique locations (rate-limited)
- Output pages/public/data/events.json
=================================================

This script is intended to be run as part of the build process
for alexandriasofiakis.com. It fetches events from a Google Calendar
ICS feed, parses them, geocodes their locations using OpenStreetMap's
Nominatim API, and outputs a structured JSON file for use on the frontend.

Configuration is done via environment variables, and geocoding results
are cached to avoid redundant API calls. The output JSON includes event
details along with geocoded coordinates when available.

==================================================
Requirements:
- Python 3.8+
- pip install requests python-dotenv

==================================================
Environment Variables:
- GOOGLE_CALENDAR_ICS: URL to the public Google Calendar ICS feed
  (Calendar must be set to public in Google Calendar settings)

==================================================
Event Title Format:
  [CATEGORY] Event Name
  e.g. "[TOWN_HALL] Waukegan Community Meeting"

  Valid categories: TOWN_HALL, VOLUNTEER, FUNDRAISER, CANVASS
  Events without a valid category bracket are still included
  but will not match any filter pill on the events page.

==================================================
Usage:
  python build_events.py
==================================================
"""

import os
import re
import json
import time
import requests
from pathlib import Path
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv

load_dotenv()

# =================================================
# Configuration
# =================================================

ICS_URL     = os.environ.get("GOOGLE_CALENDAR_ICS")
OUTPUT_PATH = Path("pages/public/data/events.json")
CACHE_PATH  = Path("backend/tools/.geocode_cache.json")

USER_AGENT        = "alexandriasofiakis.com build script"
GEOCODE_ENDPOINT  = "https://nominatim.openstreetmap.org/search"

# Categories that map to filter pills on the events page
VALID_CATEGORIES = {"TOWN_HALL", "VOLUNTEER", "FUNDRAISER", "CANVASS"}

# =================================================
# Utilities
# =================================================

def die(msg: str):
    raise SystemExit(f"❌ {msg}")


def load_json(path: Path):
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False),
        encoding="utf-8"
    )


def normalize_location(location: str) -> str:
    return location.strip().lower()


# =================================================
# ICS Line Unfolding  (RFC 5545 §3.1)
# =================================================
# Google Calendar folds long property values at 75 octets:
#   SUMMARY:A very long title that gets cut off here\r\n
#    and continued on this line
#
# We must join those continuation lines before parsing,
# otherwise the regex only sees the first fragment.

def unfold_ics(text: str) -> str:
    """
    Normalize CRLF → LF, then remove fold continuations
    (a line beginning with a single space or tab is a
    continuation of the previous line per RFC 5545).
    """
    # Normalize line endings to \n
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # Remove fold: \n followed by a single space or tab
    text = re.sub(r"\n[ \t]", "", text)
    return text


# =================================================
# ICS Parsing
# =================================================

def parse_ics(raw_text: str):
    text   = unfold_ics(raw_text)
    blocks = text.split("BEGIN:VEVENT")[1:]
    events = []

    for raw in blocks:
        chunk = raw.split("END:VEVENT")[0]

        def get(key: str, _chunk: str = chunk) -> str:
            """
            Extract the value of an ICS property by name.
            Handles optional parameters: KEY;PARAM=val:value
            """
            match = re.search(
                rf"^{re.escape(key)}(?:;[^:\r\n]*)?:(.*)$",
                _chunk,
                re.MULTILINE
            )
            if not match:
                return ""
            return match.group(1).strip()

        # ── Required field — skip event if missing ────────
        summary = get("SUMMARY")
        if not summary:
            continue

        # ── Unescape ICS text fields ──────────────────────
        def unescape(s: str) -> str:
            return (
                s.replace("\\n", "\n")
                 .replace("\\N", "\n")
                 .replace("\\,", ",")
                 .replace("\\;", ";")
                 .replace("\\\\", "\\")
            )

        description = unescape(get("DESCRIPTION"))
        location    = unescape(get("LOCATION"))
        dtstart     = get("DTSTART")
        dtend       = get("DTEND")
        uid         = get("UID")
        url         = get("URL")

        # ── Parse [CATEGORY] bracket prefix from title ────
        bracket = re.match(r"^\[([A-Z_]+)\]\s*", summary)
        if bracket:
            category   = bracket.group(1)
            clean_title = summary[bracket.end():].strip()
        else:
            category   = ""
            clean_title = summary.strip()

        events.append({
            "uid":         uid,
            "title":       clean_title,
            "full_title":  summary,       # original with bracket, for debugging
            "category":    category if category in VALID_CATEGORIES else "",
            "description": description,
            "location":    location,
            "start_raw":   dtstart,
            "end_raw":     dtend,
            "url":         url
        })

    return events


def parse_ics_date(value: str) -> str | None:
    """
    Parse an ICS date/datetime value into an ISO 8601 string.
    Handles:
      - All-day:   YYYYMMDD
      - UTC:       YYYYMMDDTHHmmssZ
      - Local/TZ:  YYYYMMDDTHHmmss  (TZID carried separately — treated as local)
    """
    if not value:
        return None

    value = value.strip()

    # All-day: YYYYMMDD
    if re.match(r"^\d{8}$", value):
        try:
            return datetime.strptime(value, "%Y%m%d").date().isoformat()
        except ValueError:
            return value

    # UTC: YYYYMMDDTHHmmssZ
    m = re.match(r"^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$", value)
    if m:
        y, mo, d, hh, mm, ss = (int(x) for x in m.groups())
        return datetime(y, mo, d, hh, mm, ss, tzinfo=timezone.utc).isoformat()

    # Local / TZID (no Z suffix) — YYYYMMDDTHHmmss
    m = re.match(r"^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$", value)
    if m:
        y, mo, d, hh, mm, ss = (int(x) for x in m.groups())
        return datetime(y, mo, d, hh, mm, ss).isoformat()

    # Fallback — return as-is
    return value


# =================================================
# Geocoding
# =================================================

def geocode_location(location: str) -> dict | None:
    try:
        response = requests.get(
            GEOCODE_ENDPOINT,
            params={"format": "json", "limit": 1, "q": location},
            headers={"User-Agent": USER_AGENT},
            timeout=10
        )
    except requests.RequestException as e:
        print(f"  ⚠ Geocode request error for '{location}': {e}")
        return None

    if response.status_code != 200:
        print(f"  ⚠ Geocode HTTP {response.status_code} for '{location}'")
        return None

    results = response.json()
    if not results:
        print(f"  ⚠ No geocode result for '{location}'")
        return None

    return {
        "lat": float(results[0]["lat"]),
        "lon": float(results[0]["lon"])
    }


# =================================================
# Main Build
# =================================================

def main():
    if not ICS_URL:
        die("GOOGLE_CALENDAR_ICS environment variable not set")

    # ── Fetch ICS ─────────────────────────────────────────
    print("📥 Fetching ICS...")
    try:
        ics_response = requests.get(
            ICS_URL,
            headers={"User-Agent": USER_AGENT},
            timeout=20
        )
    except requests.RequestException as e:
        die(f"Network error fetching ICS: {e}")

    if ics_response.status_code != 200:
        die(
            f"Failed to fetch ICS — HTTP {ics_response.status_code}\n"
            f"Make sure the calendar is set to public in Google Calendar settings."
        )

    # ── Parse events ──────────────────────────────────────
    events_raw = parse_ics(ics_response.text)
    print(f"✔ Parsed {len(events_raw)} event(s)")

    if not events_raw:
        print("⚠ No events found. Check that the calendar has events and the ICS URL is correct.")
        write_json(OUTPUT_PATH, [])
        return

    # Debug: show what was found
    for e in events_raw:
        cat_tag  = f"[{e['category']}] " if e["category"] else "[no category] "
        loc_tag  = f"@ {e['location']}"  if e["location"] else "(no location)"
        print(f"  • {cat_tag}{e['title']} — {e['start_raw'][:8] if e['start_raw'] else '?'} {loc_tag}")

    # ── Geocode unique locations ──────────────────────────
    geocode_cache = load_json(CACHE_PATH)

    unique_locations = sorted({
        normalize_location(e["location"])
        for e in events_raw
        if e["location"]
    })

    new_geocodes = [loc for loc in unique_locations if loc not in geocode_cache]

    if new_geocodes:
        print(f"\n🌍 Geocoding {len(new_geocodes)} new location(s)...")
        for loc in new_geocodes:
            print(f"  → {loc}")
            coords = geocode_location(loc)
            geocode_cache[loc] = coords
            time.sleep(1)   # Respect Nominatim rate limit (1 req/s)
        write_json(CACHE_PATH, geocode_cache)
        print(f"  ✔ Geocode cache updated")
    else:
        print(f"✔ All {len(unique_locations)} location(s) already cached")

    # ── Assemble output ───────────────────────────────────
    enriched = []
    for e in events_raw:
        norm_loc = normalize_location(e["location"]) if e["location"] else None
        start    = parse_ics_date(e["start_raw"])
        end      = parse_ics_date(e["end_raw"])

        enriched.append({
            "title":       e["title"],
            "category":    e["category"],
            "description": e["description"],
            "location":    e["location"],
            "start":       start,
            "end":         end,
            "url":         e["url"] or None,
            "coords":      geocode_cache.get(norm_loc) if norm_loc else None
        })

    # Sort ascending by start date, then title
    enriched.sort(key=lambda x: (x["start"] or "", x["title"]))

    write_json(OUTPUT_PATH, enriched)
    print(f"\n✔ events.json written — {len(enriched)} event(s)")
    print(f"📁 {OUTPUT_PATH}")


if __name__ == "__main__":
    main()