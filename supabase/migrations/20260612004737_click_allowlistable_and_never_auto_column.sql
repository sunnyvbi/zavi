
alter table decision_classes
  add column if not exists never_auto boolean not null default false;
alter table decision_classes
  add column if not exists click_allowlistable boolean not null default false;

update decision_classes
   set never_auto = true
 where slug in ('browser.action', 'growth-lead.outreach-drafts');

update decision_classes
   set click_allowlistable = true
 where slug in ('send_email', 'post_slack_message', 'create_jira_issue')
   and default_autonomy = 'approval'
   and never_auto = false;

create or replace function effective_autonomy(
  p_tenant_id uuid,
  p_decision_class text
) returns decision_autonomy
language plpgsql security definer set search_path = public stable as $$
declare v_never_auto boolean; v_override decision_autonomy; v_default decision_autonomy;
begin
  select never_auto, default_autonomy into v_never_auto, v_default
  from decision_classes where slug = p_decision_class;

  if v_never_auto is true then
    return 'approval'::decision_autonomy;
  end if;

  select autonomy into v_override
  from tenant_decision_class_overrides
  where tenant_id = p_tenant_id and decision_class = p_decision_class;
  if v_override is not null then
    return v_override;
  end if;
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
declare v_never_auto boolean;
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

create or replace function allowlist_class_for_tenant(
  p_tenant_id uuid,
  p_decision_class text,
  p_actor_user_id uuid
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_click_allowlistable boolean;
  v_never_auto boolean;
begin
  if p_tenant_id is null or p_decision_class is null or p_actor_user_id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_owner');
  end if;

  select role into v_role
  from tenant_users
  where user_id = p_actor_user_id and tenant_id = p_tenant_id;
  if v_role is null or v_role not in ('owner', 'admin') then
    return jsonb_build_object('ok', false, 'reason', 'not_owner');
  end if;

  select click_allowlistable, never_auto
    into v_click_allowlistable, v_never_auto
  from decision_classes where slug = p_decision_class;
  if v_click_allowlistable is not true or v_never_auto is true then
    return jsonb_build_object('ok', false, 'reason', 'not_allowlistable');
  end if;

  insert into tenant_decision_class_overrides (
    tenant_id, decision_class, autonomy, updated_by
  ) values (
    p_tenant_id, p_decision_class, 'auto'::decision_autonomy, p_actor_user_id
  )
  on conflict (tenant_id, decision_class)
  do update set autonomy = excluded.autonomy, updated_by = excluded.updated_by, updated_at = now();

  return jsonb_build_object('ok', true);
end $$;
revoke all on function allowlist_class_for_tenant(uuid, text, uuid) from public;
revoke all on function allowlist_class_for_tenant(uuid, text, uuid) from authenticated;
grant execute on function allowlist_class_for_tenant(uuid, text, uuid) to service_role;
