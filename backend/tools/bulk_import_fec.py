#!/usr/bin/env python3
"""
bulk_import_fec.py (UPDATED - future-proof)

Imports FEC bulk data (pipe-delimited .txt files) into your Money Tracker Postgres,
and records every import as an "import run" so later API refreshes can update the
same tables without truncating.

Expected files in: backend/seeds/fec_bulk/
  - cnYY.txt     (candidate master)            e.g., cn26.txt
  - cmYY.txt     (committee master)            e.g., cm26.txt
  - cclYY.txt    (candidate-committee link)    e.g., ccl26.txt
  - itcont.txt   (contributions by individuals)
  - itpas2.txt   (committee->candidate contribs + IEs)

Writes to tables (your app tables):
  - import_runs           (NEW)
  - candidates            (now includes source/run_id)
  - candidate_committees  (now includes source/run_id)
  - candidate_totals      (now includes source/run_id)
  - candidate_pac_agg     (now includes source/run_id)
  - raw_snapshots         (now includes source/run_id)

NOTE:
  Run the DB migration SQL FIRST (import_runs + added columns), then run this.

Usage examples:
  # Import just a handful of candidates matching name (recommended dev mode)
  python backend/tools/bulk_import_fec.py --cycle 2026 --name "Sofiakis" --state IL --district 10 --truncate

  # Import all candidates in a state (be careful; big)
  python backend/tools/bulk_import_fec.py --cycle 2026 --state IL --office house --limit-candidates 999999

"""

import argparse
import gzip
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set, Tuple

import psycopg
from psycopg.rows import dict_row

from dotenv import load_dotenv

# -----------------------------
# Paths
# -----------------------------
ROOT_DIR = Path(__file__).resolve().parents[2]  # project root
BACKEND_DIR = ROOT_DIR / "backend"
BULK_DIR = BACKEND_DIR / "seeds" / "fec_bulk"

# Load backend/.env for standalone script runs
ENV_PATH = (Path(__file__).resolve().parents[1] / ".env")  # backend/.env
load_dotenv(dotenv_path=ENV_PATH)

# -----------------------------
# Helpers
# -----------------------------
def env(name: str, default: str = "") -> str:
    return os.getenv(name, default)


def now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def safe_int(x: str, default: int = 0) -> int:
    try:
        return int(float(x)) if x else default
    except Exception:
        return default


def parse_fec_date(s: str) -> Optional[str]:
    """
    Return ISO date YYYY-MM-DD or None.
    Handles YYYYMMDD, MMDDYYYY, YYYY-MM-DD.
    """
    if not s:
        return None
    t = s.strip()

    if re.match(r"^\d{4}-\d{2}-\d{2}$", t):
        return t

    digits = re.sub(r"\D", "", t)
    if len(digits) == 8:
        # YYYYMMDD
        y1, m1, d1 = int(digits[0:4]), int(digits[4:6]), int(digits[6:8])
        if 1900 <= y1 <= 2100 and 1 <= m1 <= 12 and 1 <= d1 <= 31:
            return f"{y1:04d}-{m1:02d}-{d1:02d}"

        # MMDDYYYY
        m2, d2, y2 = int(digits[0:2]), int(digits[2:4]), int(digits[4:8])
        if 1900 <= y2 <= 2100 and 1 <= m2 <= 12 and 1 <= d2 <= 31:
            return f"{y2:04d}-{m2:02d}-{d2:02d}"

    return None


def normalize_name(n: str) -> str:
    return (n or "").strip().upper()


def open_text(path: Path):
    # FEC bulk files are commonly Latin-1 compatible.
    return open(path, "r", encoding="latin-1", errors="replace", newline="")


def pg_connect():
    db_url = env("DATABASE_URL", "")
    if db_url:
        return psycopg.connect(db_url, row_factory=dict_row)

    host = env("PGHOST", "localhost")
    port = int(env("PGPORT", "5432"))
    dbname = env("PGDATABASE", "")
    user = env("PGUSER", "")
    pwd = env("PGPASSWORD", "")

    if not (dbname and user and pwd):
        raise RuntimeError(
            "Missing PGDATABASE/PGUSER/PGPASSWORD (or DATABASE_URL). Check backend/.env"
        )

    return psycopg.connect(
        host=host, port=port, dbname=dbname, user=user, password=pwd, row_factory=dict_row
    )


