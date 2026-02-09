-- =====================================================
-- D1 / SQLite schema for Money Tracker (App-Facing)
-- =====================================================
-- Notes:
-- - D1 stores INDEX + AGGREGATES only
-- - Transaction line items live in per-entity SQLite shards (R2)
-- - All money values are stored as INTEGER CENTS
-- =====================================================

-- =====================================================
-- Candidates
-- =====================================================

CREATE TABLE IF NOT EXISTS candidates (
  candidate_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  office TEXT,
  party TEXT,
  state TEXT,
  district TEXT,
  cycle INTEGER NOT NULL,
  source TEXT, -- FEC
	release_id TEXT NOT NULL, -- immutable source versioning from split_fec_bulk_to_sqlite.py
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_candidates_cycle
  ON candidates (cycle);

CREATE INDEX IF NOT EXISTS idx_candidates_state
  ON candidates (cycle, state);

CREATE INDEX IF NOT EXISTS idx_candidates_office
	ON candidates (cycle, office);

CREATE INDEX IF NOT EXISTS idx_candidates_party
	ON candidates (cycle, party);

-- =====================================================
-- Committees
-- =====================================================

CREATE TABLE IF NOT EXISTS committees (
  committee_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  committee_type TEXT,
  designation TEXT,
  state TEXT,
  cycle INTEGER NOT NULL,
	source TEXT, -- FEC
	release_id TEXT NOT NULL, -- immutable source versioning from split_fec_bulk_to_sqlite.py
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_committees_cycle
  ON committees (cycle);

-- =====================================================
-- Candidate ↔ Committee Link
-- =====================================================

CREATE TABLE IF NOT EXISTS candidate_committee_link (
  candidate_id TEXT NOT NULL,
  committee_id TEXT NOT NULL,
  cycle INTEGER NOT NULL,
  PRIMARY KEY (candidate_id, committee_id, cycle)
);

CREATE INDEX IF NOT EXISTS idx_ccl_candidate
  ON candidate_committee_link (candidate_id, cycle);

CREATE INDEX IF NOT EXISTS idx_ccl_committee
  ON candidate_committee_link (committee_id, cycle);

-- =====================================================
-- Candidate Aggregates
-- =====================================================
-- All amounts stored as INTEGER CENTS
-- =====================================================

CREATE TABLE IF NOT EXISTS candidate_totals (
  candidate_id TEXT NOT NULL,
  cycle INTEGER NOT NULL,

  total_raised_cents INTEGER NOT NULL,
  total_spent_cents INTEGER NOT NULL,

	source TEXT, -- FEC
	release_id TEXT NOT NULL, -- immutable source versioning from split_fec_bulk_to_sqlite.py
  updated_at TEXT NOT NULL,
  PRIMARY KEY (candidate_id, cycle)
);

CREATE INDEX IF NOT EXISTS idx_candidate_totals_cycle
	ON candidate_totals (cycle);

-- =====================================================
-- Committee Aggregates
-- =====================================================

CREATE TABLE IF NOT EXISTS committee_totals (
  committee_id TEXT NOT NULL,
  cycle INTEGER NOT NULL,

  total_raised_cents INTEGER NOT NULL,
  total_spent_cents INTEGER NOT NULL,

	source TEXT, -- FEC
	release_id TEXT NOT NULL, -- immutable source versioning from split_fec_bulk_to_sqlite.py
  updated_at TEXT NOT NULL,
  PRIMARY KEY (committee_id, cycle)
);

CREATE INDEX IF NOT EXISTS idx_committee_totals_cycle
	ON committee_totals (cycle);

-- =====================================================
-- Candidate Receipt Breakdown
-- =====================================================

CREATE TABLE IF NOT EXISTS candidate_receipt_breakdown (
	candidate_id TEXT NOT NULL,
	cycle INTEGER NOT NULL,

	source_type TEXT NOT NULL,
	-- expected values:
	-- "individual"
	-- 'pac'
	-- 'party'
	-- 'self'

	amount_cents INTEGER NOT NULL,

	PRIMARY KEY (candidate_id, cycle, source_type)
);

CREATE INDEX IF NOT EXISTS idx_candidate_breakdown_cycle
	ON candidate_receipt_breakdown (cycle);

CREATE TABLE IF NOT EXISTS candidate_spending_breakdown (
	candidate_id TEXT NOT NULL,
	cycle INTEGER NOT NULL,

	spending_type TEXT NOT NULL,
	-- expected values:
	-- "operating"
	-- 'contribution'
	-- 'independent_expenditure'
	-- 'other'

	amount_cents INTEGER NOT NULL,

	PRIMARY KEY (candidate_id, cycle, spending_type)
);

-- =====================================================
-- Metadata / Import Info
-- =====================================================

CREATE TABLE IF NOT EXISTS upload_audit (
  release_id TEXT PRIMARY KEY,
	cycle INTEGER NOT NULL,
	candidate_shards INTEGER NOT NULL,
	committee_shards INTEGER NOT NULL,
	checksum_sha256 TEXT NOT NULL,
	uploaded_at TEXT NOT NULL,
	uploader_version TEXT NOT NULL
);