BEGIN;

-- ============================================================
-- Create app_facing_database schema
-- Yes, I have to rebuild the sql code again, and yes, it is tedious.
-- Yes, I know I'm an idiot..
-- Yes, I know there are better ways to do this.
-- Why did I get myself into this mess?
-- Oh thats right, because I'm an idiot and didn't know any better at the time.
-- How could I have known that you could just compress the bulk FEC data
-- into a single file and have the app read from that file directly?
-- Sigh...
-- Here I go again, rebuilding the entire database schema from scratch.
-- This time without the need for all that bulk data being stored in the database
-- and then being aggregated into the app facing tables.
-- ============================================================

-- ============================================================
-- Create moneytracker_owner role
-- ============================================================
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'moneytracker_owner') THEN
		CREATE ROLE moneytracker_owner NOINHERIT NOLOGIN;
	END IF;
END $$;

-- ============================================================
-- Create app_facing_database
-- ============================================================
DO $$
BEGIN
	IF current_database() <> 'moneytracker' THEN
		PERFORM 1 FROM pg_database WHERE datname = 'moneytracker';
		IF NOT FOUND THEN
			CREATE DATABASE moneytracker OWNER moneytracker_owner;
		END IF;
	END IF;
END$$;

-- =========================================================
-- 0) Audit tables FIRST (so FK references succeed)
-- =========================================================
DO $$
BEGIN

CREATE TABLE IF NOT EXISTS public.import_runs (
  run_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	cycle				 integer NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
	status       text NOT NULL DEFAULT 'running',
  source       text,
  notes        text,
  meta         jsonb
);

END $$;

-- ============================================================
-- Create app_facing_database schema
-- ============================================================
DO $$
BEGIN

-- candidates — canonical candidate info
CREATE TABLE IF NOT EXISTS public.candidates (
  candidate_id text PRIMARY KEY,
  name         text,
  office       text,
  party        text,
  state        text,
  district     text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  source       text,
  run_id       bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL
);

-- committees — canonical committee info
CREATE TABLE IF NOT EXISTS public.committees (
  committee_id          text PRIMARY KEY,
  name                  text,
  committee_type        text,
  committee_designation text,
  organization_type     text,
  connected_org_name    text,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  source                text,
  run_id                bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL
);

-- candidate_committees — linkage (many-to-many) with cycle
CREATE TABLE IF NOT EXISTS public.candidate_committees (
  candidate_id text NOT NULL,
  committee_id text NOT NULL,
  cycle        integer NOT NULL,

  linkage_type text,
  designation  text,

  updated_at   timestamptz NOT NULL DEFAULT now(),
  source       text,
  run_id       bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL,

  CONSTRAINT candidate_committees_pk PRIMARY KEY (candidate_id, committee_id, cycle),
  CONSTRAINT candidate_committees_fk_candidate FOREIGN KEY (candidate_id) REFERENCES public.candidates(candidate_id),
  CONSTRAINT candidate_committees_fk_committee FOREIGN KEY (committee_id) REFERENCES public.committees(committee_id)
);

-- =========================================================
-- App-facing aggregates (cached for fast UI)
-- =========================================================

CREATE TABLE IF NOT EXISTS public.candidate_totals (
  candidate_id       text NOT NULL,
  cycle              integer NOT NULL,

  coverage_end_date  date,
  receipts           numeric(14,2) NOT NULL DEFAULT 0,
  cash_on_hand       numeric(14,2) NOT NULL DEFAULT 0,
  individuals        numeric(14,2) NOT NULL DEFAULT 0,
  pacs               numeric(14,2) NOT NULL DEFAULT 0,
  self_funding       numeric(14,2) NOT NULL DEFAULT 0,
  refunds_out        numeric(14,2) NOT NULL DEFAULT 0,
  other              numeric(14,2) DEFAULT 0,
  fetched_at         timestamptz NOT NULL,
  source             text NOT NULL,
  run_id             bigint NOT NULL,
	PRIMARY KEY        (candidate_id, cycle)
);

