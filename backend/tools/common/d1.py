# ==================================================
# D1 Client Abstraction Layer
# ==================================================

# ↓ This is so annoying to see....
from __future__ import annotations

import os
import time
import subprocess
from dotenv import load_dotenv
from pathlib import Path
from typing import List, Optional

# ==================================================
# D1 Client Version 1.1
# ==================================================

# ==================================================
# Load Environment
# ==================================================

env_path = Path(__file__).resolve().parents[3] / ".env"
load_dotenv(env_path)


# ==================================================
# Exceptions
# ==================================================

class D1ExecutionError(RuntimeError):
    pass

# ==================================================
# D1 Client
# ==================================================

class D1Client:
    def __init__(self, dry_run: bool = False):
        self.dry_run = dry_run

        env = os.getenv("APP_ENV", "dev").lower()

        if env == "prod":
            self.database_name = os.getenv("D1_PROD_DATABASE_NAME")
        else:
            self.database_name = os.getenv("D1_DEV_DATABASE_NAME")

        if not self.database_name:
            raise RuntimeError("D1 database name not configured")

        print(f"[D1] Environment: {env}")
        print(f"[D1] Database: {self.database_name}")

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
