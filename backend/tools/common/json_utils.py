# -------------------------------------------------------------------------------
# JSON utilities for loading and writing dataset metadata and release information.
# -------------------------------------------------------------------------------

import json
from pathlib import Path


def load_json(path: Path, name: str | None = None):
    if not path.exists():
        raise FileNotFoundError(
            f"{name or 'JSON file'} not found at {path}"
        )
    return json.loads(path.read_text())


def write_json(path: Path, payload: dict):
    path.write_text(json.dumps(payload, indent=2))
