
begin;

create or replace function channel_credits_30d(p_tenant_id uuid)
returns int language sql stable security definer set search_path = public, pg_temp as $$
  with channel_runs as (
    select id from agent_runs
     where tenant_id = p_tenant_id
       and channel_slug is not null
       and trigger <> 'chat'
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

revoke all on function channel_credits_30d(uuid) from public, anon, authenticated;
grant execute on function channel_credits_30d(uuid) to service_role;

commit;
