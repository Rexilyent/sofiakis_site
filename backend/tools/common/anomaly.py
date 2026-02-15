# =================================================
# Aggregation Utilities (Refund-Aware)
# =================================================
# Pure aggregation logic.
# No D1.
# No SQL generation.
# No side effects.
# =================================================

import sqlite3
from pathlib import Path
from collections import defaultdict


# =================================================
# Helpers
# =================================================

def _compute_refund_ratio(positive: int, negative: int) -> float:
    """
    Computes refund ratio safely.

    negative is expected to be <= 0.
    Ratio = abs(negative) / positive
    """

    if positive <= 0:
        return 0.0

    return abs(negative) / positive


# =================================================
# Candidate Aggregation
# =================================================

def aggregate_candidate_shard(db_path: str) -> dict:
    """
    Aggregates totals + breakdowns from a candidate shard.
    Refund-aware structure.
    """

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # -------------------------------------------------
    # Candidate metadata
    # -------------------------------------------------

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

    # -------------------------------------------------
    # Initialize totals
    # -------------------------------------------------

    raised_positive = 0
    raised_negative = 0

    spent_positive = 0
    spent_negative = 0

    receipts = defaultdict(int)
    spending = defaultdict(int)
    committees = set()

    # -------------------------------------------------
    # Process transactions
    # -------------------------------------------------

    for src, direction, from_c, _, _, amt in cur.execute(
        "SELECT source,direction,from_committee_id,to_committee_id,"
        "candidate_id,amount_cents FROM transactions"
    ):
        if amt is None:
            continue

        # -----------------------------
        # Raised
        # -----------------------------

        if src in ("itcont","itpas2") and direction == "in":

            if amt >= 0:
                raised_positive += amt
            else:
                raised_negative += amt

            receipts[src] += amt

            if from_c and from_c != "_UNASSIGNED":
                committees.add(from_c)

        # -----------------------------
        # Operating spend
        # -----------------------------

        elif src == "oppexp" and direction == "out":

            if amt >= 0:
                spent_positive += amt
            else:
                spent_negative += amt

            spending["operating"] += amt

        # -----------------------------
        # Independent expenditures
        # -----------------------------

        elif src == "itpas2" and direction == "out":

            if amt >= 0:
                spent_positive += amt
            else:
                spent_negative += amt

            spending["independent_expenditure"] += amt

    conn.close()

    # -------------------------------------------------
    # Compute net + ratios
    # -------------------------------------------------

    raised_net = raised_positive + raised_negative
    spent_net = spent_positive + spent_negative

    raised_ratio = _compute_refund_ratio(raised_positive, raised_negative)
    spent_ratio = _compute_refund_ratio(spent_positive, spent_negative)

    # -------------------------------------------------
    # Return structured result
    # -------------------------------------------------

    return {
        "meta": meta,

        # Net totals (used by reconciliation + app)
        "raised": raised_net,
        "spent": spent_net,

        # Refund-aware detail
        "raised_positive": raised_positive,
        "raised_negative": raised_negative,
        "raised_refund_ratio": raised_ratio,

        "spent_positive": spent_positive,
        "spent_negative": spent_negative,
        "spent_refund_ratio": spent_ratio,

        # Breakdown data
        "receipts": dict(receipts),
        "spending": dict(spending),
        "committees": list(committees),
    }


# =================================================
# Committee Aggregation
# =================================================

def aggregate_committee_shard(db_path: str) -> dict | None:
    """
    Aggregates totals from a committee shard.
    Refund-aware.
    Returns None for _UNASSIGNED.
    """

    committee_id = Path(db_path).stem
    if committee_id == "_UNASSIGNED":
        return None

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    raised_positive = 0
    raised_negative = 0

    spent_positive = 0
    spent_negative = 0

    for src, direction, *_ , amt in cur.execute(
        "SELECT source,direction,from_committee_id,to_committee_id,"
        "candidate_id,amount_cents FROM transactions"
    ):
        if amt is None:
            continue

        # -----------------------------
        # Raised
        # -----------------------------

        if src == "itcont" and direction == "in":

            if amt >= 0:
                raised_positive += amt
            else:
                raised_negative += amt

        # -----------------------------
        # Spent
        # -----------------------------

        elif src in ("oppexp","itpas2") and direction == "out":

            if amt >= 0:
                spent_positive += amt
            else:
                spent_negative += amt

    conn.close()

    raised_net = raised_positive + raised_negative
    spent_net = spent_positive + spent_negative

    raised_ratio = _compute_refund_ratio(raised_positive, raised_negative)
    spent_ratio = _compute_refund_ratio(spent_positive, spent_negative)

    return {
        "committee_id": committee_id,

        # Net totals
        "raised": raised_net,
        "spent": spent_net,

        # Refund-aware detail
        "raised_positive": raised_positive,
        "raised_negative": raised_negative,
        "raised_refund_ratio": raised_ratio,

        "spent_positive": spent_positive,
        "spent_negative": spent_negative,
        "spent_refund_ratio": spent_ratio,
    }
