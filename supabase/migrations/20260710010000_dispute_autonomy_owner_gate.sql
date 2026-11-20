
begin;

create or replace function set_tenant_autonomy(
  p_tenant_id uuid,
  p_decision_class text,
  p_autonomy decision_autonomy
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_never_auto boolean;
  v_role text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if p_autonomy is null then
    raise exception 'autonomy required; use clear_tenant_autonomy to inherit'
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from tenant_users
    where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
  end if;

  if p_autonomy = 'auto'::decision_autonomy then
    select role into v_role from tenant_users
     where user_id = auth.uid() and tenant_id = p_tenant_id;
    if v_role is null or v_role not in ('owner', 'admin') then
      raise exception 'only an owner or admin may arm % to auto', p_decision_class
        using errcode = '42501';
    end if;
  end if;

  select never_auto into v_never_auto
  from decision_classes where slug = p_decision_class;
  if v_never_auto is true and p_autonomy <> 'approval'::decision_autonomy then
    raise exception
      'decision class % is approval-only; cannot set autonomy=%',
      p_decision_class, p_autonomy
      using errcode = '22023';
  end if;

  insert into tenant_decision_class_overrides (
    tenant_id, decision_class, autonomy, updated_by
  ) values (
    p_tenant_id, p_decision_class, p_autonomy, auth.uid()
  )
  on conflict (tenant_id, decision_class)
  do update set autonomy = excluded.autonomy, updated_by = excluded.updated_by, updated_at = now();
end $$;

revoke all on function set_tenant_autonomy(uuid, text, decision_autonomy) from public;
grant execute on function set_tenant_autonomy(uuid, text, decision_autonomy) to authenticated;

create or replace function clear_tenant_autonomy(
  p_tenant_id uuid,
  p_decision_class text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_default decision_autonomy;
  v_role text;
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

  select default_autonomy into v_default
  from decision_classes where slug = p_decision_class;
  if v_default = 'auto'::decision_autonomy then
    select role into v_role from tenant_users
     where user_id = auth.uid() and tenant_id = p_tenant_id;
    if v_role is null or v_role not in ('owner', 'admin') then
      raise exception 'only an owner or admin may inherit % (its default is auto)', p_decision_class
        using errcode = '42501';
    end if;
  end if;

  update tenant_decision_class_overrides
     set autonomy                   = null,
         waiver_expires_at          = null,
         waiver_max_daily_usd       = null,
         waiver_cooling_off_seconds = 0,
         updated_by                 = auth.uid(),
         updated_at                 = now()
   where tenant_id = p_tenant_id and decision_class = p_decision_class;
end $$;

revoke all on function clear_tenant_autonomy(uuid, text) from public;
grant execute on function clear_tenant_autonomy(uuid, text) to authenticated;

commit;
