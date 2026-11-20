
begin;

alter table public.pm_roadmap
  add column if not exists baseline_query text
    check (
      baseline_query is null
      or baseline_query in (
        'query_funnel_by_geo_category',
        'query_recent_transactions',
        'query_active_supply_by_geo_category'
      )
    ),
  add column if not exists baseline_value numeric;

comment on column public.pm_roadmap.baseline_query is
  'P1-3: the named operator_db aggregate read anchored at dispatch (one of query_funnel_by_geo_category / query_recent_transactions / query_active_supply_by_geo_category). NULL = no operator_db metric anchored; row keeps the signature-only outcome loop.';
comment on column public.pm_roadmap.baseline_value is
  'P1-3: comparable baseline scalar (sum of the named query primary metric across segments) captured at dispatch. The recurrence pass re-runs baseline_query and reports moved/flat vs this value. NULL = not captured.';

commit;
