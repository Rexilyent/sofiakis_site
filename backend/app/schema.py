# backend/app/schema.py

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS candidates (
  candidate_id TEXT PRIMARY KEY,
  name TEXT,
  office TEXT,
  party TEXT,
  state TEXT,
  district TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS candidate_totals (
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE CASCADE,
  cycle INT NOT NULL,
  coverage_end_date DATE,
  receipts BIGINT NOT NULL DEFAULT 0,
  cash_on_hand BIGINT NOT NULL DEFAULT 0,
  individuals BIGINT NOT NULL DEFAULT 0,
  pacs BIGINT NOT NULL DEFAULT 0,
  self_funding BIGINT NOT NULL DEFAULT 0,
  transfers BIGINT NOT NULL DEFAULT 0,
  refunds_out BIGINT NOT NULL DEFAULT 0,
  other BIGINT NOT NULL DEFAULT 0,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (candidate_id, cycle)
);

CREATE TABLE IF NOT EXISTS candidate_committees (
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE CASCADE,
  cycle INT NOT NULL,
  committee_id TEXT NOT NULL,
  designation TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (candidate_id, cycle, committee_id)
);

CREATE TABLE IF NOT EXISTS candidate_pac_agg (
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE CASCADE,
  cycle INT NOT NULL,
  donor_committee_id TEXT NOT NULL,
  donor_name TEXT,
  total_amount BIGINT NOT NULL DEFAULT 0,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (candidate_id, cycle, donor_committee_id)
);

CREATE TABLE IF NOT EXISTS raw_snapshots (
  snapshot_key TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(candidate_id) ON DELETE CASCADE,
  cycle INT NOT NULL,
  snapshot_type TEXT NOT NULL,
  payload_gzip BYTEA NOT NULL,
  row_count INT NOT NULL DEFAULT 0,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_candidates_name ON candidates (name);
CREATE INDEX IF NOT EXISTS idx_totals_fetched ON candidate_totals (fetched_at);
CREATE INDEX IF NOT EXISTS idx_pac_fetched ON candidate_pac_agg (fetched_at);
"""
