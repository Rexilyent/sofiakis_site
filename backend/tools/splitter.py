# -------------------------------------------------------------------------------
# Tool to split FEC bulk files into per-candidate and per-committee SQLite databases.
#     Changes in v1.0.2:
#     - Added environment variable loading for configuration
#     - Added cycle auto-detection from bulk data
#     - Added cycle argument
#     - Added strict mode and tolerance for cycle violations
#
# Command-line usage (Examples):
#		  python splitter.py
#     python splitter.py --strict
#		  python splitter.py --cycle 2026 --tolerance 0.01
#
# Arguments:
#     --cycle: Election cycle year (default: 2026)
#     --strict: Fail on any cycle violation
#     --tolerance: Allowed percentage of out-of-cycle transactions (default: 0.01)
# -------------------------------------------------------------------------------

import os
import sys
import time
import sqlite3
import argparse
from decimal import Decimal, InvalidOperation
from pathlib import Path
from collections import defaultdict
from common.hashing import sha256_file, dataset_checksum
from common.progress import progress
from common.time_utils import (
    now_iso,
    release_id,
    extract_year,
)
from common.json_utils import load_json, write_json
from common.sqlite_utils import configure_fast_write
from common.signing import (
    load_private_key,
    sign_manifest,
)
from common.cycle import (
    normalize_cycle_year,
    derive_cycle_from_transactions,
    validate_cycle_consistency,
    validate_transaction_date,
)

# ==================================================
# Splitter version
# ==================================================
SPLITTER_VERSION = "1.0.2"

# ==================================================
# Bulk data directory
# ==================================================
BULK_DIR = Path("bulk_fec")

# ==================================================
# Command-line arguments
# ==================================================

parser = argparse.ArgumentParser(description="Split FEC bulk files into per-candidate and per-committee SQLite databases.")
parser.add_argument("--cycle", type=str, help="Election cycle year (default: 2026)")

parser.add_argument("--strict", action="store_true", help="Fail on any cycle violation")

parser.add_argument(
    "--tolerance", 
    type=float,
    default=.01,
    help="Allowed percentage of out-of-cycle transactions (default: 0.01)"
)

args = parser.parse_args()

if args.cycle:
    user_cycle = normalize_cycle_year(args.cycle)
    derived_cycle = derive_cycle_from_transactions(BULK_DIR)
    validate_cycle_consistency(user_cycle, derived_cycle)
    CYCLE = user_cycle
else:
    CYCLE = derive_cycle_from_transactions(BULK_DIR)

if not CYCLE.isdigit() or len(CYCLE) != 4:
    raise ValueError("Cycle must be a 4-digit year, e.g., 2026")

print(f"Using FEC cycle: {CYCLE}")

# ==================================================
# Configuration
# ==================================================

DATASET_ROOT = Path("data/fec") / CYCLE
RELEASE_ID = release_id()
OUT_BASE = DATASET_ROOT / RELEASE_ID

CAND_DIR = OUT_BASE / "candidates"
COMM_DIR = OUT_BASE / "committees"

CAND_DIR.mkdir(parents=True, exist_ok=True)
COMM_DIR.mkdir(parents=True, exist_ok=True)

UNASSIGNED_COMMITTEE_ID = "_UNASSIGNED"
COMMIT_EVERY = 10_000

APP_ENV = os.environ.get("APP_ENV", "development").lower()

if APP_ENV in ("dev", "development"):
    SIGNING_KEY_PATH = Path(os.environ.get("SIGNING_KEY_PATH", "keys/dev/private.pem"))
elif APP_ENV in ("prod", "production"):
    SIGNING_KEY_PATH = Path(os.environ.get("SIGNING_KEY_PATH", "keys/prod/private.pem"))
else:
    raise RuntimeError(f"Unknown APP_ENV: {APP_ENV}")

# ==================================================
# Validation registry
# ==================================================

VALIDATION = defaultdict(lambda: {
    "lines_total": 0,
    "lines_parsed": 0,
    "amount_valid": 0,
    "tx_written": 0,
    "tx_skipped": 0,
    "tx_candidate": 0,
    "tx_committee": 0,
    "tx_unassigned": 0,
    "cycle_distribution": defaultdict(int),
    "cycle_violations": 0,
})

# ==================================================
# Candidate master resolution (cn > webl > weball)
# ==================================================

candidate_index = {}

