
create or replace function submit_ad_snapshot(
  p_provider text,
  p_period_start date,
  p_period_end date,
  p_payload jsonb,
  p_source text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_tenant_id uuid; v_id uuid;
begin
  select app_active_tenant() into v_tenant_id;
  if v_tenant_id is null then
    raise exception 'no active tenant for user' using errcode = '42501';
  end if;
  if not exists (select 1 from tenant_users where user_id = auth.uid() and tenant_id = v_tenant_id) then
    raise exception 'not a member of tenant %', v_tenant_id using errcode = '42501';
  end if;
  if p_provider not in ('google_ads', 'meta_ads', 'tiktok_ads', 'linkedin_ads', 'chatgpt_ads') then
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
