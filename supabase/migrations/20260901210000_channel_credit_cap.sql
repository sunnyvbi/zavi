
begin;

create or replace function channel_credits_30d(p_tenant_id uuid)
returns int language sql stable security definer set search_path = public, pg_temp as $$
  with channel_runs as (
    select id from agent_runs
     where tenant_id = p_tenant_id
       and channel_slug is not null
       and enqueued_at >= now() - interval '30 days'
  ),
  settled as (
    select l.run_id, sum(l.amount) as amt
      from tenant_credit_ledger l
      join channel_runs r on r.id = l.run_id
     where l.tenant_id = p_tenant_id and l.kind = 'settle'
     group by l.run_id
  ),
  refunded as (
    select l.run_id, sum(l.amount) as amt
      from tenant_credit_ledger l
      join channel_runs r on r.id = l.run_id
     where l.tenant_id = p_tenant_id and l.kind = 'refund'
     group by l.run_id
  ),
  outstanding as (
    select l.run_id, sum(l.amount) as amt
      from tenant_credit_ledger l
      join channel_runs r on r.id = l.run_id
      left join settled s on s.run_id = l.run_id
     where l.tenant_id = p_tenant_id and l.kind = 'reserve' and s.run_id is null
     group by l.run_id
  )
  select greatest(
    0,
    coalesce((select sum(amt) from settled), 0)
    + coalesce((select sum(amt) from outstanding), 0)
    - coalesce((select sum(amt) from refunded), 0)
  )::int;
$$;

create or replace function channel_credit_cap()
returns int language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    nullif((select blob->>'channel_credit_cap_30d' from system_config where id = 1), '')::int,
    2000
  );
$$;

create or replace function channel_budget_allows(p_tenant_id uuid, p_estimate int)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select (channel_credits_30d(p_tenant_id) + greatest(coalesce(p_estimate, 0), 0))
         <= channel_credit_cap();
$$;

revoke all on function channel_credits_30d(uuid)          from public, anon, authenticated;
revoke all on function channel_credit_cap()               from public, anon, authenticated;
revoke all on function channel_budget_allows(uuid, int)   from public, anon, authenticated;
grant execute on function channel_credits_30d(uuid)        to service_role;
grant execute on function channel_credit_cap()             to service_role;
grant execute on function channel_budget_allows(uuid, int) to service_role;

commit;

do $$
begin
  raise notice '20260901210000: channel credit cap (ledger-derived, settle + outstanding reserves - refunds; default 2000/30d via system_config.channel_credit_cap_30d)';
end $$;
