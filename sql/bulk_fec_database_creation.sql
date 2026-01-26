BEGIN;

-- =========================================================
-- Bulk FEC tables (canonical storage layer)
-- Run as: postgres (or a role that can CREATE TABLE)
-- After creation, we set OWNER to: moneytracker_user
--
-- Assumptions:
--   - public.import_runs(run_id) already exists (your tree shows it does)
--   - You are OK with "typed columns + raw jsonb + raw_line" for forward-compat
-- =========================================================

-- -----------------------------
-- cn26.txt — Candidate Master
-- -----------------------------
CREATE TABLE IF NOT EXISTS public.fec_candidate_master (
  candidate_id          text NOT NULL,
  cycle                 integer NOT NULL,
  name                  text,
  party                 text,
  office                text,
  state                 text,
  district              text,
  incumbent_challenge   text,
  status                text,
  last_updated          date,

  run_id                bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL,
  source_file           text NOT NULL DEFAULT 'cn',
  fetched_at            timestamptz NOT NULL DEFAULT now(),

  raw_line              text,
  raw                   jsonb,

  CONSTRAINT fec_candidate_master_pk PRIMARY KEY (candidate_id, cycle)
);

-- -----------------------------
-- cm26.txt — Committee Master
-- -----------------------------
CREATE TABLE IF NOT EXISTS public.fec_committee_master (
  committee_id          text NOT NULL,
  cycle                 integer NOT NULL,
  name                  text,
  committee_type        text,
  committee_designation text,
  filing_frequency      text,
  organization_type     text,
  connected_org_name    text,
  candidate_id          text,
  treasurer_name        text,
  street_1              text,
  street_2              text,
  city                  text,
  state                 text,
  zip                   text,
  last_updated          date,

  run_id                bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL,
  source_file           text NOT NULL DEFAULT 'cm',
  fetched_at            timestamptz NOT NULL DEFAULT now(),

  raw_line              text,
  raw                   jsonb,

  CONSTRAINT fec_committee_master_pk PRIMARY KEY (committee_id, cycle)
);

-- -----------------------------
-- ccl26.txt — Candidate-Committee Linkage
-- -----------------------------
CREATE TABLE IF NOT EXISTS public.fec_candidate_committee_linkage (
  candidate_id          text NOT NULL,
  committee_id          text NOT NULL,
  cycle                 integer NOT NULL,
  linkage_type          text,
  designation           text,
  date_linked           date,

  run_id                bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL,
  source_file           text NOT NULL DEFAULT 'ccl',
  fetched_at            timestamptz NOT NULL DEFAULT now(),

  raw_line              text,
  raw                   jsonb,

  CONSTRAINT fec_ccl_pk PRIMARY KEY (candidate_id, committee_id, cycle)
);

-- -----------------------------
-- weball26.txt — All Candidates
-- -----------------------------
CREATE TABLE IF NOT EXISTS public.fec_weball_candidates (
  candidate_id          text NOT NULL,
  cycle                 integer NOT NULL,
  name                  text,
  office                text,
  state                 text,
  district              text,
  party                 text,
  incumbent_challenge   text,
  status                text,

  run_id                bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL,
  source_file           text NOT NULL DEFAULT 'weball',
  fetched_at            timestamptz NOT NULL DEFAULT now(),

  raw_line              text,
  raw                   jsonb,

  CONSTRAINT fec_weball_pk PRIMARY KEY (candidate_id, cycle)
);

-- -----------------------------
-- webl26.txt — House/Senate Current Campaigns
-- -----------------------------
CREATE TABLE IF NOT EXISTS public.fec_webl_current_campaigns (
  candidate_id          text NOT NULL,
  cycle                 integer NOT NULL,
  name                  text,
  office                text,
  state                 text,
  district              text,
  party                 text,
  is_active             boolean,
  election_year         integer,

  run_id                bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL,
  source_file           text NOT NULL DEFAULT 'webl',
  fetched_at            timestamptz NOT NULL DEFAULT now(),

  raw_line              text,
  raw                   jsonb,

  CONSTRAINT fec_webl_pk PRIMARY KEY (candidate_id, cycle)
);

