
begin;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'autopilot_money_model') then
    create type autopilot_money_model as enum ('path_a', 'path_b');
  end if;
end$$;

alter table tenant_decision_class_overrides
  add column if not exists money_model autopilot_money_model;

create or replace function set_tenant_money_model(
  p_tenant_id      uuid,
  p_money_model    autopilot_money_model
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_class           text := 'stripe.create_connected_account';
  v_seed_autonomy   decision_autonomy;
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
  if p_money_model is null then
    raise exception 'set_tenant_money_model: money_model is required' using errcode = '22023';
  end if;

  select coalesce(
           (select default_autonomy from decision_classes where slug = v_class),
           'approval'::decision_autonomy
         ) into v_seed_autonomy;

  insert into tenant_decision_class_overrides (
    tenant_id, decision_class, autonomy, money_model, updated_by
  ) values (
    p_tenant_id, v_class, v_seed_autonomy, p_money_model, auth.uid()
  )
  on conflict (tenant_id, decision_class) do update
    set money_model = excluded.money_model,
        updated_by  = auth.uid(),
        updated_at  = now();
end$$;

revoke all on function set_tenant_money_model(uuid, autopilot_money_model) from public;
grant execute on function set_tenant_money_model(uuid, autopilot_money_model) to authenticated;

commit;
