
drop function if exists public.creator_invite_message_claim_email(uuid);

create or replace function public.creator_invite_message_claim_email(p_message_id uuid, p_daily_cap integer)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invite uuid;
  v_tenant uuid;
  v_emailed timestamptz;
begin
  if p_daily_cap is null or p_daily_cap < 0 or p_daily_cap > 1000 then
    raise exception 'creator_invite_message_claim_email: daily cap must be 0..1000, got %', p_daily_cap
      using errcode = '22023';
  end if;

  select invite_id, tenant_id, emailed_at into v_invite, v_tenant, v_emailed
    from public.creator_invite_messages
   where id = p_message_id;
  if v_invite is null then
    return 'not_found';
  end if;
  if v_emailed is not null then
    return 'already_emailed';
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
    return 'unreachable';
  end if;

  if exists (
    select 1 from public.creator_invite_messages
     where invite_id = v_invite and tenant_id = v_tenant and emailed_at is not null
  ) then
    return 'business_emailed_invite';
  end if;

  if (
    select count(*) from public.creator_invite_messages
     where invite_id = v_invite and emailed_at > now() - interval '7 days'
  ) >= 3 then
    return 'invitee_weekly_cap';
  end if;

  if (
    select count(*) from public.creator_invite_messages
     where tenant_id = v_tenant and emailed_at > now() - interval '24 hours'
  ) >= p_daily_cap then
    return 'business_daily_cap';
  end if;

  update public.creator_invite_messages
     set emailed_at = now()
   where id = p_message_id and emailed_at is null;
  if found then
    return 'claimed';
  end if;
  return 'already_emailed';
end;
$$;

revoke all on function public.creator_invite_message_claim_email(uuid, integer) from public, anon, authenticated;
grant execute on function public.creator_invite_message_claim_email(uuid, integer) to service_role;

alter table public.creator_invites drop constraint if exists creator_invites_hold_reason_check;
alter table public.creator_invites add constraint creator_invites_hold_reason_check
  check (hold_reason in (
    'no_email', 'prior_bounce', 'prior_declined', 'agency',
    'eu_domain', 'duplicate_review', 'email_conflict', 'test_address'));

update public.creator_invites
   set hold_reason = 'test_address', updated_at = now()
 where lower(email) like '%@yopmail.com'
   and hold_reason is null;