-- -----------------------------
-- oppexp.txt — Operating Expenditures
-- -----------------------------
CREATE TABLE IF NOT EXISTS public.fec_operating_expenditures (
  oppexp_id             bigserial PRIMARY KEY,

  cycle                 integer NOT NULL,
  committee_id          text NOT NULL,
  transaction_date      date,
  amount                numeric(14,2),

  purpose               text,
  category              text,
  recipient_name        text,
  recipient_city        text,
  recipient_state       text,
  recipient_zip         text,

  transaction_id        text,
  report_type           text,

  run_id                bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL,
  source_file           text NOT NULL DEFAULT 'oppexp',
  fetched_at            timestamptz NOT NULL DEFAULT now(),
  file_row_num          integer,

  raw_line              text,
  raw                   jsonb
);

-- -----------------------------
-- itoth.txt — Committee-to-Committee / Other committee transactions
-- -----------------------------
CREATE TABLE IF NOT EXISTS public.fec_itoth_transactions (
  itoth_id              bigserial PRIMARY KEY,

  cycle                 integer NOT NULL,
  filer_committee_id    text NOT NULL,
  other_committee_id    text,
  transaction_date      date,
  amount                numeric(14,2),

  transaction_type      text,
  transaction_desc      text,
  memo_text             text,

  transaction_id        text,
  report_type           text,

  run_id                bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL,
  source_file           text NOT NULL DEFAULT 'itoth',
  fetched_at            timestamptz NOT NULL DEFAULT now(),
  file_row_num          integer,

  raw_line              text,
  raw                   jsonb
);

-- -----------------------------
-- itpas2.txt — Committee->Candidate + Independent Expenditures (varies by cycle)
-- -----------------------------
CREATE TABLE IF NOT EXISTS public.fec_itpas2 (
  itpas2_id             bigserial PRIMARY KEY,

  cycle                 integer NOT NULL,
  filer_committee_id    text NOT NULL,
  candidate_id          text,
  payee_committee_id    text,

  transaction_date      date,
  amount                numeric(14,2),

  support_oppose        text,
  office                text,
  state                 text,
  district              text,

  purpose               text,
  memo_text             text,

  transaction_id        text,
  report_type           text,

  run_id                bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL,
  source_file           text NOT NULL DEFAULT 'itpas2',
  fetched_at            timestamptz NOT NULL DEFAULT now(),
  file_row_num          integer,

  raw_line              text,
  raw                   jsonb
);

-- -----------------------------
-- itcont.txt — Individual Contributions (you referenced it; included)
-- -----------------------------
CREATE TABLE IF NOT EXISTS public.fec_itcont_individual_contributions (
  itcont_id              bigserial PRIMARY KEY,

  cycle                  integer NOT NULL,
  recipient_committee_id text NOT NULL,
  candidate_id           text,

  contributor_name       text,
  contributor_city       text,
  contributor_state      text,
  contributor_zip        text,
  employer               text,
  occupation             text,

  transaction_date       date,
  amount                 numeric(14,2),

  transaction_id         text,
  report_type            text,
  memo_text              text,

  run_id                 bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL,
  source_file            text NOT NULL DEFAULT 'itcont',
  fetched_at             timestamptz NOT NULL DEFAULT now(),
  file_row_num           integer,

  raw_line               text,
  raw                    jsonb
);

-- =========================================================
-- App Facing Tables
-- These are simplified canonical tables for easier querying
-- and caching of common aggregations
-- =========================================================

-- -------------------------------------------------------------
-- candidates — canonical candidate info (from various FEC sources)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.candidates (
	candidate_id          text PRIMARY KEY,
	name                  text,
	office                text,
	party                 text,
	state                 text,
	district              text,
	updated_at						timestamptz NOT NULL DEFAULT now(),
	source                text,
	run_id								bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL
);

