# =================================================
# Verify / Compare FEC SQLite Shard Releases
# =================================================
# Supports:
#   --cycle
#   --release-id
#   --deep
#   --compare RELEASE_A RELEASE_B
# =================================================

import argparse
import sys
import sqlite3
from pathlib import Path
from common.hashing import sha256_file, dataset_checksum
from common.progress import progress
from common.release import resolve_release
from common.json_utils import load_json
from common.time_utils import now_iso

DATA_ROOT = Path("data/fec")
READ_CHUNK = 1024 * 1024

# -------------------------------------------------
# Helpers
# -------------------------------------------------

def die(msg: str):
    raise SystemExit(f"❌ {msg}")

# -------------------------------------------------
# Transaction Summary (used for deep comparison)
# -------------------------------------------------

def shard_summary(path: Path):
    conn = sqlite3.connect(path)
    cur = conn.cursor()
    try:
        cur.execute("SELECT COUNT(*), COALESCE(SUM(amount_cents),0) FROM transactions")
        count, total = cur.fetchone()
    except Exception:
        count, total = 0, 0
    conn.close()
    return count, total

# -------------------------------------------------
# Compare Mode
# -------------------------------------------------

def compare_releases(cycle: str, release_a: str, release_b: str, deep: bool):

    id_a, root_a = resolve_release(cycle, release_a)
    id_b, root_b = resolve_release(cycle, release_b)

    print(f"Comparing releases:")
    print(f"  A: {id_a}")
    print(f"  B: {id_b}")
    print()

    checksums_a = load_json(root_a / "checksums.json", "checksums.json (A)")
    checksums_b = load_json(root_b / "checksums.json", "checksums.json (B)")

    keys_a = set(checksums_a.keys())
    keys_b = set(checksums_b.keys())

    added = keys_b - keys_a
    removed = keys_a - keys_b
    common = keys_a & keys_b

    changed = [
        k for k in common
        if checksums_a[k] != checksums_b[k]
    ]

    print("File-level differences:")
    print(f"  Added:   {len(added)}")
    print(f"  Removed: {len(removed)}")
    print(f"  Changed: {len(changed)}")

    if deep and changed:
        print("\nDeep transaction comparison:")
        for rel_path in changed:
            path_a = root_a / Path(rel_path)
            path_b = root_b / Path(rel_path)

            if not path_a.exists() or not path_b.exists():
                continue

            count_a, total_a = shard_summary(path_a)
            count_b, total_b = shard_summary(path_b)

            if count_a != count_b or total_a != total_b:
                print(f"\n  {rel_path}")
                print(f"    Rows:   {count_a} → {count_b}")
                print(f"    Total:  {total_a} → {total_b}")

    print("\n✔ Comparison complete")
    return

# -------------------------------------------------
# Main
# -------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cycle", required=True)
    parser.add_argument("--release-id")
    parser.add_argument("--deep", action="store_true")
    parser.add_argument(
        "--compare",
        nargs=2,
        metavar=("RELEASE_A", "RELEASE_B"),
        help="Compare two releases"
    )
    args = parser.parse_args()

    # --------------------------------------------
    # Compare mode
    # --------------------------------------------

    if args.compare:
        compare_releases(args.cycle, args.compare[0], args.compare[1], args.deep)
        return

    # --------------------------------------------
    # Single-release verification
    # --------------------------------------------

    release_id, release_root = resolve_release(args.cycle, args.release_id)

    manifest = load_json(release_root / "manifest.json", "manifest.json")
    checksums = load_json(release_root / "checksums.json", "checksums.json")

    summary = manifest.get("validation", {}).get("summary")
    if not summary or summary.get("passed") is not True:
        die("Manifest validation failed")

    total = len(checksums)
    checked = 0
    missing = []
    mismatched = []

    print("Verifying shard files on disk...")
    if args.deep:
        print("⚠ Deep verification enabled")

    for rel_path, expected_hash in checksums.items():
        checked += 1
        shard_path = release_root / Path(rel_path)

        if not shard_path.exists():
            missing.append(rel_path)
        elif args.deep:
            actual_hash = sha256_file(shard_path)
            if actual_hash != expected_hash:
                mismatched.append(rel_path)

        if checked == 1 or checked % 100 == 0 or checked == total:
            progress("Shard verification", checked, total)

    if missing:
        die(f"Missing shard files: {len(missing)}")

    if mismatched:
        die(f"Checksum mismatches: {len(mismatched)}")
        
		# -----------------------------------------------------------
    # Derive shard counts (for audit/logging purposes)
    # -----------------------------------------------------------
    
    candidate_keys = [
        k for k in checksums.keys()
        if k.startswith("candidates\\") and k.endswith(".db")
		]
        
    committee_keys = [
				k for k in checksums.keys()
				if k.startswith("committees\\") and k.endswith(".db") and not k.endswith("_UNASSIGNED.db")
		]

    full_checksum = dataset_checksum(checksums)

    print("\n✔ Release verification passed")
    print(f"  Cycle:            {args.cycle}")
    print(f"  Candidate Shards: {len(candidate_keys)}")
    print(f"  Committee Shards: {len(committee_keys)}")
    print(f"  Total Shards:     {len(checksums)}")
    print(f"  Release ID:       {release_id}")
    print(f"  Dataset SHA-256:  {full_checksum}")
    print(f"  Verified at:      {now_iso()}")

if __name__ == "__main__":
    main()
