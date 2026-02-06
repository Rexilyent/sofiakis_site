-- Core candidate data
CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_normalized TEXT, -- for case-insensitive search
  office TEXT,
  party TEXT,
  state TEXT,
  district TEXT,
  incumbent_challenge TEXT,
  election_year INTEGER
);

-- Committee information (optionally tied to a candidate)
CREATE TABLE committees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  designation TEXT,
  type_category TEXT, -- e.g. "PAC", "Party", "Super PAC"
  affiliated_candidate_id TEXT REFERENCES candidates(id)
);

-- Aggregated totals from itemized transactions (from itoth.txt)
CREATE TABLE candidate_totals (
  candidate_id TEXT REFERENCES candidates(id),
  cycle INTEGER,
  total_receipts INTEGER,
  individual_contributions INTEGER,
  pac_contributions INTEGER,
  party_contributions INTEGER,
  other_committee_contributions INTEGER,
  total_disbursements INTEGER,
  cash_on_hand INTEGER,
  debts_owed INTEGER,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(candidate_id, cycle)
);

-- PAC-level aggregation per candidate
CREATE TABLE pac_contributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT REFERENCES candidates(id),
  pac_name TEXT NOT NULL,
  pac_name_normalized TEXT,
  pac_id TEXT,
  total_amount INTEGER,
  cycle INTEGER,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- (Optional) Top donors per candidate
CREATE TABLE donor_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT REFERENCES candidates(id),
  donor_name TEXT NOT NULL,
  city TEXT,
  state TEXT,
  zip_code TEXT,
  total_amount INTEGER,
  cycle INTEGER,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Metadata for available cycles
CREATE TABLE election_cycles (
  cycle INTEGER PRIMARY KEY,
  description TEXT
);

-- 🔍 Indexes for performance
CREATE INDEX idx_candidate_name ON candidates(name_normalized);
CREATE INDEX idx_totals_candidate_cycle ON candidate_totals(candidate_id, cycle);
CREATE INDEX idx_pac_contrib_candidate ON pac_contributions(candidate_id);
CREATE INDEX idx_donor_candidate ON donor_summary(candidate_id);
