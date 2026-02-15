# ============================================================
# Enterprise Validation Logger
# ============================================================
# Designed for backend terminal scripts.
# Structured validation + color-coded console output.
# ============================================================

import sys
import json
from dataclasses import dataclass, asdict
from collections import defaultdict
from typing import List, Optional
from datetime import datetime

# ------------------------------------------------------------
# Severity Levels
# ------------------------------------------------------------

DEBUG = 5
INFO = 10
WARNING = 20
ERROR = 30
CRITICAL = 40

SEVERITY_NAMES = {
    DEBUG: "DEBUG",
    INFO: "INFO",
    WARNING: "WARNING",
    ERROR: "ERROR",
    CRITICAL: "CRITICAL",
}

# ------------------------------------------------------------
# ANSI Colors
# ------------------------------------------------------------

class Colors:
    RESET = "\033[0m"
    DIM = "\033[2m"
    BOLD = "\033[1m"

    BLUE = "\033[94m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    RED = "\033[91m"
    MAGENTA = "\033[95m"

SEVERITY_COLORS = {
    DEBUG: Colors.DIM,
    INFO: Colors.BLUE,
    WARNING: Colors.YELLOW,
    ERROR: Colors.RED,
    CRITICAL: Colors.MAGENTA + Colors.BOLD,
}

# ------------------------------------------------------------
# Issue Model
# ------------------------------------------------------------

@dataclass
class Issue:
    shard_id: str
    code: str
    message: str
    severity: int
    timestamp: str

# ------------------------------------------------------------
# Logger
# ------------------------------------------------------------

class ValidationLogger:

    def __init__(
        self,
        *,
        min_level: int = INFO,
        fail_level: int = ERROR,
        verbose: bool = True,
        use_color: bool = True,
        json_output: Optional[str] = None,
        strict: bool = False,
    ):
        """
        min_level   → minimum severity to display
        fail_level  → severity that causes enforce() to raise
        verbose     → print immediately
        use_color   → enable ANSI coloring
        json_output → optional file path to export JSON log
        strict      → treat WARNING as ERROR
        """

        self.min_level = min_level
        self.fail_level = fail_level
        self.verbose = verbose
        self.use_color = use_color
        self.json_output = json_output
        self.strict = strict

        self.issues: List[Issue] = []
        self.counts = defaultdict(int)

    # --------------------------------------------------------

    def _colorize(self, severity: int, text: str) -> str:
        if not self.use_color:
            return text
        return f"{SEVERITY_COLORS[severity]}{text}{Colors.RESET}"

    # --------------------------------------------------------

    def record(
        self,
        shard_id: str,
        code: str,
        message: str,
        severity: int = WARNING,
    ):

        if self.strict and severity == WARNING:
            severity = ERROR

        issue = Issue(
            shard_id=shard_id,
            code=code,
            message=message,
            severity=severity,
            timestamp=datetime.utcnow().isoformat()
        )

        self.issues.append(issue)
        self.counts[severity] += 1

        if self.verbose and severity >= self.min_level:
            label = SEVERITY_NAMES[severity]
            formatted = f"[{label}] {shard_id} {code}: {message}"
            print(self._colorize(severity, formatted))

    # --------------------------------------------------------

    def summary(self) -> dict:
        return {
            "total": len(self.issues),
            "by_severity": {
                SEVERITY_NAMES[k]: v
                for k, v in sorted(self.counts.items())
            }
        }

    # --------------------------------------------------------

    def print_summary(self):

        if not self.issues:
            print(self._colorize(INFO, "\n✔ No validation issues"))
            return

        print("\n--- Validation Summary ---")

        for severity, count in sorted(self.counts.items()):
            label = SEVERITY_NAMES[severity]
            line = f"{label}: {count}"
            print(self._colorize(severity, line))

        print(f"Total: {len(self.issues)}")

    # --------------------------------------------------------

    def enforce(self):

        for issue in self.issues:
            if issue.severity >= self.fail_level:
                raise RuntimeError(
                    f"{SEVERITY_NAMES[issue.severity]} "
                    f"{issue.code} in {issue.shard_id}"
                )

    # --------------------------------------------------------

    def export_json(self):

        if not self.json_output:
            return

        data = {
            "generated_at": datetime.utcnow().isoformat(),
            "summary": self.summary(),
            "issues": [asdict(i) for i in self.issues],
        }

        with open(self.json_output, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

        print(self._colorize(INFO, f"JSON log written → {self.json_output}"))
