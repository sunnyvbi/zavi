
alter table slack_source_message_lifecycle
  add column if not exists latest_refire_event_id text;

alter table slack_source_message_lifecycle
  drop column if exists superseded_by;

create or replace function mark_slack_source_lifecycle(
  p_tenant           uuid,
  p_team             text,
  p_channel          text,
  p_source_ts        text,
  p_tombstone        boolean,
  p_edit_ts          text default null,
  p_refire_event_id  text default null
) returns table (
  tombstoned             boolean,
  latest_edit_ts         text,
  latest_refire_event_id text
)
language plpgsql security definer set search_path = public as $$
begin
  return query
  insert into slack_source_message_lifecycle as l
    (tenant_id, team_id, channel_id, source_ts,
     tombstoned, latest_edit_ts, latest_refire_event_id, updated_at)
  values
    (p_tenant, p_team, p_channel, p_source_ts,
     p_tombstone, p_edit_ts,
     case when p_edit_ts is not null then p_refire_event_id else null end,
     now())
  on conflict (tenant_id, team_id, channel_id, source_ts) do update set
    tombstoned = l.tombstoned or excluded.tombstoned,
    latest_edit_ts = case
      when excluded.latest_edit_ts is null then l.latest_edit_ts
      when l.latest_edit_ts is null then excluded.latest_edit_ts
      when excluded.latest_edit_ts::numeric > l.latest_edit_ts::numeric
        then excluded.latest_edit_ts
      else l.latest_edit_ts
    end,
    latest_refire_event_id = case
      when excluded.latest_edit_ts is null then l.latest_refire_event_id
      when l.latest_edit_ts is null then excluded.latest_refire_event_id
      when excluded.latest_edit_ts::numeric > l.latest_edit_ts::numeric
        then excluded.latest_refire_event_id
      else l.latest_refire_event_id
    end,
    updated_at = now()
  returning l.tombstoned, l.latest_edit_ts, l.latest_refire_event_id;
end $$;

revoke all on function mark_slack_source_lifecycle(uuid, text, text, text, boolean, text, text) from public;
grant execute on function mark_slack_source_lifecycle(uuid, text, text, text, boolean, text, text) to service_role;
