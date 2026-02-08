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

D1_DATABASE_NAME = "dev-moneytracker-db"
DATA_ROOT = Path("data/fec")

# -------------------------------------------------
# Utilities
# -------------------------------------------------

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

# -------------------------------------------------
# Load release
# -------------------------------------------------

def load_release(cycle: str):
    cycle_dir = DATA_ROOT / cycle
    latest = json.loads((cycle_dir / "LATEST.json").read_text())
    release_id = latest["release"]
    return cycle_dir / release_id, int(cycle), release_id

def verify_checksums(release_root: Path):
    expected = json.loads((release_root / "checksums.json").read_text())
    for rel, h in expected.items():
        p = release_root / rel
        if not p.exists() or sha256_file(p) != h:
            raise RuntimeError(f"Checksum mismatch: {rel}")

# -------------------------------------------------
# SQL helpers
# -------------------------------------------------

def esc(v):
    if v is None:
        return "NULL"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"

def insert(table, cols, rows):
    vals = [
        f"({', '.join(esc(v) for v in r)})"
        for r in rows
    ]
    return f"""
    INSERT OR REPLACE INTO {table}
    ({', '.join(cols)})
    VALUES {', '.join(vals)};
    """

# -------------------------------------------------
# Candidate aggregation
# -------------------------------------------------

def process_candidate_shard(db: Path):
    conn = sqlite3.connect(db)
    cur = conn.cursor()

    cur.execute("SELECT candidate_id, name, office, party, state, district, source FROM candidate")
    meta = dict(zip(
        ["candidate_id","name","office","party","state","district","source"],
        cur.fetchone()
    ))

    raised = 0
    spent = 0
    receipts = defaultdict(int)
    spending = defaultdict(int)
    committees = set()

    for src, direction, from_c, to_c, _, amt, *_ in cur.execute(
        "SELECT source, direction, from_committee_id, to_committee_id, candidate_id, amount_cents FROM transactions"
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

# -------------------------------------------------
# Committee aggregation
# -------------------------------------------------

def process_committee_shard(db: Path):
    committee_id = db.stem
    conn = sqlite3.connect(db)
    cur = conn.cursor()

    raised = 0
    spent = 0

    for src, direction, *_ , amt, *_ in cur.execute(
        "SELECT source, direction, from_committee_id, to_committee_id, candidate_id, amount_cents FROM transactions"
    ):
        if amt is None:
            continue

        if src == "itcont" and direction == "in":
            raised += amt
        elif src in ("oppexp","itpas2") and direction == "out":
            spent += amt

    conn.close()
    return committee_id, raised, spent

# -------------------------------------------------
# Main
# -------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cycle", required=True)
    args = ap.parse_args()

    release_root, cycle, release_id = load_release(args.cycle)
    verify_checksums(release_root)

    ts = now()
    sql = ["BEGIN;"]

    # ---------------- Candidates ----------------
    for db in (release_root / "candidates").glob("*.db"):
        meta, raised, spent, receipts, spending, committees = process_candidate_shard(db)
        cid = meta["candidate_id"]

        sql.append(insert(
            "candidates",
            ["candidate_id","name","office","party","state","district","cycle","source","release_id","updated_at"],
            [[cid, meta["name"], meta["office"], meta["party"], meta["state"],
              meta["district"], cycle, meta["source"], release_id, ts]]
        ))

        sql.append(insert(
            "candidate_totals",
            ["candidate_id","cycle","total_raised_cents","total_spent_cents","release_id","updated_at"],
            [[cid, cycle, raised, spent, release_id, ts]]
        ))

        for src, amt in receipts.items():
            sql.append(insert(
                "candidate_receipt_breakdown",
                ["candidate_id","cycle","source_type","amount_cents"],
                [[cid, cycle, src, amt]]
            ))

        for typ, amt in spending.items():
            sql.append(insert(
                "candidate_spending_breakdown",
                ["candidate_id","cycle","spending_type","amount_cents"],
                [[cid, cycle, typ, amt]]
            ))

        for cm in committees:
            sql.append(insert(
                "candidate_committee_link",
                ["candidate_id","committee_id","cycle"],
                [[cid, cm, cycle]]
            ))

    # ---------------- Committees ----------------
    for db in (release_root / "committees").glob("*.db"):
        cid, raised, spent = process_committee_shard(db)
        sql.append(insert(
            "committee_totals",
            ["committee_id","cycle","total_raised_cents","total_spent_cents","release_id","updated_at"],
            [[cid, cycle, raised, spent, release_id, ts]]
        ))

    sql.append(insert(
        "data_meta",
        ["key","value","updated_at"],
        [["latest_release", release_id, ts]]
    ))

    sql.append("COMMIT;")
    run_d1_sql("\n".join(sql))
    print("✔ Shard-only aggregation + D1 upload complete")

if __name__ == "__main__":
    main()
