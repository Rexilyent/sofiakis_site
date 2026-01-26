#!/usr/bin/env python3
"""
seed_openfec.py

Two commands:
  1) download: pulls OpenFEC data and saves a compressed seed file (.json.gz)
  2) import:   loads the seed file and upserts into Postgres

Example:
  python tools/seed_openfec.py download --cycle 2026 --office house --query "Sofiakis" --limit 10 --sched-a-pages 3
  python tools/seed_openfec.py import --truncate

Env (backend/.env):
  OPENFEC_API_KEY=DEMO_KEY (or your key)
  PGHOST=localhost
  PGPORT=5433
  PGDATABASE=moneytracker
  PGUSER=moneytracker_user
  PGPASSWORD=...
Optional:
  DATABASE_URL=postgresql://...
"""

import argparse
import gzip
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
import psycopg
from psycopg.rows import dict_row

# -----------------------------
# Paths
# -----------------------------
ROOT_DIR = Path(__file__).resolve().parents[2]  # sofiakis_site/
BACKEND_DIR = ROOT_DIR / "backend"
SEEDS_DIR = BACKEND_DIR / "seeds"
DEFAULT_SEED_FILE = SEEDS_DIR / "openfec_seed.json.gz"

# -----------------------------
# OpenFEC basics
# -----------------------------
OPENFEC_BASE = "https://api.open.fec.gov/v1"

def env(name: str, default: str = "") -> str:
    return os.getenv(name, default)

def now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def openfec_key() -> str:
    key = env("OPENFEC_API_KEY", "DEMO_KEY")
    if not key:
        raise RuntimeError("OPENFEC_API_KEY missing. Set it in backend/.env")
    return key

def fec_get(path: str, params: Dict[str, Any], sleep_s: float = 0.12) -> Dict[str, Any]:
    """Simple GET with minimal backoff for friendly use."""
    params = dict(params)
    params["api_key"] = openfec_key()

    url = f"{OPENFEC_BASE}{path}"
    r = requests.get(url, params=params, timeout=30)
    if r.status_code == 429:
        # Basic backoff
        time.sleep(2.0)
        r = requests.get(url, params=params, timeout=30)

    r.raise_for_status()
    time.sleep(sleep_s)
    return r.json()

# -----------------------------
# Postgres connect (same as app)
# -----------------------------
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
        raise RuntimeError("Missing PGDATABASE/PGUSER/PGPASSWORD (or DATABASE_URL). Check backend/.env")

    return psycopg.connect(
        host=host, port=port, dbname=dbname, user=user, password=pwd, row_factory=dict_row
    )

# -----------------------------
# DB helpers (schema must exist)
# -----------------------------
def ensure_dirs():
    SEEDS_DIR.mkdir(parents=True, exist_ok=True)

def truncate_tables(conn):
    conn.execute("TRUNCATE TABLE candidate_pac_agg RESTART IDENTITY CASCADE;")
    conn.execute("TRUNCATE TABLE candidate_committees RESTART IDENTITY CASCADE;")
    conn.execute("TRUNCATE TABLE candidate_totals RESTART IDENTITY CASCADE;")
    conn.execute("TRUNCATE TABLE raw_snapshots RESTART IDENTITY CASCADE;")
    conn.execute("TRUNCATE TABLE candidates RESTART IDENTITY CASCADE;")

def upsert_candidate(conn, c: Dict[str, Any]):
    conn.execute(
        """
        INSERT INTO candidates(candidate_id, name, office, party, state, district, updated_at)
        VALUES (%s,%s,%s,%s,%s,%s, now())
        ON CONFLICT (candidate_id) DO UPDATE SET
          name=EXCLUDED.name,
          office=EXCLUDED.office,
          party=EXCLUDED.party,
          state=EXCLUDED.state,
          district=EXCLUDED.district,
          updated_at=now()
        """,
        (
            c.get("candidate_id"),
            c.get("name"),
            c.get("office"),
            c.get("party"),
            c.get("state"),
            str(c.get("district")) if c.get("district") is not None else None,
        ),
    )

def upsert_totals(conn, candidate_id: str, cycle: int, totals: Dict[str, Any]):
    b = totals["breakdown"]
    conn.execute(
        """
        INSERT INTO candidate_totals
        (candidate_id, cycle, coverage_end_date, receipts, cash_on_hand,
         individuals, pacs, self_funding, transfers, refunds_out, other, fetched_at)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
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
          fetched_at=now()
        """,
        (
            candidate_id,
            cycle,
            totals.get("coverage_end_date"),
            int(totals.get("receipts", 0)),
            int(totals.get("cash_on_hand", 0)),
            int(b.get("individuals", 0)),
            int(b.get("pacs", 0)),
            int(b.get("self_funding", 0)),
            int(b.get("transfers", 0)),
            int(b.get("refunds_out", 0)),
            int(b.get("other", 0)),
        ),
    )