def truncate_tables(conn):
    conn.execute("TRUNCATE TABLE candidate_pac_agg RESTART IDENTITY CASCADE;")
    conn.execute("TRUNCATE TABLE candidate_committees RESTART IDENTITY CASCADE;")
    conn.execute("TRUNCATE TABLE candidate_totals RESTART IDENTITY CASCADE;")
    conn.execute("TRUNCATE TABLE raw_snapshots RESTART IDENTITY CASCADE;")
    conn.execute("TRUNCATE TABLE candidates RESTART IDENTITY CASCADE;")


def gzip_json_bytes(obj) -> bytes:
    raw = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    return gzip.compress(raw, compresslevel=9)


# -----------------------------
# NEW: import run tracking
# -----------------------------
def create_import_run(conn, source: str, notes: str, meta: dict) -> int:
    row = conn.execute(
        """
        INSERT INTO import_runs(source, notes, meta)
        VALUES (%s, %s, %s::jsonb)
        RETURNING run_id
        """,
        (source, notes, json.dumps(meta)),
    ).fetchone()
    return int(row["run_id"])


def finish_import_run(conn, run_id: int):
    conn.execute("UPDATE import_runs SET finished_at=now() WHERE run_id=%s", (run_id,))


# -----------------------------
# DB upserts (match your app schema + source/run_id)
# -----------------------------
def upsert_candidate(
    conn,
    candidate_id: str,
    name: str,
    office: str,
    party: str,
    state: str,
    district: Optional[str],
    source: str,
    run_id: int,
):
    conn.execute(
        """
        INSERT INTO candidates(candidate_id, name, office, party, state, district, source, run_id, updated_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s, now())
        ON CONFLICT (candidate_id) DO UPDATE SET
          name=EXCLUDED.name,
          office=EXCLUDED.office,
          party=EXCLUDED.party,
          state=EXCLUDED.state,
          district=EXCLUDED.district,
          source=EXCLUDED.source,
          run_id=EXCLUDED.run_id,
          updated_at=now()
        """,
        (candidate_id, name, office, party, state, district, source, run_id),
    )


def upsert_committee_link(
    conn,
    candidate_id: str,
    cycle: int,
    committee_id: str,
    designation: Optional[str],
    source: str,
    run_id: int,
):
    conn.execute(
        """
        INSERT INTO candidate_committees(candidate_id, cycle, committee_id, designation, source, run_id, fetched_at)
        VALUES (%s,%s,%s,%s,%s,%s, now())
        ON CONFLICT (candidate_id, cycle, committee_id) DO UPDATE SET
          designation=EXCLUDED.designation,
          source=EXCLUDED.source,
          run_id=EXCLUDED.run_id,
          fetched_at=now()
        """,
        (candidate_id, cycle, committee_id, designation, source, run_id),
    )


def upsert_totals(
    conn,
    candidate_id: str,
    cycle: int,
    coverage_end_date: Optional[str],
    receipts: int,
    cash_on_hand: int,
    individuals: int,
    pacs: int,
    self_funding: int,
    transfers: int,
    refunds_out: int,
    other: int,
    source: str,
    run_id: int,
):
    conn.execute(
        """
        INSERT INTO candidate_totals
        (candidate_id, cycle, coverage_end_date, receipts, cash_on_hand,
         individuals, pacs, self_funding, transfers, refunds_out, other, source, run_id, fetched_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
        ON CONFLICT (candidate_id, cycle) DO UPDATE SET
          coverage_end_date=EXCLUDED.coverage_end_date,
          receipts=EXCLUDED.receipts,
          cash_on_hand=EXCLUDED.cash_on_hand,
          individuals=EXCLUDED.individuals,
          pacs=EXCLUDED.pacs,
          self_funding=EXCLUDED.self_funding,
          transfers=EXCLUDED.transfers,
          refunds_out=EXCLUDED.refunds_out,
          other=EXCLUDED.other,
          source=EXCLUDED.source,
          run_id=EXCLUDED.run_id,
          fetched_at=now()
        """,
        (
            candidate_id,
            cycle,
            coverage_end_date,
            receipts,
            cash_on_hand,
            individuals,
            pacs,
            self_funding,
            transfers,
            refunds_out,
            other,
            source,
            run_id,
        ),
    )