-- -------------------------------------------------------------
-- committees — canonical committee info (from various FEC sources)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.committees (
	committee_id          text PRIMARY KEY,
	name                  text,
	committee_type        text,
	committee_designation text,
	organization_type     text,
	connected_org_name    text,
	updated_at						timestamptz NOT NULL DEFAULT now(),
	source                text,
	run_id								bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL
);
-- -------------------------------------------------------------
-- candidate_committees — canonical candidate-committee linkage
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.candidate_committees (
	committee_id          text PRIMARY KEY,
	name                  text,
	committee_type        text,
	committee_designation text,
	filing_frequency			text,
	organization_type     text,
	connected_org_name		text,
	treasurer_name        text,
	city                  text,
	state                 text,
	zip                   text,
	updated_at						timestamptz NOT NULL DEFAULT now(),
	source                text,
	run_id								bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL
);

-- -------------------------------------------------------------
-- candidate_totals — cached totals per candidate per cycle
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.candidate_totals (
	candidate_id          text NOT NULL,
	cycle                 integer NOT NULL,
	coverage_end_date		  date,
	receipts              bigint DEFAULT 0,
	cash_on_hand         	bigint DEFAULT 0,
	individuals 					bigint DEFAULT 0,
	pacs                 	bigint DEFAULT 0,
	self_funding        	bigint DEFAULT 0,
	refunds_out 			 	  bigint DEFAULT 0,
	other 							  bigint DEFAULT 0,
	fetched_at						timestamptz NOT NULL DEFAULT now(),
	source                text,
	run_id								bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL,
);

-- -------------------------------------------------------------
-- committee_totals — cached totals per committee per cycle
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.committee_donor_totals (
	cycle                 integer NOT NULL,
	donor_committee_id    text NOT NULL,
	donor_name					  text,
	total_amount        	bigint DEFAULT 0,
	fetched_at						timestamptz NOT NULL DEFAULT now(),
	source                text,
	run_id								bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL,
);

-- -------------------------------------------------------------
-- candidate_receipts_monthly — cached monthly receipts per candidate per cycle
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.candidate_receipts_monthly (
	candidate_id          text NOT NULL,
	cycle                 integer NOT NULL,
	ymonth_start					date NOT NULL,
	individuals_amount   	bigint DEFAULT 0,
	pac_amount          	bigint DEFAULT 0,
	other_committee_amount	bigint DEFAULT 0,
	total_amount					bigint DEFAULT 0,
	fetched_at						timestamptz NOT NULL DEFAULT now(),
	source                text,
	run_id								bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL,
);

-- -------------------------------------------------------------
-- candidate_receipts_breakdown — cached receipts breakdown per candidate per cycle
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.candidate_receipts_breakdown (
	candidate_id          text NOT NULL,
	cycle                 integer NOT NULL,
	bucket 							  text NOT NULL,
	total_amount        	bigint DEFAULT 0,
	fetched_at						timestamptz NOT NULL DEFAULT now(),
	source                text,
	run_id								bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL,
);

-- -------------------------------------------------------------
-- candidate_pac_agg — cached PAC contributions per candidate per cycle
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.candidate_pac_agg (
	candidate_id          text NOT NULL,
	cycle                 integer NOT NULL,
	donor_committee_id		text NOT NULL,
	donor_name					  text,
	total_amount        	bigint DEFAULT 0,
	fetched_at						timestamptz NOT NULL DEFAULT now(),
	source                text,
	run_id								bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL,
);

-- -------------------------------------------------------------
-- candidate_individual_donor_agg — cached individual contributions per candidate per cycle
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.candidate_individual_donor_agg (
	candidate_id          text NOT NULL,
	cycle                 integer NOT NULL,
	donor_name					  text NOT NULL,
	donor_state					  text,
	donor_zip						  text,
	total_amount        	bigint DEFAULT 0,
	fetched_at						timestamptz NOT NULL DEFAULT now(),
	source                text,
	run_id								bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL,
);

