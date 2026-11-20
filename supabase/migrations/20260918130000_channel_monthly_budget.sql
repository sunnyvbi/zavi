
begin;

alter table tenant_channels
  add column if not exists monthly_budget_usd numeric null;

create or replace function set_channel_monthly_budget(
  p_tenant_id    uuid,
  p_channel_slug text,
  p_usd          numeric
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_exists boolean;
begin
  if p_tenant_id is null
     or nullif(trim(p_channel_slug), '') is null
     or (p_usd is not null and (p_usd < 0 or p_usd > 100000000)) then
    return false;
  end if;

  insert into tenant_channels (tenant_id, channel_slug, monthly_budget_usd)
  values (p_tenant_id, p_channel_slug, p_usd)
  on conflict (tenant_id, channel_slug) do update
    set monthly_budget_usd = p_usd;

  select true into v_exists
    from tenant_channels
   where tenant_id = p_tenant_id
     and channel_slug = p_channel_slug
     and monthly_budget_usd is not distinct from p_usd;

  return coalesce(v_exists, false);
end $$;

revoke all on function set_channel_monthly_budget(uuid, text, numeric)
  from public, anon, authenticated;
grant execute on function set_channel_monthly_budget(uuid, text, numeric)
  to service_role;

commit;
