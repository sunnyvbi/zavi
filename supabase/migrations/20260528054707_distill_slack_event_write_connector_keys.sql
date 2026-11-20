
create or replace function distill_slack_event_write(
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant_id          uuid;
  v_slack_payload      jsonb := p_payload -> 'slack_message_index';
  v_memory_payload     jsonb := p_payload -> 'memory_note';
  v_killswitched       boolean := false;
  v_index_written      boolean := false;
  v_memory_note_id     uuid := null;
begin
  v_tenant_id := (p_payload ->> 'tenant_id')::uuid;
  if v_tenant_id is null then
    raise exception 'distill_slack_event_write: tenant_id is required';
  end if;

  if v_slack_payload is null then
    raise exception 'distill_slack_event_write: slack_message_index payload is required';
  end if;

  begin
    v_killswitched := not slack_index_visible(v_tenant_id);
  exception
    when undefined_function then
      v_killswitched := false;
  end;

  if not v_killswitched then
    insert into slack_message_index (
      tenant_id,
      channel_id,
      ts,
      author_user_id,
      text_redacted,
      thread_ts,
      msg_subtype,
      conversation_type,
      is_private,
      source_team_id,
      source_user_ids
    ) values (
      v_tenant_id,
      v_slack_payload ->> 'channel_id',
      v_slack_payload ->> 'ts',
      v_slack_payload ->> 'author_user_id',
      coalesce(v_slack_payload ->> 'text_redacted', ''),
      v_slack_payload ->> 'thread_ts',
      v_slack_payload ->> 'msg_subtype',
      coalesce(v_slack_payload ->> 'conversation_type', 'channel_public'),
      coalesce((v_slack_payload ->> 'is_private')::boolean, false),
      coalesce(v_slack_payload ->> 'source_team_id', ''),
      coalesce(
        (select array_agg(value::text)
           from jsonb_array_elements_text(coalesce(v_slack_payload -> 'source_user_ids', '[]'::jsonb))),
        '{}'::text[]
      )
    )
    on conflict (tenant_id, channel_id, ts) do nothing;
    v_index_written := true;
  end if;

  if v_memory_payload is not null then
    insert into memory_note (
      tenant_id,
      title,
      body_markdown,
      source,
      source_ref,
      tags,
      note_type,
      connector_object_keys
    ) values (
      v_tenant_id,
      left(coalesce(v_memory_payload ->> 'title', ''), 200),
      left(coalesce(v_memory_payload ->> 'body_markdown', ''), 8000),
      'auto_distill_slack',
      v_memory_payload ->> 'source_ref',
      coalesce(
        (select array_agg(value::text)
           from jsonb_array_elements_text(coalesce(v_memory_payload -> 'tags', '[]'::jsonb))),
        '{}'::text[]
      ),
      coalesce(v_memory_payload ->> 'note_type', 'untyped'),
      coalesce(v_memory_payload -> 'connector_object_keys', '[]'::jsonb)
    )
    returning id into v_memory_note_id;
  end if;

  return jsonb_build_object(
    'memory_note_id',              v_memory_note_id,
    'slack_message_index_written', v_index_written,
    'killswitched',                v_killswitched
  );
end $$;

revoke all on function distill_slack_event_write(jsonb) from public, authenticated, anon;
grant execute on function distill_slack_event_write(jsonb) to service_role;
