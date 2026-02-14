# =================================================
# Verify / Compare FEC SQLite Shard Releases
# =================================================
# Version: 0.0.2
#  - Added support for cryptographic signature verification
#
# Supports:
#   --cycle
#   --release-id
#   --deep
#   --compare RELEASE_A RELEASE_B
#   --public-key PATH
# =================================================

import os
import argparse
import sqlite3
from pathlib import Path
from common.hashing import sha256_file, dataset_checksum
from common.progress import progress
from common.release import resolve_release
from common.json_utils import load_json
from common.time_utils import now_iso

# 🔐 Integrity Engine
from common.release_integrity import (
    validate_manifest_structure,
    validate_manifest_passed,
    validate_release_structure,
    validate_no_extra_shards,
    validate_checksums_on_disk,
    validate_dataset_fingerprint,
)

# 🔏 Signature Engine
from common.signing import (
    load_public_key,
    verify_manifest_signature,
)

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

def compare_releases(cycle: str, release_a: str, release_b: str, deep: bool, public_key_path: Path):

    id_a, root_a = resolve_release(cycle, release_a)
    id_b, root_b = resolve_release(cycle, release_b)

    print(f"Comparing releases:")
    print(f"  A: {id_a}")
    print(f"  B: {id_b}")
    print()

    # Verify both manifests before comparing
    for rel_id, rel_root in [(id_a, root_a), (id_b, root_b)]:
        manifest = load_json(rel_root / "manifest.json")
        public_key = load_public_key(public_key_path.read_bytes())

        if not verify_manifest_signature(manifest, public_key):
            die(f"Manifest signature invalid for release {rel_id}")

        print(f"✔ Signature verified for {rel_id}")

    checksums_a = load_json(root_a / "checksums.json")
    checksums_b = load_json(root_b / "checksums.json")

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

# ==================================================
# Single Release Verification
# ==================================================

def verify_release(cycle: str, release_id: str | None, deep: bool, public_key_path: Path):

    release_id, release_root = resolve_release(cycle, release_id)

    manifest = load_json(release_root / "manifest.json")
    checksums = load_json(release_root / "checksums.json")
    
		# -------------------------------------------------
    # 🔐 Cryptographic Signature Verification (FIRST)
    # -------------------------------------------------

    if not public_key_path.exists():
        die(f"Trusted public key not found: {public_key_path}")

    public_key = load_public_key(public_key_path.read_bytes())

    if not verify_manifest_signature(manifest, public_key):
        die("Manifest signature verification FAILED")

    print("✔ Manifest cryptographic signature verified")


    # -------------------------------------------------
    # Integrity Checks (delegated to release_integrity)
    # -------------------------------------------------

    try:
        validate_release_structure(release_root)
        validate_manifest_structure(manifest)
        validate_manifest_passed(manifest)
        validate_no_extra_shards(release_root, checksums)
        validate_checksums_on_disk(release_root, checksums, deep=deep)
    except Exception as e:
        die(str(e))

    # -------------------------------------------------
    # Shard Counting (for audit/logging output only)
    # -------------------------------------------------

    total = len(checksums)
    checked = 0

    print("Verifying shard files on disk...")
    if deep:
        print("⚠ Deep verification enabled")

    for _ in checksums.keys():
        checked += 1
        if checked == 1 or checked % 100 == 0 or checked == total:
            progress("Shard verification", checked, total)

    # Derive shard counts
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

    full_checksum = validate_dataset_fingerprint(checksums)

    print("\n✔ Release verification passed")
    print(f"  Cycle:            {cycle}")
    print(f"  Candidate Shards: {len(candidate_keys)}")
    print(f"  Committee Shards: {len(committee_keys)}")
    print(f"  Total Shards:     {len(checksums)}")
    print(f"  Release ID:       {release_id}")
    print(f"  Dataset SHA-256:  {full_checksum}")
    print(f"  Verified at:      {now_iso()}")
    
# ==================================================
# Main Entrypoint
# ==================================================

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
    
		# Public key resolution
    public_key_path = Path(
        args.public_key
        or os.environ.get("TRUSTED_PUBLIC_KEY")
        or "keys/prod/public.pem"
    )


    # Compare mode
    if args.compare:
        compare_releases(
            args.cycle,
            args.compare[0],
            args.compare[1],
            args.deep
        )
        return

    # Single verification mode
    verify_release(
        args.cycle,
        args.release_id,
        args.deep
    )


if __name__ == "__main__":
    main()