# =================================================
# Verify FEC SQLite Shard Release
# =================================================
# Verifies:
# - Canonical release via LATEST.json
# - All shard files listed in checksums.json exist
# - Candidate / committee shard counts derived from checksums.json
# - _UNASSIGNED committee shard excluded
# - Manifest validation.summary.passed == true
# - Dataset-level checksum derived from checksums.json
# Includes a progress bar so users know the script is running
# =================================================

import argparse
import json
import hashlib
import sys
from pathlib import Path
from datetime import datetime, UTC

DATA_ROOT = Path("data/fec")

# -------------------------------------------------
# Helpers
# -------------------------------------------------

def die(msg: str):
    raise SystemExit(f"❌ {msg}")

def load_json(path: Path, name: str):
    if not path.exists():
        die(f"{name} not found at {path}")
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as e:
        die(f"Invalid JSON in {name}: {e}")

def dataset_checksum(checksums: dict) -> str:
    """
    Deterministic dataset fingerprint.
    This is what gets stored in upload_audit.checksum_sha256
    """
    return hashlib.sha256(
        json.dumps(checksums, sort_keys=True).encode()
    ).hexdigest()

def progress(label: str, current: int, total: int, width: int = 40):
    if total <= 0:
        return
    filled = int(width * current / total)
    bar = "█" * filled + "░" * (width - filled)
    pct = (current / total) * 100
    sys.stdout.write(
        f"\r{label:<25} [{bar}] {current:,}/{total:,} ({pct:5.1f}%)"
    )
    sys.stdout.flush()
    if current == total:
        print()

# -------------------------------------------------
# Main
# -------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Verify integrity of a split FEC shard release"
    )
    parser.add_argument("--cycle", required=True, help="Election cycle (e.g. 2026)")
    args = parser.parse_args()

    cycle_dir = DATA_ROOT / args.cycle
    if not cycle_dir.exists():
        die(f"Cycle directory does not exist: {cycle_dir}")

    # -------------------------------------------------
    # Resolve canonical release
    # -------------------------------------------------

    latest = load_json(cycle_dir / "LATEST.json", "LATEST.json")
    release_id = latest.get("release")
    if not release_id:
        die("LATEST.json missing 'release' field")

    release_root = cycle_dir / release_id
    if not release_root.exists():
        die(f"Release directory does not exist: {release_root}")

    # -------------------------------------------------
    # Load files
    # -------------------------------------------------

    checksums = load_json(release_root / "checksums.json", "checksums.json")
    manifest = load_json(release_root / "manifest.json", "manifest.json")

    # -------------------------------------------------
    # Manifest validation gate
    # -------------------------------------------------

    summary = manifest.get("validation", {}).get("summary")
    if not summary:
        die("manifest.json missing validation.summary")

    if summary.get("passed") is not True:
        die("Manifest validation failed (summary.passed != true)")

    # -------------------------------------------------
    # Derive shard expectations from checksums.json
    # -------------------------------------------------

    candidate_keys = [
        k for k in checksums.keys()
        if k.startswith("candidates\\") and k.endswith(".db")
    ]

    committee_keys = [
        k for k in checksums.keys()
        if k.startswith("committees\\")
        and k.endswith(".db")
        and not k.endswith("_UNASSIGNED.db")
    ]

    expected_candidates = len(candidate_keys)
    expected_committees = len(committee_keys)

    if expected_candidates == 0:
        die("No candidate shards found in checksums.json")

    # -------------------------------------------------
    # Verify shard files exist on disk (with progress)
    # -------------------------------------------------

    print("Verifying shard files on disk...")
    total = len(checksums)
    checked = 0
    missing = []

    for rel_path in checksums.keys():
        checked += 1
        shard_path = release_root / Path(rel_path)

        if not shard_path.exists():
            missing.append(rel_path)

        if checked == 1 or checked % 100 == 0 or checked == total:
            progress("Shard verification", checked, total)

    if missing:
        die(
            "Missing shard files:\n"
            + "\n".join(f"  - {m}" for m in missing)
        )

    # -------------------------------------------------
    # Dataset-level checksum
    # -------------------------------------------------

    full_checksum = dataset_checksum(checksums)

    # -------------------------------------------------
    # Success output
    # -------------------------------------------------

    print("\n✔ Release verification passed")
    print(f"  Cycle:              {args.cycle}")
    print(f"  Release ID:         {release_id}")
    print(f"  Candidate shards:   {expected_candidates}")
    print(f"  Committee shards:   {expected_committees}")
    print(f"  Dataset SHA-256:    {full_checksum}")
    print(f"  Verified at:        {datetime.now(UTC).isoformat()}Z")

if __name__ == "__main__":
    main()
