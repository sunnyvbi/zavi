
create or replace function public.public_live_stats()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'tokens_total', (
      select coalesce(sum(coalesce(ar.cost_tokens, 0)), 0)::bigint
      from public.agent_runs ar
      join public.tenants t on t.id = ar.tenant_id
      where t.kind = 'real'
        and ar.status = 'success'
    ),
    'tokens_7d', (
      select coalesce(sum(coalesce(ar.cost_tokens, 0)), 0)::bigint
      from public.agent_runs ar
      join public.tenants t on t.id = ar.tenant_id
      where t.kind = 'real'
        and ar.status = 'success'
        and ar.enqueued_at >= now() - interval '7 days'
    ),
    'actions_total', (
      select
        (select count(*)
           from public.decisions d
           join public.tenants t on t.id = d.tenant_id
          where t.kind = 'real'
            and d.status = 'acted'
            and d.approved_at is not null
            and d.handler is not null)
      + (select count(*)
           from public.channel_actions ca
           join public.tenants t on t.id = ca.tenant_id
          where t.kind = 'real'
            and ca.exec_status = 'executed')
    )::bigint,
    'actions_7d', (
      select
        (select count(*)
           from public.decisions d
           join public.tenants t on t.id = d.tenant_id
          where t.kind = 'real'
            and d.status = 'acted'
            and d.approved_at is not null
            and d.handler is not null
            and d.dispatched_at >= now() - interval '7 days')
      + (select count(*)
           from public.channel_actions ca
           join public.tenants t on t.id = ca.tenant_id
          where t.kind = 'real'
            and ca.exec_status = 'executed'
            and ca.executed_at >= now() - interval '7 days')
    )::bigint,
    'as_of', now()
  );
$$;

comment on function public.public_live_stats() is
  'Platform-wide totals (tokens processed, human-approved actions carried out) for the public marketing counter. Aggregates only, kind=real tenants. service_role only.';

revoke all on function public.public_live_stats() from public, anon, authenticated;
grant execute on function public.public_live_stats() to service_role;
