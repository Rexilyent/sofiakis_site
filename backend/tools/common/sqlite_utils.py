# -----------------------------------------------------------------
# SQLite utilities for optimizing database performance during release verification.
# -----------------------------------------------------------------

import sqlite3


def configure_fast_write(conn: sqlite3.Connection):
    conn.execute("PRAGMA journal_mode=DELETE;")
    conn.execute("PRAGMA synchronous=OFF;")
    conn.execute("PRAGMA busy_timeout=5000;")