def load_candidate_file(path, source):
    if not path.exists():
        return
    with path.open(encoding="utf-8", errors="ignore") as f:
        for line in f:
            p = line.rstrip("\n").split("|")
            if len(p) < 6:
                continue
            cid = p[0].strip()
            if not cid or cid in {"N", "NONE", "00000000"}:
                continue
            if cid not in candidate_index or source == "cn":
                candidate_index[cid] = {
                    "candidate_id": cid,
                    "name": p[1].strip(),
                    "office": p[2].strip(),
                    "party": p[3].strip(),
                    "state": p[4].strip(),
                    "district": p[5].strip(),
                    "source": source,
                }

load_candidate_file(BULK_DIR / f"weball{CYCLE[-2:]}.txt", "weball")
load_candidate_file(BULK_DIR / f"webl{CYCLE[-2:]}.txt", "webl")
load_candidate_file(BULK_DIR / f"cn{CYCLE[-2:]}.txt", "cn")

print(f"Loaded {len(candidate_index)} candidates")

# ==================================================
# Helpers
# ==================================================

def is_real_candidate(cid):
    return cid in candidate_index

def is_real_committee(cid):
    return bool(cid and cid.startswith("C") and len(cid) == 9)

def parse_amount_cents(val):
    try:
        return int(Decimal(val) * 100)
    except (InvalidOperation, TypeError):
        return None

def parse_date(val):
    return val if val else None

# ==================================================
# SQLite helpers
# ==================================================

candidate_dbs = {}
committee_dbs = {}
TX_COUNT = 0

def open_candidate_db(cid):
    conn = sqlite3.connect(CAND_DIR / f"{cid}.db")
    configure_fast_write(conn)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS candidate (
            candidate_id TEXT PRIMARY KEY,
            name TEXT,
            office TEXT,
            party TEXT,
            state TEXT,
            district TEXT,
            source TEXT
        );
        CREATE TABLE IF NOT EXISTS transactions (
            source TEXT,
            direction TEXT,
            from_committee_id TEXT,
            to_committee_id TEXT,
            candidate_id TEXT,
            amount_cents INTEGER,
            transaction_date TEXT,
            raw_line TEXT
        );
    """)
    conn.execute("DELETE FROM candidate")
    conn.execute(
        "INSERT INTO candidate VALUES (?,?,?,?,?,?,?)",
        tuple(candidate_index[cid].values())
    )
    return conn

def open_committee_db(cid):
    conn = sqlite3.connect(COMM_DIR / f"{cid}.db")
    configure_fast_write(conn)
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS transactions (
            source TEXT,
            direction TEXT,
            from_committee_id TEXT,
            to_committee_id TEXT,
            candidate_id TEXT,
            amount_cents INTEGER,
            transaction_date TEXT,
            raw_line TEXT
        );
        CREATE TABLE IF NOT EXISTS committee_candidates (
            committee_id TEXT,
            candidate_id TEXT,
            PRIMARY KEY (committee_id, candidate_id)
        );
    """)
    return conn

def get_candidate_db(cid):
    if not is_real_candidate(cid):
        return None
    return candidate_dbs.setdefault(cid, open_candidate_db(cid))

def get_committee_db(cid):
    key = cid if is_real_committee(cid) else UNASSIGNED_COMMITTEE_ID
    conn = committee_dbs.get(key)
    if conn is None:
        conn = open_committee_db(key)
        committee_dbs[key] = conn
    return conn

def insert_tx(conn, source, direction, from_c, to_c, cand, amt, date, raw):
    global TX_COUNT
    VALIDATION[source]["lines_parsed"] += 1

    if amt is None:
        VALIDATION[source]["tx_skipped"] += 1
        return

    VALIDATION[source]["amount_valid"] += 1

    if conn is None:
        VALIDATION[source]["tx_skipped"] += 1
        return

    if cand:
        VALIDATION[source]["tx_candidate"] += 1
    else:
        VALIDATION[source]["tx_committee"] += 1

    if from_c == UNASSIGNED_COMMITTEE_ID or to_c == UNASSIGNED_COMMITTEE_ID:
        VALIDATION[source]["tx_unassigned"] += 1
        
		# ------------------------------------
    # Cycle Locking
    # ------------------------------------
    if date:
        if not validate_transaction_date(date, CYCLE):
            VALIDATION[source]["cycle_violations"] += 1
        else:
            year = extract_year(date)
            if year:
                VALIDATION[source]["cycle_distribution"][str(year)] += 1
		# ------------------------------------

    conn.execute(
        "INSERT INTO transactions VALUES (?,?,?,?,?,?,?,?)",
        (source, direction, from_c, to_c, cand, amt, date, raw)
    )

    VALIDATION[source]["tx_written"] += 1
    TX_COUNT += 1
    if TX_COUNT % COMMIT_EVERY == 0:
        conn.commit()