def upsert_committees(conn, candidate_id: str, cycle: int, committees: List[Dict[str, Any]]):
    for cm in committees:
        conn.execute(
            """
            INSERT INTO candidate_committees(candidate_id, cycle, committee_id, designation, fetched_at)
            VALUES (%s,%s,%s,%s, now())
            ON CONFLICT (candidate_id, cycle, committee_id) DO UPDATE SET
              designation=EXCLUDED.designation,
              fetched_at=now()
            """,
            (
                candidate_id,
                cycle,
                cm.get("committee_id"),
                cm.get("designation") or cm.get("designation_full"),
            ),
        )

def upsert_pac_agg(conn, candidate_id: str, cycle: int, pac_rows: List[Dict[str, Any]]):
    for row in pac_rows:
        conn.execute(
            """
            INSERT INTO candidate_pac_agg(candidate_id, cycle, donor_committee_id, donor_name, total_amount, fetched_at)
            VALUES (%s,%s,%s,%s,%s, now())
            ON CONFLICT (candidate_id, cycle, donor_committee_id) DO UPDATE SET
              donor_name=EXCLUDED.donor_name,
              total_amount=EXCLUDED.total_amount,
              fetched_at=now()
            """,
            (
                candidate_id,
                cycle,
                row["donor_committee_id"],
                row.get("donor_name"),
                int(row.get("total_amount", 0)),
            ),
        )

def insert_raw_snapshot(conn, snapshot_key: str, candidate_id: str, cycle: int, snapshot_type: str, rows: List[Dict[str, Any]]):
    payload = json.dumps(rows, separators=(",", ":")).encode("utf-8")
    payload_gz = gzip.compress(payload, compresslevel=9)
    conn.execute(
        """
        INSERT INTO raw_snapshots(snapshot_key, candidate_id, cycle, snapshot_type, payload_gzip, row_count, fetched_at)
        VALUES (%s,%s,%s,%s,%s,%s, now())
        ON CONFLICT (snapshot_key) DO UPDATE SET
          payload_gzip=EXCLUDED.payload_gzip,
          row_count=EXCLUDED.row_count,
          fetched_at=now()
        """,
        (snapshot_key, candidate_id, cycle, snapshot_type, payload_gz, len(rows)),
    )

# -----------------------------
# OpenFEC query helpers
# -----------------------------
def search_candidates(query: str, cycle: int, office: str, limit: int) -> List[Dict[str, Any]]:
    # OpenFEC uses office codes: H, S, P; their search endpoint supports office and cycle.
    # We'll map friendly values.
    office_map = {"house": "H", "senate": "S", "president": "P", "": ""}
    office_code = office_map.get(office.lower(), office)

    data = fec_get(
        "/candidates/search/",
        {
            "q": query,
            "cycle": cycle,
            "office": office_code,
            "per_page": min(limit, 100),
        },
    )
    return data.get("results") or []

def get_candidate_totals(candidate_id: str, cycle: int) -> Dict[str, Any]:
    data = fec_get(
        f"/candidate/{candidate_id}/totals/",
        {"cycle": cycle, "per_page": 20},
    )
    rows = data.get("results") or []

    # Pick "best" row: prefer last filing / highest receipts; keep simple for seeding.
    best = None
    for r in rows:
        if not best:
            best = r
            continue
        if (r.get("receipts") or 0) > (best.get("receipts") or 0):
            best = r

    if not best:
        return {
            "coverage_end_date": None,
            "receipts": 0,
            "cash_on_hand": 0,
            "breakdown": {
                "individuals": 0,
                "pacs": 0,
                "self_funding": 0,
                "transfers": 0,
                "refunds_out": 0,
                "other": 0,
            },
        }

    # Normalize to the same fields your app expects
    indiv = int(best.get("individual_contributions") or 0)
    pacs = int(best.get("pac_contributions") or 0)
    self_fund = int(best.get("candidate_contribution") or 0)
    transfers = int(best.get("transfers_from_affiliated_committee") or 0)
    refunds_out = int(best.get("refunded_individual_contributions") or 0) + int(best.get("refunded_other_political_committee_contributions") or 0)

    receipts = int(best.get("receipts") or 0)
    # “other” is a catch-all: receipts - known buckets, but never below 0.
    other = max(0, receipts - (indiv + pacs + self_fund + transfers))

    return {
        "coverage_end_date": best.get("coverage_end_date"),
        "receipts": receipts,
        "cash_on_hand": int(best.get("cash_on_hand_end_period") or 0),
        "breakdown": {
            "individuals": indiv,
            "pacs": pacs,
            "self_funding": self_fund,
            "transfers": transfers,
            "refunds_out": refunds_out,
            "other": other,
        },
    }

