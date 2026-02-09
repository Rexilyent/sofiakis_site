# =================================================
# Aggregate SQLite Shards → Cloudflare D1
# Parallel shard processing + verified uploads
# =================================================

import sqlite3
import subprocess
import argparse
import hashlib
import json
import sys
import os
from pathlib import Path
from datetime import datetime, UTC
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor, as_completed

# ==================================================
# Configuration
# ==================================================

D1_DATABASE_NAME = os.environ.get("D1_DATABASE", "dev-moneytracker-db")
DATA_ROOT = Path("data/fec")
UPLOADER_VERSION = "uploader-v1.1"

BATCH_SIZE = 200
MAX_SQL_STATEMENTS = 400
MAX_WORKERS = max(1, os.cpu_count() - 1)

# ==================================================
# Utilities
# ==================================================

def run_d1_sql(sql: str):
    proc = subprocess.run(
        ["wrangler", "d1", "execute", D1_DATABASE_NAME, "--file=-"],
        input=sql.encode(),
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode())

def now():
    return datetime.now(UTC).isoformat() + "Z"

# ==================================================
# Progress bar
# ==================================================

def progress(label, current, total, width=40):
    filled = int(width * current / total) if total else width
    bar = "█" * filled + "░" * (width - filled)
    pct = (current / total * 100) if total else 100
    sys.stdout.write(
        f"\r{label:<25} [{bar}] {current}/{total} ({pct:5.1f}%)"
    )
    sys.stdout.flush()
    if current == total:
        print()

# ==================================================
# SQL helpers
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
# Parallel shard workers
# ==================================================

def process_candidate_shard(db_path: str):
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    cur.execute(
        "SELECT candidate_id,name,office,party,state,district,source FROM candidate"
    )
    row = cur.fetchone()
    if not row:
        raise RuntimeError(f"{db_path} missing candidate row")

    meta = dict(zip(
        ["candidate_id","name","office","party","state","district","source"],
        row
    ))

    raised = spent = 0
    receipts = defaultdict(int)
    spending = defaultdict(int)
    committees = set()

    for src, direction, from_c, _, _, amt in cur.execute(
        "SELECT source,direction,from_committee_id,to_committee_id,"
        "candidate_id,amount_cents FROM transactions"
    ):
        if amt is None:
            continue

        if src in ("itcont","itpas2") and direction == "in":
            raised += amt
            receipts[src] += amt
            if from_c and from_c != "_UNASSIGNED":
                committees.add(from_c)

        elif src == "oppexp" and direction == "out":
            spent += amt
            spending["operating"] += amt

        elif src == "itpas2" and direction == "out":
            spent += amt
            spending["independent_expenditure"] += amt

    conn.close()
    return {
        "meta": meta,
        "raised": raised,
        "spent": spent,
        "receipts": dict(receipts),
        "spending": dict(spending),
        "committees": list(committees),
    }

def process_committee_shard(db_path: str):
    committee_id = Path(db_path).stem
    if committee_id == "_UNASSIGNED":
        return None

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    raised = spent = 0

    for src, direction, *_ , amt in cur.execute(
        "SELECT source,direction,from_committee_id,to_committee_id,"
        "candidate_id,amount_cents FROM transactions"
    ):
        if amt is None:
            continue

        if src == "itcont" and direction == "in":
            raised += amt
        elif src in ("oppexp","itpas2") and direction == "out":
            spent += amt

    conn.close()
    return {
        "committee_id": committee_id,
        "raised": raised,
        "spent": spent,
    }

# ==================================================
# Release loading + verification
# ==================================================

def load_release(cycle: str):
    cycle_dir = DATA_ROOT / cycle
    latest = json.loads((cycle_dir / "LATEST.json").read_text())
    release_id = latest["release"]
    release_root = cycle_dir / release_id

    checksums = json.loads((release_root / "checksums.json").read_text())
    manifest = json.loads((release_root / "manifest.json").read_text())

    dataset_hash = hashlib.sha256(
        json.dumps(checksums, sort_keys=True).encode()
    ).hexdigest()

    expected_candidates = manifest.get("candidate_count")
    expected_committees = manifest.get("committee_count")

    if expected_candidates is None or expected_committees is None:
        raise RuntimeError("manifest.json missing shard counts")

    return (
        release_root,
        int(cycle),
        release_id,
        dataset_hash,
        expected_candidates,
        expected_committees,
    )

# ==================================================
# Safe SQL flushing
# ==================================================

def flush_sql(sql):
    if len(sql) > 1:
        sql.append("COMMIT;")
        run_d1_sql("\n".join(sql))
        return ["BEGIN;"]
    return sql

