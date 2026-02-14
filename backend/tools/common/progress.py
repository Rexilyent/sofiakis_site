# ----------------------------------------------------------------------------
# Progress bar utility for command-line tools.
# ----------------------------------------------------------------------------

import sys

def progress(label: str, current: int, total: int, width: int = 40):
    if total <= 0:
        return

    filled = int(width * current / total)
    bar = "█" * filled + "░" * (width - filled)
    pct = (current / total) * 100

    sys.stdout.write(
        f"\r{label:<28} [{bar}] {current:,}/{total:,} ({pct:5.1f}%)"
    )
    sys.stdout.flush()

    if current == total:
        print()
