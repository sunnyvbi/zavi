
begin;

alter table channel_actions drop constraint if exists channel_actions_status_check;
alter table channel_actions add constraint channel_actions_status_check
  check (status in ('pending','acted','rejected','snoozed','redone','stale','displaced'));

alter table channel_action_events drop constraint if exists channel_action_events_event_check;
alter table channel_action_events add constraint channel_action_events_event_check
  check (event in (
    'proposed','acted','rejected','snoozed','redo_requested','redone','stale_flagged',
    'displaced',
    'revised','approved','executed','exec_failed'));

comment on constraint channel_actions_status_check on channel_actions is
  'displaced (2026-09-21): retired because five better open actions outrank it. Never age-based — see rank-actions.ts.';

create or replace function displace_channel_actions(
  p_tenant_id    uuid,
  p_channel_slug text,
  p_run_id       uuid,
  p_loser_ids    uuid[],
  p_winner_title text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id        uuid;
  v_row       channel_actions%rowtype;
  v_key       text;
  v_note      text;
  v_displaced int := 0;
  v_skipped   int := 0;
begin
  if p_tenant_id is null or p_channel_slug is null or p_run_id is null
     or p_loser_ids is null or array_length(p_loser_ids, 1) is null then
    return jsonb_build_object('ok', true, 'displaced', 0, 'skipped', 0);
  end if;

  v_note := left('Displaced: five open actions outrank it'
                 || coalesce(', highest new: ' || nullif(trim(p_winner_title), ''), ''), 1000);

  foreach v_id in array p_loser_ids loop
    v_key := 'displaced:' || p_run_id || ':' || v_id;

    select * into v_row from channel_actions where id = v_id for update;

    if v_row.id is null
       or v_row.tenant_id is distinct from p_tenant_id
       or v_row.channel_slug is distinct from p_channel_slug
       or v_row.status not in ('pending', 'snoozed')
       or coalesce(v_row.exec_status, '') in ('queued', 'dispatching')
    then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if exists (select 1 from channel_action_events
                where action_id = v_id and event_key = v_key) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    update channel_actions
       set status = 'displaced', status_at = now(), note = coalesce(note, v_note)
     where id = v_id;

    insert into channel_action_events
      (tenant_id, action_id, event, actor_kind, run_id, note, event_key)
    values
      (p_tenant_id, v_id, 'displaced', 'channel_run', p_run_id, v_note, v_key);

    v_displaced := v_displaced + 1;
  end loop;

  return jsonb_build_object('ok', true, 'displaced', v_displaced, 'skipped', v_skipped);
end $$;

revoke all on function displace_channel_actions(uuid, text, uuid, uuid[], text)
  from public, anon, authenticated;
grant execute on function displace_channel_actions(uuid, text, uuid, uuid[], text)
  to service_role;

commit;