# ==================================================
# Pre-create databases
# ==================================================

print("Creating candidate databases...")
total_candidates = len(candidate_index)

for i, cid in enumerate(candidate_index, start=1):
    get_candidate_db(cid)
    if i % 100 == 0 or i == total_candidates:
        progress("Candidates", i, total_candidates)
        
print()
print(f"✔ {len(candidate_dbs)} candidate DBs")

print("Collecting committees...")
committee_ids = set()

if (BULK_DIR / f"cm{CYCLE[-2:]}.txt").exists():
    for line in (BULK_DIR / f"cm{CYCLE[-2:]}.txt").open(encoding="utf-8", errors="ignore"):
        cid = line.split("|", 1)[0].strip()
        if is_real_committee(cid):
            committee_ids.add(cid)

for line in (BULK_DIR / f"ccl{CYCLE[-2:]}.txt").open(encoding="utf-8", errors="ignore"):
    p = line.rstrip("\n").split("|")
    if len(p) >= 2 and is_real_committee(p[1]):
        committee_ids.add(p[1])

print(f"Creating {len(committee_ids)} committee DBs...")
for i, cid in enumerate(committee_ids, start=1):
    get_committee_db(cid)
    if i % 100 == 0 or i == len(committee_ids):
        progress("Committees", i, len(committee_ids))

print()
print("✔ Committee DBs ready")

# ==================================================
# Candidate ↔ Committee links
# ==================================================

print("Linking candidates ↔ committees...")
ccl_path = BULK_DIR / f"ccl{CYCLE[-2:]}.txt"
total_lines = sum(1 for _ in ccl_path.open(encoding="utf-8", errors="ignore"))

with ccl_path.open(encoding="utf-8", errors="ignore") as f:
    for i, line in enumerate(f, start=1):
        p = line.rstrip("\n").split("|")
        if len(p) >= 2 and is_real_candidate(p[0]) and is_real_committee(p[1]):
            get_committee_db(p[1]).execute(
                "INSERT OR IGNORE INTO committee_candidates VALUES (?,?)",
                (p[1], p[0])
            )
            
        if i % 100 == 0 or i == total_lines:
            progress("Linking", i, total_lines)
            
print()
print("✔ Links complete")

# ==================================================
# Transaction processing with progress + validation
# ==================================================

def process_file(path, handler, label, source_key):
    total = sum(1 for _ in path.open(encoding="utf-8", errors="ignore"))
    count = 0
    last = time.time()

    with path.open(encoding="utf-8", errors="ignore") as f:
        for line in f:
            VALIDATION[source_key]["lines_total"] += 1
            p = line.rstrip("\n").split("|")
            if len(p) >= 15:
                handler(p, line)
            else:
                VALIDATION[source_key]["tx_skipped"] += 1
            count += 1
            if time.time() - last > 0.1:
                progress(label, count, total)
                last = time.time()

    progress(label, total, total)
    print()

process_file(
    BULK_DIR / "itcont.txt",
    lambda p, raw: insert_tx(
        get_committee_db(p[0]), "itcont", "in",
        None, p[0], None,
        parse_amount_cents(p[14]), parse_date(p[13]), raw
    ),
    "itcont (individual)",
    "itcont"
)

process_file(
    BULK_DIR / "itpas2.txt",
    lambda p, raw: (
        insert_tx(
            get_committee_db(p[0]), "itpas2", "out",
            p[0], None, p[1],
            parse_amount_cents(p[14]), parse_date(p[13]), raw
        ),
        insert_tx(
            get_candidate_db(p[1]), "itpas2", "in",
            p[0], None, p[1],
            parse_amount_cents(p[14]), parse_date(p[13]), raw
        )
    ),
    "itpas2 (PAC → candidate)",
    "itpas2"
)

process_file(
    BULK_DIR / "itoth.txt",
    lambda p, raw: (
        insert_tx(
            get_committee_db(p[0]), "itoth", "out",
            p[0], p[1], None,
            parse_amount_cents(p[14]), parse_date(p[13]), raw
        ),
        insert_tx(
            get_committee_db(p[1]), "itoth", "in",
            p[0], p[1], None,
            parse_amount_cents(p[14]), parse_date(p[13]), raw
        )
    ),
    "itoth (committee ↔ committee)",
    "itoth"
)

