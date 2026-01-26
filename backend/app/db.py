from contextlib import contextmanager
import psycopg
from psycopg.rows import dict_row
from .settings import DATABASE_URL, PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD

@contextmanager
def get_conn():
    # Preferred: explicit params (avoids URL escaping problems)
    if PGDATABASE and PGUSER and PGPASSWORD:
        with psycopg.connect(
            host=PGHOST,
            port=PGPORT,
            dbname=PGDATABASE,
            user=PGUSER,
            password=PGPASSWORD,
            row_factory=dict_row,
        ) as conn:
            yield conn
        return

    # Fallback: DATABASE_URL (must be URL-encoded if password has special chars)
    if DATABASE_URL:
        with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
            yield conn
        return

    raise RuntimeError(
        "DB config missing. Set PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD (recommended) "
        "or set DATABASE_URL."
    )