-- -------------------------------------------------------------
-- candidate_expenditures_totals — cached expenditures totals per candidate per cycle
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.candidate_expenditures_totals (
	candidate_id          text NOT NULL,
	cycle                 integer NOT NULL,
	operating_expenditures bigint DEFAULT 0,
	fetched_at						timestamptz NOT NULL DEFAULT now(),
	source                text,
	run_id								bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL,
);

-- -------------------------------------------------------------
-- candidate_expenditures_monthly — cached monthly expenditures per candidate per cycle
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.candidate_expenditures_monthly (
	candidate_id          text NOT NULL,
	cycle                 integer NOT NULL,
	month_start					date NOT NULL,
	operating_expenditures bigint DEFAULT 0,
	total_amount					bigint DEFAULT 0,
	fetched_at						timestamptz NOT NULL DEFAULT now(),
	source                text,
	run_id								bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL,
);

-- -------------------------------------------------------------
-- candidate_expenditures_breakdown — cached expenditures breakdown per candidate per cycle
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.candidate_expenditures_breakdown (
	candidate_id          text NOT NULL,
	cycle                 integer NOT NULL,
	category              text NOT NULL,
	total_amount        	bigint DEFAULT 0,
	fetched_at						timestamptz NOT NULL DEFAULT now(),
	source                text,
	run_id								bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL,
);

-- =========================================================
-- Audit Tables
-- =========================================================

-- -------------------------------------------------------------
-- import_runs — tracks each bulk import run
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.import_runs (
	run_id                bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	started_at            timestamptz NOT NULL DEFAULT now(),
	finished_at           timestamptz,
	source 							  text,
	notes								  text,
	meta 								  jsonb
);

-- ---------------------------------------------------------
-- raw_snapshots - stores raw snapshot files for auditing
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.raw_snapshots (
	snapshot_key 			 text PRIMARY KEY,
	candidate_id 			 text,
	cycle 					   integer,
	snapshot_type 		 text,
	payload_gzip 		   bytea,
	row_count 			   integer,
	fetched_at 			   timestamptz NOT NULL DEFAULT now(),
	source 					   text,
	run_id 					   bigint REFERENCES public.import_runs(run_id) ON DELETE SET NULL
);

-- =========================================================
-- Indexes for typical chart/totals queries
-- =========================================================
CREATE INDEX IF NOT EXISTS idx_fec_cand_master_cycle       ON public.fec_candidate_master (cycle);
CREATE INDEX IF NOT EXISTS idx_fec_comm_master_cycle       ON public.fec_committee_master (cycle);
CREATE INDEX IF NOT EXISTS idx_fec_ccl_candidate           ON public.fec_candidate_committee_linkage (candidate_id, cycle);
CREATE INDEX IF NOT EXISTS idx_fec_ccl_committee           ON public.fec_candidate_committee_linkage (committee_id, cycle);

CREATE INDEX IF NOT EXISTS idx_fec_webl_office_state       ON public.fec_webl_current_campaigns (office, state, cycle);
CREATE INDEX IF NOT EXISTS idx_fec_weball_office_state     ON public.fec_weball_candidates (office, state, cycle);

CREATE INDEX IF NOT EXISTS idx_oppexp_committee_date       ON public.fec_operating_expenditures (committee_id, cycle, transaction_date);
CREATE INDEX IF NOT EXISTS idx_oppexp_amount               ON public.fec_operating_expenditures (amount);

CREATE INDEX IF NOT EXISTS idx_itoth_filer_date            ON public.fec_itoth_transactions (filer_committee_id, cycle, transaction_date);
CREATE INDEX IF NOT EXISTS idx_itoth_other                 ON public.fec_itoth_transactions (other_committee_id, cycle);

CREATE INDEX IF NOT EXISTS idx_itpas2_candidate_date       ON public.fec_itpas2 (candidate_id, cycle, transaction_date);
CREATE INDEX IF NOT EXISTS idx_itpas2_filer_date           ON public.fec_itpas2 (filer_committee_id, cycle, transaction_date);

