import sqlite3
import json
import hashlib
from decimal import Decimal, InvalidOperation
from pathlib import Path
from datetime import datetime, UTC

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

# ==================================================
# Candidate master resolution (cn > webl > weball)
# ==================================================

candidate_index: dict[str, dict] = {}

def load_candidate_file(path: Path, source: str):
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
# Validation helpers
# ==================================================

def is_real_candidate(candidate_id: str | None) -> bool:
    return bool(candidate_id and candidate_id in candidate_index)

def is_real_committee(committee_id: str | None) -> bool:
    return bool(
        committee_id
        and committee_id.startswith("C")
        and len(committee_id) == 9
        and committee_id not in {"A", "N", "NONE", "00000000"}
    )

def parse_amount_cents(val: str | None):
    if not val:
        return None

    val = val.strip()
    if not val:
        return None

    try:
        # Some FEC fields contain junk like "." or "NA"
        d = Decimal(val)
        return int(d * 100)
    except (InvalidOperation, ValueError):
        return None

def parse_date(val: str):
    return val if val else None

# ==================================================
# SQLite helpers
# ==================================================

candidate_dbs: dict[str, sqlite3.Connection] = {}
committee_dbs: dict[str, sqlite3.Connection] = {}

def open_candidate_db(candidate_id: str) -> sqlite3.Connection:
    meta = candidate_index[candidate_id]
    path = CAND_DIR / f"{candidate_id}.db"
    conn = sqlite3.connect(path)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS candidate (
            candidate_id TEXT PRIMARY KEY,
            name TEXT,
            office TEXT,
            party TEXT,
            state TEXT,
            district TEXT,
            source TEXT
        );
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS transactions (
            source TEXT NOT NULL,
            committee_id TEXT,
            candidate_id TEXT,
            amount_cents INTEGER,
            transaction_date TEXT,
            raw_line TEXT NOT NULL
        );
    """)
    conn.execute("DELETE FROM candidate")
    conn.execute(
        "INSERT INTO candidate VALUES (?,?,?,?,?,?,?)",
        tuple(meta.values())
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(transaction_date)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_tx_amount ON transactions(amount_cents)")
    return conn

def open_committee_db(committee_id: str) -> sqlite3.Connection:
    path = COMM_DIR / f"{committee_id}.db"
    conn = sqlite3.connect(path)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS transactions (
            source TEXT NOT NULL,
            committee_id TEXT,
            candidate_id TEXT,
            amount_cents INTEGER,
            transaction_date TEXT,
            raw_line TEXT NOT NULL
        );
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(transaction_date)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_tx_amount ON transactions(amount_cents)")
    return conn

def get_candidate_db(candidate_id: str):
    if not is_real_candidate(candidate_id):
        return None
    if candidate_id not in candidate_dbs:
        candidate_dbs[candidate_id] = open_candidate_db(candidate_id)
    return candidate_dbs[candidate_id]

def get_committee_db(committee_id: str):
    key = committee_id if is_real_committee(committee_id) else UNASSIGNED_COMMITTEE_ID
    if key not in committee_dbs:
        committee_dbs[key] = open_committee_db(key)
    return committee_dbs[key]

def insert_tx(conn, src, committee_id, candidate_id, amount_cents, date, raw):
    conn.execute(
        "INSERT INTO transactions VALUES (?,?,?,?,?,?)",
        (src, committee_id, candidate_id, amount_cents, date, raw),
    )

# ==================================================
# Pre-create candidate DBs
# ==================================================

print("Pre-creating candidate databases...")
for cid in candidate_index:
    get_candidate_db(cid)
print(f"Pre-created {len(candidate_index)} candidate databases")

# ==================================================
# Candidate ↔ Committee links
# ==================================================

committee_candidates: dict[str, set[str]] = {}

with open(BULK_DIR / "ccl26.txt", encoding="utf-8", errors="ignore") as f:
    for line in f:
        p = line.rstrip("\n").split("|")
        if len(p) >= 2 and is_real_candidate(p[0]) and is_real_committee(p[1]):
            committee_candidates.setdefault(p[1], set()).add(p[0])

# ==================================================
# Transaction processing (UNCHANGED LOGIC)
# ==================================================

def process_file(path, handler):
    with open(path, encoding="utf-8", errors="ignore") as f:
        for line in f:
            p = line.rstrip("\n").split("|")
            if len(p) >= 15:
                handler(p, line)

# itcont
process_file(BULK_DIR / "itcont.txt", lambda p, raw:
    insert_tx(
        get_committee_db(p[0]),
        "itcont",
        p[0],
        None,
        parse_amount_cents(p[14]),
        parse_date(p[13]),
        raw,
    )
)

# itpas2
process_file(BULK_DIR / "itpas2.txt", lambda p, raw:
    (
        insert_tx(
            get_committee_db(p[0]),
            "itpas2",
            p[0],
            p[1],
            parse_amount_cents(p[14]),
            parse_date(p[13]),
            raw,
        ),
        insert_tx(
            get_candidate_db(p[1]),
            "itpas2",
            p[0],
            p[1],
            parse_amount_cents(p[14]),
            parse_date(p[13]),
            raw,
        ) if is_real_candidate(p[1]) else None
    )
)

# itoth
process_file(BULK_DIR / "itoth.txt", lambda p, raw:
    (
        insert_tx(get_committee_db(p[0]), "itoth", p[0], None, parse_amount_cents(p[14]), parse_date(p[13]), raw),
        insert_tx(get_committee_db(p[1]), "itoth", p[1], None, parse_amount_cents(p[14]), parse_date(p[13]), raw)
    )
)

# oppexp
process_file(BULK_DIR / "oppexp.txt", lambda p, raw:
    insert_tx(get_committee_db(p[0]), "oppexp", p[0], None, parse_amount_cents(p[14]), parse_date(p[13]), raw)
)

# ==================================================
# Finalize
# ==================================================

for conn in list(candidate_dbs.values()) + list(committee_dbs.values()):
    conn.commit()
    conn.close()

# ==================================================
# Manifest + checksums
# ==================================================

checksums = {}
for db in OUT_BASE.rglob("*.db"):
    checksums[str(db.relative_to(OUT_BASE))] = hashlib.sha256(db.read_bytes()).hexdigest()

manifest = {
    "cycle": CYCLE,
    "release_id": RELEASE_ID,
    "generated_at": datetime.now(UTC).isoformat() + "Z",
    "candidate_count": len(candidate_dbs),
    "committee_count": len(committee_dbs),
    "schema_version": 1,
}

(OUT_BASE / "manifest.json").write_text(json.dumps(manifest, indent=2))
(OUT_BASE / "checksums.json").write_text(json.dumps(checksums, indent=2))

print(f"✔ Dataset release created: {RELEASE_ID}")
print("✔ Includes manifest.json and checksums.json")
