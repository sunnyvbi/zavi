
begin;

alter table public.channel_actions add column if not exists held_reason text;
alter table public.channel_actions drop constraint if exists channel_actions_held_reason_check;
alter table public.channel_actions add constraint channel_actions_held_reason_check
  check (held_reason is null or held_reason in ('pacing', 'released'));
comment on column public.channel_actions.held_reason is
  'Signup card pacing (onboarding-pacing.ts): pacing = held behind a future snooze so the founder sees one channel first; released = was held and let out, never held again. Null = never paced.';

do $$
begin
  if to_regclass('lab.channel_actions') is not null then
    alter table lab.channel_actions add column if not exists held_reason text;
  end if;
end $$;

create or replace function hold_paced_channel_actions(
  p_tenant_id uuid, p_ids uuid[], p_until timestamptz
) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n int;
begin
  if p_tenant_id is null or p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;
  if p_until is null or p_until <= now() then
    return 0;
  end if;
  if exists (
       select 1 from channel_action_events e
        where e.tenant_id = p_tenant_id and e.actor_kind = 'founder'
     ) or exists (
       select 1 from channel_actions c
        where c.tenant_id = p_tenant_id and c.founder_touched_at is not null
     ) then
    return 0;
  end if;

  update channel_actions c
     set status = 'snoozed', snoozed_until = p_until, held_reason = 'pacing'
   where c.tenant_id = p_tenant_id
     and c.id = any(p_ids)
     and c.status = 'pending'
     and c.held_reason is null
     and c.founder_touched_at is null
     and c.exec_status is null
     and c.approved_by is null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function hold_paced_channel_actions(uuid, uuid[], timestamptz) from public, anon, authenticated;
grant execute on function hold_paced_channel_actions(uuid, uuid[], timestamptz) to service_role;

create or replace function release_paced_channel_actions(
  p_tenant_id uuid, p_channels text[], p_ids uuid[]
) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n int;
begin
  if p_tenant_id is null then
    return 0;
  end if;
  update channel_actions c
     set status = 'pending', snoozed_until = null, held_reason = 'released'
   where c.tenant_id = p_tenant_id
     and c.held_reason = 'pacing'
     and c.status = 'snoozed'
     and (p_channels is null or c.channel_slug = any(p_channels))
     and (p_ids is null or c.id = any(p_ids))
     and not exists (
       select 1 from channel_action_events e
        where e.action_id = c.id and e.tenant_id = p_tenant_id and e.actor_kind = 'founder'
     );
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function release_paced_channel_actions(uuid, text[], uuid[]) from public, anon, authenticated;
grant execute on function release_paced_channel_actions(uuid, text[], uuid[]) to service_role;

commit;