CREATE TABLE IF NOT EXISTS public.committee_donor_totals (
  cycle              integer NOT NULL,
  donor_committee_id text NOT NULL,
  donor_name         text,
  total_amount       numeric(14,2) NOT NULL DEFAULT 0,

  fetched_at         timestamptz NOT NULL,
  source             text NOT NULL,
  run_id             bigint NOT NULL,
  PRIMARY KEY        (cycle, donor_committee_id)
);

CREATE TABLE IF NOT EXISTS public.individual_donor_totals (
	cycle              integer NOT NULL,
	donor_name         text NOT NULL,
	donor_state        text,
	donor_zip          text,
	total_amount       numeric(14,2) NOT NULL DEFAULT 0,
	fetched_at         timestamptz NOT NULL,
	source             text NOT NULL,
	run_id             bigint NOT NULL,
	PRIMARY KEY        (cycle, donor_name, donor_state, donor_zip)
);

CREATE TABLE IF NOT EXISTS public.candidate_receipts_monthly (
  candidate_id          text NOT NULL,
  cycle                 integer NOT NULL,
  month_start           date NOT NULL,

  individuals_amount    numeric(14,2) NOT NULL DEFAULT 0,
  pac_amount            numeric(14,2) NOT NULL DEFAULT 0,
  other_committee_amount numeric(14,2) NOT NULL DEFAULT 0,
  total_amount          numeric(14,2) NOT NULL DEFAULT 0,

  fetched_at            timestamptz NOT NULL,
  source                text NOT NULL,
  run_id                bigint NOT NULL,
  PRIMARY KEY           (candidate_id, cycle, month_start)
);

CREATE TABLE IF NOT EXISTS public.candidate_pac_agg (
  candidate_id       text NOT NULL,
  cycle              integer NOT NULL,
  donor_committee_id text NOT NULL,
  donor_name         text NOT NULL,
  total_amount       numeric(14,2) NOT NULL DEFAULT 0,

  fetched_at         timestamptz NOT NULL,
  source             text NOT NULL,
  run_id             bigint NOT NULL,

  PRIMARY KEY (candidate_id, cycle, donor_committee_id)
);

CREATE TABLE IF NOT EXISTS public.candidate_individual_donor_agg (
  candidate_id  text NOT NULL,
  cycle         integer NOT NULL,
  donor_name    text NOT NULL,
  donor_state   text,
  donor_zip     text,
  total_amount  numeric(14,2) NOT NULL DEFAULT 0,

  fetched_at    timestamptz NOT NULL,
  source        text NOT NULL,
  run_id        bigint NOT NULL,
  CONSTRAINT candidate_individual_donor_agg_pk PRIMARY KEY (candidate_id, cycle, donor_name, donor_state, donor_zip)
);

CREATE TABLE IF NOT EXISTS public.candidate_expenditures_totals (
  candidate_id           text NOT NULL,
  cycle                  integer NOT NULL,
  operating_expenditures numeric(14,2) NOT NULL DEFAULT 0,

  fetched_at             timestamptz NOT NULL,
  source                 text NOT NULL,
  run_id                 bigint NOT NULL,
  PRIMARY KEY (candidate_id, cycle)
);

CREATE TABLE IF NOT EXISTS public.candidate_expenditures_monthly (
  candidate_id           text NOT NULL,
  cycle                  integer NOT NULL,
  month_start            date NOT NULL,
  operating_expenditures numeric(14,2) NOT NULL DEFAULT 0,
  total_amount           numeric(14,2) NOT NULL DEFAULT 0,

  fetched_at             timestamptz NOT NULL,
  source                 text NOT NULL,
  run_id                 bigint NOT NULL,
  PRIMARY KEY (candidate_id, cycle, month_start)
);

END $$;

-- ============================================================
-- Create login roles
-- ============================================================
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'moneytracker_app') THEN
    CREATE ROLE moneytracker_app LOGIN PASSWORD '...';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'moneytracker_importer') THEN
    CREATE ROLE moneytracker_importer LOGIN PASSWORD '...';
  END IF;
END $$;