process_file(
    BULK_DIR / "oppexp.txt",
    lambda p, raw: insert_tx(
        get_committee_db(p[0]), "oppexp", "out",
        p[0], None, None,
        parse_amount_cents(p[14]), parse_date(p[13]), raw
    ),
    "oppexp (operating)",
    "oppexp"
)

# ==================================================
# Finalize + audit manifest
# ==================================================

for conn in list(candidate_dbs.values()) + list(committee_dbs.values()):
    conn.commit()
    conn.close()

db_files = list(OUT_BASE.rglob("*.db"))
total_dbs = len(db_files)

checksums = {}

print("Calculating checksums for database files...")

for i, db in enumerate(db_files, start=1):
    checksums[str(db.relative_to(OUT_BASE))] = sha256_file(db)
    if i % 10 == 0 or i == total_dbs:
        progress("Checksums", i, total_dbs)

print()

# --------------------------------
# Aggregate cycle distribution
# --------------------------------

aggregate_cycle_distribution = defaultdict(int)

for v in VALIDATION.values():
    for year, count in v["cycle_distribution"].items():
        aggregate_cycle_distribution[year] += count
        
# --------------------------------
# Aggregate violation statistics
# --------------------------------

total_parsed = sum(v["lines_parsed"] for v in VALIDATION.values())
total_violations = sum(v["cycle_violations"] for v in VALIDATION.values())

violation_rate = (
    (total_violations / total_parsed) * 100
    if total_parsed else 0
)

# --------------------------------
# Build summary
# --------------------------------

summary = {
    "total_lines": sum(v["lines_total"] for v in VALIDATION.values()),
    "total_written": sum(v["tx_written"] for v in VALIDATION.values()),
    "total_skipped": sum(v["tx_skipped"] for v in VALIDATION.values()),
    "cycle_distribution": dict(aggregate_cycle_distribution),
    "violation_rate_percent": round(violation_rate, 6)
}

summary["passed"] = all(
    v["tx_written"] + v["tx_skipped"] == v["lines_parsed"]
    for v in VALIDATION.values()
)

# --------------------------------
# Enforcement Policy (STRICT / TOLERANCE)
# --------------------------------

if args.strict and total_violations > 0:
    raise RuntimeError(
        f"❌ Cycle violations detected — Strict mode enabled"
    )

if violation_rate > args.tolerance:
    raise RuntimeError(
        f"❌ Violation rate {violation_rate:.2f}% exceeds tolerance {args.tolerance:.2f}%"
    )

# --------------------------------
# Build manifest
# --------------------------------

manifest = {
    "cycle": CYCLE,
    "release_id": RELEASE_ID,
    "generated_at": now_iso(),
    "schema_version": 3,
    
    # 🔐 Required for uploader integrity validation
    "candidate_count": len(candidate_dbs),
    "committee_count": len(
        [k for k in committee_dbs.keys() if k != UNASSIGNED_COMMITTEE_ID]
    ),
    
    "validation": {
        **VALIDATION,
        "summary": summary
    }
}

# --------------------------------------------------
# Paths
# --------------------------------------------------

manifest_path = OUT_BASE / "manifest.json"
checksums_path = OUT_BASE / "checksums.json"

# --------------------------------------------------
# Write checksums.json using json_utils
# --------------------------------------------------

write_json(checksums_path, checksums, sort_keys=True)

# --------------------------------------------------
# Sign manifest
# --------------------------------------------------

if not SIGNING_KEY_PATH.exists():
    raise RuntimeError(f"Signing key not found: {SIGNING_KEY_PATH}")

private_key = load_private_key(
    SIGNING_KEY_PATH.read_bytes()
)

signed_manifest = sign_manifest(
    manifest,
    private_key
)

# --------------------------------------------------
# Write signed manifest using json_utils
# --------------------------------------------------

write_json(manifest_path, signed_manifest, sort_keys=True)

print("✔ Manifest written and cryptographically signed")
print("✔ checksums.json written")

write_json(DATASET_ROOT / "LATEST.json", {
    "cycle": CYCLE,
    "release": RELEASE_ID,
    "generated_at": now_iso()
}, sort_keys=True)
print("✔ LATEST.json updated")

if not summary["passed"]:
    raise RuntimeError("❌ Validation failed — see manifest.json")

print(f"\n✔ Dataset release created: {RELEASE_ID}")
print("✔ Validation embedded in manifest.json")
