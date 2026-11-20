
alter table public.decisions
  add column if not exists rejected_by uuid references auth.users(id) on delete set null,
  add column if not exists rejected_at timestamptz;

comment on column public.decisions.rejected_by is
  'Gap5 S5: auth.users.id of the human who REJECTED this decision (was overloaded into approved_by). NULL on approved/auto/pre-migration-reject rows.';
comment on column public.decisions.rejected_at is
  'Gap5 S5: when the decision was rejected. NULL on approved/auto/pre-migration-reject rows.';

create or replace function decide_decision_as_actor(
  p_decision_id uuid,
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_action text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_status text;
  v_new_status text;
begin
  if p_action not in ('approve', 'reject') then
    raise exception 'invalid action %', p_action using errcode = '22023';
  end if;

  select tenant_id, status into v_tenant, v_status
    from decisions where id = p_decision_id;

  if v_tenant is null then
    raise exception 'decision % not found', p_decision_id using errcode = '42704';
  end if;

  if v_tenant <> p_tenant_id then
    raise exception 'cross_tenant: decision % belongs to a different tenant', p_decision_id
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from tenant_users
    where user_id = p_actor_user_id and tenant_id = p_tenant_id
  ) then
    raise exception 'not_member: actor is not a member of tenant %', p_tenant_id
      using errcode = '42501';
  end if;

  if v_status <> 'proposed' then
    return jsonb_build_object('changed', false, 'status', v_status);
  end if;

  v_new_status := case when p_action = 'approve' then 'approved' else 'rejected' end;

  update decisions
     set status      = v_new_status,
         approved_by = case when p_action = 'approve' then p_actor_user_id else approved_by end,
         approved_at = case when p_action = 'approve' then now()          else approved_at end,
         rejected_by = case when p_action = 'reject'  then p_actor_user_id else rejected_by end,
         rejected_at = case when p_action = 'reject'  then now()          else rejected_at end
   where id = p_decision_id and status = 'proposed';

  return jsonb_build_object('changed', true, 'status', v_new_status);
end $$;

revoke all on function decide_decision_as_actor(uuid, uuid, uuid, text) from public;
revoke all on function decide_decision_as_actor(uuid, uuid, uuid, text) from authenticated;
grant execute on function decide_decision_as_actor(uuid, uuid, uuid, text) to service_role;

create or replace function decide_decision_as_staff(
  p_decision_id uuid,
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_action text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_status text;
  v_new_status text;
begin
  if p_action not in ('approve', 'reject') then
    raise exception 'invalid action %', p_action using errcode = '22023';
  end if;

  select tenant_id, status into v_tenant, v_status
    from decisions where id = p_decision_id;
  if v_tenant is null then
    raise exception 'decision % not found', p_decision_id using errcode = '42704';
  end if;

  if v_tenant <> p_tenant_id then
    raise exception 'cross_tenant: decision % belongs to a different tenant', p_decision_id
      using errcode = '42501';
  end if;

  if v_status <> 'proposed' then
    return jsonb_build_object('changed', false, 'status', v_status);
  end if;

  v_new_status := case when p_action = 'approve' then 'approved' else 'rejected' end;

  update decisions
     set status      = v_new_status,
         approved_by = case when p_action = 'approve' then p_actor_user_id else approved_by end,
         approved_at = case when p_action = 'approve' then now()          else approved_at end,
         rejected_by = case when p_action = 'reject'  then p_actor_user_id else rejected_by end,
         rejected_at = case when p_action = 'reject'  then now()          else rejected_at end
   where id = p_decision_id and status = 'proposed';

  return jsonb_build_object('changed', true, 'status', v_new_status);
end $$;

revoke all on function decide_decision_as_staff(uuid, uuid, uuid, text) from public, authenticated, anon;
grant execute on function decide_decision_as_staff(uuid, uuid, uuid, text) to service_role;

create or replace function reject_decision(p_decision_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_status text;
begin
  select tenant_id, status into v_tenant, v_status
    from decisions where id = p_decision_id;
  if v_tenant is null then
    raise exception 'decision % not found', p_decision_id using errcode = '42704';
  end if;
  if v_status != 'proposed' then
    raise exception 'decision % is in status % (must be proposed)', p_decision_id, v_status using errcode = '22023';
  end if;
  perform _assert_tenant_admin(v_tenant);
  update decisions
     set status = 'rejected', rejected_by = auth.uid(), rejected_at = now()
   where id = p_decision_id;
end $$;

create or replace function resolve_decision_actors(
  p_tenant_id uuid,
  p_user_ids uuid[]
) returns table(user_id uuid, label text)
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from tenant_users tu
    where tu.user_id = auth.uid() and tu.tenant_id = p_tenant_id
  ) then
    return;
  end if;

  return query
  select u.id as user_id,
    case
      when exists (
        select 1 from tenant_users m
        where m.user_id = u.id and m.tenant_id = p_tenant_id
      ) then coalesce(
        (select tm.display_name
           from team_members tm
          where tm.tenant_id = p_tenant_id
            and lower(tm.primary_email) = lower(u.email)
            and tm.status = 'active'
          limit 1),
        u.email
      )
      else 'Zavi staff'
    end as label
  from auth.users u
  where u.id = any(p_user_ids);
end $$;

revoke all on function resolve_decision_actors(uuid, uuid[]) from public, anon;
grant execute on function resolve_decision_actors(uuid, uuid[]) to authenticated, service_role;