def upsert_pac_agg(
    conn,
    candidate_id: str,
    cycle: int,
    donor_committee_id: str,
    donor_name: Optional[str],
    total_amount: int,
    source: str,
    run_id: int,
):
    conn.execute(
        """
        INSERT INTO candidate_pac_agg(candidate_id, cycle, donor_committee_id, donor_name, total_amount, source, run_id, fetched_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s, now())
        ON CONFLICT (candidate_id, cycle, donor_committee_id) DO UPDATE SET
          donor_name=EXCLUDED.donor_name,
          total_amount=EXCLUDED.total_amount,
          source=EXCLUDED.source,
          run_id=EXCLUDED.run_id,
          fetched_at=now()
        """,
        (candidate_id, cycle, donor_committee_id, donor_name, total_amount, source, run_id),
    )


def upsert_raw_snapshot(
    conn,
    snapshot_key: str,
    candidate_id: str,
    cycle: int,
    snapshot_type: str,
    rows: List[dict],
    source: str,
    run_id: int,
):
    payload_gz = gzip_json_bytes(rows)
    conn.execute(
        """
        INSERT INTO raw_snapshots(snapshot_key, candidate_id, cycle, snapshot_type, payload_gzip, row_count, source, run_id, fetched_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s, now())
        ON CONFLICT (snapshot_key) DO UPDATE SET
          payload_gzip=EXCLUDED.payload_gzip,
          row_count=EXCLUDED.row_count,
          source=EXCLUDED.source,
          run_id=EXCLUDED.run_id,
          fetched_at=now()
        """,
        (
            snapshot_key,
            candidate_id,
            cycle,
            snapshot_type,
            payload_gz,
            len(rows),
            source,
            run_id,
        ),
    )


# -----------------------------
# Bulk file parsing (minimal fields we need)
# -----------------------------
def cycle_suffix(cycle: int) -> str:
    # 2026 -> "26"
    return str(cycle)[-2:]


def file_for(prefix: str, cycle: int) -> Path:
    return BULK_DIR / f"{prefix}{cycle_suffix(cycle)}.txt"


def assert_files_exist(paths: List[Path]):
    missing = [p for p in paths if not p.exists()]
    if missing:
        raise FileNotFoundError(
            "Missing bulk file(s):\n  " + "\n  ".join(str(p) for p in missing)
        )


def parse_cn_candidates(
    cn_path: Path,
    cycle: int,
    name_contains: Optional[str],
    office_filter: Optional[str],
    state_filter: Optional[str],
    district_filter: Optional[str],
    limit: int,
) -> Dict[str, dict]:
    """
    cnYY.txt layout (matches YOUR cn26.txt):
      0 CAND_ID
      1 CAND_NAME
      2 CAND_PTY_AFFILIATION
      3 CAND_ELECTION_YR
      4 CAND_ST
      5 CAND_OFFICE (H/S/P)
      6 CAND_DISTRICT
      9 CAND_PCC
    """
    wanted: Dict[str, dict] = {}
    name_contains_u = normalize_name(name_contains) if name_contains else None

    office_map = {"house": "H", "senate": "S", "president": "P"}
    office_code = office_map.get((office_filter or "").lower(), None) if office_filter else None

    st_u = (state_filter or "").upper() if state_filter else None
    dist_u = str(district_filter).zfill(2) if district_filter else None

    with open_text(cn_path) as f:
        for line in f:
            parts = line.rstrip("\n").split("|")
            if len(parts) < 7:
                continue

            cand_id = parts[0].strip()
            cand_name = parts[1].strip()
            party = parts[2].strip()
            election_yr = parts[3].strip()
            state = parts[4].strip()
            office = parts[5].strip()
            district = parts[6].strip()

            if election_yr and safe_int(election_yr, 0) != cycle:
                continue
            if office_code and office != office_code:
                continue
            if st_u and state.upper() != st_u:
                continue
            if dist_u and district.zfill(2) != dist_u:
                continue
            if name_contains_u and name_contains_u not in normalize_name(cand_name):
                continue

            wanted[cand_id] = {
                "candidate_id": cand_id,
                "name": cand_name,
                "party": party,
                "office": office,  # H/S/P
                "state": state,
                "district": district.zfill(2) if district else None,
            }

            if limit and len(wanted) >= limit:
                break

    return wanted


