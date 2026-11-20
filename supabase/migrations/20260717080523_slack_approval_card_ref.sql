
alter table public.dispatch_notice_refs
  drop constraint if exists dispatch_notice_refs_surface_check;

alter table public.dispatch_notice_refs
  add constraint dispatch_notice_refs_surface_check
  check (surface in ('chat', 'slack', 'slack_approval_card'));

create or replace function upsert_dispatch_notice_ref(
  p_decision_id      uuid,
  p_surface          text,
  p_tenant_id        uuid,
  p_chat_message_id  uuid default null,
  p_chat_thread_id   uuid default null,
  p_slack_channel_id text default null,
  p_slack_ts         text default null,
  p_slack_team_id    text default null,
  p_notice_body      text default null,
  p_pr_url           text default null,
  p_pr_number        int  default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_surface not in ('chat', 'slack', 'slack_approval_card') then
    raise exception 'upsert_dispatch_notice_ref: invalid surface %', p_surface;
  end if;
  insert into public.dispatch_notice_refs (
    decision_id, surface, tenant_id,
    chat_message_id, chat_thread_id,
    slack_channel_id, slack_ts, slack_team_id,
    notice_body, pr_url, pr_number
  ) values (
    p_decision_id, p_surface, p_tenant_id,
    p_chat_message_id, p_chat_thread_id,
    p_slack_channel_id, p_slack_ts, p_slack_team_id,
    p_notice_body, p_pr_url, p_pr_number
  )
  on conflict (decision_id, surface) do update set
    chat_message_id  = coalesce(excluded.chat_message_id,  dispatch_notice_refs.chat_message_id),
    chat_thread_id   = coalesce(excluded.chat_thread_id,   dispatch_notice_refs.chat_thread_id),
    slack_channel_id = coalesce(excluded.slack_channel_id, dispatch_notice_refs.slack_channel_id),
    slack_ts         = coalesce(excluded.slack_ts,         dispatch_notice_refs.slack_ts),
    slack_team_id    = coalesce(excluded.slack_team_id,    dispatch_notice_refs.slack_team_id),
    notice_body      = coalesce(excluded.notice_body,      dispatch_notice_refs.notice_body),
    pr_url           = coalesce(excluded.pr_url,           dispatch_notice_refs.pr_url),
    pr_number        = coalesce(excluded.pr_number,        dispatch_notice_refs.pr_number);
end;
$$;

revoke execute on function upsert_dispatch_notice_ref(
  uuid, text, uuid, uuid, uuid, text, text, text, text, text, int
) from public, anon, authenticated;

grant execute on function upsert_dispatch_notice_ref(
  uuid, text, uuid, uuid, uuid, text, text, text, text, text, int
) to service_role;
