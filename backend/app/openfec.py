import gzip
import json
from typing import Any, Dict, List, Tuple, Optional
import httpx
from .settings import OPENFEC_API_KEY, SCHED_A_MAX_PAGES, SCHED_A_PER_PAGE

BASE = "https://api.open.fec.gov/v1"

def gzip_json(obj: Any) -> bytes:
    raw = json.dumps(obj).encode("utf-8")
    return gzip.compress(raw, compresslevel=6)

async def _get(path: str, params: List[tuple]) -> Dict[str, Any]:
    # params must already include api_key
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(f"{BASE}{path}", params=params)
        r.raise_for_status()
        return r.json()

async def search_candidates(name: str, cycle: int, office: str) -> Dict[str, Any]:
    params = [
        ("api_key", OPENFEC_API_KEY),
        ("name", name),
        ("election_year", str(cycle)),
        ("per_page", "20"),
    ]
    if office:
        params.append(("office", office))
    return await _get("/candidates/search/", params)

async def totals(candidate_id: str, cycle: int) -> Dict[str, Any]:
    params = [("api_key", OPENFEC_API_KEY), ("cycle", str(cycle))]
    return await _get(f"/candidate/{candidate_id}/totals/", params)

def pick_best_totals_row(data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    rows = data.get("results") or []
    if not rows:
        return None
    # choose newest coverage_end_date if present
    rows.sort(key=lambda r: (r.get("coverage_end_date") or ""), reverse=True)
    return rows[0]

def normalize_totals_row(r: Dict[str, Any]) -> Dict[str, Any]:
    receipts = int(r.get("receipts") or r.get("total_receipts") or 0)
    cash_on_hand = int(r.get("cash_on_hand_end_period") or r.get("cash_on_hand") or 0)

    individuals = int(
        r.get("individual_contributions")
        or r.get("individual_itemized_contributions")
        or 0
    )
    pacs = int(
        r.get("pac_contributions")
        or r.get("other_political_committee_contributions")
        or 0
    )
    self_funding = int(r.get("candidate_contribution") or r.get("candidate_loans") or 0)
    transfers = int(
        r.get("transfers_from_affiliates")
        or r.get("transfers_from_other_authorized_committee")
        or 0
    )

    refunds_raw = int(r.get("refunds") or r.get("refunded_individual_contributions") or 0)
    refunds_out = abs(refunds_raw) if refunds_raw else 0

    known = individuals + pacs + self_funding + transfers
    other = max(0, receipts - known) if receipts > 0 else 0

    return {
        "coverage_end_date": r.get("coverage_end_date"),
        "receipts": receipts,
        "cash_on_hand": cash_on_hand,
        "breakdown": {
            "individuals": individuals,
            "pacs": pacs,
            "self_funding": self_funding,
            "transfers": transfers,
            "refunds_out": refunds_out,
            "other": other,
        },
    }

async def candidate_committees(candidate_id: str, cycle: int) -> Dict[str, Any]:
    params = [
        ("api_key", OPENFEC_API_KEY),
        ("cycle", str(cycle)),
        ("designation", "P"),
        ("per_page", "100"),
    ]
    return await _get(f"/candidate/{candidate_id}/committees/", params)

async def schedule_a_committee_agg(committee_ids: List[str], cycle: int) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """
    Fetches Schedule A for multiple committee_ids, contributor_type=committee,
    aggregates to donor_committee_id -> sum(amount).
    Returns (aggregates_sorted, raw_rows_all_pages)
    """
    agg: Dict[str, Dict[str, Any]] = {}
    raw_rows: List[Dict[str, Any]] = []

    paging = {"last_index": None, "last_contribution_receipt_date": None, "sort_null_only": None}

    for _ in range(SCHED_A_MAX_PAGES):
        params: List[tuple] = [
            ("api_key", OPENFEC_API_KEY),
            ("two_year_transaction_period", str(cycle)),
            ("contributor_type", "committee"),
            ("sort", "-contribution_receipt_date"),
            ("per_page", str(SCHED_A_PER_PAGE)),
        ]
        for cid in committee_ids:
            params.append(("committee_id", cid))

        if paging["last_index"]:
            params.append(("last_index", paging["last_index"]))
        if paging["last_contribution_receipt_date"]:
            params.append(("last_contribution_receipt_date", paging["last_contribution_receipt_date"]))
        if paging["sort_null_only"]:
            params.append(("sort_null_only", "true"))

        data = await _get("/schedules/schedule_a/", params)
        rows = data.get("results") or []
        if not rows:
            break

        raw_rows.extend(rows)

        for row in rows:
            donor_id = row.get("contributor_id") or row.get("contributor_committee_id")
            donor_name = row.get("contributor_name") or row.get("contributor_committee_name") or "Unknown committee"
            amt = row.get("contribution_receipt_amount") or 0
            if not donor_id or not amt:
                continue

            if donor_id not in agg:
                agg[donor_id] = {
                    "donor_committee_id": donor_id,
                    "donor_name": donor_name,
                    "total_amount": 0,
                }
            agg[donor_id]["total_amount"] += int(amt)

            # keep best name seen
            if donor_name and len(donor_name) > len(agg[donor_id].get("donor_name") or ""):
                agg[donor_id]["donor_name"] = donor_name

        last = (data.get("pagination") or {}).get("last_indexes") or {}
        paging["last_index"] = last.get("last_index")
        paging["last_contribution_receipt_date"] = last.get("last_contribution_receipt_date")
        paging["sort_null_only"] = True if last.get("sort_null_only") else None

        if not paging["last_index"]:
            break

    pacs = sorted(agg.values(), key=lambda x: x["total_amount"], reverse=True)
    return pacs, raw_rows
