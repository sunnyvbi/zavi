
alter table decision_classes
  add column if not exists informational boolean not null default false;

comment on column decision_classes.informational is
  'True = a side-effect-free RENDER class (you read it, you do not approve it). '
  'effective_autonomy() clamps it to auto so no tenant override can strand it in '
  'the approval queue. Mutually exclusive with never_auto.';

alter table decision_classes
  drop constraint if exists decision_classes_informational_not_never_auto;
alter table decision_classes
  add constraint decision_classes_informational_not_never_auto
  check (not (informational and never_auto));

update decision_classes
   set informational = true
 where dispatch_handler = 'digest.post'
   and default_autonomy = 'auto'
   and never_auto = false;

create or replace function effective_autonomy(
  p_tenant_id uuid,
  p_decision_class text
) returns decision_autonomy
language plpgsql security definer set search_path = public, pg_temp stable as $$
declare
  v_never_auto boolean;
  v_informational boolean;
  v_override decision_autonomy;
  v_default decision_autonomy;
begin
  select never_auto, informational, default_autonomy
    into v_never_auto, v_informational, v_default
  from decision_classes where slug = p_decision_class;

  if v_never_auto is true then
    return 'approval'::decision_autonomy;
  end if;

  if v_informational is true then
    return 'auto'::decision_autonomy;
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
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_never_auto boolean;
  v_informational boolean;
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

  select never_auto, informational into v_never_auto, v_informational
  from decision_classes where slug = p_decision_class;

  if v_never_auto is true and p_autonomy <> 'approval'::decision_autonomy then
    raise exception
      'decision class % is approval-only; cannot set autonomy=%',
      p_decision_class, p_autonomy
      using errcode = '22023';
  end if;

  if v_informational is true and p_autonomy <> 'auto'::decision_autonomy then
    raise exception
      'decision class % is informational (a read-only render with no side effect); cannot set autonomy=%',
      p_decision_class, p_autonomy
      using errcode = '22023';
  end if;

  insert into tenant_decision_class_overrides as o
    (tenant_id, decision_class, autonomy, updated_by, updated_at)
  values (p_tenant_id, p_decision_class, p_autonomy, auth.uid(), now())
  on conflict (tenant_id, decision_class)
  do update set autonomy = excluded.autonomy,
                updated_by = excluded.updated_by,
                updated_at = now();
end $$;
revoke all on function set_tenant_autonomy(uuid, text, decision_autonomy) from public;
grant execute on function set_tenant_autonomy(uuid, text, decision_autonomy) to authenticated, service_role;

update tenant_decision_class_overrides o
   set autonomy = null, updated_at = now()
  from decision_classes c
 where c.slug = o.decision_class
   and c.informational is true
   and o.autonomy is not null;
