
create table tenant_ad_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  provider text not null,
  period_start date not null,
  period_end date not null,
  payload jsonb not null,
  source text not null default 'manual_paste',
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);
create index tenant_ad_snapshots_tenant_provider_recent
  on tenant_ad_snapshots (tenant_id, provider, period_end desc);

alter table tenant_ad_snapshots enable row level security;
create policy tenant_ad_snapshots_member_select on tenant_ad_snapshots
  for select using (
    exists (select 1 from tenant_users tu
            where tu.user_id = auth.uid() and tu.tenant_id = tenant_ad_snapshots.tenant_id)
  );

create or replace function submit_ad_snapshot(
  p_provider text,
  p_period_start date,
  p_period_end date,
  p_payload jsonb,
  p_source text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_tenant_id uuid; v_id uuid;
begin
  select active_tenant_id into v_tenant_id from profiles where user_id = auth.uid();
  if v_tenant_id is null then
    raise exception 'no active tenant for user' using errcode = '42501';
  end if;
  if not exists (select 1 from tenant_users where user_id = auth.uid() and tenant_id = v_tenant_id) then
    raise exception 'not a member of tenant %', v_tenant_id using errcode = '42501';
  end if;
  if p_provider not in ('google_ads', 'meta_ads', 'tiktok_ads', 'linkedin_ads') then
    raise exception 'unsupported provider %', p_provider using errcode = '22023';
  end if;
  if p_period_start > p_period_end then
    raise exception 'period_start > period_end' using errcode = '22023';
  end if;

  insert into tenant_ad_snapshots (tenant_id, provider, period_start, period_end, payload, source, created_by)
  values (v_tenant_id, p_provider, p_period_start, p_period_end, p_payload, coalesce(p_source, 'manual_paste'), auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke all on function submit_ad_snapshot(text, date, date, jsonb, text) from public;
grant execute on function submit_ad_snapshot(text, date, date, jsonb, text) to authenticated;

create or replace function get_latest_ad_snapshot(
  p_tenant_id uuid,
  p_provider text,
  p_max_age_days int
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_row record;
begin
  select payload, period_start, period_end, source, created_at
    into v_row
    from tenant_ad_snapshots
   where tenant_id = p_tenant_id
     and provider = p_provider
     and period_end >= (current_date - p_max_age_days)
   order by period_end desc, created_at desc
   limit 1;
  if v_row is null then
    return null;
  end if;
  return jsonb_build_object(
    'payload', v_row.payload,
    'period_start', v_row.period_start,
    'period_end', v_row.period_end,
    'source', v_row.source,
    'created_at', v_row.created_at
  );
end $$;
revoke all on function get_latest_ad_snapshot(uuid, text, int) from public;
