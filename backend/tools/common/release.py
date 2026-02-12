# -------------------------------------------------------------------------------
# Release resolution and loading utilities for FEC dataset management.
# -------------------------------------------------------------------------------

from pathlib import Path
from .json_utils import load_json

DATA_ROOT = Path("data/fec")


def resolve_release(cycle: str, release_id: str | None = None):
    cycle_dir = DATA_ROOT / cycle
    if not cycle_dir.exists():
        raise RuntimeError(f"Cycle directory missing: {cycle_dir}")

    if not release_id:
        latest = load_json(cycle_dir / "LATEST.json", "LATEST.json")
        release_id = latest.get("release")

    release_root = cycle_dir / release_id

    if not release_root.exists():
        raise RuntimeError(f"Release directory missing: {release_root}")

    return release_id, release_root


def load_release_bundle(cycle: str):
    release_id, release_root = resolve_release(cycle)

    manifest = load_json(release_root / "manifest.json", "manifest.json")
    checksums = load_json(release_root / "checksums.json", "checksums.json")

    return release_id, release_root, manifest, checksums
