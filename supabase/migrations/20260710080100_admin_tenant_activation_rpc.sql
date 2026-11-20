
create or replace function public.admin_tenant_activation(p_window_days int default 60)
returns table (
  tenant_id             uuid,
  slug                  text,
  display_name          text,
  kind                  text,
  created_at            timestamptz,
  brain_seeded          boolean,
  connectors_count      bigint,
  first_connector_at    timestamptz,
  runs                  bigint,
  first_run_at          timestamptz,
  approval_acted        boolean,
  first_acted_at        timestamptz,
  first_deliverable_at  timestamptz,
  last_active_at        timestamptz,
  activated             boolean,
  activated_at          timestamptz,
  activation_stage      text,
  stage_since           timestamptz,
  days_in_stage         numeric,
  time_to_value_hours   numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with win as (
    select (now() - make_interval(days => greatest(1, coalesce(p_window_days, 60))))::timestamptz as since
  ),
  scope as (
    select t.id, t.slug, t.display_name, t.kind, t.created_at
    from public.tenants t, win
    where t.created_at >= win.since
  ),
  brain as (
    select tenant_id, count(*) as n
    from public.memory_note where tenant_id in (select id from scope)
    group by tenant_id
  ),
  conn as (
    select tenant_id, count(*) as n, min(connected_at) as first_at
    from public.connector_metadata where tenant_id in (select id from scope)
    group by tenant_id
  ),
  runs_agg as (
    select tenant_id, count(*) as n, min(enqueued_at) as first_at, max(enqueued_at) as last_at
    from public.agent_runs where tenant_id in (select id from scope)
    group by tenant_id
  ),
  acted as (
    select tenant_id, min(emitted_at) as first_at
    from public.decisions
    where tenant_id in (select id from scope) and status <> 'proposed'
    group by tenant_id
  ),
  msgs as (
    select tenant_id, max(created_at) as last_at
    from public.agent_thread_messages where tenant_id in (select id from scope)
    group by tenant_id
  ),
  deliv as (
    select tenant_id, min(occurred_at) as first_at
    from public.activity_events
    where tenant_id in (select id from scope) and verb = 'deliverable.produced'
    group by tenant_id
  )
  select
    s.id as tenant_id,
    s.slug,
    s.display_name,
    s.kind,
    s.created_at,
    coalesce(b.n, 0) > 0 as brain_seeded,
    coalesce(c.n, 0) as connectors_count,
    c.first_at as first_connector_at,
    coalesce(r.n, 0) as runs,
    r.first_at as first_run_at,
    a.first_at is not null as approval_acted,
    a.first_at as first_acted_at,
    d.first_at as first_deliverable_at,
    greatest(r.last_at, m.last_at) as last_active_at,
    (coalesce(r.n, 0) > 0 and a.first_at is not null) as activated,
    case when coalesce(r.n, 0) > 0 and a.first_at is not null
         then greatest(r.first_at, a.first_at) end as activated_at,
    case
      when coalesce(b.n, 0) = 0 then 'needs_onboarding'
      when coalesce(c.n, 0) = 0 then 'needs_connector'
      when coalesce(r.n, 0) = 0 then 'needs_first_run'
      when a.first_at is null   then 'needs_approval'
      else 'activated'
    end as activation_stage,
    case
      when coalesce(b.n, 0) = 0 then s.created_at
      when coalesce(c.n, 0) = 0 then s.created_at
      when coalesce(r.n, 0) = 0 then coalesce(c.first_at, s.created_at)
      when a.first_at is null   then coalesce(r.first_at, s.created_at)
      else greatest(r.first_at, a.first_at)
    end as stage_since,
    round((extract(epoch from (now() -
      case
        when coalesce(b.n, 0) = 0 then s.created_at
        when coalesce(c.n, 0) = 0 then s.created_at
        when coalesce(r.n, 0) = 0 then coalesce(c.first_at, s.created_at)
        when a.first_at is null   then coalesce(r.first_at, s.created_at)
        else greatest(r.first_at, a.first_at)
      end)) / 86400.0)::numeric, 1) as days_in_stage,
    case when coalesce(r.n, 0) > 0 and a.first_at is not null
         then round((extract(epoch from (greatest(r.first_at, a.first_at) - s.created_at)) / 3600.0)::numeric, 1)
    end as time_to_value_hours
  from scope s
  left join brain b   on b.tenant_id = s.id
  left join conn c    on c.tenant_id = s.id
  left join runs_agg r on r.tenant_id = s.id
  left join acted a   on a.tenant_id = s.id
  left join msgs m    on m.tenant_id = s.id
  left join deliv d   on d.tenant_id = s.id;
$$;

comment on function public.admin_tenant_activation(int) is
  'Admin-only per-tenant activation projection (ladder: brain->connector->run->approval->activated). Cross-tenant staff read; service_role only.';

revoke execute on function public.admin_tenant_activation(int) from public, anon, authenticated;
grant execute on function public.admin_tenant_activation(int) to service_role;
