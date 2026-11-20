
begin;

create table if not exists public.ad_budget_snapshots (
  budget_id           uuid primary key references public.ad_budgets(id) on delete cascade,
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  month_start         date not null check (month_start = date_trunc('month', month_start)::date),
  generation          bigint not null default 1 check (generation >= 1),
  computed_at         timestamptz not null default now(),
  read_started_at     timestamptz not null,
  totals              jsonb not null check (jsonb_typeof(totals) = 'object'),
  objects             jsonb not null check (jsonb_typeof(objects) = 'array'),
  complete_platforms  text[] not null default '{}',
  unread_platforms    text[] not null default '{}',
  reflected_hold_ids  uuid[] not null default '{}',
  memory              jsonb not null default '{}'::jsonb check (jsonb_typeof(memory) = 'object')
);
create index if not exists ad_budget_snapshots_tenant on public.ad_budget_snapshots (tenant_id);

alter table public.ad_budget_snapshots enable row level security;
revoke all on public.ad_budget_snapshots from public, anon, authenticated;
revoke all on public.ad_budget_snapshots from service_role;
grant select on public.ad_budget_snapshots to service_role;

create table if not exists public.ad_budget_shadow_verdicts (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants(id) on delete cascade,
  budget_id                uuid not null references public.ad_budgets(id) on delete cascade,
  idem_key                 text not null check (char_length(idem_key) between 1 and 200),
  platform                 text not null check (char_length(platform) between 1 and 32),
  op                       text not null check (op in ('raise', 'resume', 'create')),
  object_id                text check (object_id is null or char_length(object_id) <= 64),
  daily_delta_usd          numeric(12,2) not null check (daily_delta_usd >= 0),
  real_verdict             text not null check (real_verdict in ('held', 'already_held', 'refused')),
  real_reason              text check (real_reason is null or char_length(real_reason) <= 64),
  real_amount_usd          numeric(14,2),
  real_room_usd            numeric(14,2),
  shadow_verdict           text not null check (shadow_verdict in ('would_allow', 'would_refuse', 'no_snapshot')),
  shadow_note              text check (shadow_note is null or char_length(shadow_note) <= 200),
  shadow_change_usd        numeric(14,2),
  shadow_open_auth_usd     numeric(14,2),
  shadow_expected_room_usd numeric(14,2),
  shadow_ceiling_room_usd  numeric(14,2),
  snapshot_generation      bigint,
  snapshot_age_s           integer,
  created_at               timestamptz not null default now()
);
create index if not exists ad_budget_shadow_verdicts_recent
  on public.ad_budget_shadow_verdicts (tenant_id, created_at desc);

alter table public.ad_budget_shadow_verdicts enable row level security;
revoke all on public.ad_budget_shadow_verdicts from public, anon, authenticated;
revoke all on public.ad_budget_shadow_verdicts from service_role;
grant select on public.ad_budget_shadow_verdicts to service_role;

create or replace function public.record_ad_budget_snapshot(
  p_tenant_id          uuid,
  p_budget_id          uuid,
  p_month_start        date,
  p_read_started_at    timestamptz,
  p_totals             jsonb,
  p_objects            jsonb,
  p_complete_platforms text[],
  p_unread_platforms   text[],
  p_reflected_hold_ids uuid[],
  p_memory             jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_generation bigint;
begin
  if p_tenant_id is null or p_budget_id is null or p_month_start is null or p_read_started_at is null then
    raise exception 'record_ad_budget_snapshot: tenant, budget, month and read start are required' using errcode = '22023';
  end if;
  if p_month_start <> date_trunc('month', p_month_start)::date then
    raise exception 'record_ad_budget_snapshot: month_start must be the first of a month' using errcode = '22023';
  end if;
  if p_read_started_at > now() + interval '5 minutes' then
    raise exception 'record_ad_budget_snapshot: read start is in the future' using errcode = '22023';
  end if;
  if p_totals is null or jsonb_typeof(p_totals) <> 'object' or octet_length(p_totals::text) > 16384
     or p_objects is null or jsonb_typeof(p_objects) <> 'array' or octet_length(p_objects::text) > 4194304 then
    raise exception 'record_ad_budget_snapshot: totals or objects are missing or too large' using errcode = '22023';
  end if;
  if p_memory is null or jsonb_typeof(p_memory) <> 'object' or octet_length(p_memory::text) > 4194304 then
    raise exception 'record_ad_budget_snapshot: memory is missing or too large' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_complete_platforms), 0) > 64 or coalesce(cardinality(p_unread_platforms), 0) > 64
     or coalesce(cardinality(p_reflected_hold_ids), 0) > 20000 then
    raise exception 'record_ad_budget_snapshot: list too long' using errcode = '22023';
  end if;
  if not exists (select 1 from ad_budgets where id = p_budget_id and tenant_id = p_tenant_id) then
    raise exception 'record_ad_budget_snapshot: budget not found for tenant' using errcode = '22023';
  end if;

  insert into ad_budget_snapshots as s
    (budget_id, tenant_id, month_start, generation, computed_at, read_started_at, totals, objects,
     complete_platforms, unread_platforms, reflected_hold_ids, memory)
  values
    (p_budget_id, p_tenant_id, p_month_start, 1, now(), p_read_started_at, p_totals, p_objects,
     coalesce(p_complete_platforms, '{}'), coalesce(p_unread_platforms, '{}'), coalesce(p_reflected_hold_ids, '{}'), p_memory)
  on conflict (budget_id) do update
     set month_start = excluded.month_start,
         generation = s.generation + 1,
         computed_at = now(),
         read_started_at = excluded.read_started_at,
         totals = excluded.totals,
         objects = excluded.objects,
         complete_platforms = excluded.complete_platforms,
         unread_platforms = excluded.unread_platforms,
         reflected_hold_ids = excluded.reflected_hold_ids,
         memory = excluded.memory
   where s.tenant_id = p_tenant_id and s.read_started_at <= excluded.read_started_at
  returning s.generation into v_generation;

  if v_generation is null then
    return jsonb_build_object('status', 'stale', 'generation', null);
  end if;
  return jsonb_build_object('status', 'stored', 'generation', v_generation);
