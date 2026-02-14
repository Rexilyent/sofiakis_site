# =================================================
# Aggregation Utilities
# =================================================
# Pure aggregation logic.
# No D1.
# No SQL generation.
# No side effects.
# =================================================

import sqlite3
from pathlib import Path
from collections import defaultdict

# -------------------------------------------------
# Candidate Aggregation
# -------------------------------------------------

def aggregate_candidate_shard(db_path: str) -> dict:
    """
    Aggregates totals + breakdowns from a candidate shard.
    Returns structured dict ready for persistence.
    """

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    cur.execute(
        "SELECT candidate_id,name,office,party,state,district,source FROM candidate"
    )
    row = cur.fetchone()
    if not row:
        conn.close()
        raise RuntimeError(f"{db_path} missing candidate row")

    meta = dict(zip(
        ["candidate_id","name","office","party","state","district","source"],
        row
    ))

    raised = 0
    spent = 0
    receipts = defaultdict(int)
    spending = defaultdict(int)
    committees = set()

    for src, direction, from_c, _, _, amt in cur.execute(
        "SELECT source,direction,from_committee_id,to_committee_id,"
        "candidate_id,amount_cents FROM transactions"
    ):
        if amt is None:
            continue

        # Raised
        if src in ("itcont","itpas2") and direction == "in":
            raised += amt
            receipts[src] += amt
            if from_c and from_c != "_UNASSIGNED":
                committees.add(from_c)

        # Operating spend
        elif src == "oppexp" and direction == "out":
            spent += amt
            spending["operating"] += amt

        # Independent expenditures
        elif src == "itpas2" and direction == "out":
            spent += amt
            spending["independent_expenditure"] += amt

    conn.close()

    return {
        "meta": meta,
        "raised": raised,
        "spent": spent,
        "receipts": dict(receipts),
        "spending": dict(spending),
        "committees": list(committees),
    }

# -------------------------------------------------
# Committee Aggregation
# -------------------------------------------------

def aggregate_committee_shard(db_path: str) -> dict | None:
    """
    Aggregates totals from a committee shard.
    Returns None for _UNASSIGNED.
    """

    committee_id = Path(db_path).stem
    if committee_id == "_UNASSIGNED":
        return None

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    raised = 0
    spent = 0

    for src, direction, *_ , amt in cur.execute(
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

    return {
        "committee_id": committee_id,
        "raised": raised,
        "spent": spent,
    }
