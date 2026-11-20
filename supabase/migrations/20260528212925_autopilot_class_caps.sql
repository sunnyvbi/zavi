
begin;

alter table tenant_decision_class_overrides
  add column if not exists max_daily_usd      numeric,
  add column if not exists max_per_action_usd numeric;

create or replace function set_tenant_class_caps(
  p_tenant_id          uuid,
  p_decision_class     text,
  p_max_daily_usd      numeric,
  p_max_per_action_usd numeric
) returns void
language plpgsql security definer set search_path = public as $$
declare v_seed_autonomy decision_autonomy;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
  end if;
  if (p_max_daily_usd is not null and p_max_daily_usd < 0)
     or (p_max_per_action_usd is not null and p_max_per_action_usd < 0) then
    raise exception 'set_tenant_class_caps: caps must be >= 0' using errcode = '22023';
  end if;

  select coalesce(
           (select default_autonomy from decision_classes where slug = p_decision_class),
           'approval'::decision_autonomy
         ) into v_seed_autonomy;

  insert into tenant_decision_class_overrides (
    tenant_id, decision_class, autonomy, max_daily_usd, max_per_action_usd, updated_by
  ) values (
    p_tenant_id, p_decision_class, v_seed_autonomy, p_max_daily_usd, p_max_per_action_usd, auth.uid()
  )
  on conflict (tenant_id, decision_class) do update
    set max_daily_usd      = excluded.max_daily_usd,
        max_per_action_usd = excluded.max_per_action_usd,
        updated_by         = excluded.updated_by,
        updated_at         = now();
end $$;

revoke all on function set_tenant_class_caps(uuid, text, numeric, numeric) from public;
grant execute on function set_tenant_class_caps(uuid, text, numeric, numeric) to authenticated;

commit;