def get_candidate_committees(candidate_id: str, cycle: int) -> List[Dict[str, Any]]:
    data = fec_get(
        f"/candidate/{candidate_id}/committees/",
        {"cycle": cycle, "per_page": 100},
    )
    return data.get("results") or []

def get_schedule_a_for_committee(committee_id: str, cycle: int, pages: int, per_page: int) -> List[Dict[str, Any]]:
    """
    Schedule A endpoint is large; we limit pages for seeding.
    We only keep fields needed for PAC aggregation + potential drilldowns.
    """
    out: List[Dict[str, Any]] = []
    for page in range(1, pages + 1):
        data = fec_get(
            "/schedules/schedule_a/",
            {
                "committee_id": committee_id,
                "two_year_transaction_period": cycle,
                "per_page": per_page,
                "page": page,
                # keep it deterministic / consistent
                "sort": "-contribution_receipt_date",
            },
            sleep_s=0.15,
        )
        rows = data.get("results") or []
        if not rows:
            break

        for r in rows:
            # Keep a compact subset
            out.append(
                {
                    "committee_id": r.get("committee_id"),
                    "contribution_receipt_date": r.get("contribution_receipt_date"),
                    "contribution_receipt_amount": r.get("contribution_receipt_amount") or 0,
                    "contributor_name": r.get("contributor_name"),
                    "contributor_committee_id": r.get("contributor_committee_id"),
                    "contributor_entity_type": r.get("contributor_entity_type"),
                    "contribution_form": r.get("contribution_form"),
                    "memo_text": r.get("memo_text"),
                    "line_number": r.get("line_number"),
                }
            )
    return out

