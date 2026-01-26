CREATE OR REPLACE FUNCTION public.refresh_aggregates(p_run_id bigint, p_cycle int)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.import_runs r WHERE r.run_id = p_run_id) THEN
    RAISE EXCEPTION 'import_runs.run_id % does not exist', p_run_id;
  END IF;

  -- =========================================================
  -- 1) candidates (priority: cn > webl > weball)
  -- =========================================================
  INSERT INTO public.candidates
    (candidate_id, name, office, party, state, district, updated_at, source, run_id)
  SELECT
    z.candidate_id,
    z.name,
    z.office,
    z.party,
    z.state,
    z.district,
    now(),
    z.source,
    p_run_id
  FROM (
    SELECT DISTINCT ON (candidate_id)
      candidate_id, name, office, party, state, district, source
    FROM (
      SELECT
        c.candidate_id,
        c.name,
        CASE
          WHEN upper(c.office) = 'H' THEN 'house'
          WHEN upper(c.office) = 'S' THEN 'senate'
          WHEN upper(c.office) = 'P' THEN 'president'
          ELSE c.office
        END AS office,
        c.party,
        c.state,
        NULLIF(lpad(COALESCE(c.district,''), 2, '0'), '') AS district,
        'fec_candidate_master'::text AS source,
        1 AS pr
      FROM public.fec_candidate_master c
      WHERE c.cycle = p_cycle

      UNION ALL
      SELECT
        w.candidate_id,
        w.name,
        w.office,
        w.party,
        w.state,
        NULLIF(lpad(COALESCE(w.district,''), 2, '0'), '') AS district,
        'fec_webl'::text AS source,
        2 AS pr
      FROM public.fec_webl_current_campaigns w
      WHERE w.cycle = p_cycle

      UNION ALL
      SELECT
        a.candidate_id,
        a.name,
        a.office,
        a.party,
        a.state,
        NULLIF(lpad(COALESCE(a.district,''), 2, '0'), '') AS district,
        'fec_weball'::text AS source,
        3 AS pr
      FROM public.fec_weball_candidates a
      WHERE a.cycle = p_cycle
    ) s
    ORDER BY candidate_id, pr ASC
  ) z
  ON CONFLICT (candidate_id)
  DO UPDATE SET
    name       = COALESCE(EXCLUDED.name, public.candidates.name),
    office     = COALESCE(EXCLUDED.office, public.candidates.office),
    party      = COALESCE(EXCLUDED.party, public.candidates.party),
    state      = COALESCE(EXCLUDED.state, public.candidates.state),
    district   = COALESCE(EXCLUDED.district, public.candidates.district),
    updated_at = EXCLUDED.updated_at,
    source     = EXCLUDED.source,
    run_id     = EXCLUDED.run_id;

  -- =========================================================
  -- 2) candidate_committees
  -- =========================================================
  INSERT INTO public.candidate_committees
    (candidate_id, cycle, committee_id, designation, fetched_at, source, run_id)
  SELECT
    ccl.candidate_id,
    ccl.cycle,
    ccl.committee_id,
    COALESCE(ccl.designation, ccl.linkage_type),
    now(),
    'fec_bulk',
    p_run_id
  FROM public.fec_candidate_committee_linkage ccl
  WHERE ccl.cycle = p_cycle
  ON CONFLICT (candidate_id, cycle, committee_id)
  DO UPDATE SET
    designation = EXCLUDED.designation,
    fetched_at  = EXCLUDED.fetched_at,
    source      = EXCLUDED.source,
    run_id      = EXCLUDED.run_id;

  -- =========================================================
  -- 3) candidate_pac_agg (donor name comes from committee master)
  -- =========================================================
  INSERT INTO public.candidate_pac_agg
    (candidate_id, cycle, donor_committee_id, donor_name, total_amount, fetched_at, source, run_id)
  SELECT
    i.candidate_id,
    i.cycle,
    i.filer_committee_id AS donor_committee_id,
    cm.name AS donor_name,
    COALESCE(SUM(i.amount), 0)::numeric(14,2)::bigint AS total_amount,
    now(),
    'fec_bulk',
    p_run_id
  FROM public.fec_itpas2 i
  LEFT JOIN public.fec_committee_master cm
    ON cm.committee_id = i.filer_committee_id
   AND cm.cycle = i.cycle
  WHERE i.cycle = p_cycle
    AND i.candidate_id IS NOT NULL
  GROUP BY i.candidate_id, i.cycle, i.filer_committee_id, cm.name
  ON CONFLICT (candidate_id, cycle, donor_committee_id)
  DO UPDATE SET
    donor_name   = EXCLUDED.donor_name,
    total_amount = EXCLUDED.total_amount,
    fetched_at   = EXCLUDED.fetched_at,
    source       = EXCLUDED.source,
    run_id       = EXCLUDED.run_id;

  -- =========================================================
  -- 4) candidate_totals (receipts = individuals + pacs; itoth goes to other)
  -- =========================================================
  WITH
  indiv AS (
    SELECT
      l.candidate_id,
      c.cycle,
      COALESCE(SUM(c.amount), 0)::numeric(14,2)::bigint AS individuals
    FROM public.fec_itcont_individual_contributions c
    JOIN public.fec_candidate_committee_linkage l
      ON l.committee_id = c.recipient_committee_id
     AND l.cycle = c.cycle
    WHERE c.cycle = p_cycle
    GROUP BY l.candidate_id, c.cycle
  ),
  pacs AS (
    SELECT
      i.candidate_id,
      i.cycle,
      COALESCE(SUM(i.amount), 0)::numeric(14,2)::bigint AS pacs
    FROM public.fec_itpas2 i
    WHERE i.cycle = p_cycle
      AND i.candidate_id IS NOT NULL
    GROUP BY i.candidate_id, i.cycle
  ),
  itoth_other AS (
    SELECT
      l.candidate_id,
      t.cycle,
      COALESCE(SUM(t.amount), 0)::numeric(14,2)::bigint AS other
    FROM public.fec_itoth_transactions t
    JOIN public.fec_candidate_committee_linkage l
      ON l.committee_id = t.filer_committee_id
     AND l.cycle = t.cycle
    WHERE t.cycle = p_cycle
    GROUP BY l.candidate_id, t.cycle
  ),
  merged AS (
    SELECT
      COALESCE(indiv.candidate_id, pacs.candidate_id, itoth_other.candidate_id) AS candidate_id,
      COALESCE(indiv.cycle, pacs.cycle, itoth_other.cycle) AS cycle,
      COALESCE(indiv.individuals, 0)::bigint AS individuals,
      COALESCE(pacs.pacs, 0)::bigint AS pacs,
      COALESCE(itoth_other.other, 0)::bigint AS other
    FROM indiv
    FULL OUTER JOIN pacs
      ON pacs.candidate_id = indiv.candidate_id
     AND pacs.cycle = indiv.cycle
    FULL OUTER JOIN itoth_other
      ON itoth_other.candidate_id = COALESCE(indiv.candidate_id, pacs.candidate_id)
     AND itoth_other.cycle = COALESCE(indiv.cycle, pacs.cycle)
  )
  INSERT INTO public.candidate_totals
    (candidate_id, cycle, coverage_end_date, receipts, cash_on_hand,
     individuals, pacs, self_funding, transfers, refunds_out, other,
     fetched_at, source, run_id)
  SELECT
    m.candidate_id,
    m.cycle,
    NULL::date,
    (m.individuals + m.pacs)::bigint,
    0::bigint,
    m.individuals,
    m.pacs,
    0::bigint,
    0::bigint,
    0::bigint,
    m.other,
    now(),
    'fec_bulk',
    p_run_id
  FROM merged m
  ON CONFLICT (candidate_id, cycle)
  DO UPDATE SET
    coverage_end_date = EXCLUDED.coverage_end_date,
    receipts          = EXCLUDED.receipts,
    cash_on_hand      = EXCLUDED.cash_on_hand,
    individuals       = EXCLUDED.individuals,
    pacs              = EXCLUDED.pacs,
    self_funding      = EXCLUDED.self_funding,
    transfers         = EXCLUDED.transfers,
    refunds_out       = EXCLUDED.refunds_out,
    other             = EXCLUDED.other,
    fetched_at        = EXCLUDED.fetched_at,
    source            = EXCLUDED.source,
    run_id            = EXCLUDED.run_id;

  -- =========================================================
  -- 5) candidate_receipt_breakdown
  -- =========================================================
  INSERT INTO public.candidate_receipt_breakdown
    (candidate_id, cycle, bucket, total_amount, fetched_at, source, run_id)
  SELECT t.candidate_id, t.cycle, t.bucket, t.total_amount, now(), 'fec_bulk', p_run_id
  FROM (
    SELECT candidate_id, cycle, 'individuals'::text AS bucket, individuals::bigint AS total_amount
      FROM public.candidate_totals WHERE cycle = p_cycle
    UNION ALL
    SELECT candidate_id, cycle, 'pacs'::text, pacs::bigint
      FROM public.candidate_totals WHERE cycle = p_cycle
    UNION ALL
    SELECT candidate_id, cycle, 'other_committees'::text, other::bigint
      FROM public.candidate_totals WHERE cycle = p_cycle
    UNION ALL
    SELECT candidate_id, cycle, 'total_receipts'::text, receipts::bigint
      FROM public.candidate_totals WHERE cycle = p_cycle
  ) t
  ON CONFLICT (candidate_id, cycle, bucket)
  DO UPDATE SET
    total_amount = EXCLUDED.total_amount,
    fetched_at   = EXCLUDED.fetched_at,
    source       = EXCLUDED.source,
    run_id       = EXCLUDED.run_id;

  -- =========================================================
  -- 6) candidate_receipts_monthly
  -- =========================================================
  WITH
  indiv_m AS (
    SELECT
      l.candidate_id,
      c.cycle,
      date_trunc('month', c.transaction_date)::date AS month_start,
      COALESCE(SUM(c.amount), 0)::numeric(14,2)::bigint AS individuals_amount
    FROM public.fec_itcont_individual_contributions c
    JOIN public.fec_candidate_committee_linkage l
      ON l.committee_id = c.recipient_committee_id
     AND l.cycle = c.cycle
    WHERE c.cycle = p_cycle
      AND c.transaction_date IS NOT NULL
    GROUP BY l.candidate_id, c.cycle, date_trunc('month', c.transaction_date)::date
  ),
  pac_m AS (
    SELECT
      i.candidate_id,
      i.cycle,
      date_trunc('month', i.transaction_date)::date AS month_start,
      COALESCE(SUM(i.amount), 0)::numeric(14,2)::bigint AS pac_amount
    FROM public.fec_itpas2 i
    WHERE i.cycle = p_cycle
      AND i.candidate_id IS NOT NULL
      AND i.transaction_date IS NOT NULL
    GROUP BY i.candidate_id, i.cycle, date_trunc('month', i.transaction_date)::date
  ),
  other_m AS (
    SELECT
      l.candidate_id,
      t.cycle,
      date_trunc('month', t.transaction_date)::date AS month_start,
      COALESCE(SUM(t.amount), 0)::numeric(14,2)::bigint AS other_committee_amount
    FROM public.fec_itoth_transactions t
    JOIN public.fec_candidate_committee_linkage l
      ON l.committee_id = t.filer_committee_id
     AND l.cycle = t.cycle
    WHERE t.cycle = p_cycle
      AND t.transaction_date IS NOT NULL
    GROUP BY l.candidate_id, t.cycle, date_trunc('month', t.transaction_date)::date
  ),
  merged_m AS (
    SELECT
      COALESCE(indiv_m.candidate_id, pac_m.candidate_id, other_m.candidate_id) AS candidate_id,
      COALESCE(indiv_m.cycle, pac_m.cycle, other_m.cycle) AS cycle,
      COALESCE(indiv_m.month_start, pac_m.month_start, other_m.month_start) AS month_start,
      COALESCE(indiv_m.individuals_amount, 0)::bigint AS individuals_amount,
      COALESCE(pac_m.pac_amount, 0)::bigint AS pac_amount,
      COALESCE(other_m.other_committee_amount, 0)::bigint AS other_committee_amount
    FROM indiv_m
    FULL OUTER JOIN pac_m
      ON pac_m.candidate_id = indiv_m.candidate_id
     AND pac_m.cycle = indiv_m.cycle
     AND pac_m.month_start = indiv_m.month_start
    FULL OUTER JOIN other_m
      ON other_m.candidate_id = COALESCE(indiv_m.candidate_id, pac_m.candidate_id)
     AND other_m.cycle = COALESCE(indiv_m.cycle, pac_m.cycle)
     AND other_m.month_start = COALESCE(indiv_m.month_start, pac_m.month_start)
  )
  INSERT INTO public.candidate_receipts_monthly
    (candidate_id, cycle, month_start, individuals_amount, pac_amount, other_committee_amount, total_amount,
     fetched_at, source, run_id)
  SELECT
    m.candidate_id,
    m.cycle,
    m.month_start,
    m.individuals_amount,
    m.pac_amount,
    m.other_committee_amount,
    (m.individuals_amount + m.pac_amount + m.other_committee_amount)::bigint,
    now(),
    'fec_bulk',
    p_run_id
  FROM merged_m m
  WHERE m.month_start IS NOT NULL
  ON CONFLICT (candidate_id, cycle, month_start)
  DO UPDATE SET
    individuals_amount     = EXCLUDED.individuals_amount,
    pac_amount             = EXCLUDED.pac_amount,
    other_committee_amount = EXCLUDED.other_committee_amount,
    total_amount           = EXCLUDED.total_amount,
    fetched_at             = EXCLUDED.fetched_at,
    source                 = EXCLUDED.source,
    run_id                 = EXCLUDED.run_id;

  -- =========================================================
  -- 7) Expenditures totals + monthly + breakdown
  -- =========================================================
  INSERT INTO public.candidate_expenditures_totals
    (candidate_id, cycle, operating_expenditures, total_expenditures, fetched_at, source, run_id)
  SELECT
    l.candidate_id,
    o.cycle,
    COALESCE(SUM(o.amount), 0)::numeric(14,2)::bigint,
    COALESCE(SUM(o.amount), 0)::numeric(14,2)::bigint,
    now(),
    'fec_bulk',
    p_run_id
  FROM public.fec_operating_expenditures o
  JOIN public.fec_candidate_committee_linkage l
    ON l.committee_id = o.committee_id
   AND l.cycle = o.cycle
  WHERE o.cycle = p_cycle
  GROUP BY l.candidate_id, o.cycle
  ON CONFLICT (candidate_id, cycle)
  DO UPDATE SET
    operating_expenditures = EXCLUDED.operating_expenditures,
    total_expenditures     = EXCLUDED.total_expenditures,
    fetched_at             = EXCLUDED.fetched_at,
    source                 = EXCLUDED.source,
    run_id                 = EXCLUDED.run_id;

  INSERT INTO public.candidate_expenditures_monthly
    (candidate_id, cycle, month_start, operating_expenditures_amount, total_amount, fetched_at, source, run_id)
  SELECT
    l.candidate_id,
    o.cycle,
    date_trunc('month', o.transaction_date)::date,
    COALESCE(SUM(o.amount), 0)::numeric(14,2)::bigint,
    COALESCE(SUM(o.amount), 0)::numeric(14,2)::bigint,
    now(),
    'fec_bulk',
    p_run_id
  FROM public.fec_operating_expenditures o
  JOIN public.fec_candidate_committee_linkage l
    ON l.committee_id = o.committee_id
   AND l.cycle = o.cycle
  WHERE o.cycle = p_cycle
    AND o.transaction_date IS NOT NULL
  GROUP BY l.candidate_id, o.cycle, date_trunc('month', o.transaction_date)::date
  ON CONFLICT (candidate_id, cycle, month_start)
  DO UPDATE SET
    operating_expenditures_amount = EXCLUDED.operating_expenditures_amount,
    total_amount                  = EXCLUDED.total_amount,
    fetched_at                    = EXCLUDED.fetched_at,
    source                        = EXCLUDED.source,
    run_id                        = EXCLUDED.run_id;

  INSERT INTO public.candidate_expenditure_breakdown
    (candidate_id, cycle, category, total_amount, fetched_at, source, run_id)
  SELECT
    l.candidate_id,
    o.cycle,
    COALESCE(NULLIF(o.category,''), NULLIF(o.purpose,''), 'UNKNOWN') AS category,
    COALESCE(SUM(o.amount), 0)::numeric(14,2)::bigint,
    now(),
    'fec_bulk',
    p_run_id
  FROM public.fec_operating_expenditures o
  JOIN public.fec_candidate_committee_linkage l
    ON l.committee_id = o.committee_id
   AND l.cycle = o.cycle
  WHERE o.cycle = p_cycle
  GROUP BY l.candidate_id, o.cycle, COALESCE(NULLIF(o.category,''), NULLIF(o.purpose,''), 'UNKNOWN')
  ON CONFLICT (candidate_id, cycle, category)
  DO UPDATE SET
    total_amount = EXCLUDED.total_amount,
    fetched_at   = EXCLUDED.fetched_at,
    source       = EXCLUDED.source,
    run_id       = EXCLUDED.run_id;

  -- =========================================================
  -- 8) Candidate individual donors (top donors per candidate)
  -- =========================================================
  INSERT INTO public.candidate_individual_donor_agg
    (candidate_id, cycle, donor_name, donor_state, donor_zip, total_amount, fetched_at, source, run_id)
  SELECT
    l.candidate_id,
    c.cycle,
    COALESCE(NULLIF(c.contributor_name,''), 'UNKNOWN') AS donor_name,
    NULLIF(c.contributor_state,'') AS donor_state,
    NULLIF(c.contributor_zip,'') AS donor_zip,
    COALESCE(SUM(c.amount), 0)::numeric(14,2)::bigint AS total_amount,
    now(),
    'fec_bulk',
    p_run_id
  FROM public.fec_itcont_individual_contributions c
  JOIN public.fec_candidate_committee_linkage l
    ON l.committee_id = c.recipient_committee_id
   AND l.cycle = c.cycle
  WHERE c.cycle = p_cycle
  GROUP BY l.candidate_id, c.cycle,
           COALESCE(NULLIF(c.contributor_name,''), 'UNKNOWN'),
           NULLIF(c.contributor_state,''),
           NULLIF(c.contributor_zip,'')
  ON CONFLICT (candidate_id, cycle, donor_name, donor_state, donor_zip)
  DO UPDATE SET
    total_amount = EXCLUDED.total_amount,
    fetched_at   = EXCLUDED.fetched_at,
    source       = EXCLUDED.source,
    run_id       = EXCLUDED.run_id;

  -- =========================================================
  -- 9) Global committee donors
  -- =========================================================
  INSERT INTO public.committee_donor_totals
    (cycle, donor_committee_id, donor_name, total_amount, fetched_at, source, run_id)
  SELECT
    i.cycle,
    i.filer_committee_id,
    cm.name,
    COALESCE(SUM(i.amount), 0)::numeric(14,2)::bigint,
    now(),
    'fec_bulk',
    p_run_id
  FROM public.fec_itpas2 i
  LEFT JOIN public.fec_committee_master cm
    ON cm.committee_id = i.filer_committee_id
   AND cm.cycle = i.cycle
  WHERE i.cycle = p_cycle
  GROUP BY i.cycle, i.filer_committee_id, cm.name
  ON CONFLICT (cycle, donor_committee_id)
  DO UPDATE SET
    donor_name   = EXCLUDED.donor_name,
    total_amount = EXCLUDED.total_amount,
    fetched_at   = EXCLUDED.fetched_at,
    source       = EXCLUDED.source,
    run_id       = EXCLUDED.run_id;

  -- =========================================================
  -- 10) Global individual donors
  -- =========================================================
  INSERT INTO public.individual_donor_totals
    (cycle, donor_name, donor_state, donor_zip, total_amount, fetched_at, source, run_id)
  SELECT
    c.cycle,
    COALESCE(NULLIF(c.contributor_name,''), 'UNKNOWN'),
    NULLIF(c.contributor_state,''),
    NULLIF(c.contributor_zip,''),
    COALESCE(SUM(c.amount), 0)::numeric(14,2)::bigint,
    now(),
    'fec_bulk',
    p_run_id
  FROM public.fec_itcont_individual_contributions c
  WHERE c.cycle = p_cycle
  GROUP BY c.cycle,
           COALESCE(NULLIF(c.contributor_name,''), 'UNKNOWN'),
           NULLIF(c.contributor_state,''),
           NULLIF(c.contributor_zip,'')
  ON CONFLICT (cycle, donor_name, donor_state, donor_zip)
  DO UPDATE SET
    total_amount = EXCLUDED.total_amount,
    fetched_at   = EXCLUDED.fetched_at,
    source       = EXCLUDED.source,
    run_id       = EXCLUDED.run_id;

END;
$$;

ALTER FUNCTION public.refresh_aggregates(bigint, int) OWNER TO moneytracker_user;
GRANT EXECUTE ON FUNCTION public.refresh_aggregates(bigint, int) TO moneytracker_importer;