def parse_cm_committee_names(cm_path: Path) -> Dict[str, dict]:
    """
    cmYY.txt (common):
      0 CMTE_ID
      1 CMTE_NM
      8 CMTE_DSGN (if present)
      9 CMTE_TP   (if present)
    """
    out: Dict[str, dict] = {}
    with open_text(cm_path) as f:
        for line in f:
            parts = line.rstrip("\n").split("|")
            if len(parts) < 2:
                continue
            cmte_id = parts[0].strip()
            cmte_nm = parts[1].strip()
            dsgn = parts[8].strip() if len(parts) > 8 else ""
            ctype = parts[9].strip() if len(parts) > 9 else ""
            out[cmte_id] = {"name": cmte_nm, "designation": dsgn, "type": ctype}
    return out


def parse_ccl_links(ccl_path: Path, cycle: int, selected_candidate_ids: Set[str]) -> Dict[str, Set[str]]:
    """
    cclYY.txt (common):
      0 CAND_ID
      1 CAND_ELECTION_YR
      3 CMTE_ID
      ...
    """
    cand_to_comm: Dict[str, Set[str]] = defaultdict(set)
    with open_text(ccl_path) as f:
        for line in f:
            parts = line.rstrip("\n").split("|")
            if len(parts) < 4:
                continue
            cand_id = parts[0].strip()
            cand_yr = safe_int(parts[1].strip(), 0)
            cmte_id = parts[3].strip()

            if cand_id not in selected_candidate_ids:
                continue
            if cand_yr and cand_yr != cycle:
                continue
            if cmte_id:
                cand_to_comm[cand_id].add(cmte_id)

    return cand_to_comm


# -----------------------------
# Big file streamers
# -----------------------------
def stream_itcont(itcont_path: Path) -> Iterable[Tuple[str, int, str]]:
    """
    itcont.txt (common):
      0 CMTE_ID
      13 TRANSACTION_DT
      14 TRANSACTION_AMT
    """
    with open_text(itcont_path) as f:
        for line in f:
            parts = line.rstrip("\n").split("|")
            if len(parts) < 15:
                continue
            cmte_id = parts[0].strip()
            dt = parts[13].strip()
            amt = safe_int(parts[14].strip(), 0)
            yield cmte_id, amt, dt


def stream_itpas2(itpas2_path: Path) -> Iterable[Tuple[str, str, str, int, str]]:
    """
    itpas2.txt varies slightly by release.
    We parse:
      donor_committee_id  = field 0
      donor_name          = field 7 (common)
      amount              = field 14 (common)
      date                = field 13 (common)
      recipient_candidate = best-effort: scan from end for a token matching candidate id pattern.
    """
    cand_id_re = re.compile(r"^[HSP][0-9]{8}$")

    with open_text(itpas2_path) as f:
        for line in f:
            parts = line.rstrip("\n").split("|")
            if len(parts) < 15:
                continue

            donor_cmte_id = parts[0].strip()
            donor_name = parts[7].strip() if len(parts) > 7 else ""
            dt = parts[13].strip() if len(parts) > 13 else ""
            amt = safe_int(parts[14].strip() if len(parts) > 14 else "0", 0)

            recip_cand_id = ""
            for idx in range(len(parts) - 1, -1, -1):
                token = parts[idx].strip()
                if cand_id_re.match(token):
                    recip_cand_id = token
                    break

            if not recip_cand_id:
                continue

            yield donor_cmte_id, recip_cand_id, donor_name, amt, dt


