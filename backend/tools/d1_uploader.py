# =================================================
# Aggregate SQLite Shards → Cloudflare D1
# Parallel shard processing + verified uploads w/ cryptographic signatures
#
# Version 1.1.2
#
#   Changelog:
#     - Renamed to d1_uploader.py
#     - Updated to use D1Client v1.1
# =================================================

import sqlite3
import subprocess
import argparse
import os
from pathlib import Path
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed

from common.d1 import D1Client
from common.hashing import dataset_checksum
from common.progress import progress
from common.json_utils import load_json
from common.time_utils import now_iso
from common.release import resolve_release
from common.release_integrity import (
    validate_release_structure,
    validate_manifest_structure,
    validate_manifest_passed,
    validate_shard_counts,
    validate_no_extra_shards,
    validate_checksums_on_disk,
)
from common.audit import (
    build_upload_audit,
    build_insert_sql,
    build_upload_exists_sql,
)

from common.signing import (
    load_public_key,
    verify_manifest_signature,
)

from common.anomaly_logger import AnomalyLogger
from common.anomaly import (
    check_candidate_aggregate,
    check_committee_aggregate,
)

from common.aggregation import (
    aggregate_candidate_shard,
    aggregate_committee_shard,
)

from common.reconciliation import (
    reconcile_candidate_shard,
    reconcile_committee_shard,
)

# ==================================================
# Configuration
# ==================================================

D1_DATABASE_NAME = os.environ.get("D1_DATABASE", "dev-moneytracker-db")
DATA_ROOT = Path("data/fec")
APP_ENV = os.environ.get("APP_ENV", "development").lower()

if APP_ENV in ("dev", "development"):
    TRUSTED_PUBLIC_KEY = Path(os.environ.get("TRUSTED_DEV_KEY", "keys/dev/public.pem"))
elif APP_ENV in ("prod", "production"):
    TRUSTED_PUBLIC_KEY = Path(os.environ.get("TRUSTED_PROD_KEY", "keys/prod/public.pem"))
else:
    raise RuntimeError(f"Unknown APP_ENV: {APP_ENV}")

UPLOADER_VERSION = "uploader-v1.1.2"

BATCH_SIZE = 200
MAX_SQL_STATEMENTS = 400
MAX_WORKERS = max(1, os.cpu_count() - 1)

# ==================================================
# SQL Helpers
# ==================================================

def esc(v):
    if v is None:
        return "NULL"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def insert(table, cols, rows):
    values = [
        f"({', '.join(esc(v) for v in r)})"
        for r in rows
    ]
    return f"""
    INSERT INTO {table}
    ({', '.join(cols)})
    VALUES {', '.join(values)}
    ON CONFLICT DO NOTHING;
    """

# ==================================================
# Release Loading + Integrity Gate
# ==================================================

def load_release(cycle: str, deep_verify: bool):

    release_id, release_root = resolve_release(cycle)

    checksums = load_json(release_root / "checksums.json")
    manifest = load_json(release_root / "manifest.json")

    validate_release_structure(release_root)
    
		# -------------------------------------------------
	  # 🔐 Cryptographic Signature Gate (FIRST)
    # -------------------------------------------------
    
    if not TRUSTED_PUBLIC_KEY.exists():
        raise RuntimeError(
            f"Trusted public key not found: {TRUSTED_PUBLIC_KEY}"
        )
    
    public_key = load_public_key(
			TRUSTED_PUBLIC_KEY.read_bytes()
		)
    
    if not verify_manifest_signature(manifest, public_key):
        raise RuntimeError(
            "Manifest signature verification FAILED"
        )
    
    print(f"✔ Manifest signature verified")
    
		# -------------------------------------------------
    # Integrity checks
    # -------------------------------------------------
		
    validate_manifest_structure(manifest)
    validate_manifest_passed(manifest)
    validate_no_extra_shards(release_root, checksums)

    if deep_verify:
        validate_checksums_on_disk(
            release_root,
            checksums,
            deep=True
        )

    dataset_hash = dataset_checksum(checksums)
    
    signature_block = manifest.get("_signature", {})
    signature_hex = signature_block.get("signature", "")

    return release_root, release_id, manifest, checksums, dataset_hash, signature_hex

# ==================================================
# Entrypoint
# ==================================================

