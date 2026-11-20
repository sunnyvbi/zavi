
create table if not exists public.creator_invite_messages (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,
  invite_id            uuid not null references public.creator_invites(id) on delete cascade,
  sender_user_id       uuid,
  body                 text not null check (length(body) between 1 and 4000),
  emailed_at           timestamptz,
  carried_to_thread_id uuid,
  created_at           timestamptz not null default now()
);

comment on table public.creator_invite_messages is
  'Business messages to an invited (not yet signed up) creator. Emailed under a DB-enforced cap; copied into creator_threads on signup. service_role only.';

create index if not exists creator_invite_messages_tenant_invite_idx
  on public.creator_invite_messages (tenant_id, invite_id, created_at);
create index if not exists creator_invite_messages_invite_emailed_idx
  on public.creator_invite_messages (invite_id, emailed_at) where emailed_at is not null;
create index if not exists creator_invite_messages_uncarried_idx
  on public.creator_invite_messages (invite_id) where carried_to_thread_id is null;

alter table public.creator_invite_messages enable row level security;
revoke all on public.creator_invite_messages from public, anon, authenticated;
grant select, insert, update, delete on public.creator_invite_messages to service_role;

create or replace function public.creator_invite_message_claim_email(p_message_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite uuid;
  v_tenant uuid;
  v_emailed timestamptz;
begin
  select invite_id, tenant_id, emailed_at into v_invite, v_tenant, v_emailed
    from public.creator_invite_messages
   where id = p_message_id;
  if v_invite is null or v_emailed is not null then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('creator_invite_message_tenant:' || v_tenant::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('creator_invite_message:' || v_invite::text, 0));

  if not exists (
    select 1 from public.creator_invites ci
     where ci.id = v_invite
       and ci.email is not null
       and ci.unsubscribed_at is null
       and ci.bounced_at is null
       and ci.human_member_id is null
       and ci.claimed_at is null
       and ci.member_deleted_at is null
       and ci.send_failed_at is null
       and ci.hold_reason is null
  ) then
    return false;
  end if;

  if exists (
    select 1 from public.creator_invite_messages
     where invite_id = v_invite and tenant_id = v_tenant and emailed_at is not null
  ) then
    return false;
  end if;

  if (
    select count(*) from public.creator_invite_messages
     where invite_id = v_invite and emailed_at > now() - interval '7 days'
  ) >= 3 then
    return false;
  end if;

  if (
    select count(*) from public.creator_invite_messages
     where tenant_id = v_tenant and emailed_at > now() - interval '24 hours'
  ) >= 10 then
    return false;
  end if;

  update public.creator_invite_messages
     set emailed_at = now()
   where id = p_message_id and emailed_at is null;
  return found;
end;
$$;

revoke all on function public.creator_invite_message_claim_email(uuid) from public, anon, authenticated;
grant execute on function public.creator_invite_message_claim_email(uuid) to service_role;
