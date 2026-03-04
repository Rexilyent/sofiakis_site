#!/usr/bin/env python3
"""
=================================================
Build Static Events JSON (Pre-Geocoded)
-------------------------------------------------
- Fetch Google Calendar ICS
- Parse events
- Geocode unique locations (rate-limited)
- Output pages/public/data/events.json
=================================================
"""

import os
import re
import json
import time
import hashlib
import requests
from pathlib import Path
from datetime import datetime
from urllib.parse import quote
from dotenv import load_dotenv

load_dotenv()

# =================================================
# Configuration
# =================================================

ICS_URL = os.environ.get("GOOGLE_CALENDAR_ICS")

OUTPUT_PATH = Path("pages/public/data/events.json")
CACHE_PATH = Path("backend/tools/.geocode_cache.json")

USER_AGENT = "alexandriaforil10.com build script"

GEOCODE_ENDPOINT = (
    "https://nominatim.openstreetmap.org/search"
)


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
        json.dumps(payload, indent=2, sort_keys=True),
        encoding="utf-8"
    )


def normalize_location(location: str) -> str:
    return location.strip().lower()


# =================================================
# ICS Parsing
# =================================================

def parse_ics(text: str):
    blocks = text.split("BEGIN:VEVENT")[1:]
    events = []

    for raw in blocks:
        chunk = raw.split("END:VEVENT")[0]

        def get(key):
            match = re.search(
                rf"^{key}(?:;[^:]*)?:(.*)$",
                chunk,
                re.MULTILINE
            )
            return match.group(1).strip() if match else ""

        summary = get("SUMMARY")
        if not summary:
            continue

        description = (
            get("DESCRIPTION")
            .replace("\\n", "\n")
            .replace("\\,", ",")
            .replace("\\;", ";")
        )

        location = (
            get("LOCATION")
            .replace("\\n", "\n")
            .replace("\\,", ",")
            .replace("\\;", ";")
        )

        dtstart = get("DTSTART")
        dtend = get("DTEND")

        events.append({
            "title": summary,
            "description": description,
            "location": location,
            "start_raw": dtstart,
            "end_raw": dtend
        })

    return events


def parse_ics_date(value: str):
    if not value:
        return None

    # All-day YYYYMMDD
    if re.match(r"^\d{8}$", value):
        return datetime.strptime(value, "%Y%m%d").date().isoformat()

    # UTC datetime
    match = re.match(
        r"^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$",
        value
    )
    if not match:
        return value

    y, m, d, hh, mm, ss = match.groups()
    dt = datetime(
        int(y), int(m), int(d),
        int(hh), int(mm), int(ss)
    )

    return dt.isoformat()


# =================================================
# Geocoding
# =================================================

def geocode_location(location: str):
    response = requests.get(
        GEOCODE_ENDPOINT,
        params={
            "format": "json",
            "limit": 1,
            "q": location
        },
        headers={
            "User-Agent": USER_AGENT
        },
        timeout=10
    )

    if response.status_code != 200:
        print(f"⚠ Geocode failed ({response.status_code}) for {location}")
        return None

    results = response.json()

    if not results:
        print(f"⚠ No geocode result for {location}")
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

    print("📥 Fetching ICS...")
    ics_response = requests.get(
        ICS_URL,
        headers={"User-Agent": USER_AGENT},
        timeout=20
    )

    if ics_response.status_code != 200:
        die("Failed to fetch ICS")

    events_raw = parse_ics(ics_response.text)
    print(f"✔ Parsed {len(events_raw)} events")

    geocode_cache = load_json(CACHE_PATH)

    unique_locations = sorted({
        normalize_location(e["location"])
        for e in events_raw
        if e["location"]
    })

    print(f"🌍 Geocoding {len(unique_locations)} unique locations")

    for loc in unique_locations:

        if loc in geocode_cache:
            continue

        print(f"  → {loc}")
        coords = geocode_location(loc)

        geocode_cache[loc] = coords

        time.sleep(1)  # Respect Nominatim rate limit

    write_json(CACHE_PATH, geocode_cache)

    enriched = []

    for e in events_raw:
        norm_loc = normalize_location(e["location"]) if e["location"] else None

        enriched.append({
            "title": e["title"],
            "description": e["description"],
            "location": e["location"],
            "start": parse_ics_date(e["start_raw"]),
            "end": parse_ics_date(e["end_raw"]),
            "coords": geocode_cache.get(norm_loc) if norm_loc else None
        })

    # Deterministic sort
    enriched.sort(key=lambda x: (x["start"] or "", x["title"]))

    write_json(OUTPUT_PATH, enriched)

    print("✔ events.json generated successfully")
    print(f"📁 Output: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()