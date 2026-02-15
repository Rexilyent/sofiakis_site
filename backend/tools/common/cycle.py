# ==================================================
# Helpers for election cycle detection
# ==================================================

from pathlib import Path
from collections import defaultdict

from common.time_utils import extract_year


# --------------------------------------------------
# Cycle Normalization
# --------------------------------------------------

def normalize_cycle_year(year_str: str) -> str:
    """
    Normalize 4-digit year to official FEC cycle year (even).
    2025 → 2026
    """

    if not year_str.isdigit() or len(year_str) != 4:
        raise ValueError("Year must be a 4-digit string")

    year = int(year_str)

    if year % 2 != 0:
        year += 1

    return str(year)


def cycle_window(cycle: str):
    """
    Given normalized cycle year (even),
    return (start_year, end_year)
    """

    year = int(cycle)

    if year % 2 != 0:
        raise ValueError("Cycle year must be even")

    return year - 1, year


# --------------------------------------------------
# Bulk Detection (Candidate Files)
# --------------------------------------------------

def detect_cycle_from_bulk(
    bulk_dir: Path,
    *,
    max_lines_per_file: int = 200,
    strict: bool = False,
) -> str:

    if not bulk_dir.exists():
        raise RuntimeError(f"Bulk directory not found: {bulk_dir}")

    possible_cycles = defaultdict(int)

    for file in bulk_dir.glob("cn*.txt"):
        with file.open(encoding="utf-8", errors="ignore") as f:
            for i, line in enumerate(f):
                parts = line.rstrip("\n").split("|")

                for field in parts:
                    year = extract_year(field)
                    if year and 2000 <= year <= 2100:
                        possible_cycles[str(year)] += 1

                if i >= max_lines_per_file:
                    break

    if not possible_cycles:
        raise RuntimeError(
            "Unable to auto-detect cycle from bulk directory. "
            "Please specify --cycle explicitly."
        )

    if strict and len(possible_cycles) > 1:
        detected = ", ".join(sorted(possible_cycles.keys()))
        raise RuntimeError(
            f"Multiple cycles detected: {detected}"
        )

    detected = sorted(
        possible_cycles.items(),
        key=lambda x: x[1],
        reverse=True,
    )[0][0]

    print(f"🔍 Auto-detected cycle from bulk data: {detected}")
    return normalize_cycle_year(detected)


# --------------------------------------------------
# Transaction-Based Detection
# --------------------------------------------------

def derive_cycle_from_transactions(
    bulk_dir: Path,
    *,
    max_lines_per_file: int = 5000,
) -> str:

    tx_files = [
        "itcont.txt",
        "itpas2.txt",
        "itoth.txt",
        "oppexp.txt",
    ]

    cycle_counts = defaultdict(int)

    for fname in tx_files:
        path = bulk_dir / fname
        if not path.exists():
            continue

        with path.open(encoding="utf-8", errors="ignore") as f:
            for i, line in enumerate(f):
                parts = line.rstrip("\n").split("|")

                for field in parts:
                    year = extract_year(field)
                    if year and 2000 <= year <= 2100:
                        cycle_year = normalize_cycle_year(str(year))
                        cycle_counts[cycle_year] += 1

                if i >= max_lines_per_file:
                    break

    if not cycle_counts:
        raise RuntimeError(
            "Unable to derive cycle from transaction files."
        )

    detected_cycle = sorted(
        cycle_counts.items(),
        key=lambda x: x[1],
        reverse=True,
    )[0][0]

    print(f"🔍 Derived cycle from transaction data: {detected_cycle}")
    return detected_cycle


# --------------------------------------------------
# Consistency Validation
# --------------------------------------------------

def validate_cycle_consistency(user_cycle: str, derived_cycle: str):

    normalized = normalize_cycle_year(user_cycle)

    if normalized != derived_cycle:
        raise RuntimeError(
            f"Cycle mismatch detected.\n"
            f"User provided: {user_cycle} → normalized {normalized}\n"
            f"Derived from transactions: {derived_cycle}"
        )


# --------------------------------------------------
# Transaction Date Validation
# --------------------------------------------------

def validate_transaction_date(date_str: str, cycle: str) -> bool:
    """
    Validate transaction date against FEC 2-year window.
    """

    year = extract_year(date_str)
    if not year:
        return False

    start_year, end_year = cycle_window(cycle)

    return start_year <= year <= end_year
