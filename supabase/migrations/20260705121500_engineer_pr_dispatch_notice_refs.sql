
create table if not exists public.dispatch_notice_refs (
  decision_id       uuid not null,
  surface           text not null check (surface in ('chat', 'slack')),
  tenant_id         uuid not null,
  chat_message_id   uuid,
  chat_thread_id    uuid,
  slack_channel_id  text,
  slack_ts          text,
  slack_team_id     text,
  notice_body       text,
  pr_url            text,
  pr_number         int,
  head_sha          text,
  ci_status         text not null default 'pending'
                     check (ci_status in ('pending', 'verifying', 'green', 'red', 'na')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (decision_id, surface)
);

comment on table public.dispatch_notice_refs is
  'Engineer honest-PR verify Slice 4: editable notice message ref per (decision_id, surface) + CI-readback keys (pr_url, head_sha). The CI-readback worker edits the stored ref ⚠️/🟡→✅/❌ once, in place. Service-role write via RPCs only.';

alter table public.dispatch_notice_refs enable row level security;

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
set search_path = public
as $$
begin
  if p_surface not in ('chat', 'slack') then
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
    chat_message_id  = coalesce(excluded.chat_message_id, dispatch_notice_refs.chat_message_id),
    chat_thread_id   = coalesce(excluded.chat_thread_id, dispatch_notice_refs.chat_thread_id),
    slack_channel_id = coalesce(excluded.slack_channel_id, dispatch_notice_refs.slack_channel_id),
    slack_ts         = coalesce(excluded.slack_ts, dispatch_notice_refs.slack_ts),
    slack_team_id    = coalesce(excluded.slack_team_id, dispatch_notice_refs.slack_team_id),
    notice_body      = coalesce(excluded.notice_body, dispatch_notice_refs.notice_body),
    pr_url           = coalesce(excluded.pr_url, dispatch_notice_refs.pr_url),
    pr_number        = coalesce(excluded.pr_number, dispatch_notice_refs.pr_number),
    updated_at       = now();
end;
$$;

create or replace function set_dispatch_notice_ci(
  p_decision_id uuid,
  p_head_sha    text,
  p_ci_status   text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_ci_status not in ('verifying', 'green', 'red', 'na') then
    raise exception 'set_dispatch_notice_ci: invalid ci_status %', p_ci_status;
  end if;
  update public.dispatch_notice_refs
     set head_sha   = coalesce(p_head_sha, head_sha),
         ci_status  = p_ci_status,
         updated_at = now()
   where decision_id = p_decision_id
     and ci_status not in ('green', 'red', 'na');
end;
$$;

revoke all on function upsert_dispatch_notice_ref(
  uuid, text, uuid, uuid, uuid, text, text, text, text, text, int
) from public, anon, authenticated;
revoke all on function set_dispatch_notice_ci(uuid, text, text)
  from public, anon, authenticated;
