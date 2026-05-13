-- ================================
-- D1 Schema for Volunteers
-- ================================
-- Notes:
-- - D1 stores Volunteer data only
-- - Volunteer data is collected via public-facing forms and stored in D1 for later analysis and outreach
-- - All timestamps are stored as TEXT in ISO 8601 format (e.g., "2024-06-01T12:00:00Z")
-- - Consent is stored as BOOLEAN (0 for no consent, 1 for consent)
-- - Source form identifies which public form the volunteer submitted (e.g., "homepage", "issues_page", etc.)
-- - IP hash is stored as TEXT to anonymize volunteer data while still allowing for duplicate detection
-- ================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS volunteers (
	volunteer_id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	email TEXT NOT NULL UNIQUE,
	phone TEXT,
	zip TEXT NOT NULL,
	consent BOOLEAN NOT NULL DEFAULT 0,
	email_verified BOOLEAN NOT NULL DEFAULT 0,
	email_verified_at TEXT,
	email_hash TEXT,
	source_form TEXT NOT NULL,
	ip_hash TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_volunteers_email ON volunteers(email);
CREATE INDEX IF NOT EXISTS idx_volunteers_ip_hash ON volunteers(ip_hash);
CREATE INDEX IF NOT EXISTS idx_volunteers_email_hash ON volunteers(email_hash);

CREATE TABLE IF NOT EXISTS volunteer_interests (
	volunteer_id TEXT NOT NULL,
	interest TEXT NOT NULL,
	PRIMARY KEY (volunteer_id, interest),
	FOREIGN KEY (volunteer_id) REFERENCES volunteers(volunteer_id)
	ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS volunteer_languages (
	volunteer_id TEXT NOT NULL,
	language TEXT NOT NULL,
	PRIMARY KEY (volunteer_id, language),
	FOREIGN KEY (volunteer_id) REFERENCES volunteers(volunteer_id)
	ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS volunteer_submissions (
	submission_id TEXT PRIMARY KEY,
	volunteer_id TEXT NOT NULL,
	form_type TEXT NOT NULL,
	submitted_at TEXT NOT NULL,
	verification_expires_at TEXT,
	raw_payload_hash TEXT NOT NULL,
	FOREIGN KEY (volunteer_id) REFERENCES volunteers(volunteer_id)
	ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_volunteer_submissions_volunteer_id ON volunteer_submissions(volunteer_id);

-- =====================================================
-- Deletion Log for GDPR Compliance
-- =====================================================
CREATE TABLE IF NOT EXISTS deletion_requests (
	request_id TEXT PRIMARY KEY,
	volunteer_id TEXT NOT NULL,
	email TEXT NOT NULL,
	type TEXT NOT NULL, -- "soft" or "hard"
	requested_at TEXT NOT NULL,
	processed_at TEXT
);

-- =====================================================
-- Rate Limiting Table
-- =====================================================

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start TEXT NOT NULL
);