# -------------------------------------------------------------------------------
# Time utilities for release verification and dataset management.
# Handles flexible date parsing and timestamp generation.
# -------------------------------------------------------------------------------

from datetime import datetime, UTC
from typing import Optional


# ==================================================
# Timestamp Helpers
# ==================================================

def now_iso() -> str:
    return datetime.now(UTC).isoformat() + "Z"


def release_id() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H-%M-%SZ")


# ==================================================
# Flexible Date Parsing
# ==================================================

SUPPORTED_FORMATS = [
    "%Y%m%d",     # 20260115
    "%m%d%Y",     # 01152026
    "%Y-%m-%d",   # 2026-01-15
    "%m/%d/%Y",   # 01/15/2026
]


def parse_date_flexible(date_str: str) -> Optional[datetime]:
    """
    Attempt to parse a date string using known formats.
    Returns datetime object or None.
    """

    if not date_str:
        return None

    for fmt in SUPPORTED_FORMATS:
        try:
            return datetime.strptime(date_str, fmt)
        except ValueError:
            continue

    return None


def extract_year(date_str: str) -> Optional[int]:
    """
    Extract year from flexible date string.
    """
    dt = parse_date_flexible(date_str)
    return dt.year if dt else None