# -----------------------------
# Main
# -----------------------------
def main():
    parser = argparse.ArgumentParser(description="Import FEC bulk files into Money Tracker Postgres.")
    parser.add_argument("--cycle", type=int, required=True, help="Election cycle year, e.g. 2026")
    parser.add_argument("--name", type=str, default=None, help="Filter candidates where name contains this string")
    parser.add_argument("--office", type=str, default=None, help="house|senate|president (optional)")
    parser.add_argument("--state", type=str, default=None, help="State code, e.g. IL (optional)")
    parser.add_argument("--district", type=str, default=None, help="District number, e.g. 10 (optional, House only)")
    parser.add_argument("--limit-candidates", type=int, default=10, help="Max candidates to import (default 10 for safety)")

    parser.add_argument("--truncate", action="store_true", help="Truncate existing data tables before import")

    parser.add_argument("--no-individuals", action="store_true", help="Skip itcont (individual contributions)")
    parser.add_argument("--no-committees", action="store_true", help="Skip itpas2 (committee contributions / PAC)")

    parser.add_argument("--snapshot", action="store_true", help="Store compressed raw snapshots (recommended for future drilldown)")
    parser.add_argument("--max-snapshot-rows", type=int, default=5000, help="Max raw rows stored per candidate per file type")

    parser.add_argument("--progress-every", type=int, default=250000, help="Print progress every N lines in big files")
    args = parser.parse_args()

    cycle = args.cycle
    limit = max(1, args.limit_candidates)

    # Resolve required files
    cn_path = file_for("cn", cycle)
    cm_path = file_for("cm", cycle)
    ccl_path = file_for("ccl", cycle)

    itcont_path = BULK_DIR / "itcont.txt"
    itpas2_path = BULK_DIR / "itpas2.txt"

    needed = [cn_path, cm_path, ccl_path]
    if not args.no_individuals:
        needed.append(itcont_path)
    if not args.no_committees:
        needed.append(itpas2_path)

    assert_files_exist(needed)

    print("[1/6] Loading candidates from:", cn_path)
    candidates = parse_cn_candidates(
        cn_path=cn_path,
        cycle=cycle,
        name_contains=args.name,
        office_filter=args.office,
        state_filter=args.state,
        district_filter=args.district,
        limit=limit,
    )
    if not candidates:
        print("[ERR] No candidates matched your filters.", file=sys.stderr)
        sys.exit(1)

    selected_ids = set(candidates.keys())
    print(f"      Selected candidates: {len(selected_ids)}")
    for c in list(candidates.values())[:5]:
        print(
            f"      - {c['candidate_id']}  {c['name']}  {c['office']}-{c['state']}"
            f"{('-'+c['district']) if c.get('district') else ''}"
        )

    print("[2/6] Loading committee master from:", cm_path)
    cmte_meta = parse_cm_committee_names(cm_path)

    print("[3/6] Loading candidate-committee links from:", ccl_path)
    cand_to_comm = parse_ccl_links(ccl_path, cycle, selected_ids)

    # Invert mapping: committee -> candidate(s)
    comm_to_cands: Dict[str, Set[str]] = defaultdict(set)
    for cand_id, comms in cand_to_comm.items():
        for cmte_id in comms:
            comm_to_cands[cmte_id].add(cand_id)

    # Accumulators
    indiv_totals = defaultdict(int)   # candidate -> sum
    pac_totals = defaultdict(int)     # candidate -> sum

    # ✅ UPDATED: store max coverage date as ISO (YYYY-MM-DD), not raw text
    coverage_end_iso: Dict[str, str] = {}  # candidate -> max ISO date

    pac_agg = defaultdict(lambda: defaultdict(int))  # candidate -> donor_cmte -> sum
    pac_agg_name = {}  # donor_cmte -> name

    snap_indiv = defaultdict(list)  # candidate -> rows
    snap_pac = defaultdict(list)    # candidate -> rows

    # Stream individuals
    if not args.no_individuals:
        print("[4/6] Streaming itcont (individual contributions):", itcont_path)
        count = 0
        for cmte_id, amt, dt in stream_itcont(itcont_path):
            count += 1
            if args.progress_every and count % args.progress_every == 0:
                print(f"      itcont lines processed: {count:,}")

            cand_ids = comm_to_cands.get(cmte_id)
            if not cand_ids:
                continue

            iso = parse_fec_date(dt)  # ✅ UPDATED

            for cand_id in cand_ids:
                indiv_totals[cand_id] += amt

                # ✅ UPDATED: compare ISO strings; safe and consistent
                if iso:
                    prev = coverage_end_iso.get(cand_id)
                    if (not prev) or (iso > prev):
                        coverage_end_iso[cand_id] = iso

                if args.snapshot and len(snap_indiv[cand_id]) < args.max_snapshot_rows:
                    snap_indiv[cand_id].append(
                        {"committee_id": cmte_id, "amount": amt, "date": dt, "date_iso": iso, "source": "itcont"}
                    )

        print(f"      itcont done. lines read: {count:,}")

    # Stream committee contributions / IEs
    if not args.no_committees:
        print("[5/6] Streaming itpas2 (committee contributions & IEs):", itpas2_path)
        count = 0
        for donor_cmte_id, recip_cand_id, donor_name, amt, dt in stream_itpas2(itpas2_path):
            count += 1
            if args.progress_every and count % args.progress_every == 0:
                print(f"      itpas2 lines processed: {count:,}")

            if recip_cand_id not in selected_ids:
                continue

            pac_totals[recip_cand_id] += amt

            iso = parse_fec_date(dt)  # ✅ UPDATED
            if iso:
                prev = coverage_end_iso.get(recip_cand_id)
                if (not prev) or (iso > prev):
                    coverage_end_iso[recip_cand_id] = iso

            if donor_cmte_id:
                pac_agg[recip_cand_id][donor_cmte_id] += amt
                if donor_cmte_id not in pac_agg_name and donor_name:
                    pac_agg_name[donor_cmte_id] = donor_name

            if args.snapshot and len(snap_pac[recip_cand_id]) < args.max_snapshot_rows:
                snap_pac[recip_cand_id].append(
                    {
                        "donor_committee_id": donor_cmte_id,
                        "donor_name": donor_name,
                        "amount": amt,
                        "date": dt,
                        "date_iso": iso,
                        "source": "itpas2",
                    }
                )

        print(f"      itpas2 done. lines read: {count:,}")

    # Write to Postgres
    print("[6/6] Writing to Postgres...")
    with pg_connect() as conn:
        if args.truncate:
            print("      Truncating tables...")
            truncate_tables(conn)

        run_id = create_import_run(
            conn,
            source="bulk",
            notes="bulk_import_fec.py",
            meta={
                "cycle": cycle,
                "filters": {
                    "name": args.name,
                    "office": args.office,
                    "state": args.state,
                    "district": args.district,
                    "limit_candidates": args.limit_candidates,
                },
                "snapshot": bool(args.snapshot),
                "started_at": now_utc_iso(),
            },
        )

        source = "bulk"

        # candidates + committee links
        for cand_id, c in candidates.items():
            office_code = (c.get("office") or "").strip().upper()
            office_name = {"H": "house", "S": "senate", "P": "president"}.get(office_code, office_code)

            upsert_candidate(
                conn,
                candidate_id=cand_id,
                name=c.get("name") or "",
                office=office_name,
                party=c.get("party") or "",
                state=c.get("state") or "",
                district=c.get("district"),
                source=source,
                run_id=run_id,
            )

            for cmte_id in sorted(cand_to_comm.get(cand_id, set())):
                meta = cmte_meta.get(cmte_id, {})
                dsgn = meta.get("designation") or ""
                nm = meta.get("name") or ""
                designation = f"{dsgn} - {nm}".strip(" -") if (dsgn or nm) else None

                upsert_committee_link(
                    conn,
                    cand_id,
                    cycle,
                    cmte_id,
                    designation,
                    source=source,
                    run_id=run_id,
                )

        # totals
        for cand_id in candidates.keys():
            indiv = int(indiv_totals.get(cand_id, 0))
            pacs = int(pac_totals.get(cand_id, 0))
            receipts = indiv + pacs

            self_funding = 0
            transfers = 0
            refunds_out = 0
            other = 0
            cash_on_hand = 0

            # ✅ UPDATED: directly use ISO coverage end
            cov_iso = coverage_end_iso.get(cand_id)

            upsert_totals(
                conn,
                cand_id,
                cycle,
                cov_iso,
                receipts,
                cash_on_hand,
                indiv,
                pacs,
                self_funding,
                transfers,
                refunds_out,
                other,
                source=source,
                run_id=run_id,
            )

        # PAC breakdown
        for cand_id, donor_map in pac_agg.items():
            top = sorted(donor_map.items(), key=lambda kv: kv[1], reverse=True)
            for donor_cmte_id, total_amt in top:
                upsert_pac_agg(
                    conn,
                    cand_id,
                    cycle,
                    donor_cmte_id,
                    pac_agg_name.get(donor_cmte_id),
                    int(total_amt),
                    source=source,
                    run_id=run_id,
                )

        # raw snapshots
        if args.snapshot:
            for cand_id in candidates.keys():
                if snap_indiv.get(cand_id):
                    key = f"{cand_id}:{cycle}:itcont_seed"
                    upsert_raw_snapshot(
                        conn,
                        key,
                        cand_id,
                        cycle,
                        "itcont_seed",
                        snap_indiv[cand_id],
                        source=source,
                        run_id=run_id,
                    )
                if snap_pac.get(cand_id):
                    key = f"{cand_id}:{cycle}:itpas2_seed"
                    upsert_raw_snapshot(
                        conn,
                        key,
                        cand_id,
                        cycle,
                        "itpas2_seed",
                        snap_pac[cand_id],
                        source=source,
                        run_id=run_id,
                    )

        finish_import_run(conn, run_id)
        conn.commit()

    print("[OK] Import complete.")
    print("     Candidates:", len(candidates))
    print("     Import run_id recorded in import_runs.")


if __name__ == "__main__":
    main()
