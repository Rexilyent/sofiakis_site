# ==================================================
# Reconciliation Engine
# ==================================================
# Post-aggregation validation against raw shard data.
# 
# ==================================================

import sqlite3
from typing import List, Tuple

from common.validation_logger import (
    INFO,
    WARNING,
    ERROR,
)

Issue = Tuple[str, str, int]


# ==================================================
# Shared Helpers
# ==================================================

def _scalar(conn: sqlite3.Connection, query: str) -> int:
    cur = conn.execute(query)
    row = cur.fetchone()
    return row[0] if row else 0


def _compare(
    issues: List[Issue],
    code: str,
    actual: int,
    expected: int,
    severity: int = ERROR,
):
    if actual != expected:
        issues.append((
            code,
            f"{actual} != {expected}",
            severity
        ))


# ==================================================
# Candidate Reconciliation
# ==================================================

def reconcile_candidate_shard(
    db_path: str,
    aggregate_result: dict
) -> List[Issue]:

    issues: List[Issue] = []

    conn = sqlite3.connect(db_path)

    # ----------------------------------------------
    # 1. Raised total
    # ----------------------------------------------

    actual_raised = _scalar(conn, """
        SELECT COALESCE(SUM(amount_cents), 0)
        FROM transactions
        WHERE source IN ('itcont','itpas2')
          AND direction = 'in'
    """)

    _compare(
        issues,
        "RAISED_MISMATCH",
        actual_raised,
        aggregate_result.get("raised", 0),
        ERROR
    )

    # ----------------------------------------------
    # 2. Spent total
    # ----------------------------------------------

    actual_spent = _scalar(conn, """
        SELECT COALESCE(SUM(amount_cents), 0)
        FROM transactions
        WHERE (
            (source = 'oppexp' AND direction = 'out')
            OR
            (source = 'itpas2' AND direction = 'out')
        )
    """)

    _compare(
        issues,
        "SPENT_MISMATCH",
        actual_spent,
        aggregate_result.get("spent", 0),
        ERROR
    )

    # ----------------------------------------------
    # 3. Receipt breakdown validation
    # ----------------------------------------------

    breakdown_sum = sum(
        aggregate_result.get("receipts", {}).values()
    )

    if breakdown_sum != aggregate_result.get("raised", 0):
        issues.append((
            "RECEIPT_BREAKDOWN_MISMATCH",
            f"{breakdown_sum} != {aggregate_result.get('raised', 0)}",
            ERROR
        ))

    # ----------------------------------------------
    # 4. Spending breakdown validation
    # ----------------------------------------------

    spending_sum = sum(
        aggregate_result.get("spending", {}).values()
    )

    if spending_sum != aggregate_result.get("spent", 0):
        issues.append((
            "SPENDING_BREAKDOWN_MISMATCH",
            f"{spending_sum} != {aggregate_result.get('spent', 0)}",
            ERROR
        ))

    # ----------------------------------------------
    # 5. Direction rule validation
    # ----------------------------------------------

    cur = conn.execute("""
        SELECT source, direction, COUNT(*)
        FROM transactions
        GROUP BY source, direction
    """)

    for source, direction, count in cur.fetchall():

        if source == "itcont" and direction != "in":
            issues.append((
                "INVALID_DIRECTION",
                f"{count} itcont rows not direction='in'",
                WARNING
            ))

        if source == "oppexp" and direction != "out":
            issues.append((
                "INVALID_DIRECTION",
                f"{count} oppexp rows not direction='out'",
                WARNING
            ))

    conn.close()

    return issues


# ==================================================
# Committee Reconciliation
# ==================================================

def reconcile_committee_shard(
    db_path: str,
    aggregate_result: dict
) -> List[Issue]:

    if not aggregate_result:
        return []

    issues: List[Issue] = []

    conn = sqlite3.connect(db_path)

    # ----------------------------------------------
    # 1. Raised total
    # ----------------------------------------------

    actual_raised = _scalar(conn, """
        SELECT COALESCE(SUM(amount_cents), 0)
        FROM transactions
        WHERE source = 'itcont'
          AND direction = 'in'
    """)

    _compare(
        issues,
        "RAISED_MISMATCH",
        actual_raised,
        aggregate_result.get("raised", 0),
        ERROR
    )

    # ----------------------------------------------
    # 2. Spent total
    # ----------------------------------------------

    actual_spent = _scalar(conn, """
        SELECT COALESCE(SUM(amount_cents), 0)
        FROM transactions
        WHERE direction = 'out'
          AND source IN ('oppexp','itpas2')
    """)

    _compare(
        issues,
        "SPENT_MISMATCH",
        actual_spent,
        aggregate_result.get("spent", 0),
        ERROR
    )

    # ----------------------------------------------
    # 3. Direction sanity checks
    # ----------------------------------------------

    cur = conn.execute("""
        SELECT source, direction, COUNT(*)
        FROM transactions
        GROUP BY source, direction
    """)

    for source, direction, count in cur.fetchall():

        if source == "itcont" and direction != "in":
            issues.append((
                "INVALID_DIRECTION",
                f"{count} itcont rows not direction='in'",
                WARNING
            ))

    conn.close()

    return issues
