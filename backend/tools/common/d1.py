# ==================================================
# D1 Client Abstraction Layer
# ==================================================

from __future__ import annotations

import subprocess
import os
import time
from typing import List, Optional


# ==================================================
# Exceptions
# ==================================================

class D1ExecutionError(RuntimeError):
    pass


# ==================================================
# D1 Client
# ==================================================

class D1Client:

    def __init__(
        self,
        database: Optional[str] = None,
        dry_run: bool = False,
        max_retries: int = 1,
    ):
        self.database = database or os.environ.get("D1_DATABASE")
        self.dry_run = dry_run
        self.max_retries = max_retries

        if not self.database:
            raise RuntimeError("D1 database name not configured")

    # -------------------------------------------------
    # Core Execution
    # -------------------------------------------------

    def execute(self, sql: str) -> float:
        """
        Executes raw SQL.
        Returns execution duration (seconds).
        """

        if self.dry_run:
            print("\n[D1 DRY RUN]")
            print(sql)
            return 0.0

        attempt = 0

        while True:
            start = time.time()

            proc = subprocess.run(
                ["wrangler", "d1", "execute", self.database, "--file=-"],
                input=sql.encode(),
                capture_output=True,
            )

            duration = time.time() - start

            if proc.returncode == 0:
                return duration

            if attempt >= self.max_retries:
                raise D1ExecutionError(proc.stderr.decode())

            attempt += 1
            time.sleep(1)

    # -------------------------------------------------
    # Transaction Execution
    # -------------------------------------------------

    def transaction(self, statements: List[str]) -> float:
        """
        Wraps statements in BEGIN/COMMIT.
        """
        if not statements:
            return 0.0

        sql = ["BEGIN;"]
        sql.extend(statements)
        sql.append("COMMIT;")

        return self.execute("\n".join(sql))

    # -------------------------------------------------
    # Scalar Query
    # -------------------------------------------------

    def scalar(self, sql: str) -> str:
        """
        Executes SQL and returns stdout.
        Used for existence checks.
        """

        if self.dry_run:
            print("\n[D1 DRY RUN - SCALAR]")
            print(sql)
            return ""

        proc = subprocess.run(
            ["wrangler", "d1", "execute", self.database, "--file=-"],
            input=sql.encode(),
            capture_output=True,
        )

        if proc.returncode != 0:
            raise D1ExecutionError(proc.stderr.decode())

        return proc.stdout.decode().strip()

    # -------------------------------------------------
    # Batch Flusher
    # -------------------------------------------------

    def flush_batch(self, statements: List[str]) -> List[str]:
        """
        Executes and resets batch list.
        """
        if statements:
            self.transaction(statements)
        return []
