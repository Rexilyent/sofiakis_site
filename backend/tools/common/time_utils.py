# -------------------------------------------------------------------------------
# Time utilities for release verification and dataset management.
# -------------------------------------------------------------------------------

from datetime import datetime, UTC


def now_iso() -> str:
    return datetime.now(UTC).isoformat() + "Z"

def release_id() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H-%M-%SZ")