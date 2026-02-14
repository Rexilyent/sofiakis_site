# ================================================================================
# Release Integrity & Validation Utilities
# ================================================================================

import datetime
from pathlib import Path
from typing import Dict
from common.hashing import sha256_file, dataset_checksum

# -------------------------------------------------------------------------------
# Manifest validation
# -------------------------------------------------------------------------------

def validate_manifest_structure(manifest: dict):
	"""
	Ensures required top-level manifest keys exist.
	"""
	required = ["cycle", "release_id", "generated_at", "schema_version", "validation"]
	for key in required:
		if key not in manifest:
			raise ValueError(f"Manifest missing required key: {key}")
		
def validate_manifest_passed(manifest: dict):
	"""
	Ensures embedded validation summary passed.
	"""
	summary = manifest.get("validation", {}).get("summary")
	if not summary:
		raise RuntimeError("Manifest validation summary missing")
	
	if summary.get("passed") is not True:
		raise RuntimeError("Manifest validation did not pass")
	
# -------------------------------------------------------------------------------
# Schema Version Validation
# -------------------------------------------------------------------------------

def validate_schema_version(manifest: dict, expected_version: str):
	"""
	Validates manifest schema version matches expected.
	"""
	actual = manifest.get("schema_version")
	if actual != expected_version:
		raise RuntimeError(
			f"Schema version mismatch:\n"
			f"expected {expected_version}\n"
			f"found {actual}"
		)
	
# -------------------------------------------------------------------------------
# Shard Count Verification
# -------------------------------------------------------------------------------

def validate_shard_counts(
		manifest: dict,
		candidate_count: int,
		committee_count: int
):
	"""
	Validates shard counts in manifest against expected counts.
	"""
	expected_candidates = manifest.get("candidate_count")
	expected_committees = manifest.get("committee_count")
	
	if expected_candidates is None or expected_committees is None:
		raise RuntimeError("Manifest missing shard counts")
	
	if candidate_count != expected_candidates:
		raise RuntimeError(
			f"Candidate shard count mismatch: expected {expected_candidates}, "
			f"found {candidate_count}")
	
	if committee_count != expected_committees:
		raise RuntimeError(
			f"Committee shard count mismatch: expected {expected_committees}, "
			f"found {committee_count}")
	
# -------------------------------------------------------------------------------
# Extra Shard Detection
# -------------------------------------------------------------------------------

def validate_no_extra_shards(
    release_root: Path,
    checksums: Dict[str, str]
):
    actual_files = {
        str(p.relative_to(release_root))
        for p in release_root.rglob("*.db")
    }

    expected_files = set(checksums.keys())

    extras = actual_files - expected_files

    if extras:
        raise RuntimeError(
            f"Unexpected shard files detected: {len(extras)}")

# -------------------------------------------------------------------------------
# Checksum Validation
# -------------------------------------------------------------------------------

def validate_checksums_on_disk(
		release_root: Path,
		checksums: Dict[str, str],
		deep: bool = False
):
	"""
	Validates that all shard files exist.
	If deep=True, recomputes hashes and compares.
	"""

	missing = []
	mismatched = []
	
	for rel_path, expected_hash in checksums.items():
		shard_path = release_root / Path(rel_path)

		if not shard_path.exists():
			missing.append(rel_path)
			continue
		
		if deep:
			actual_hash = sha256_file(shard_path)
			if actual_hash != expected_hash:
				mismatched.append(rel_path)

	if missing:
		raise RuntimeError(f"Missing shard files: {len(missing)}")
	
	if mismatched:
		raise RuntimeError(f"Checksum mismatches: {len(mismatched)}")
	
# -------------------------------------------------------------------------------
# Dataset Fingerprint Validation
# -------------------------------------------------------------------------------

def validate_dataset_fingerprint(
		checksums: Dict[str, str],
		expected_hash: str | None = None
) -> str:
	"""
	Computes dataset-level SHA256 and optionally compares to an expected hash.
	"""
	computed = dataset_checksum(checksums)
	
	if expected_hash and computed != expected_hash:
		raise RuntimeError(
			f"Dataset fingerprint mismatch:\n"
			f"expected {expected_hash}\n"
			f"computed {computed}")
	
	return computed

# -------------------------------------------------------------------------------
# Release Root Validation
# -------------------------------------------------------------------------------

def validate_release_structure(release_root: Path):
	"""
	Ensures expected director layout exists.
	"""
	required_dirs = ["candidates", "committees"]

	for d in required_dirs:
		if not (release_root / d).exists():
			raise RuntimeError(f"Missing required directory: {d}")
		
# -------------------------------------------------------------------------------
# Release Size Validation
# -------------------------------------------------------------------------------

def validate_total_shard_size(
    release_root: Path,
    max_mb: int = 1024
):
    total_bytes = sum(
        p.stat().st_size
        for p in release_root.rglob("*.db")
    )

    total_mb = total_bytes / (1024 * 1024)

    if total_mb > max_mb:
        raise RuntimeError(
            f"Release size {total_mb:.2f} MB exceeds limit of {max_mb} MB"
        )

    return total_mb

# -------------------------------------------------------------------------------
# Release Timestamp Sanity Check
# -------------------------------------------------------------------------------

def validate_release_timestamp(manifest: dict):
    ts = manifest.get("generated_at")

    try:
        datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        raise RuntimeError("Invalid manifest generated_at timestamp")
		
# -------------------------------------------------------------------------------
# Full Pre-Upload Gate
# -------------------------------------------------------------------------------

def validate_release_for_upload(
    release_root: Path,
    manifest: dict,
    checksums: Dict[str, str],
    candidate_count: int,
    committee_count: int,
		expected_schema_version: int,
    deep: bool = False
) -> str:
    """
    Full integrity gate before D1 upload.
    """

    validate_release_structure(release_root)
    validate_manifest_structure(manifest)
    validate_manifest_passed(manifest)
    validate_schema_version(manifest, expected_schema_version)
    validate_release_timestamp(manifest)
    validate_shard_counts(manifest, candidate_count, committee_count)
    validate_no_extra_shards(release_root, checksums)
    validate_checksums_on_disk(release_root, checksums, deep)

    return validate_dataset_fingerprint(checksums)