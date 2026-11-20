
create or replace function effective_autonomy(
  p_tenant_id uuid,
  p_decision_class text
) returns decision_autonomy
language plpgsql security definer set search_path = public stable as $$
declare v_override decision_autonomy; v_default decision_autonomy;
begin
  if p_decision_class = any (array['browser.action', 'growth-lead.outreach-drafts']) then
    return 'approval'::decision_autonomy;
  end if;

  select autonomy into v_override
  from tenant_decision_class_overrides
  where tenant_id = p_tenant_id and decision_class = p_decision_class;
  if v_override is not null then
    return v_override;
  end if;
  select default_autonomy into v_default
  from decision_classes where slug = p_decision_class;
  return coalesce(v_default, 'approval'::decision_autonomy);
end $$;
revoke all on function effective_autonomy(uuid, text) from public;
grant execute on function effective_autonomy(uuid, text) to authenticated, service_role;

create or replace function set_tenant_autonomy(
  p_tenant_id uuid,
  p_decision_class text,
  p_autonomy decision_autonomy
) returns void
language plpgsql security definer set search_path = public as $$
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
  if p_decision_class = any (array['browser.action', 'growth-lead.outreach-drafts'])
     and p_autonomy <> 'approval'::decision_autonomy then
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
