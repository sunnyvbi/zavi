
begin;

alter table public.decisions add column if not exists archived_at   timestamptz;
alter table public.decisions add column if not exists snoozed_until timestamptz;

comment on column public.decisions.archived_at is
  'Set by archive_decision(). Distinguishes "the founder closed this without doing it" from an approve-driven acted. Never set by the approve path.';
comment on column public.decisions.snoozed_until is
  'Set by snooze_decision(). Status stays proposed; customer-visible surfaces hide the row until this passes. NULL = not snoozed.';

create or replace view public.customer_visible_pending_decisions
with (security_invoker = true) as
  select d.*
  from public.decisions d
  where d.status = 'proposed'
    and d.autonomy_at_emit = 'approval'
    and (d.snoozed_until is null or d.snoozed_until <= now());

comment on view public.customer_visible_pending_decisions is
  'Single source of truth for "a decision the founder still needs to see". Every customer-facing list/count reads THIS, never a hand-rolled status filter.';

grant select on public.customer_visible_pending_decisions to authenticated, service_role;

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
     set status = 'acted', archived_at = now()
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

create or replace function public.snooze_decision(
  p_tenant_id   uuid,
  p_decision_id uuid,
  p_until       timestamptz
) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_updated int;
  v_tenant  uuid;
  v_class   text;
begin
  if p_until is null or p_until <= now() then
    raise exception 'snooze_decision: p_until must be in the future'
      using errcode = 'P0001';
  end if;
  if p_until > now() + interval '14 days' then
    raise exception 'snooze_decision: p_until exceeds the 14 day ceiling'
      using errcode = 'P0001';
  end if;

  update public.decisions d
     set snoozed_until = p_until
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

  select d.tenant_id, d.decision_class into v_tenant, v_class
  from public.decisions d where d.id = p_decision_id;

  if v_tenant is null then
    return false;
  end if;
  if p_tenant_id is distinct from v_tenant then
    raise exception 'snooze_decision: decision % belongs to tenant %, not %',
      p_decision_id, v_tenant, p_tenant_id using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.decision_classes dc
     where dc.slug = v_class and dc.founder_managed is true
  ) then
    raise exception 'snooze_decision: class % is not founder_managed', v_class
      using errcode = 'P0001';
  end if;

  return false;
end $$;

revoke all on function public.snooze_decision(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.snooze_decision(uuid, uuid, timestamptz) to service_role;

commit;

do $$
begin
  raise notice '20260902021000: archive_decision + snooze_decision + customer_visible_pending_decisions';
end $$;
