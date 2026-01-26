from fastapi import FastAPI, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from datetime import datetime, timezone
from typing import Optional

from .db import get_conn
from .settings import CACHE_TTL_TOTALS_SECONDS, CACHE_TTL_PACS_SECONDS, CACHE_TTL_COMM_SECONDS
from .schema import SCHEMA_SQL
from .schema_models import SearchResponse, TotalsResponse, PacResponse, RefreshRequest
from . import openfec


app = FastAPI(title="Money Tracker API")

# If your frontend is same-origin, CORS doesn't matter.
# If it's separate (Cloudflare Pages), replace "*" with your domain later.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

def is_fresh(ts: Optional[datetime], ttl_seconds: int) -> bool:
    if not ts:
        return False
    age = (datetime.now(timezone.utc) - ts).total_seconds()
    return age < ttl_seconds

def ensure_schema():
    with get_conn() as conn:
        conn.execute(SCHEMA_SQL)
        conn.commit()

@app.on_event("startup")
def startup():
    ensure_schema()

@app.get("/health")
def health():
    return {"ok": True}

@app.get("/health/db")
def health_db():
    with get_conn() as conn:
        row = conn.execute("SELECT 1 AS ok").fetchone()
        return {"db": True, "ok": row["ok"] == 1}

@app.get("/api/money/candidates/search", response_model=SearchResponse)
async def candidates_search(
    name: str = Query(..., min_length=2),
    cycle: int = Query(...),
    office: str = Query("", description="H, S, P, or empty")
):
    try:
        data = await openfec.search_candidates(name=name, cycle=cycle, office=office)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    results = data.get("results") or []

    # Upsert into DB so the rest of the API can rely on candidates table
    with get_conn() as conn:
        for c in results:
            conn.execute("""
                INSERT INTO candidates(candidate_id, name, office, party, state, district, updated_at)
                VALUES (%s,%s,%s,%s,%s,%s, now())
                ON CONFLICT (candidate_id) DO UPDATE SET
                  name=EXCLUDED.name,
                  office=EXCLUDED.office,
                  party=EXCLUDED.party,
                  state=EXCLUDED.state,
                  district=EXCLUDED.district,
                  updated_at=now()
            """, (
                c.get("candidate_id"),
                c.get("name"),
                c.get("office"),
                c.get("party_full") or c.get("party"),
                c.get("state"),
                str(c.get("district")) if c.get("district") is not None else None
            ))
        conn.commit()

    out = [{
        "candidate_id": c.get("candidate_id"),
        "name": c.get("name"),
        "office": c.get("office"),
        "party": c.get("party_full") or c.get("party"),
        "state": c.get("state"),
        "district": c.get("district"),
    } for c in results]

    return {"source": "live", "results": out}

