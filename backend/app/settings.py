import os
from dotenv import load_dotenv
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parents[1] / ".env"  # backend/.env
load_dotenv(dotenv_path=ENV_PATH)


DATABASE_URL = os.getenv("DATABASE_URL", "")  # optional
PGHOST = os.getenv("PGHOST", "localhost")
PGPORT = int(os.getenv("PGPORT", "5432"))
PGDATABASE = os.getenv("PGDATABASE", "")
PGUSER = os.getenv("PGUSER", "")
PGPASSWORD = os.getenv("PGPASSWORD", "")
OPENFEC_API_KEY = os.getenv("OPENFEC_API_KEY", "DEMO_KEY")

CACHE_TTL_TOTALS_SECONDS = int(os.getenv("CACHE_TTL_TOTALS_SECONDS", "43200"))
CACHE_TTL_PACS_SECONDS   = int(os.getenv("CACHE_TTL_PACS_SECONDS", "86400"))
CACHE_TTL_COMM_SECONDS   = int(os.getenv("CACHE_TTL_COMM_SECONDS", "86400"))

SCHED_A_PER_PAGE  = int(os.getenv("SCHED_A_PER_PAGE", "100"))
SCHED_A_MAX_PAGES = int(os.getenv("SCHED_A_MAX_PAGES", "15"))
