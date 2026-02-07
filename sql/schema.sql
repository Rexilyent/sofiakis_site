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
  source TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_candidates_cycle
  ON candidates (cycle);

CREATE INDEX IF NOT EXISTS idx_candidates_state
  ON candidates (state);

-- =====================================================
-- Committees
-- =====================================================

CREATE TABLE IF NOT EXISTS committees (
  committee_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  committee_type TEXT,
  designation TEXT,
  state TEXT,
  connected_org_name TEXT,
  cycle INTEGER NOT NULL,
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
  cash_on_hand_cents INTEGER,

  updated_at TEXT NOT NULL,
  PRIMARY KEY (candidate_id, cycle)
);

-- =====================================================
-- Committee Aggregates
-- =====================================================

CREATE TABLE IF NOT EXISTS committee_totals (
  committee_id TEXT NOT NULL,
  cycle INTEGER NOT NULL,

  total_raised_cents INTEGER NOT NULL,
  total_spent_cents INTEGER NOT NULL,
  cash_on_hand_cents INTEGER,

  updated_at TEXT NOT NULL,
  PRIMARY KEY (committee_id, cycle)
);

-- =====================================================
-- Metadata / Import Info
-- =====================================================

CREATE TABLE IF NOT EXISTS data_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
