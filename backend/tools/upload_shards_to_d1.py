# =================================================
# Aggregate SQLite Shards → Cloudflare D1
# =================================================

import sqlite3
import subprocess
from pathlib import Path
import argparse
import hashlib
import json
from datetime import datetime, UTC
from collections import defaultdict
import sys

# ==================================================
# Configuration
# ==================================================

D1_DATABASE_NAME = "dev-moneytracker-db"
DATA_ROOT = Path("data/fec")
UPLOADER_VERSION = "uploader-v1.0"

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

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

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
# Load + validate release
# ==================================================

def load_release(cycle: str):
    cycle_dir = DATA_ROOT / cycle
    latest_path = cycle_dir / "LATEST.json"
    if not latest_path.exists():
        raise RuntimeError("LATEST.json not found")

    latest = json.loads(latest_path.read_text())
    release_id = latest["release"]
    release_root = cycle_dir / release_id

    if not release_root.exists():
        raise RuntimeError("Release directory missing")

    return release_root, int(cycle), release_id

def verify_release_completeness(release_root: Path):
    cand_dir = release_root / "candidates"
    comm_dir = release_root / "committees"
    checksum_path = release_root / "checksums.json"

    if not checksum_path.exists():
        raise RuntimeError("checksums.json missing")

    candidate_dbs = sorted(cand_dir.glob("*.db"))
    committee_dbs = sorted(comm_dir.glob("*.db"))

    if not candidate_dbs:
        raise RuntimeError("No candidate shards found")

    if not committee_dbs:
        raise RuntimeError("No committee shards found")

    expected = json.loads(checksum_path.read_text())
    for rel, h in expected.items():
        p = release_root / rel
        if not p.exists():
            raise RuntimeError(f"Missing shard: {rel}")
        if sha256_file(p) != h:
            raise RuntimeError(f"Checksum mismatch: {rel}")

    return candidate_dbs, committee_dbs, sha256_file(checksum_path)

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
    INSERT OR REPLACE INTO {table}
    ({', '.join(cols)})
    VALUES {', '.join(values)};
    """

def audit(sql, release_id, phase, msg, ts):
    sql.append(insert(
        "upload_audit_log",
        ["release_id","phase","message","logged_at"],
        [[release_id, phase, msg, ts]]
    ))

# ==================================================
# Aggregation
# ==================================================

def process_candidate_shard(db: Path):
    conn = sqlite3.connect(db)
    cur = conn.cursor()

    cur.execute(
        "SELECT candidate_id,name,office,party,state,district,source FROM candidate"
    )
    meta = dict(zip(
        ["candidate_id","name","office","party","state","district","source"],
        cur.fetchone()
    ))

    raised = 0
    spent = 0
    receipts = defaultdict(int)
    spending = defaultdict(int)
    committees = set()

    for src, direction, from_c, _, _, amt, *_ in cur.execute(
        "SELECT source,direction,from_committee_id,to_committee_id,"
        "candidate_id,amount_cents FROM transactions"
    ):
        if amt is None:
            continue

        if src in ("itcont","itpas2") and direction == "in":
            raised += amt
            receipts[src] += amt
            if from_c:
                committees.add(from_c)

        elif src == "oppexp" and direction == "out":
            spent += amt
            spending["operating"] += amt

        elif src == "itpas2" and direction == "out":
            spent += amt
            spending["independent_expenditure"] += amt

    conn.close()
    return meta, raised, spent, receipts, spending, committees

def process_committee_shard(db: Path):
    committee_id = db.stem
    conn = sqlite3.connect(db)
    cur = conn.cursor()

    raised = 0
    spent = 0

    for src, direction, *_ , amt, *_ in cur.execute(
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
    return committee_id, raised, spent

# ==================================================
# Entrypoint
# ==================================================

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cycle", required=True)
    args = parser.parse_args()

    release_root, cycle, release_id = load_release(args.cycle)
    candidate_dbs, committee_dbs, checksum_hash = verify_release_completeness(release_root)

    ts = now()
    sql = ["BEGIN;"]

    audit(sql, release_id, "init", "Release validated", ts)

    # ---------------- Candidates ----------------
    print("\nProcessing candidate shards")
    audit(sql, release_id, "candidates", f"{len(candidate_dbs)} shards", ts)

    for i, db in enumerate(candidate_dbs, 1):
        progress("Candidates", i, len(candidate_dbs))
        meta, raised, spent, receipts, spending, committees = process_candidate_shard(db)
        cid = meta["candidate_id"]

        sql.append(insert(
            "candidates",
            ["candidate_id","name","office","party","state","district",
             "cycle","source","release_id","updated_at"],
            [[cid, meta["name"], meta["office"], meta["party"],
              meta["state"], meta["district"],
              cycle, meta["source"], release_id, ts]]
        ))

        sql.append(insert(
            "candidate_totals",
            ["candidate_id","cycle","total_raised_cents",
             "total_spent_cents","release_id","updated_at"],
            [[cid, cycle, raised, spent, release_id, ts]]
        ))

        for k, v in receipts.items():
            sql.append(insert(
                "candidate_receipt_breakdown",
                ["candidate_id","cycle","source_type","amount_cents"],
                [[cid, cycle, k, v]]
            ))

        for k, v in spending.items():
            sql.append(insert(
                "candidate_spending_breakdown",
                ["candidate_id","cycle","spending_type","amount_cents"],
                [[cid, cycle, k, v]]
            ))

        for cm in committees:
            sql.append(insert(
                "candidate_committee_link",
                ["candidate_id","committee_id","cycle"],
                [[cid, cm, cycle]]
            ))

    # ---------------- Committees ----------------
    print("\nProcessing committee shards")
    audit(sql, release_id, "committees", f"{len(committee_dbs)} shards", ts)

    for i, db in enumerate(committee_dbs, 1):
        progress("Committees", i, len(committee_dbs))
        cid, raised, spent = process_committee_shard(db)
        sql.append(insert(
            "committee_totals",
            ["committee_id","cycle","total_raised_cents",
             "total_spent_cents","release_id","updated_at"],
            [[cid, cycle, raised, spent, release_id, ts]]
        ))

    # ---------------- Audit summary ----------------
    sql.append(insert(
        "upload_audit",
        ["release_id","cycle","candidate_shards","committee_shards",
         "checksum_sha256","uploaded_at","uploader_version"],
        [[release_id, cycle, len(candidate_dbs),
          len(committee_dbs), checksum_hash, ts, UPLOADER_VERSION]]
    ))

    audit(sql, release_id, "finalize", "Upload committed", ts)

    sql.append("COMMIT;")
    run_d1_sql("\n".join(sql))

    print("\n✔ Upload complete")
    print(f"✔ Release {release_id}")
    print(f"✔ Candidates: {len(candidate_dbs)}")
    print(f"✔ Committees: {len(committee_dbs)}")

if __name__ == "__main__":
    main()