def main():

    parser = argparse.ArgumentParser()
    parser.add_argument("--cycle", required=True)
    parser.add_argument("--deep-verify", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()
    
    d1 = D1Client(dry_run=args.dry_run)

    release_root, release_id, manifest, checksums, checksum, signature_hex = \
        load_release(args.cycle, args.deep_verify)
    
    anomaly_logger = AnomalyLogger(release_id, strict=args.strict)

    candidate_dbs = sorted((release_root / "candidates").glob("*.db"))
    committee_dbs = sorted((release_root / "committees").glob("*.db"))

    actual_candidates = len(candidate_dbs)
    actual_committees = len(
        [db for db in committee_dbs if db.stem != "_UNASSIGNED"]
    )

    validate_shard_counts(
        manifest,
        actual_candidates,
        actual_committees
    )

    cycle = int(args.cycle)
    ts = now_iso()

    # ==================================================
    # Idempotency Gate
    # ==================================================

    if not args.force:
        exists_sql = build_upload_exists_sql(release_id)
        result = d1.scalar(exists_sql)
        if result.strip() not in ("0", ""):
            raise RuntimeError(
                f"Release {release_id} already uploaded."
            )

    print(f"\nParallel processing with {MAX_WORKERS} workers")

    # ==================================================
    # Candidate Upload
    # ==================================================

    completed = 0
    total = actual_candidates

    for batch_start in range(0, total, BATCH_SIZE):
        batch = candidate_dbs[batch_start:batch_start+BATCH_SIZE]
        statements = []

        with ProcessPoolExecutor(MAX_WORKERS) as pool:
            futures = {
                pool.submit(aggregate_candidate_shard, str(db)): str(db)
                for db in batch
						}

            for f in as_completed(futures):
                db_path = futures[f]
                r = f.result()
                # -------------------------------
                # Anomaly check
                # -------------------------------
                issues = check_candidate_aggregate(r)
                
								# -------------------------------
                # Reconciliation check
                # -------------------------------
                issues += reconcile_candidate_shard(db_path, r)
                
								# -------------------------------
                # Log Anomalies
                # -------------------------------
                for code, msg in issues:
                    anomaly_logger.record(
                        shard_id=r["meta"].get("candidate_id"),
                        issue_code=code,
                        message=msg
                    )
                completed += 1
                progress("Candidates", completed, total)

                m = r["meta"]
                cid = m["candidate_id"]

                statements.append(insert(
                    "candidates",
                    ["candidate_id","name","office","party","state",
                     "district","cycle","source","release_id","updated_at"],
                    [[cid, m["name"], m["office"], m["party"],
                      m["state"], m["district"],
                      cycle, m["source"], release_id, ts]]
                ))

                statements.append(insert(
                    "candidate_totals",
                    ["candidate_id","cycle","total_raised_cents",
                     "total_spent_cents","release_id","updated_at"],
                    [[cid, cycle, r["raised"], r["spent"],
                      release_id, ts]]
                ))

                for k,v in r["receipts"].items():
                    statements.append(insert(
                        "candidate_receipt_breakdown",
                        ["candidate_id","cycle","source_type",
                         "amount_cents","release_id","updated_at"],
                        [[cid, cycle, k, v, release_id, ts]]
                    ))

                for k,v in r["spending"].items():
                    statements.append(insert(
                        "candidate_spending_breakdown",
                        ["candidate_id","cycle","spending_type",
                         "amount_cents","release_id","updated_at"],
                        [[cid, cycle, k, v, release_id, ts]]
                    ))

                for cm in r["committees"]:
                    statements.append(insert(
                        "candidate_committee_link",
                        ["candidate_id","committee_id","cycle",
                         "release_id","updated_at"],
                        [[cid, cm, cycle, release_id, ts]]
                    ))

                if len(statements) > MAX_SQL_STATEMENTS:
                    d1.transaction(statements)
                    statements = []

        if statements:
            d1.transaction(statements)

    print("\n✔ Candidates complete")

    # ==================================================
    # Committee Upload
    # ==================================================

    completed = 0
    total = actual_committees

    for batch_start in range(0, len(committee_dbs), BATCH_SIZE):
        batch = committee_dbs[batch_start:batch_start+BATCH_SIZE]
        statements = []

        with ProcessPoolExecutor(MAX_WORKERS) as pool:
            futures = {
                pool.submit(aggregate_committee_shard, str(db)): str(db)
                for db in batch
            }

            for f in as_completed(futures):
                db_path = futures[f]
                r = f.result()
                # -------------------------------
                # Anomaly check
                # -------------------------------
                issues = check_committee_aggregate(r)
                
								# -------------------------------
                # Reconciliation check
                # -------------------------------
                issues += reconcile_committee_shard(db_path, r)
                
								# -------------------------------
                # Log Anomalies
                # -------------------------------
                for code, msg in issues:
                    anomaly_logger.record(
                        shard_id=r["meta"].get("committee_id"),
                        issue_code=code,
                        message=msg
                    )
                if not r:
                    continue

                completed += 1
                progress("Committees", completed, total)

                statements.append(insert(
                    "committee_totals",
                    ["committee_id","cycle","total_raised_cents",
                     "total_spent_cents","release_id","updated_at"],
                    [[r["committee_id"], cycle,
                      r["raised"], r["spent"],
                      release_id, ts]]
                ))

                if len(statements) > MAX_SQL_STATEMENTS:
                    d1.transaction(statements)
                    statements = []

        if statements:
            d1.transaction(statements)
    # ==================================================
    # Upload Audit Record
    # ==================================================

    audit_record = build_upload_audit(
        release_id=release_id,
        cycle=cycle,
        candidate_shards=actual_candidates,
        committee_shards=actual_committees,
        checksum_sha256=checksum,
        uploader_version=UPLOADER_VERSION,
        manifest_signature=signature_hex,
        anomaly_summary=anomaly_logger.summary()
    )

    audit_sql = build_insert_sql(
        audit_record,
        table_name="upload_audit"
    )

    d1.execute(audit_sql)

    print("\n✔ Upload complete and verified")
    print(f"  Release ID: {release_id}")
    print(f"  Dataset SHA256: {checksum}")

if __name__ == "__main__":
    main()