end $$;

revoke all on function public.record_ad_budget_snapshot(uuid, uuid, date, timestamptz, jsonb, jsonb, text[], text[], uuid[], jsonb)
  from public, anon, authenticated;
grant execute on function public.record_ad_budget_snapshot(uuid, uuid, date, timestamptz, jsonb, jsonb, text[], text[], uuid[], jsonb)
  to service_role;

create or replace function public.ad_budget_shadow_context(p_tenant_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_view     jsonb;
  v_budget   uuid;
  v_snapshot jsonb;
  v_holds    jsonb;
  v_n        integer;
begin
  if p_tenant_id is null then
    raise exception 'ad_budget_shadow_context: tenant is required' using errcode = '22023';
  end if;
  v_view := ad_budget_month_view(p_tenant_id);
  if v_view is null then
    return jsonb_build_object('view', null, 'snapshot', null, 'open_holds', '[]'::jsonb, 'open_holds_truncated', false);
  end if;
  v_budget := (v_view->>'id')::uuid;

  select jsonb_build_object(
           'budget_id', s.budget_id, 'month_start', s.month_start, 'generation', s.generation,
           'computed_at', s.computed_at, 'read_started_at', s.read_started_at, 'totals', s.totals,
           'complete_platforms', to_jsonb(s.complete_platforms), 'unread_platforms', to_jsonb(s.unread_platforms),
           'reflected_hold_ids', to_jsonb(s.reflected_hold_ids))
    into v_snapshot
    from ad_budget_snapshots s
   where s.budget_id = v_budget and s.tenant_id = p_tenant_id;

  select count(*) into v_n from ad_budget_reservations r
   where r.budget_id = v_budget and r.tenant_id = p_tenant_id and r.status in ('reserved', 'committed');
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', h.id, 'idem_key', h.idem_key, 'platform', h.platform, 'object_id', h.object_id,
           'status', h.status, 'paused', h.paused, 'daily_delta_usd', h.daily_delta_usd,
           'created_at', h.created_at, 'updated_at', h.updated_at)), '[]'::jsonb)
    into v_holds
    from (select r.* from ad_budget_reservations r
           where r.budget_id = v_budget and r.tenant_id = p_tenant_id and r.status in ('reserved', 'committed')
           order by r.id
           limit 5000) h;

  return jsonb_build_object('view', v_view, 'snapshot', v_snapshot, 'open_holds', v_holds,
                            'open_holds_truncated', v_n > 5000);
end $$;

revoke all on function public.ad_budget_shadow_context(uuid) from public, anon, authenticated;
grant execute on function public.ad_budget_shadow_context(uuid) to service_role;

create or replace function public.record_ad_budget_shadow_verdict(
  p_tenant_id uuid,
  p_row       jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if p_tenant_id is null or p_row is null or jsonb_typeof(p_row) <> 'object' or octet_length(p_row::text) > 8192 then
    raise exception 'record_ad_budget_shadow_verdict: tenant and a row are required' using errcode = '22023';
  end if;
  if not exists (
    select 1 from ad_budgets where id = (p_row->>'budget_id')::uuid and tenant_id = p_tenant_id
  ) then
    raise exception 'record_ad_budget_shadow_verdict: budget not found for tenant' using errcode = '22023';
  end if;

  insert into ad_budget_shadow_verdicts
    (tenant_id, budget_id, idem_key, platform, op, object_id, daily_delta_usd,
     real_verdict, real_reason, real_amount_usd, real_room_usd,
     shadow_verdict, shadow_note, shadow_change_usd, shadow_open_auth_usd,
     shadow_expected_room_usd, shadow_ceiling_room_usd, snapshot_generation, snapshot_age_s)
  values
    (p_tenant_id, (p_row->>'budget_id')::uuid, p_row->>'idem_key', p_row->>'platform', p_row->>'op',
     nullif(p_row->>'object_id', ''), round((p_row->>'daily_delta_usd')::numeric, 2),
     p_row->>'real_verdict', left(p_row->>'real_reason', 64),
     round((p_row->>'real_amount_usd')::numeric, 2), round((p_row->>'real_room_usd')::numeric, 2),
     p_row->>'shadow_verdict', left(p_row->>'shadow_note', 200),
     round((p_row->>'shadow_change_usd')::numeric, 2), round((p_row->>'shadow_open_auth_usd')::numeric, 2),
     round((p_row->>'shadow_expected_room_usd')::numeric, 2), round((p_row->>'shadow_ceiling_room_usd')::numeric, 2),
     (p_row->>'snapshot_generation')::bigint, (p_row->>'snapshot_age_s')::integer)
  returning id into v_id;

  return jsonb_build_object('status', 'recorded', 'id', v_id);
end $$;

revoke all on function public.record_ad_budget_shadow_verdict(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_ad_budget_shadow_verdict(uuid, jsonb) to service_role;

commit;