def compute_pac_agg_from_schedule_a(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Aggregate by contributor_committee_id (PAC committee id).
    Only counts rows that actually have contributor_committee_id.
    """
    agg: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        donor_id = r.get("contributor_committee_id")
        if not donor_id:
            continue
        amt = int(r.get("contribution_receipt_amount") or 0)
        cur = agg.get(donor_id)
        if not cur:
            agg[donor_id] = {
                "donor_committee_id": donor_id,
                "donor_name": r.get("contributor_name"),
                "total_amount": amt,
            }
        else:
            cur["total_amount"] += amt

    # Sort biggest PACs first (nice for testing UI)
    return sorted(agg.values(), key=lambda x: x["total_amount"], reverse=True)

# -----------------------------
# Seed file format
# -----------------------------
def build_seed_payload(candidates: List[Dict[str, Any]], cycle: int, sched_a_pages: int, sched_a_per_page: int) -> Dict[str, Any]:
    seed: Dict[str, Any] = {
        "meta": {
            "created_at": now_utc_iso(),
            "cycle": cycle,
            "source": "OpenFEC",
            "sched_a_pages": sched_a_pages,
            "sched_a_per_page": sched_a_per_page,
        },
        "candidates": [],
    }

    for c in candidates:
        cand_id = c.get("candidate_id")
        if not cand_id:
            continue

        totals = get_candidate_totals(cand_id, cycle)
        committees = get_candidate_committees(cand_id, cycle)

        # Pull limited schedule A from committees to compute PAC breakdown + store raw snapshot
        schedule_a_all: List[Dict[str, Any]] = []
        for cm in committees:
            cm_id = cm.get("committee_id")
            if not cm_id:
                continue
            if sched_a_pages > 0:
                rows = get_schedule_a_for_committee(cm_id, cycle, pages=sched_a_pages, per_page=sched_a_per_page)
                schedule_a_all.extend(rows)

        pac_agg = compute_pac_agg_from_schedule_a(schedule_a_all) if schedule_a_all else []

        seed["candidates"].append(
            {
                "candidate": {
                    "candidate_id": cand_id,
                    "name": c.get("name"),
                    "office": c.get("office"),
                    "party": c.get("party_full") or c.get("party"),
                    "state": c.get("state"),
                    "district": c.get("district"),
                },
                "totals": totals,
                "committees": [
                    {
                        "committee_id": cm.get("committee_id"),
                        "designation": cm.get("designation") or cm.get("designation_full"),
                    }
                    for cm in committees
                ],
                "pac_agg": pac_agg[:200],  # keep seed smaller
                "schedule_a_snapshot": schedule_a_all,  # already compact
            }
        )

    return seed

def write_seed_file(seed: Dict[str, Any], path: Path):
    ensure_dirs()
    raw = json.dumps(seed, separators=(",", ":")).encode("utf-8")
    gz = gzip.compress(raw, compresslevel=9)
    path.write_bytes(gz)

def read_seed_file(path: Path) -> Dict[str, Any]:
    data = gzip.decompress(path.read_bytes()).decode("utf-8")
    return json.loads(data)

# -----------------------------
# Import into DB
# -----------------------------
def import_seed(path: Path, truncate: bool):
    seed = read_seed_file(path)
    cycle = int(seed["meta"]["cycle"])

    with pg_connect() as conn:
        if truncate:
            truncate_tables(conn)

        for entry in seed.get("candidates", []):
            c = entry["candidate"]
            upsert_candidate(conn, c)

            upsert_totals(conn, c["candidate_id"], cycle, entry["totals"])

            upsert_committees(conn, c["candidate_id"], cycle, entry.get("committees", []))

            # PAC aggregates (computed from Schedule A snapshot)
            upsert_pac_agg(conn, c["candidate_id"], cycle, entry.get("pac_agg", []))

            # Raw snapshot stored in DB (compressed BYTEA)
            snap_rows = entry.get("schedule_a_snapshot") or []
            if snap_rows:
                snapshot_key = f"{c['candidate_id']}:{cycle}:schedule_a_seed"
                insert_raw_snapshot(
                    conn,
                    snapshot_key=snapshot_key,
                    candidate_id=c["candidate_id"],
                    cycle=cycle,
                    snapshot_type="schedule_a_seed",
                    rows=snap_rows,
                )

        conn.commit()

# -----------------------------
# CLI
# -----------------------------
def main():
    parser = argparse.ArgumentParser(description="Download OpenFEC data and seed Postgres for testing.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("download", help="Download OpenFEC data into a compressed seed file.")
    d.add_argument("--cycle", type=int, required=True, help="Election cycle (e.g., 2026).")
    d.add_argument("--office", type=str, default="", help="house|senate|president or empty for all")
    d.add_argument("--query", type=str, required=True, help="Candidate search query (name).")
    d.add_argument("--limit", type=int, default=10, help="Max candidates to include (<=100).")
    d.add_argument("--sched-a-pages", type=int, default=0, help="How many schedule A pages per committee to include (0 disables).")
    d.add_argument("--sched-a-per-page", type=int, default=50, help="Schedule A per_page (max 100, lower saves space).")
    d.add_argument("--out", type=str, default=str(DEFAULT_SEED_FILE), help="Output seed file (.json.gz).")

    i = sub.add_parser("import", help="Import a seed file into Postgres.")
    i.add_argument("--in", dest="inp", type=str, default=str(DEFAULT_SEED_FILE), help="Input seed file (.json.gz).")
    i.add_argument("--truncate", action="store_true", help="Truncate tables before import (dev reset).")

    args = parser.parse_args()

    if args.cmd == "download":
        limit = max(1, min(args.limit, 100))
        per_page = max(1, min(args.sched_a_per_page, 100))
        candidates = search_candidates(args.query, args.cycle, args.office, limit=limit)
        payload = build_seed_payload(candidates, args.cycle, args.sched_a_pages, per_page)

        out_path = Path(args.out)
        write_seed_file(payload, out_path)

        print(f"[OK] Saved seed file: {out_path}")
        print(f"     Candidates: {len(payload.get('candidates', []))}")
        print(f"     Cycle: {payload['meta']['cycle']}")
        print(f"     Schedule A pages/committee: {payload['meta']['sched_a_pages']}")
        return

    if args.cmd == "import":
        inp = Path(args.inp)
        if not inp.exists():
            print(f"[ERR] Seed file not found: {inp}", file=sys.stderr)
            sys.exit(1)

        import_seed(inp, truncate=args.truncate)
        print(f"[OK] Imported seed file into Postgres: {inp}")
        return


if __name__ == "__main__":
    main()