CREATE INDEX IF NOT EXISTS idx_itcont_recipient_date       ON public.fec_itcont_individual_contributions (recipient_committee_id, cycle, transaction_date);
CREATE INDEX IF NOT EXISTS idx_itcont_amount               ON public.fec_itcont_individual_contributions (amount);


CREATE INDEX IF NOT EXISTS idx_committees_run_id					 ON public.candidate_committees (run_id);

CREATE INDEX IF NOT EXISTS idx_pac_agg_run_id							 ON public.candidate_pac_agg (run_id);
CREATE INDEX IF NOT EXISTS idx_pac_fetched 						     ON public.candidate_pac_agg (fetched_at);

CREATE INDEX IF NOT EXISTS idx_totals_fetched 						 ON public.candidate_totals (fetched_at);
CREATE INDEX IF NOT EXISTS idx_totals_run_id							 ON public.candidate_totals (run_id);

CREATE INDEX IF NOT EXISTS idx_candidates_name						 ON public.candidates (name);
CREATE INDEX IF NOT EXISTS idx_candidates_run_id					 ON public.candidates (run_id);

CREATE INDEX IF NOT EXISTS idx_committees_name						 ON public.committees (name);
CREATE INDEX IF NOT EXISTS idx_committees_run_id					 ON public.committees (run_id);

-- =========================================================
-- Ownership (per your requirement)
-- =========================================================
ALTER TABLE public.fec_candidate_master OWNER TO moneytracker_user;
ALTER TABLE public.fec_committee_master OWNER TO moneytracker_user;
ALTER TABLE public.fec_candidate_committee_linkage OWNER TO moneytracker_user;
ALTER TABLE public.fec_weball_candidates OWNER TO moneytracker_user;
ALTER TABLE public.fec_webl_current_campaigns OWNER TO moneytracker_user;

ALTER TABLE public.fec_operating_expenditures OWNER TO moneytracker_user;
ALTER SEQUENCE public.fec_operating_expenditures_oppexp_id_seq OWNER TO moneytracker_user;

ALTER TABLE public.fec_itoth_transactions OWNER TO moneytracker_user;
ALTER SEQUENCE public.fec_itoth_transactions_itoth_id_seq OWNER TO moneytracker_user;

ALTER TABLE public.fec_itpas2 OWNER TO moneytracker_user;
ALTER SEQUENCE public.fec_itpas2_itpas2_id_seq OWNER TO moneytracker_user;

ALTER TABLE public.fec_itcont_individual_contributions OWNER TO moneytracker_user;
ALTER SEQUENCE public.fec_itcont_individual_contributions_itcont_id_seq OWNER TO moneytracker_user;

ALTER TABLE public.candidates OWNER TO moneytracker_user; -- canonical candidate info
ALTER TABLE public.committees OWNER TO moneytracker_user; -- canonical committee info
ALTER TABLE public.candidate_committees OWNER TO moneytracker_user; -- canonical candidate-committee linkage
ALTER TABLE public.candidate_totals OWNER TO moneytracker_user; -- cached totals per candidate per cycle
ALTER TABLE public.committee_donor_totals OWNER TO moneytracker_user; -- cached totals per committee per cycle
ALTER TABLE public.candidate_receipts_monthly OWNER TO moneytracker_user; -- cached monthly receipts per candidate per cycle
ALTER TABLE public.candidate_receipts_breakdown OWNER TO moneytracker_user; -- cached receipts breakdown per candidate per cycle
ALTER TABLE public.candidate_pac_agg OWNER TO moneytracker_user; -- cached PAC contributions per candidate per cycle
ALTER TABLE public.candidate_individual_donor_agg OWNER TO moneytracker_user; -- cached individual contributions per candidate per cycle
ALTER TABLE public.candidate_expenditures_totals OWNER TO moneytracker_user; -- cached expenditures totals per candidate per cycle
ALTER TABLE public.candidate_expenditures_monthly OWNER TO moneytracker_user; -- cached monthly expenditures per candidate per cycle
ALTER TABLE public.candidate_expenditures_breakdown OWNER TO moneytracker_user; -- cached expenditures breakdown per candidate per cycle

COMMIT;
