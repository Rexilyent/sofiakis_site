#!/usr/bin/env python3
"""
bulk_import_fec.py (direct-to-app schema)

Imports FEC bulk pipe-delimited .txt files and writes *directly* into the app-facing schema
defined in `app_facing_database_creation.sql`.

This script:
- creates an import run (public.import_runs)
- (optionally) clears prior rows for the given cycle in app-facing aggregate tables
- upserts canonical entities:
    - public.candidates  (from cnYY + weballYY + weblYY)
    - public.committees  (from cmYY)
    - public.candidate_committees (from cclYY)
- streams the large transaction files and incrementally upserts aggregates:
    - itcont.txt  -> candidate_individual_donor_agg, individual_donor_totals, candidate_receipts_monthly, candidate_totals
    - itpas2.txt  -> candidate_pac_agg, committee_donor_totals, candidate_receipts_monthly, candidate_totals
    - itoth.txt   -> committee_donor_totals (optional; transfers between committees)
    - oppexp.txt  -> candidate_expenditures_monthly, candidate_expenditures_totals

Notes / assumptions:
- FEC bulk layouts can vary slightly by cycle. This parser uses the same “common index” heuristics
  you were using previously.
- Some transactions reference only committees. To attribute those to candidates, we use CCL linkage
  for the requested cycle. If a committee maps to multiple candidates in the cycle, we skip attribution
  (and count it in a "skipped" stat) rather than guessing.

Usage:
  python backend/tools/bulk_import_fec.py --cycle 2026 --bulk-dir backend/seeds/fec_bulk --reset-cycle
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, DefaultDict, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

import psycopg
from psycopg.rows import dict_row
from dotenv import load_dotenv


# -----------------------------
# Paths / env
# -----------------------------
ROOT_DIR = Path(__file__).resolve().parents[2]  # project root
BACKEND_DIR = ROOT_DIR / "backend"
DEFAULT_BULK_DIR = BACKEND_DIR / "seeds" / "fec_bulk"

ENV_PATH = (Path(__file__).resolve().parents[1] / ".env")  # backend/.env
load_dotenv(dotenv_path=ENV_PATH)


def env(name: str, default: str = "") -> str:
    return os.getenv(name, default)


def open_text(path: Path):
    # FEC bulk files are commonly Latin-1 compatible.
    return open(path, "r", encoding="latin-1", errors="replace", newline="")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def safe_num(x: str) -> Optional[float]:
    try:
        t = (x or "").strip()
        if not t:
            return None
        return float(t)
    except Exception:
        return None


def parse_fec_date(s: str) -> Optional[date]:
    """
    Return a date or None.
    Handles YYYYMMDD, MMDDYYYY, YYYY-MM-DD (and any string containing 8 digits).
    """
    if not s:
        return None
    t = s.strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}$", t):
        try:
            return datetime.strptime(t, "%Y-%m-%d").date()
        except Exception:
            return None

    digits = re.sub(r"\D", "", t)
    if len(digits) != 8:
        return None

    # YYYYMMDD
    y1, m1, d1 = int(digits[0:4]), int(digits[4:6]), int(digits[6:8])
    if 1900 <= y1 <= 2100 and 1 <= m1 <= 12 and 1 <= d1 <= 31:
        try:
            return date(y1, m1, d1)
        except Exception:
            pass

    # MMDDYYYY
    m2, d2, y2 = int(digits[0:2]), int(digits[2:4]), int(digits[4:8])
    if 1900 <= y2 <= 2100 and 1 <= m2 <= 12 and 1 <= d2 <= 31:
        try:
            return date(y2, m2, d2)
        except Exception:
            pass

    return None


def month_start(d: date) -> date:
    return date(d.year, d.month, 1)


def parts_get(parts: Sequence[str], idx: int) -> str:
    return parts[idx].strip() if idx < len(parts) and parts[idx] is not None else ""


def read_pipe_rows(path: Path) -> Iterator[Tuple[int, str, List[str]]]:
    """Yield (row_num starting at 1, raw_line, parts)."""
    with open_text(path) as f:
        for i, line in enumerate(f, start=1):
            raw = line.rstrip("\n")
            # Some bulk files end with trailing '|', split keeps last empty part, that's fine.
            yield i, raw, raw.split("|")


def cycle_suffix(cycle: int) -> str:
    return str(cycle)[-2:]


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


# -----------------------------
# import run tracking
# -----------------------------
def create_import_run(conn, cycle: int, source: str, notes: str, meta: dict) -> int:
    row = conn.execute(
        """
        INSERT INTO public.import_runs(cycle, source, notes, meta)
        VALUES (%s, %s, %s, %s::jsonb)
        RETURNING run_id
        """,
        (cycle, source, notes, json.dumps(meta)),
    ).fetchone()
    return int(row["run_id"])


def finish_import_run(conn, run_id: int, status: str = "finished"):
    conn.execute(
        "UPDATE public.import_runs SET finished_at=now(), status=%s WHERE run_id=%s",
        (status, run_id),
    )


# -----------------------------
# batching helpers
# -----------------------------
def batched(it: Iterable[Any], batch_size: int) -> Iterable[List[Any]]:
    batch: List[Any] = []
    for x in it:
        batch.append(x)
        if len(batch) >= batch_size:
            yield batch
            batch = []
    if batch:
        yield batch


# -----------------------------
# canonical entity parsing
# -----------------------------
@dataclass
class CandidateRec:
    candidate_id: str
    name: Optional[str] = None
    office: Optional[str] = None
    party: Optional[str] = None
    state: Optional[str] = None
    district: Optional[str] = None
    # for merge/debug
    source_rank: int = 99
    source_tag: str = "unknown"


def merge_candidate(dst: CandidateRec, src: CandidateRec) -> CandidateRec:
    """
    Merge preferring higher-quality sources (lower source_rank) but also
    filling missing fields.
    """
    if src.source_rank < dst.source_rank:
        # Higher priority: take non-empty values, but don't overwrite with empties.
        for field in ("name", "office", "party", "state", "district"):
            v = getattr(src, field)
            if v:
                setattr(dst, field, v)
        dst.source_rank = src.source_rank
        dst.source_tag = src.source_tag
        return dst

    # Lower (or equal) priority: only fill missing values.
    for field in ("name", "office", "party", "state", "district"):
        if getattr(dst, field):
            continue
        v = getattr(src, field)
        if v:
            setattr(dst, field, v)
    return dst


def parse_cn_candidates(path: Path, cycle: int) -> Dict[str, CandidateRec]:
    out: Dict[str, CandidateRec] = {}
    for _, _, p in read_pipe_rows(path):
        cand_id = parts_get(p, 0)
        if not cand_id:
            continue
        election_year = parts_get(p, 3)
        if election_year and election_year.isdigit() and int(election_year) != cycle:
            continue

        district = parts_get(p, 6)
        out[cand_id] = CandidateRec(
            candidate_id=cand_id,
            name=(parts_get(p, 1) or None),
            party=(parts_get(p, 2) or None),
            state=(parts_get(p, 4) or None),
            office=(parts_get(p, 5) or None),
            district=(district.zfill(2) if district else None),
            source_rank=2,  # lower priority than current-campaign lists
            source_tag="cn",
        )
    return out


def parse_weball_candidates(path: Path) -> Dict[str, CandidateRec]:
    out: Dict[str, CandidateRec] = {}
    for _, _, p in read_pipe_rows(path):
        cand_id = parts_get(p, 0)
        if not cand_id:
            continue
        district = parts_get(p, 4)
        out[cand_id] = CandidateRec(
            candidate_id=cand_id,
            name=(parts_get(p, 1) or None),
            office=(parts_get(p, 2) or None),
            state=(parts_get(p, 3) or None),
            district=(district.zfill(2) if district else None),
            party=(parts_get(p, 5) or None),
            source_rank=1,
            source_tag="weball",
        )
    return out


def parse_webl_candidates(path: Path) -> Dict[str, CandidateRec]:
    out: Dict[str, CandidateRec] = {}
    for _, _, p in read_pipe_rows(path):
        cand_id = parts_get(p, 0)
        if not cand_id:
            continue
        district = parts_get(p, 4)
        out[cand_id] = CandidateRec(
            candidate_id=cand_id,
            name=(parts_get(p, 1) or None),
            office=(parts_get(p, 2) or None),
            state=(parts_get(p, 3) or None),
            district=(district.zfill(2) if district else None),
            party=(parts_get(p, 5) or None),
            source_rank=0,  # highest priority
            source_tag="webl",
        )
    return out


@dataclass
class CommitteeRec:
    committee_id: str
    name: Optional[str] = None
    committee_type: Optional[str] = None
    committee_designation: Optional[str] = None
    organization_type: Optional[str] = None
    connected_org_name: Optional[str] = None


def parse_cm_committees(path: Path, cycle: int) -> Dict[str, CommitteeRec]:
    out: Dict[str, CommitteeRec] = {}
    for _, _, p in read_pipe_rows(path):
        cmte_id = parts_get(p, 0)
        if not cmte_id:
            continue
        # cm layouts often include election_year around index 3; be forgiving
        election_year = parts_get(p, 3)
        if election_year and election_year.isdigit() and int(election_year) != cycle:
            # some cm files don't use this position; don't hard-skip if committee_id is present
            pass

        out[cmte_id] = CommitteeRec(
            committee_id=cmte_id,
            name=(parts_get(p, 1) or None),
            committee_type=(parts_get(p, 2) or None),
            committee_designation=(parts_get(p, 3) or None),
            organization_type=(parts_get(p, 4) or None),
            connected_org_name=(parts_get(p, 5) or None),
        )
    return out


@dataclass
class LinkRec:
    candidate_id: str
    committee_id: str
    cycle: int
    linkage_type: Optional[str] = None
    designation: Optional[str] = None


def parse_ccl_links(path: Path, cycle: int) -> List[LinkRec]:
    out: List[LinkRec] = []
    for _, _, p in read_pipe_rows(path):
        cand_id = parts_get(p, 0)
        cmte_id = parts_get(p, 1)
        if not (cand_id and cmte_id):
            continue

        election_year = parts_get(p, 2)
        if election_year and election_year.isdigit() and int(election_year) != cycle:
            continue

        linkage_type = parts_get(p, 3) or None
        designation = parts_get(p, 4) or None

        out.append(
            LinkRec(
                candidate_id=cand_id,
                committee_id=cmte_id,
                cycle=cycle,
                linkage_type=linkage_type,
                designation=designation,
            )
        )
    return out


# -----------------------------
# DB writers (canonical)
# -----------------------------
def upsert_candidates(conn, candidates: Dict[str, CandidateRec], run_id: int):
    sql = """
    INSERT INTO public.candidates
      (candidate_id, name, office, party, state, district, updated_at, source, run_id)
    VALUES
      (%s,%s,%s,%s,%s,%s, now(), %s, %s)
    ON CONFLICT (candidate_id) DO UPDATE SET
      name       = COALESCE(EXCLUDED.name, public.candidates.name),
      office     = COALESCE(EXCLUDED.office, public.candidates.office),
      party      = COALESCE(EXCLUDED.party, public.candidates.party),
      state      = COALESCE(EXCLUDED.state, public.candidates.state),
      district   = COALESCE(EXCLUDED.district, public.candidates.district),
      updated_at = now(),
      source     = EXCLUDED.source,
      run_id     = EXCLUDED.run_id
    """
    rows = [
        (
            c.candidate_id,
            c.name,
            c.office,
            c.party,
            c.state,
            c.district,
            c.source_tag,
            run_id,
        )
        for c in candidates.values()
    ]
    if rows:
        conn.executemany(sql, rows)


def upsert_committees(conn, committees: Dict[str, CommitteeRec], run_id: int):
    sql = """
    INSERT INTO public.committees
      (committee_id, name, committee_type, committee_designation, organization_type,
       connected_org_name, updated_at, source, run_id)
    VALUES
      (%s,%s,%s,%s,%s,%s, now(), %s, %s)
    ON CONFLICT (committee_id) DO UPDATE SET
      name                  = COALESCE(EXCLUDED.name, public.committees.name),
      committee_type        = COALESCE(EXCLUDED.committee_type, public.committees.committee_type),
      committee_designation = COALESCE(EXCLUDED.committee_designation, public.committees.committee_designation),
      organization_type     = COALESCE(EXCLUDED.organization_type, public.committees.organization_type),
      connected_org_name    = COALESCE(EXCLUDED.connected_org_name, public.committees.connected_org_name),
      updated_at            = now(),
      source                = EXCLUDED.source,
      run_id                = EXCLUDED.run_id
    """
    rows = [
        (
            c.committee_id,
            c.name,
            c.committee_type,
            c.committee_designation,
            c.organization_type,
            c.connected_org_name,
            "cm",
            run_id,
        )
        for c in committees.values()
    ]
    if rows:
        conn.executemany(sql, rows)


def upsert_candidate_committees(conn, links: List[LinkRec], run_id: int):
    sql = """
    INSERT INTO public.candidate_committees
      (candidate_id, committee_id, cycle, linkage_type, designation, updated_at, source, run_id)
    VALUES
      (%s,%s,%s,%s,%s, now(), %s, %s)
    ON CONFLICT (candidate_id, committee_id, cycle) DO UPDATE SET
      linkage_type = COALESCE(EXCLUDED.linkage_type, public.candidate_committees.linkage_type),
      designation  = COALESCE(EXCLUDED.designation, public.candidate_committees.designation),
      updated_at   = now(),
      source       = EXCLUDED.source,
      run_id       = EXCLUDED.run_id
    """
    rows = [
        (l.candidate_id, l.committee_id, l.cycle, l.linkage_type, l.designation, "ccl", run_id)
        for l in links
    ]
    if rows:
        conn.executemany(sql, rows)


# -----------------------------
# DB writers (aggregates)
# -----------------------------
def upsert_candidate_totals(conn, rows: List[Tuple[Any, ...]]):
    """
    rows: (candidate_id, cycle, coverage_end_date, receipts, cash_on_hand, individuals, pacs,
           self_funding, refunds_out, other, fetched_at, source, run_id)
    """
    sql = """
    INSERT INTO public.candidate_totals
      (candidate_id, cycle, coverage_end_date, receipts, cash_on_hand, individuals, pacs,
       self_funding, refunds_out, other, fetched_at, source, run_id)
    VALUES
      (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
    ON CONFLICT (candidate_id, cycle) DO UPDATE SET
      coverage_end_date = GREATEST(public.candidate_totals.coverage_end_date, EXCLUDED.coverage_end_date),
      receipts          = EXCLUDED.receipts,
      cash_on_hand      = EXCLUDED.cash_on_hand,
      individuals       = EXCLUDED.individuals,
      pacs              = EXCLUDED.pacs,
      self_funding      = EXCLUDED.self_funding,
      refunds_out       = EXCLUDED.refunds_out,
      other             = EXCLUDED.other,
      fetched_at        = EXCLUDED.fetched_at,
      source            = EXCLUDED.source,
      run_id            = EXCLUDED.run_id
    """
    if rows:
        conn.executemany(sql, rows)


def upsert_individual_donor_totals(conn, rows: List[Tuple[Any, ...]]):
    """
    rows: (cycle, donor_name, donor_state, donor_zip, total_amount, fetched_at, source, run_id)
    """
    sql = """
    INSERT INTO public.individual_donor_totals
      (cycle, donor_name, donor_state, donor_zip, total_amount, fetched_at, source, run_id)
    VALUES
      (%s,%s,%s,%s,%s,%s,%s,%s)
    ON CONFLICT (cycle, donor_name, donor_state, donor_zip) DO UPDATE SET
      total_amount = EXCLUDED.total_amount,
      fetched_at   = EXCLUDED.fetched_at,
      source       = EXCLUDED.source,
      run_id       = EXCLUDED.run_id
    """
    if rows:
        conn.executemany(sql, rows)


def upsert_candidate_individual_donor_agg(conn, rows: List[Tuple[Any, ...]]):
    """
    rows: (candidate_id, cycle, donor_name, donor_state, donor_zip, total_amount, fetched_at, source, run_id)
    """
    sql = """
    INSERT INTO public.candidate_individual_donor_agg
      (candidate_id, cycle, donor_name, donor_state, donor_zip, total_amount, fetched_at, source, run_id)
    VALUES
      (%s,%s,%s,%s,%s,%s,%s,%s,%s)
    ON CONFLICT (candidate_id, cycle, donor_name, donor_state, donor_zip) DO UPDATE SET
      total_amount = EXCLUDED.total_amount,
      fetched_at   = EXCLUDED.fetched_at,
      source       = EXCLUDED.source,
      run_id       = EXCLUDED.run_id
    """
    if rows:
        conn.executemany(sql, rows)


def upsert_committee_donor_totals(conn, rows: List[Tuple[Any, ...]]):
    """
    rows: (cycle, donor_committee_id, donor_name, total_amount, fetched_at, source, run_id)
    """
    sql = """
    INSERT INTO public.committee_donor_totals
      (cycle, donor_committee_id, donor_name, total_amount, fetched_at, source, run_id)
    VALUES
      (%s,%s,%s,%s,%s,%s,%s)
    ON CONFLICT (cycle, donor_committee_id) DO UPDATE SET
      donor_name   = COALESCE(EXCLUDED.donor_name, public.committee_donor_totals.donor_name),
      total_amount = EXCLUDED.total_amount,
      fetched_at   = EXCLUDED.fetched_at,
      source       = EXCLUDED.source,
      run_id       = EXCLUDED.run_id
    """
    if rows:
        conn.executemany(sql, rows)


def upsert_candidate_pac_agg(conn, rows: List[Tuple[Any, ...]]):
    """
    rows: (candidate_id, cycle, donor_committee_id, donor_name, total_amount, fetched_at, source, run_id)
    """
    sql = """
    INSERT INTO public.candidate_pac_agg
      (candidate_id, cycle, donor_committee_id, donor_name, total_amount, fetched_at, source, run_id)
    VALUES
      (%s,%s,%s,%s,%s,%s,%s,%s)
    ON CONFLICT (candidate_id, cycle, donor_committee_id) DO UPDATE SET
      donor_name   = COALESCE(EXCLUDED.donor_name, public.candidate_pac_agg.donor_name),
      total_amount = EXCLUDED.total_amount,
      fetched_at   = EXCLUDED.fetched_at,
      source       = EXCLUDED.source,
      run_id       = EXCLUDED.run_id
    """
    if rows:
        conn.executemany(sql, rows)


def upsert_candidate_receipts_monthly(conn, rows: List[Tuple[Any, ...]]):
    """
    rows: (candidate_id, cycle, month_start, individuals_amount, pac_amount, other_committee_amount,
           total_amount, fetched_at, source, run_id)
    """
    sql = """
    INSERT INTO public.candidate_receipts_monthly
      (candidate_id, cycle, month_start, individuals_amount, pac_amount, other_committee_amount,
       total_amount, fetched_at, source, run_id)
    VALUES
      (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
    ON CONFLICT (candidate_id, cycle, month_start) DO UPDATE SET
      individuals_amount     = EXCLUDED.individuals_amount,
      pac_amount             = EXCLUDED.pac_amount,
      other_committee_amount = EXCLUDED.other_committee_amount,
      total_amount           = EXCLUDED.total_amount,
      fetched_at             = EXCLUDED.fetched_at,
      source                 = EXCLUDED.source,
      run_id                 = EXCLUDED.run_id
    """
    if rows:
        conn.executemany(sql, rows)


def upsert_candidate_expenditures_totals(conn, rows: List[Tuple[Any, ...]]):
    """
    rows: (candidate_id, cycle, operating_expenditures, fetched_at, source, run_id)
    """
    sql = """
    INSERT INTO public.candidate_expenditures_totals
      (candidate_id, cycle, operating_expenditures, fetched_at, source, run_id)
    VALUES
      (%s,%s,%s,%s,%s,%s)
    ON CONFLICT (candidate_id, cycle) DO UPDATE SET
      operating_expenditures = EXCLUDED.operating_expenditures,
      fetched_at             = EXCLUDED.fetched_at,
      source                 = EXCLUDED.source,
      run_id                 = EXCLUDED.run_id
    """
    if rows:
        conn.executemany(sql, rows)


def upsert_candidate_expenditures_monthly(conn, rows: List[Tuple[Any, ...]]):
    """
    rows: (candidate_id, cycle, month_start, operating_expenditures, total_amount, fetched_at, source, run_id)
    """
    sql = """
    INSERT INTO public.candidate_expenditures_monthly
      (candidate_id, cycle, month_start, operating_expenditures, total_amount, fetched_at, source, run_id)
    VALUES
      (%s,%s,%s,%s,%s,%s,%s,%s)
    ON CONFLICT (candidate_id, cycle, month_start) DO UPDATE SET
      operating_expenditures = EXCLUDED.operating_expenditures,
      total_amount           = EXCLUDED.total_amount,
      fetched_at             = EXCLUDED.fetched_at,
      source                 = EXCLUDED.source,
      run_id                 = EXCLUDED.run_id
    """
    if rows:
        conn.executemany(sql, rows)


# -----------------------------
# Cycle reset (app-facing tables only)
# -----------------------------
def reset_cycle_rows(conn, cycle: int):
    """
    Clear existing rows for the cycle so re-import is idempotent.
    Does NOT touch canonical candidates/committees (no cycle dimension).
    """
    conn.execute("DELETE FROM public.candidate_committees WHERE cycle=%s", (cycle,))
    conn.execute("DELETE FROM public.candidate_totals WHERE cycle=%s", (cycle,))
    conn.execute("DELETE FROM public.committee_donor_totals WHERE cycle=%s", (cycle,))
    conn.execute("DELETE FROM public.individual_donor_totals WHERE cycle=%s", (cycle,))
    conn.execute("DELETE FROM public.candidate_receipts_monthly WHERE cycle=%s", (cycle,))
    conn.execute("DELETE FROM public.candidate_pac_agg WHERE cycle=%s", (cycle,))
    conn.execute("DELETE FROM public.candidate_individual_donor_agg WHERE cycle=%s", (cycle,))
    conn.execute("DELETE FROM public.candidate_expenditures_totals WHERE cycle=%s", (cycle,))
    conn.execute("DELETE FROM public.candidate_expenditures_monthly WHERE cycle=%s", (cycle,))


# -----------------------------
# Streaming aggregators
# -----------------------------
@dataclass
class ImportStats:
    itcont_rows: int = 0
    itcont_attributed: int = 0
    itcont_skipped_multi_link: int = 0

    itpas2_rows: int = 0
    itpas2_attributed: int = 0
    itpas2_skipped_no_candidate: int = 0

    itoth_rows: int = 0

    oppexp_rows: int = 0
    oppexp_attributed: int = 0
    oppexp_skipped_multi_link: int = 0


def build_committee_to_candidate_map(links: List[LinkRec]) -> Dict[str, List[str]]:
    m: Dict[str, List[str]] = defaultdict(list)
    for l in links:
        m[l.committee_id].append(l.candidate_id)
    return m


def flush_dict_sums(
    conn,
    *,
    fetched_at: datetime,
    source: str,
    run_id: int,
    cycle: int,
    # dicts
    cand_totals: Dict[str, Dict[str, Any]],
    ind_totals: Dict[Tuple[str, str, str], float],
    cand_ind_agg: Dict[Tuple[str, str, str, str], float],
    cmte_totals: Dict[str, float],
    cand_pac_agg: Dict[Tuple[str, str], float],
    receipts_monthly: Dict[Tuple[str, date], Dict[str, float]],
    exp_totals: Dict[str, float],
    exp_monthly: Dict[Tuple[str, date], float],
):
    """
    Write the *current* aggregated state to DB (as upserts).
    The dicts are assumed to represent the complete totals so far; the upserts overwrite totals.
    """

    # candidate_totals
    ct_rows: List[Tuple[Any, ...]] = []
    for cand_id, v in cand_totals.items():
        individuals = float(v.get("individuals", 0.0))
        pacs = float(v.get("pacs", 0.0))
        other = float(v.get("other", 0.0))
        receipts = individuals + pacs + other
        coverage_end = v.get("coverage_end_date")
        ct_rows.append(
            (
                cand_id,
                cycle,
                coverage_end,
                receipts,
                0.0,  # cash_on_hand (not in bulk files)
                individuals,
                pacs,
                0.0,  # self_funding
                0.0,  # refunds_out
                other,
                fetched_at,
                source,
                run_id,
            )
        )
    upsert_candidate_totals(conn, ct_rows)

    # individual_donor_totals
    idt_rows: List[Tuple[Any, ...]] = [
        (cycle, dn, st or None, zp or None, amt, fetched_at, source, run_id)
        for (dn, st, zp), amt in ind_totals.items()
        if dn
    ]
    upsert_individual_donor_totals(conn, idt_rows)

    # candidate_individual_donor_agg
    cida_rows: List[Tuple[Any, ...]] = [
        (cand_id, cycle, dn, st or None, zp or None, amt, fetched_at, source, run_id)
        for (cand_id, dn, st, zp), amt in cand_ind_agg.items()
        if cand_id and dn
    ]
    upsert_candidate_individual_donor_agg(conn, cida_rows)

    # committee_donor_totals
    cdt_rows: List[Tuple[Any, ...]] = [
        (cycle, cmte_id, None, amt, fetched_at, source, run_id) for cmte_id, amt in cmte_totals.items()
    ]
    upsert_committee_donor_totals(conn, cdt_rows)

    # candidate_pac_agg
    cpa_rows: List[Tuple[Any, ...]] = [
        (cand_id, cycle, donor_id, None, amt, fetched_at, source, run_id)
        for (cand_id, donor_id), amt in cand_pac_agg.items()
    ]
    upsert_candidate_pac_agg(conn, cpa_rows)

    # candidate_receipts_monthly
    crm_rows: List[Tuple[Any, ...]] = []
    for (cand_id, mstart), v in receipts_monthly.items():
        indiv = float(v.get("individuals", 0.0))
        pac = float(v.get("pacs", 0.0))
        otherc = float(v.get("other", 0.0))
        total = indiv + pac + otherc
        crm_rows.append((cand_id, cycle, mstart, indiv, pac, otherc, total, fetched_at, source, run_id))
    upsert_candidate_receipts_monthly(conn, crm_rows)

    # candidate_expenditures_totals
    cet_rows: List[Tuple[Any, ...]] = [
        (cand_id, cycle, amt, fetched_at, source, run_id) for cand_id, amt in exp_totals.items()
    ]
    upsert_candidate_expenditures_totals(conn, cet_rows)

    # candidate_expenditures_monthly
    cem_rows: List[Tuple[Any, ...]] = [
        (cand_id, cycle, mstart, amt, amt, fetched_at, source, run_id)
        for (cand_id, mstart), amt in exp_monthly.items()
    ]
    upsert_candidate_expenditures_monthly(conn, cem_rows)


def load_committee_names(conn) -> Dict[str, str]:
    rows = conn.execute("SELECT committee_id, name FROM public.committees").fetchall()
    return {r["committee_id"]: (r["name"] or "") for r in rows}


def apply_committee_names_to_agg(
    *,
    committee_names: Dict[str, str],
    candidate_pac_agg_rows: List[Tuple[Any, ...]],
    committee_donor_totals_rows: List[Tuple[Any, ...]],
) -> Tuple[List[Tuple[Any, ...]], List[Tuple[Any, ...]]]:
    """
    Fill donor_name where possible for candidate_pac_agg and committee_donor_totals.
    """
    cpa2 = []
    for cand_id, cycle, donor_id, donor_name, amt, fetched_at, source, run_id in candidate_pac_agg_rows:
        nm = donor_name or (committee_names.get(donor_id) or None)
        cpa2.append((cand_id, cycle, donor_id, nm, amt, fetched_at, source, run_id))

    cdt2 = []
    for cycle, donor_id, donor_name, amt, fetched_at, source, run_id in committee_donor_totals_rows:
        nm = donor_name or (committee_names.get(donor_id) or None)
        cdt2.append((cycle, donor_id, nm, amt, fetched_at, source, run_id))

    return cpa2, cdt2


def stream_itcont(
    path: Path,
    cycle: int,
    committee_to_candidates: Dict[str, List[str]],
    cand_totals: Dict[str, Dict[str, Any]],
    ind_totals: Dict[Tuple[str, str, str], float],
    cand_ind_agg: Dict[Tuple[str, str, str, str], float],
    receipts_monthly: Dict[Tuple[str, date], Dict[str, float]],
    stats: ImportStats,
    *,
    progress_every: int,
    verbose: bool,
):
    for row_num, _, p in read_pipe_rows(path):
        stats.itcont_rows += 1

        recipient_cmte = parts_get(p, 0)
        if not recipient_cmte:
            continue

        contributor_name = parts_get(p, 7)
        contributor_state = parts_get(p, 9)
        contributor_zip = parts_get(p, 10)
        dt = parse_fec_date(parts_get(p, 13))
        amt = safe_num(parts_get(p, 14))
        if amt is None or amt == 0:
            continue

        cands = committee_to_candidates.get(recipient_cmte) or []
        if len(cands) != 1:
            if len(cands) > 1:
                stats.itcont_skipped_multi_link += 1
            continue

        cand_id = cands[0]
        stats.itcont_attributed += 1

        # candidate totals
        d = cand_totals.setdefault(cand_id, {"individuals": 0.0, "pacs": 0.0, "other": 0.0, "coverage_end_date": None})
        d["individuals"] = float(d["individuals"]) + float(amt)
        if dt:
            prev = d.get("coverage_end_date")
            if prev is None or dt > prev:
                d["coverage_end_date"] = dt

        # global donor totals
        key = (contributor_name, contributor_state, contributor_zip)
        ind_totals[key] = float(ind_totals.get(key, 0.0)) + float(amt)

        # candidate donor agg
        key2 = (cand_id, contributor_name, contributor_state, contributor_zip)
        cand_ind_agg[key2] = float(cand_ind_agg.get(key2, 0.0)) + float(amt)

        # monthly receipts
        if dt:
            ms = month_start(dt)
            mrec = receipts_monthly.setdefault((cand_id, ms), {"individuals": 0.0, "pacs": 0.0, "other": 0.0})
            mrec["individuals"] = float(mrec["individuals"]) + float(amt)

        if progress_every and stats.itcont_rows % progress_every == 0:
            print(f"      itcont processed: {stats.itcont_rows:,} rows", flush=True)


def stream_itpas2(
    path: Path,
    cycle: int,
    committee_to_candidates: Dict[str, List[str]],
    cand_totals: Dict[str, Dict[str, Any]],
    cmte_totals: Dict[str, float],
    cand_pac_agg: Dict[Tuple[str, str], float],
    receipts_monthly: Dict[Tuple[str, date], Dict[str, float]],
    stats: ImportStats,
    *,
    progress_every: int,
    verbose: bool,
):
    cand_id_re = re.compile(r"^[HSP][0-9]{8}$")

    for row_num, _, p in read_pipe_rows(path):
        stats.itpas2_rows += 1

        filer_cmte = parts_get(p, 0)
        if not filer_cmte:
            continue

        # Common: date at ~13, amount at ~14
        dt = parse_fec_date(parts_get(p, 13))
        amt = safe_num(parts_get(p, 14))
        if amt is None or amt == 0:
            continue

        # Candidate id: try common indices first, then scan.
        cand_id = ""
        for idx in (7, 8, 6, 5, 4, 3, 2, 1):
            tok = parts_get(p, idx)
            if cand_id_re.match(tok):
                cand_id = tok
                break
        if not cand_id:
            for tok in reversed([x.strip() for x in p]):
                if cand_id_re.match(tok):
                    cand_id = tok
                    break

        # Fallback: payee committee could be linked to candidate
        if not cand_id:
            payee_cmte = parts_get(p, 1)
            if payee_cmte and payee_cmte.startswith("C"):
                cands = committee_to_candidates.get(payee_cmte) or []
                if len(cands) == 1:
                    cand_id = cands[0]

        if not cand_id:
            stats.itpas2_skipped_no_candidate += 1
            continue

        stats.itpas2_attributed += 1

        # committee donor totals
        cmte_totals[filer_cmte] = float(cmte_totals.get(filer_cmte, 0.0)) + float(amt)

        # candidate totals
        d = cand_totals.setdefault(cand_id, {"individuals": 0.0, "pacs": 0.0, "other": 0.0, "coverage_end_date": None})
        d["pacs"] = float(d["pacs"]) + float(amt)
        if dt:
            prev = d.get("coverage_end_date")
            if prev is None or dt > prev:
                d["coverage_end_date"] = dt

        # candidate pac agg
        key = (cand_id, filer_cmte)
        cand_pac_agg[key] = float(cand_pac_agg.get(key, 0.0)) + float(amt)

        # monthly receipts
        if dt:
            ms = month_start(dt)
            mrec = receipts_monthly.setdefault((cand_id, ms), {"individuals": 0.0, "pacs": 0.0, "other": 0.0})
            mrec["pacs"] = float(mrec["pacs"]) + float(amt)

        if progress_every and stats.itpas2_rows % progress_every == 0:
            print(f"      itpas2 processed: {stats.itpas2_rows:,} rows", flush=True)


def stream_itoth(
    path: Path,
    cmte_totals: Dict[str, float],
    stats: ImportStats,
    *,
    progress_every: int,
):
    """
    Optional: treat committee-to-committee transfers as part of committee donor totals.
    This can be useful if you want to show "most active donor committees" overall,
    not just donors to candidates.
    """
    for _, _, p in read_pipe_rows(path):
        stats.itoth_rows += 1
        filer = parts_get(p, 0)
        if not filer:
            continue
        amt = safe_num(parts_get(p, 14) or parts_get(p, 13))
        if amt is None or amt == 0:
            continue
        cmte_totals[filer] = float(cmte_totals.get(filer, 0.0)) + float(amt)

        if progress_every and stats.itoth_rows % progress_every == 0:
            print(f"      itoth processed: {stats.itoth_rows:,} rows", flush=True)


def stream_oppexp(
    path: Path,
    cycle: int,
    committee_to_candidates: Dict[str, List[str]],
    exp_totals: Dict[str, float],
    exp_monthly: Dict[Tuple[str, date], float],
    stats: ImportStats,
    *,
    progress_every: int,
):
    for _, _, p in read_pipe_rows(path):
        stats.oppexp_rows += 1
        cmte = parts_get(p, 0)
        if not cmte:
            continue
        dt = parse_fec_date(parts_get(p, 13) or parts_get(p, 12))
        amt = safe_num(parts_get(p, 14) or parts_get(p, 13))
        if amt is None or amt == 0:
            continue

        cands = committee_to_candidates.get(cmte) or []
        if len(cands) != 1:
            if len(cands) > 1:
                stats.oppexp_skipped_multi_link += 1
            continue

        cand_id = cands[0]
        stats.oppexp_attributed += 1

        exp_totals[cand_id] = float(exp_totals.get(cand_id, 0.0)) + float(amt)
        if dt:
            ms = month_start(dt)
            exp_monthly[(cand_id, ms)] = float(exp_monthly.get((cand_id, ms), 0.0)) + float(amt)

        if progress_every and stats.oppexp_rows % progress_every == 0:
            print(f"      oppexp processed: {stats.oppexp_rows:,} rows", flush=True)


# -----------------------------
# main
# -----------------------------
def main() -> int:
    p = argparse.ArgumentParser(description="Import + aggregate FEC bulk txt files directly into app-facing tables.")
    p.add_argument("--cycle", type=int, required=True, help="Election cycle year, e.g. 2026")
    p.add_argument("--bulk-dir", type=str, default=str(DEFAULT_BULK_DIR), help="Directory holding the FEC .txt files")

    p.add_argument("--batch-size", type=int, default=25_000, help="DB executemany batch size for canonical inserts.")
    p.add_argument("--flush-every", type=int, default=250_000, help="Flush aggregates to DB every N rows (per large file).")
    p.add_argument("--progress-every", type=int, default=500_000, help="Print progress every N processed rows per large file.")
    p.add_argument("--reset-cycle", action="store_true", help="Delete existing app-facing rows for this cycle before import.")
    p.add_argument("--include-itoth", action="store_true", help="Include itoth.txt in committee donor totals (optional).")
    p.add_argument("--verbose", action="store_true", help="More console output.")

    p.add_argument("--only", nargs="*", default=None,
                   help="Only import these datasets: cn cm ccl weball webl itcont itpas2 itoth oppexp")
    p.add_argument("--skip", nargs="*", default=None,
                   help="Skip these datasets: cn cm ccl weball webl itcont itpas2 itoth oppexp")

    args = p.parse_args()

    cycle = int(args.cycle)
    bulk_dir = Path(args.bulk_dir).resolve()
    verbose = bool(args.verbose)

    wanted = set(x.lower() for x in (args.only or [])) if args.only else None
    skipped = set(x.lower() for x in (args.skip or [])) if args.skip else set()

    def do(name: str) -> bool:
        if name in skipped:
            return False
        if wanted is None:
            return True
        return name in wanted

    # Resolve file paths
    cn_path = bulk_dir / f"cn{cycle_suffix(cycle)}.txt"
    cm_path = bulk_dir / f"cm{cycle_suffix(cycle)}.txt"
    ccl_path = bulk_dir / f"ccl{cycle_suffix(cycle)}.txt"
    weball_path = bulk_dir / f"weball{cycle_suffix(cycle)}.txt"
    webl_path = bulk_dir / f"webl{cycle_suffix(cycle)}.txt"

    itcont_path = bulk_dir / "itcont.txt"
    itpas2_path = bulk_dir / "itpas2.txt"
    itoth_path = bulk_dir / "itoth.txt"
    oppexp_path = bulk_dir / "oppexp.txt"

    # Quick existence check (skip missing)
    def exists(pth: Path) -> bool:
        return pth.exists() and pth.is_file()

    conn = pg_connect()
    conn.autocommit = False

    started = now_utc()
    meta = {
        "cycle": cycle,
        "bulk_dir": str(bulk_dir),
        "datasets_only": sorted(list(wanted)) if wanted else None,
        "datasets_skip": sorted(list(skipped)) if skipped else None,
        "started_at": started.isoformat(),
    }

    run_id = None
    stats = ImportStats()

    # Aggregation state (kept in-memory, periodically flushed as full totals so far)
    cand_totals: Dict[str, Dict[str, Any]] = {}
    ind_totals: Dict[Tuple[str, str, str], float] = {}
    cand_ind_agg: Dict[Tuple[str, str, str, str], float] = {}
    cmte_totals: Dict[str, float] = {}
    cand_pac_agg: Dict[Tuple[str, str], float] = {}
    receipts_monthly: Dict[Tuple[str, date], Dict[str, float]] = {}
    exp_totals: Dict[str, float] = {}
    exp_monthly: Dict[Tuple[str, date], float] = {}

    try:
        with conn.transaction():
            run_id = create_import_run(conn, cycle=cycle, source="fec_bulk_txt", notes="direct-to-app import", meta=meta)

            if args.reset_cycle:
                if verbose:
                    print(f"Resetting existing rows for cycle {cycle}...")
                reset_cycle_rows(conn, cycle)

            # -------------------------
            # 1) Canonical entities
            # -------------------------
            candidates: Dict[str, CandidateRec] = {}

            if do("cn") and exists(cn_path):
                if verbose:
                    print(f"Parsing {cn_path.name} ...")
                for cid, rec in parse_cn_candidates(cn_path, cycle).items():
                    candidates[cid] = rec

            if do("weball") and exists(weball_path):
                if verbose:
                    print(f"Parsing {weball_path.name} ...")
                for cid, rec in parse_weball_candidates(weball_path).items():
                    if cid in candidates:
                        candidates[cid] = merge_candidate(candidates[cid], rec)
                    else:
                        candidates[cid] = rec

            if do("webl") and exists(webl_path):
                if verbose:
                    print(f"Parsing {webl_path.name} ...")
                for cid, rec in parse_webl_candidates(webl_path).items():
                    if cid in candidates:
                        candidates[cid] = merge_candidate(candidates[cid], rec)
                    else:
                        candidates[cid] = rec

            if candidates:
                if verbose:
                    print(f"Upserting candidates: {len(candidates):,}")
                upsert_candidates(conn, candidates, run_id)

            committees: Dict[str, CommitteeRec] = {}
            if do("cm") and exists(cm_path):
                if verbose:
                    print(f"Parsing {cm_path.name} ...")
                committees = parse_cm_committees(cm_path, cycle)
                if verbose:
                    print(f"Upserting committees: {len(committees):,}")
                upsert_committees(conn, committees, run_id)

            links: List[LinkRec] = []
            if do("ccl") and exists(ccl_path):
                if verbose:
                    print(f"Parsing {ccl_path.name} ...")
                links = parse_ccl_links(ccl_path, cycle)
                if verbose:
                    print(f"Upserting candidate_committees: {len(links):,}")
                upsert_candidate_committees(conn, links, run_id)

            committee_to_candidates = build_committee_to_candidate_map(links)

            # -------------------------
            # 2) Stream aggregates
            # -------------------------
            fetched_at = now_utc()
            source = "fec_bulk_txt"

            def flush_all():
                # Fill donor names from committees table after canonical upserts
                committee_names = load_committee_names(conn)

                # We'll flush using the helper that doesn't include names; then do an extra pass
                # to update donor_name fields (lightweight, uses upserts again).
                flush_dict_sums(
                    conn,
                    fetched_at=fetched_at,
                    source=source,
                    run_id=run_id,
                    cycle=cycle,
                    cand_totals=cand_totals,
                    ind_totals=ind_totals,
                    cand_ind_agg=cand_ind_agg,
                    cmte_totals=cmte_totals,
                    cand_pac_agg=cand_pac_agg,
                    receipts_monthly=receipts_monthly,
                    exp_totals=exp_totals,
                    exp_monthly=exp_monthly,
                )

                # Patch donor names (donor_name is optional but nice for UI)
                # candidate_pac_agg
                cpa_rows = [
                    (cand_id, cycle, donor_id, committee_names.get(donor_id) or None, amt, fetched_at, source, run_id)
                    for (cand_id, donor_id), amt in cand_pac_agg.items()
                ]
                upsert_candidate_pac_agg(conn, cpa_rows)

                # committee_donor_totals
                cdt_rows = [
                    (cycle, donor_id, committee_names.get(donor_id) or None, amt, fetched_at, source, run_id)
                    for donor_id, amt in cmte_totals.items()
                ]
                upsert_committee_donor_totals(conn, cdt_rows)

            # itcont
            if do("itcont") and exists(itcont_path):
                if verbose:
                    print(f"Streaming {itcont_path.name} ...")
                last_flush_rows = 0
                for row_num, raw, parts in read_pipe_rows(itcont_path):
                    # re-use the streaming function but inlined for flush control
                    stats.itcont_rows += 1

                    recipient_cmte = parts_get(parts, 0)
                    if not recipient_cmte:
                        continue

                    contributor_name = parts_get(parts, 7)
                    contributor_state = parts_get(parts, 9)
                    contributor_zip = parts_get(parts, 10)
                    dt = parse_fec_date(parts_get(parts, 13))
                    amt = safe_num(parts_get(parts, 14))
                    if amt is None or amt == 0:
                        continue

                    cands = committee_to_candidates.get(recipient_cmte) or []
                    if len(cands) != 1:
                        if len(cands) > 1:
                            stats.itcont_skipped_multi_link += 1
                        continue

                    cand_id = cands[0]
                    stats.itcont_attributed += 1

                    d = cand_totals.setdefault(cand_id, {"individuals": 0.0, "pacs": 0.0, "other": 0.0, "coverage_end_date": None})
                    d["individuals"] = float(d["individuals"]) + float(amt)
                    if dt:
                        prev = d.get("coverage_end_date")
                        if prev is None or dt > prev:
                            d["coverage_end_date"] = dt

                    key = (contributor_name, contributor_state, contributor_zip)
                    ind_totals[key] = float(ind_totals.get(key, 0.0)) + float(amt)

                    key2 = (cand_id, contributor_name, contributor_state, contributor_zip)
                    cand_ind_agg[key2] = float(cand_ind_agg.get(key2, 0.0)) + float(amt)

                    if dt:
                        ms = month_start(dt)
                        mrec = receipts_monthly.setdefault((cand_id, ms), {"individuals": 0.0, "pacs": 0.0, "other": 0.0})
                        mrec["individuals"] = float(mrec["individuals"]) + float(amt)

                    if args.progress_every and stats.itcont_rows % args.progress_every == 0:
                        print(f"      itcont processed: {stats.itcont_rows:,} rows", flush=True)

                    if args.flush_every and stats.itcont_rows % args.flush_every == 0:
                        if verbose:
                            print("      flushing aggregates (itcont)...", flush=True)
                        flush_all()

            # itpas2
            if do("itpas2") and exists(itpas2_path):
                if verbose:
                    print(f"Streaming {itpas2_path.name} ...")
                cand_id_re = re.compile(r"^[HSP][0-9]{8}$")
                for row_num, raw, parts in read_pipe_rows(itpas2_path):
                    stats.itpas2_rows += 1
                    filer_cmte = parts_get(parts, 0)
                    if not filer_cmte:
                        continue
                    dt = parse_fec_date(parts_get(parts, 13))
                    amt = safe_num(parts_get(parts, 14))
                    if amt is None or amt == 0:
                        continue

                    cand_id = ""
                    for idx in (7, 8, 6, 5, 4, 3, 2, 1):
                        tok = parts_get(parts, idx)
                        if cand_id_re.match(tok):
                            cand_id = tok
                            break
                    if not cand_id:
                        for tok in reversed([x.strip() for x in parts]):
                            if cand_id_re.match(tok):
                                cand_id = tok
                                break

                    if not cand_id:
                        payee_cmte = parts_get(parts, 1)
                        if payee_cmte and payee_cmte.startswith("C"):
                            cands = committee_to_candidates.get(payee_cmte) or []
                            if len(cands) == 1:
                                cand_id = cands[0]

                    if not cand_id:
                        stats.itpas2_skipped_no_candidate += 1
                        continue

                    stats.itpas2_attributed += 1

                    cmte_totals[filer_cmte] = float(cmte_totals.get(filer_cmte, 0.0)) + float(amt)

                    d = cand_totals.setdefault(cand_id, {"individuals": 0.0, "pacs": 0.0, "other": 0.0, "coverage_end_date": None})
                    d["pacs"] = float(d["pacs"]) + float(amt)
                    if dt:
                        prev = d.get("coverage_end_date")
                        if prev is None or dt > prev:
                            d["coverage_end_date"] = dt

                    key = (cand_id, filer_cmte)
                    cand_pac_agg[key] = float(cand_pac_agg.get(key, 0.0)) + float(amt)

                    if dt:
                        ms = month_start(dt)
                        mrec = receipts_monthly.setdefault((cand_id, ms), {"individuals": 0.0, "pacs": 0.0, "other": 0.0})
                        mrec["pacs"] = float(mrec["pacs"]) + float(amt)

                    if args.progress_every and stats.itpas2_rows % args.progress_every == 0:
                        print(f"      itpas2 processed: {stats.itpas2_rows:,} rows", flush=True)

                    if args.flush_every and stats.itpas2_rows % args.flush_every == 0:
                        if verbose:
                            print("      flushing aggregates (itpas2)...", flush=True)
                        flush_all()

            # itoth (optional)
            if args.include_itoth and do("itoth") and exists(itoth_path):
                if verbose:
                    print(f"Streaming {itoth_path.name} ...")
                for _, _, parts in read_pipe_rows(itoth_path):
                    stats.itoth_rows += 1
                    filer = parts_get(parts, 0)
                    if not filer:
                        continue
                    amt = safe_num(parts_get(parts, 14) or parts_get(parts, 13))
                    if amt is None or amt == 0:
                        continue
                    cmte_totals[filer] = float(cmte_totals.get(filer, 0.0)) + float(amt)

                    if args.progress_every and stats.itoth_rows % args.progress_every == 0:
                        print(f"      itoth processed: {stats.itoth_rows:,} rows", flush=True)

                    if args.flush_every and stats.itoth_rows % args.flush_every == 0:
                        if verbose:
                            print("      flushing aggregates (itoth)...", flush=True)
                        flush_all()

            # oppexp
            if do("oppexp") and exists(oppexp_path):
                if verbose:
                    print(f"Streaming {oppexp_path.name} ...")
                for _, _, parts in read_pipe_rows(oppexp_path):
                    stats.oppexp_rows += 1
                    cmte = parts_get(parts, 0)
                    if not cmte:
                        continue
                    dt = parse_fec_date(parts_get(parts, 13) or parts_get(parts, 12))
                    amt = safe_num(parts_get(parts, 14) or parts_get(parts, 13))
                    if amt is None or amt == 0:
                        continue

                    cands = committee_to_candidates.get(cmte) or []
                    if len(cands) != 1:
                        if len(cands) > 1:
                            stats.oppexp_skipped_multi_link += 1
                        continue

                    cand_id = cands[0]
                    stats.oppexp_attributed += 1

                    exp_totals[cand_id] = float(exp_totals.get(cand_id, 0.0)) + float(amt)
                    if dt:
                        ms = month_start(dt)
                        exp_monthly[(cand_id, ms)] = float(exp_monthly.get((cand_id, ms), 0.0)) + float(amt)

                    if args.progress_every and stats.oppexp_rows % args.progress_every == 0:
                        print(f"      oppexp processed: {stats.oppexp_rows:,} rows", flush=True)

                    if args.flush_every and stats.oppexp_rows % args.flush_every == 0:
                        if verbose:
                            print("      flushing aggregates (oppexp)...", flush=True)
                        flush_all()

            # final flush
            if verbose:
                print("Final flush...")
            flush_all()

            finish_import_run(conn, run_id, status="finished")

        # end transaction

    except Exception as e:
        try:
            if run_id is not None:
                with conn.transaction():
                    finish_import_run(conn, run_id, status="failed")
        except Exception:
            pass
        print(f"\nERROR: {e}", file=sys.stderr)
        return 2
    finally:
        try:
            conn.close()
        except Exception:
            pass

    # summary
    print("\nDone.")
    print(f"Run ID: {run_id}")
    print("Stats:")
    print(f"  itcont rows: {stats.itcont_rows:,} | attributed: {stats.itcont_attributed:,} | skipped multi-link: {stats.itcont_skipped_multi_link:,}")
    print(f"  itpas2 rows: {stats.itpas2_rows:,} | attributed: {stats.itpas2_attributed:,} | skipped no-candidate: {stats.itpas2_skipped_no_candidate:,}")
    if args.include_itoth:
        print(f"  itoth rows: {stats.itoth_rows:,}")
    print(f"  oppexp rows: {stats.oppexp_rows:,} | attributed: {stats.oppexp_attributed:,} | skipped multi-link: {stats.oppexp_skipped_multi_link:,}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
