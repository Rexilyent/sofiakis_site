import json
from pathlib import Path
from typing import Any


def load_json(path: Path, name: str | None = None) -> Any:
    if not path.exists():
        raise FileNotFoundError(
            f"{name or 'JSON file'} not found at {path}"
        )
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(
    path: Path,
    payload: dict,
    *,
    sort_keys: bool = False,
):
    """
    Write JSON in a consistent, reproducible way.

    - UTF-8 encoding
    - 2-space indentation
    - Optional deterministic key sorting
    """

    path.parent.mkdir(parents=True, exist_ok=True)

    path.write_text(
        json.dumps(
            payload,
            indent=2,
            sort_keys=sort_keys,
        ),
        encoding="utf-8",
    )
