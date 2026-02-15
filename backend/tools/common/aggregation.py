# =================================================
# Aggregation Utilities
# =================================================
# Version 0.0.2
#
# Changelog:
# - Added ratio calculations
# - Improved transaction processing logic
# =================================================

import sqlite3
from pathlib import Path
from collections import defaultdict


# -------------------------------------------------
# Helpers
# -------------------------------------------------

def _ratio(negative: int, positive: int) -> float:
    if positive <= 0:
        return 0.0
    return abs(negative) / positive


# -------------------------------------------------
# Candidate Aggregation
# -------------------------------------------------

def aggregate_candidate_shard(db_path: str) -> dict:

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

    raised_pos = 0
    raised_neg = 0
    spent_pos = 0
    spent_neg = 0

    receipts = defaultdict(int)
    spending = defaultdict(int)
    committees = set()

    for src, direction, from_c, _, _, amt in cur.execute(
        "SELECT source,direction,from_committee_id,to_committee_id,"
        "candidate_id,amount_cents FROM transactions"
    ):

        if amt is None:
            continue

        # -------------------------------------------------
        # Raised
        # -------------------------------------------------

        if src in ("itcont","itpas2") and direction == "in":

            if amt >= 0:
                raised_pos += amt
            else:
                raised_neg += amt

            receipts[src] += amt

            if from_c and from_c != "_UNASSIGNED":
                committees.add(from_c)

        # -------------------------------------------------
        # Operating spend
        # -------------------------------------------------

        elif src == "oppexp" and direction == "out":

            if amt >= 0:
                spent_pos += amt
            else:
                spent_neg += amt

            spending["operating"] += amt

        # -------------------------------------------------
        # Independent expenditures
        # -------------------------------------------------

        elif src == "itpas2" and direction == "out":

            if amt >= 0:
                spent_pos += amt
            else:
                spent_neg += amt

            spending["independent_expenditure"] += amt

    conn.close()

    raised_net = raised_pos + raised_neg
    spent_net = spent_pos + spent_neg

    return {
        "meta": meta,

        # Net totals (for backward compatibility)
        "raised": raised_net,
        "spent": spent_net,

        # Positive / negative breakdown
        "raised_positive": raised_pos,
        "raised_negative": raised_neg,
        "spent_positive": spent_pos,
        "spent_negative": spent_neg,

        # Refund ratios
        "raised_refund_ratio": _ratio(raised_neg, raised_pos),
        "spent_refund_ratio": _ratio(spent_neg, spent_pos),

        # Source breakdown
        "receipts": dict(receipts),
        "spending": dict(spending),

        # Committee relationships
        "committees": list(committees),
    }


# -------------------------------------------------
# Committee Aggregation
# -------------------------------------------------

def aggregate_committee_shard(db_path: str) -> dict | None:

    committee_id = Path(db_path).stem

    if committee_id == "_UNASSIGNED":
        return None

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    raised_pos = 0
    raised_neg = 0
    spent_pos = 0
    spent_neg = 0

    for src, direction, *_ , amt in cur.execute(
        "SELECT source,direction,from_committee_id,to_committee_id,"
        "candidate_id,amount_cents FROM transactions"
    ):

        if amt is None:
            continue

        # -------------------------------------------------
        # Raised
        # -------------------------------------------------

        if src == "itcont" and direction == "in":

            if amt >= 0:
                raised_pos += amt
            else:
                raised_neg += amt

        # -------------------------------------------------
        # Spent
        # -------------------------------------------------

        elif src in ("oppexp","itpas2") and direction == "out":

            if amt >= 0:
                spent_pos += amt
            else:
                spent_neg += amt

    conn.close()

    raised_net = raised_pos + raised_neg
    spent_net = spent_pos + spent_neg

    return {
        "committee_id": committee_id,

        # Net totals
        "raised": raised_net,
        "spent": spent_net,

        # Positive / negative components
        "raised_positive": raised_pos,
        "raised_negative": raised_neg,
        "spent_positive": spent_pos,
        "spent_negative": spent_neg,

        # Refund ratios
        "raised_refund_ratio": _ratio(raised_neg, raised_pos),
        "spent_refund_ratio": _ratio(spent_neg, spent_pos),
    }
