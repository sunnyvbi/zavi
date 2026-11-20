
begin;

create or replace function public.archive_decision(
  p_tenant_id   uuid,
  p_decision_id uuid
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_updated int;
  v_tenant  uuid;
  v_class   text;
  v_status  text;
begin
  update public.decisions d
     set status = 'archived', archived_at = now()
   where d.id = p_decision_id
     and d.tenant_id = p_tenant_id
     and d.status = 'proposed'
     and exists (
       select 1 from public.decision_classes dc
        where dc.slug = d.decision_class
          and dc.founder_managed is true
     );
  get diagnostics v_updated = row_count;

  if v_updated > 0 then
    return true;
  end if;

  select d.tenant_id, d.decision_class, d.status
    into v_tenant, v_class, v_status
  from public.decisions d where d.id = p_decision_id;

  if v_tenant is null then
    return false;
  end if;
  if p_tenant_id is distinct from v_tenant then
    raise exception 'archive_decision: decision % belongs to tenant %, not %',
      p_decision_id, v_tenant, p_tenant_id using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.decision_classes dc
     where dc.slug = v_class and dc.founder_managed is true
  ) then
    raise exception 'archive_decision: class % is not founder_managed', v_class
      using errcode = 'P0001';
  end if;

  return false;
end $$;

revoke all on function public.archive_decision(uuid, uuid) from public, anon, authenticated;
grant execute on function public.archive_decision(uuid, uuid) to service_role;

update public.decisions
   set status = 'archived'
 where status = 'acted'
   and archived_at is not null;

create or replace view public.customer_visible_declined_decisions
with (security_invoker = true) as
  select d.*
  from public.decisions d
  where d.status = 'archived';

comment on view public.customer_visible_declined_decisions is
  'Decisions the founder closed WITHOUT doing the work ("Didn''t do it"), plus the actions a redo superseded. Terminal, and neither accepted nor rejected: archive exists so that "I did not get to it" never teaches Zavi to stop proposing the work. Counted so a decline is not rendered as a completion.';

grant select on public.customer_visible_declined_decisions to authenticated, service_role;

commit;

do $$
begin
  raise notice '20260919230000: archive_decision writes archived (not acted) + backfill + declined view';
end $$;