# ==================================================
# Entrypoint
# ==================================================

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cycle", required=True)
    args = parser.parse_args()

    (
        release_root,
        cycle,
        release_id,
        checksum,
        expected_candidates,
        expected_committees,
    ) = load_release(args.cycle)

    ts = now()

    candidate_dbs = sorted((release_root / "candidates").glob("*.db"))
    committee_dbs = sorted((release_root / "committees").glob("*.db"))

    actual_candidates = len(candidate_dbs)
    actual_committees = len([db for db in committee_dbs if db.stem != "_UNASSIGNED"])

    if actual_candidates != expected_candidates:
        raise RuntimeError(
            f"Candidate shard mismatch: expected {expected_candidates}, found {actual_candidates}"
        )

    if actual_committees != expected_committees:
        raise RuntimeError(
            f"Committee shard mismatch: expected {expected_committees}, found {actual_committees}"
        )

    print(f"\nParallel processing with {MAX_WORKERS} workers")

    # ==================================================
    # Candidates
    # ==================================================

    completed = 0
    total = actual_candidates

    for batch_start in range(0, total, BATCH_SIZE):
        batch = candidate_dbs[batch_start:batch_start+BATCH_SIZE]
        sql = ["BEGIN;"]

        with ProcessPoolExecutor(MAX_WORKERS) as pool:
            futures = [pool.submit(process_candidate_shard, str(db)) for db in batch]

            for f in as_completed(futures):
                r = f.result()
                completed += 1
                progress("Candidates", completed, total)

                m = r["meta"]
                cid = m["candidate_id"]

                sql.append(insert(
                    "candidates",
                    ["candidate_id","name","office","party","state","district",
                     "cycle","source","release_id","updated_at"],
                    [[cid, m["name"], m["office"], m["party"],
                      m["state"], m["district"],
                      cycle, m["source"], release_id, ts]]
                ))

                sql.append(insert(
                    "candidate_totals",
                    ["candidate_id","cycle","total_raised_cents",
                     "total_spent_cents","release_id","updated_at"],
                    [[cid, cycle, r["raised"], r["spent"], release_id, ts]]
                ))

                for k,v in r["receipts"].items():
                    sql.append(insert(
                        "candidate_receipt_breakdown",
                        ["candidate_id","cycle","source_type",
                         "amount_cents","release_id","updated_at"],
                        [[cid, cycle, k, v, release_id, ts]]
                    ))

                for k,v in r["spending"].items():
                    sql.append(insert(
                        "candidate_spending_breakdown",
                        ["candidate_id","cycle","spending_type",
                         "amount_cents","release_id","updated_at"],
                        [[cid, cycle, k, v, release_id, ts]]
                    ))

                for cm in r["committees"]:
                    sql.append(insert(
                        "candidate_committee_link",
                        ["candidate_id","committee_id","cycle",
                         "release_id","updated_at"],
                        [[cid, cm, cycle, release_id, ts]]
                    ))

                if len(sql) > MAX_SQL_STATEMENTS:
                    sql = flush_sql(sql)

        sql = flush_sql(sql)

    print("\n✔ Candidates complete")

    # ==================================================
    # Committees
    # ==================================================

    completed = 0
    total = actual_committees

    for batch_start in range(0, len(committee_dbs), BATCH_SIZE):
        batch = committee_dbs[batch_start:batch_start+BATCH_SIZE]
        sql = ["BEGIN;"]

        with ProcessPoolExecutor(MAX_WORKERS) as pool:
            futures = [pool.submit(process_committee_shard, str(db)) for db in batch]

            for f in as_completed(futures):
                r = f.result()
                if not r:
                    continue

                completed += 1
                progress("Committees", completed, total)

                sql.append(insert(
                    "committee_totals",
                    ["committee_id","cycle","total_raised_cents",
                     "total_spent_cents","release_id","updated_at"],
                    [[r["committee_id"], cycle,
                      r["raised"], r["spent"],
                      release_id, ts]]
                ))

                if len(sql) > MAX_SQL_STATEMENTS:
                    sql = flush_sql(sql)

        sql = flush_sql(sql)

    # ==================================================
    # Final audit (single authoritative record)
    # ==================================================

    sql = ["BEGIN;"]
    sql.append(insert(
        "upload_audit",
        ["release_id","cycle","candidate_shards","committee_shards",
         "checksum_sha256","uploaded_at","uploader_version"],
        [[release_id, cycle, expected_candidates,
          expected_committees, checksum, ts, UPLOADER_VERSION]]
    ))
    sql.append("COMMIT;")
    run_d1_sql("\n".join(sql))

    print("\n✔ Upload complete and verified")

if __name__ == "__main__":
    main()
