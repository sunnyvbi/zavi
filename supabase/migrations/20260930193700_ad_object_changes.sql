
begin;

create table if not exists public.ad_object_changes (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  platform         text not null check (platform in ('meta', 'google')),
  object_id        text not null check (char_length(object_id) between 1 and 64),
  level            text check (level is null or level in ('ad_set', 'campaign')),
  campaign_id      text check (campaign_id is null or char_length(campaign_id) <= 64),
  object_name      text check (object_name is null or char_length(object_name) <= 500),
  source           text not null check (source in ('zavi', 'outside')),
  action_table     text check (action_table is null or action_table in ('channel_actions', 'decisions', 'budget_stop')),
  action_id        uuid,
  change_kind      text not null check (change_kind in ('status', 'budget')),
  before_status    text check (before_status is null or char_length(before_status) <= 64),
  after_status     text check (after_status is null or char_length(after_status) <= 64),
  before_daily_usd numeric(12,2) check (before_daily_usd is null or before_daily_usd >= 0),
  after_daily_usd  numeric(12,2) check (after_daily_usd is null or after_daily_usd >= 0),
  occurred_at      timestamptz not null default now(),
  check ((source = 'zavi') = (action_table is not null)),
  check (action_table is null or action_table = 'budget_stop' or action_id is not null),
  unique (tenant_id, action_table, action_id, object_id, change_kind)
);
create index if not exists ad_object_changes_object
  on public.ad_object_changes (tenant_id, platform, object_id, occurred_at desc);
create index if not exists ad_object_changes_recent
  on public.ad_object_changes (tenant_id, occurred_at desc);

alter table public.ad_object_changes enable row level security;

create policy ad_object_changes_member_select on public.ad_object_changes
  for select using (
    exists (
      select 1 from public.tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = ad_object_changes.tenant_id
    )
  );
create policy ad_object_changes_active_tenant_restrict
  on public.ad_object_changes as restrictive for select
  using (tenant_id = (select public.app_active_tenant()));

revoke all on public.ad_object_changes from public, anon;
revoke insert, update, delete, truncate on public.ad_object_changes from authenticated;
grant select on public.ad_object_changes to authenticated;
revoke all on public.ad_object_changes from service_role;
grant select on public.ad_object_changes to service_role;

create or replace function public.record_ad_object_changes(
  p_tenant_id uuid,
  p_changes   jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n int;
begin
  if p_tenant_id is null then
    raise exception 'record_ad_object_changes: tenant is required' using errcode = '22023';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 500 then
    raise exception 'record_ad_object_changes: changes must be an array of at most 500' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_changes) e
     where jsonb_typeof(e) <> 'object'
        or coalesce(e->>'platform', '') not in ('meta', 'google')
        or coalesce(char_length(e->>'object_id'), 0) not between 1 and 64
        or coalesce(e->>'source', '') not in ('zavi', 'outside')
        or coalesce(e->>'change_kind', '') not in ('status', 'budget')
        or (e->>'level' is not null and e->>'level' not in ('ad_set', 'campaign'))
        or coalesce(char_length(e->>'campaign_id'), 0) > 64
        or coalesce(char_length(e->>'before_status'), 0) > 64
        or coalesce(char_length(e->>'after_status'), 0) > 64
        or (e->>'before_daily_usd' is not null and not ((e->>'before_daily_usd')::numeric >= 0 and (e->>'before_daily_usd')::numeric < 1000000000))
        or (e->>'after_daily_usd' is not null and not ((e->>'after_daily_usd')::numeric >= 0 and (e->>'after_daily_usd')::numeric < 1000000000))
        or ((e->>'source') = 'zavi') <> (e->>'action_table' is not null)
        or (e->>'action_table' is not null and e->>'action_table' not in ('channel_actions', 'decisions', 'budget_stop'))
        or (e->>'action_table' in ('channel_actions', 'decisions') and e->>'action_id' is null)
  ) then
    raise exception 'record_ad_object_changes: invalid change row' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_changes) e
     where (e->>'action_table' = 'channel_actions'
            and not exists (select 1 from channel_actions a
                             where a.id = (e->>'action_id')::uuid and a.tenant_id = p_tenant_id))
        or (e->>'action_table' = 'decisions'
            and not exists (select 1 from decisions d
                             where d.id = (e->>'action_id')::uuid and d.tenant_id = p_tenant_id))
  ) then
    raise exception 'record_ad_object_changes: action not found for this tenant' using errcode = '22023';
  end if;

  insert into ad_object_changes (tenant_id, platform, object_id, level, campaign_id, object_name, source,
                                 action_table, action_id, change_kind, before_status, after_status,
                                 before_daily_usd, after_daily_usd, occurred_at)
  select p_tenant_id, e->>'platform', e->>'object_id', e->>'level', nullif(e->>'campaign_id', ''),
         left(e->>'object_name', 500), e->>'source', e->>'action_table', (e->>'action_id')::uuid,
         e->>'change_kind', e->>'before_status', e->>'after_status',
         round((e->>'before_daily_usd')::numeric, 2), round((e->>'after_daily_usd')::numeric, 2), now()
    from jsonb_array_elements(p_changes) e
  on conflict (tenant_id, action_table, action_id, object_id, change_kind) do nothing;
  get diagnostics v_n = row_count;

  return jsonb_build_object('status', 'recorded', 'inserted', v_n);
end $$;

revoke all on function public.record_ad_object_changes(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_ad_object_changes(uuid, jsonb) to service_role;

commit;