@app.get("/api/money/candidate/{candidate_id}/totals", response_model=TotalsResponse)
async def candidate_totals(candidate_id: str, cycle: int = Query(...)):
    # Try cache
    with get_conn() as conn:
        row = conn.execute("""
            SELECT * FROM candidate_totals
            WHERE candidate_id=%s AND cycle=%s
        """, (candidate_id, cycle)).fetchone()

        if row and is_fresh(row["fetched_at"], CACHE_TTL_TOTALS_SECONDS):
            return {
                "source": "cache",
                "cycle": cycle,
                "candidate_id": candidate_id,
                "coverage_end_date": row["coverage_end_date"].isoformat() if row["coverage_end_date"] else None,
                "receipts": int(row["receipts"]),
                "cash_on_hand": int(row["cash_on_hand"]),
                "breakdown": {
                    "individuals": int(row["individuals"]),
                    "pacs": int(row["pacs"]),
                    "self_funding": int(row["self_funding"]),
                    "transfers": int(row["transfers"]),
                    "refunds_out": int(row["refunds_out"]),
                    "other": int(row["other"]),
                }
            }

    # Fetch live
    try:
        fec = await openfec.totals(candidate_id, cycle)
        best = openfec.pick_best_totals_row(fec)
        normalized = openfec.normalize_totals_row(best) if best else {
            "coverage_end_date": None,
            "receipts": 0,
            "cash_on_hand": 0,
            "breakdown": {"individuals":0,"pacs":0,"self_funding":0,"transfers":0,"refunds_out":0,"other":0}
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    # Store
    with get_conn() as conn:
        conn.execute("""
            INSERT INTO candidates(candidate_id, updated_at)
            VALUES (%s, now())
            ON CONFLICT (candidate_id) DO UPDATE SET updated_at=now()
        """, (candidate_id,))

        b = normalized["breakdown"]
        conn.execute("""
            INSERT INTO candidate_totals(
              candidate_id, cycle, coverage_end_date, receipts, cash_on_hand,
              individuals, pacs, self_funding, transfers, refunds_out, other, fetched_at
            )
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
        """, (
            candidate_id, cycle,
            normalized["coverage_end_date"],
            normalized["receipts"],
            normalized["cash_on_hand"],
            b["individuals"], b["pacs"], b["self_funding"], b["transfers"], b["refunds_out"], b["other"]
        ))
        conn.commit()

    return {
        "source": "live",
        "cycle": cycle,
        "candidate_id": candidate_id,
        "coverage_end_date": normalized["coverage_end_date"],
        "receipts": normalized["receipts"],
        "cash_on_hand": normalized["cash_on_hand"],
        "breakdown": normalized["breakdown"]
    }

@app.get("/api/money/candidate/{candidate_id}/pacs", response_model=PacResponse)
async def candidate_pacs(
    candidate_id: str,
    cycle: int = Query(...),
    store_raw: int = Query(0, description="1 saves gzip snapshot (Schedule A rows) on recompute")
):
    # Cache check: if we have fresh PAC agg rows, serve them
    with get_conn() as conn:
        freshest = conn.execute("""
            SELECT max(fetched_at) AS fetched_at
            FROM candidate_pac_agg
            WHERE candidate_id=%s AND cycle=%s
        """, (candidate_id, cycle)).fetchone()

        if freshest and freshest["fetched_at"] and is_fresh(freshest["fetched_at"], CACHE_TTL_PACS_SECONDS):
            rows = conn.execute("""
                SELECT donor_committee_id, donor_name, total_amount
                FROM candidate_pac_agg
                WHERE candidate_id=%s AND cycle=%s
                ORDER BY total_amount DESC
            """, (candidate_id, cycle)).fetchall()

            return {
                "source": "cache",
                "cycle": cycle,
                "candidate_id": candidate_id,
                "raw_snapshot_saved": False,
                "pacs": [
                    {"donor_committee_id": r["donor_committee_id"], "donor_name": r["donor_name"], "total_amount": int(r["total_amount"])}
                    for r in rows
                ]
            }

    # Need to recompute: committees -> schedule_a -> aggregate
    raw_saved = False

    try:
        comm_json = await openfec.candidate_committees(candidate_id, cycle)
        committees = comm_json.get("results") or []
        committee_ids = [c.get("committee_id") for c in committees if c.get("committee_id")]

        if not committee_ids:
            return {"source": "live", "cycle": cycle, "candidate_id": candidate_id, "raw_snapshot_saved": False, "pacs": []}

        pacs, raw_rows = await openfec.schedule_a_committee_agg(committee_ids, cycle)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    with get_conn() as conn:
        # ensure candidate exists
        conn.execute("""
            INSERT INTO candidates(candidate_id, updated_at)
            VALUES (%s, now())
            ON CONFLICT (candidate_id) DO UPDATE SET updated_at=now()
        """, (candidate_id,))

        # committees cache refresh
        # only refresh if stale or empty (optional). We'll just upsert and timestamp.
        for c in committees:
            conn.execute("""
                INSERT INTO candidate_committees(candidate_id, cycle, committee_id, designation, fetched_at)
                VALUES (%s,%s,%s,%s, now())
                ON CONFLICT (candidate_id, cycle, committee_id) DO UPDATE SET
                  designation=EXCLUDED.designation,
                  fetched_at=now()
            """, (candidate_id, cycle, c.get("committee_id"), c.get("designation")))
        # PAC agg refresh (clean + insert)
        conn.execute("DELETE FROM candidate_pac_agg WHERE candidate_id=%s AND cycle=%s", (candidate_id, cycle))
        for p in pacs:
            conn.execute("""
                INSERT INTO candidate_pac_agg(candidate_id, cycle, donor_committee_id, donor_name, total_amount, fetched_at)
                VALUES (%s,%s,%s,%s,%s, now())
                ON CONFLICT (candidate_id, cycle, donor_committee_id) DO UPDATE SET
                  donor_name=EXCLUDED.donor_name,
                  total_amount=EXCLUDED.total_amount,
                  fetched_at=now()
            """, (candidate_id, cycle, p["donor_committee_id"], p.get("donor_name"), int(p["total_amount"])))

        if store_raw == 1 and raw_rows:
            snapshot_key = f"schedule_a:{candidate_id}:{cycle}"
            payload = openfec.gzip_json(raw_rows)
            conn.execute("""
                INSERT INTO raw_snapshots(snapshot_key, candidate_id, cycle, snapshot_type, payload_gzip, row_count, fetched_at)
                VALUES (%s,%s,%s,%s,%s,%s, now())
                ON CONFLICT (snapshot_key) DO UPDATE SET
                  payload_gzip=EXCLUDED.payload_gzip,
                  row_count=EXCLUDED.row_count,
                  fetched_at=now()
            """, (snapshot_key, candidate_id, cycle, "schedule_a", payload, len(raw_rows)))
            raw_saved = True

        conn.commit()

    return {
        "source": "live",
        "cycle": cycle,
        "candidate_id": candidate_id,
        "raw_snapshot_saved": raw_saved,
        "pacs": pacs
    }

@app.post("/api/money/refresh")
async def refresh(req: RefreshRequest):
    """
    Clears cached rows so next request refetches OpenFEC and repopulates DB.
    """
    with get_conn() as conn:
        for cid in req.candidate_ids:
            conn.execute("DELETE FROM candidate_totals WHERE candidate_id=%s AND cycle=%s", (cid, req.cycle))
            conn.execute("DELETE FROM candidate_pac_agg WHERE candidate_id=%s AND cycle=%s", (cid, req.cycle))
            conn.execute("DELETE FROM candidate_committees WHERE candidate_id=%s AND cycle=%s", (cid, req.cycle))
            conn.execute("DELETE FROM raw_snapshots WHERE snapshot_key=%s", (f"schedule_a:{cid}:{req.cycle}",))
        conn.commit()
    return {"status": "cleared_cache"}
