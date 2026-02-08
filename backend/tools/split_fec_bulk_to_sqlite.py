import sqlite3
import json
import hashlib
import sys
import time
from decimal import Decimal, InvalidOperation
from pathlib import Path
from datetime import datetime, UTC
from collections import defaultdict

# ==================================================
# Configuration
# ==================================================

CYCLE = "2026"
BULK_DIR = Path("bulk_fec")

DATASET_ROOT = Path("data/fec") / CYCLE
RELEASE_ID = datetime.now(UTC).strftime("%Y-%m-%dT%H-%M-%SZ")
OUT_BASE = DATASET_ROOT / RELEASE_ID

CAND_DIR = OUT_BASE / "candidates"
COMM_DIR = OUT_BASE / "committees"

CAND_DIR.mkdir(parents=True, exist_ok=True)
COMM_DIR.mkdir(parents=True, exist_ok=True)

UNASSIGNED_COMMITTEE_ID = "_UNASSIGNED"
COMMIT_EVERY = 10_000

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
})

# ==================================================
# Progress bar
# ==================================================

def progress(label, current, total, width=40):
    filled = int(width * current / total) if total else 0
    bar = "█" * filled + "░" * (width - filled)
    pct = (current / total * 100) if total else 0
    sys.stdout.write(
        f"\r{label:<30} [{bar}] {current:,}/{total:,} ({pct:5.1f}%)"
    )
    sys.stdout.flush()

# ==================================================
# SQLite config (FAST WRITE MODE)
# ==================================================

def configure_sqlite(conn):
    conn.execute("PRAGMA journal_mode=DELETE;")
    conn.execute("PRAGMA synchronous=OFF;")
    conn.execute("PRAGMA busy_timeout=5000;")

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

load_candidate_file(BULK_DIR / "weball26.txt", "weball")
load_candidate_file(BULK_DIR / "webl26.txt", "webl")
load_candidate_file(BULK_DIR / "cn26.txt", "cn")

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
    configure_sqlite(conn)
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
    configure_sqlite(conn)
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
for cid in candidate_index:
    get_candidate_db(cid)
print(f"✔ {len(candidate_dbs)} candidate DBs")

print("Collecting committees...")
committee_ids = set()

if (BULK_DIR / "cm26.txt").exists():
    for line in (BULK_DIR / "cm26.txt").open(encoding="utf-8", errors="ignore"):
        cid = line.split("|", 1)[0].strip()
        if is_real_committee(cid):
            committee_ids.add(cid)

for line in (BULK_DIR / "ccl26.txt").open(encoding="utf-8", errors="ignore"):
    p = line.rstrip("\n").split("|")
    if len(p) >= 2 and is_real_committee(p[1]):
        committee_ids.add(p[1])

print(f"Creating {len(committee_ids)} committee DBs...")
for cid in committee_ids:
    get_committee_db(cid)
print("✔ Committee DBs ready")

# ==================================================
# Candidate ↔ Committee links
# ==================================================

print("Linking candidates ↔ committees...")
with (BULK_DIR / "ccl26.txt").open(encoding="utf-8", errors="ignore") as f:
    for line in f:
        p = line.rstrip("\n").split("|")
        if len(p) >= 2 and is_real_candidate(p[0]) and is_real_committee(p[1]):
            get_committee_db(p[1]).execute(
                "INSERT OR IGNORE INTO committee_candidates VALUES (?,?)",
                (p[1], p[0])
            )
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

checksums = {
    str(db.relative_to(OUT_BASE)): hashlib.sha256(db.read_bytes()).hexdigest()
    for db in OUT_BASE.rglob("*.db")
}

summary = {
    "total_lines": sum(v["lines_total"] for v in VALIDATION.values()),
    "total_written": sum(v["tx_written"] for v in VALIDATION.values()),
    "total_skipped": sum(v["tx_skipped"] for v in VALIDATION.values()),
}

summary["passed"] = all(
    v["tx_written"] + v["tx_skipped"] == v["lines_parsed"]
    for v in VALIDATION.values()
)

manifest = {
    "cycle": CYCLE,
    "release_id": RELEASE_ID,
    "generated_at": datetime.now(UTC).isoformat() + "Z",
    "schema_version": 3,
    "validation": {
        **VALIDATION,
        "summary": summary
    }
}

(OUT_BASE / "manifest.json").write_text(json.dumps(manifest, indent=2))
(OUT_BASE / "checksums.json").write_text(json.dumps(checksums, indent=2))
print("✔ Manifest and checksums written")

(DATASET_ROOT / "LATEST.json").write_text(json.dumps({
    "cycle": CYCLE,
    "release": RELEASE_ID,
    "generated_at": datetime.now(UTC).isoformat() + "Z"
}, indent=2))
print("✔ LATEST.json updated")

if not summary["passed"]:
    raise RuntimeError("❌ Validation failed — see manifest.json")

print(f"\n✔ Dataset release created: {RELEASE_ID}")
print("✔ Validation embedded in manifest.json")
