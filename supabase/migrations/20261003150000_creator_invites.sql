
create table if not exists public.creator_invites (
  id                 uuid primary key default gen_random_uuid(),
  source_key         text not null unique check (length(source_key) between 1 and 600),
  email              text check (email is null or length(email) between 3 and 320),
  display_name       text not null check (length(btrim(display_name)) between 1 and 120),
  profiles           jsonb not null default '{}'::jsonb,
  followers          jsonb not null default '{}'::jsonb,
  source_meta        jsonb not null default '{}'::jsonb,
  hold_reason        text check (hold_reason in (
                       'no_email', 'prior_bounce', 'prior_declined', 'agency',
                       'eu_domain', 'duplicate_review', 'email_conflict')),
  in_conversation    boolean not null default false,
  batch              text not null check (length(batch) between 1 and 64),
  unsub_token        uuid not null unique default gen_random_uuid(),
  invited_at         timestamptz,
  send_failed_at     timestamptz,
  last_error         text check (last_error is null or length(last_error) <= 500),
  unsubscribed_at    timestamptz,
  unsubscribe_source text check (unsubscribe_source is null or unsubscribe_source in ('link', 'one_click')),
  bounced_at         timestamptz,
  bounce_reason      text check (bounce_reason is null or length(bounce_reason) <= 200),
  human_member_id    uuid references public.human_members(id) on delete set null,
  claimed_at         timestamptz,
  member_deleted_at  timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on table public.creator_invites is
  'Creator prospects seeded from the outreach sheet + one-time invite/claim history. GLOBAL, RLS default-deny, service_role only. No auth user or human_members row is created here.';

create unique index if not exists creator_invites_email_key
  on public.creator_invites (lower(email)) where email is not null;

create index if not exists creator_invites_batch_idx on public.creator_invites (batch);
create index if not exists creator_invites_member_idx
  on public.creator_invites (human_member_id) where human_member_id is not null;

alter table public.creator_invites enable row level security;
revoke all on public.creator_invites from public, anon, authenticated;
grant select, insert, update, delete on public.creator_invites to service_role;

create or replace view public.creator_invite_status
with (security_invoker = true) as
select
  ci.*,
  case
    when ci.member_deleted_at is not null then 'deleted'
    when m.vetting_state = 'approved' then 'completed'
    when ci.human_member_id is not null or ci.claimed_at is not null then 'onboarding'
    when ci.bounced_at is not null then 'bounced'
    when ci.unsubscribed_at is not null then 'unsubscribed'
    when ci.send_failed_at is not null then 'send_failed'
    when ci.invited_at is not null then 'invited'
    when ci.hold_reason is not null and ci.hold_reason <> 'no_email' then 'held'
    when ci.email is null then 'no_email'
    else 'seeded'
  end as label
from public.creator_invites ci
left join public.human_members m on m.id = ci.human_member_id;

revoke all on public.creator_invite_status from public, anon, authenticated;
grant select on public.creator_invite_status to service_role;

create or replace function public.creator_invite_existing_accounts(p_emails text[])
returns table (email text, kind text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with wanted as (
    select distinct lower(btrim(e)) as email from unnest(coalesce(p_emails, '{}'::text[])) as e
  )
  select w.email, 'creator'::text
    from wanted w
   where exists (select 1 from public.human_member_pii p where lower(btrim(p.email)) = w.email)
  union
  select w.email, 'account'::text
    from wanted w
   where exists (select 1 from auth.users u where lower(u.email) = w.email)
     and not exists (select 1 from public.human_member_pii p where lower(btrim(p.email)) = w.email);
$$;

create or replace function public.creator_invite_stamp(
  p_id uuid,
  p_include_in_conversation boolean default false,
  p_retry boolean default false
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  update public.creator_invites ci
     set invited_at = now(), send_failed_at = null, last_error = null, updated_at = now()
   where ci.id = p_id
     and ci.email is not null
     and ci.hold_reason is null
     and ci.human_member_id is null
     and ci.claimed_at is null
     and ci.member_deleted_at is null
     and ci.unsubscribed_at is null
     and ci.bounced_at is null
     and (p_include_in_conversation or not ci.in_conversation)
     and case when p_retry then ci.send_failed_at is not null
              else ci.invited_at is null end
  returning ci.id into v_id;
  return v_id is not null;
end;
$$;

create or replace function public.creator_invite_link_signup(p_email text, p_member_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  if p_email is null or p_member_id is null then
    return 0;
  end if;
  update public.creator_invites ci
     set human_member_id = p_member_id,
         claimed_at = coalesce(ci.claimed_at, now()),
         updated_at = now()
   where ci.email is not null
     and lower(ci.email) = lower(btrim(p_email))
     and ci.human_member_id is null
     and ci.member_deleted_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.creator_invite_reconcile_links()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update public.creator_invites ci
     set human_member_id = m.id,
         claimed_at = coalesce(ci.claimed_at, now()),
         updated_at = now()
    from public.human_member_pii p
    join public.human_members m on m.id = p.human_member_id
   where ci.human_member_id is null
     and ci.member_deleted_at is null
     and ci.email is not null
     and lower(ci.email) = lower(btrim(p.email));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.creator_invite_scrub_deleted_member()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.creator_invites ci
     set source_key = 'deleted:' || ci.id::text,
         display_name = '(deleted)',
         profiles = '{}'::jsonb,
         followers = '{}'::jsonb,
         source_meta = '{}'::jsonb,
         claimed_at = coalesce(ci.claimed_at, now()),
         member_deleted_at = now(),
         updated_at = now()
   where ci.human_member_id = old.id;
  return old;
end;
$$;

drop trigger if exists creator_invite_scrub_on_member_delete on public.human_members;
create trigger creator_invite_scrub_on_member_delete
  before delete on public.human_members
  for each row execute function public.creator_invite_scrub_deleted_member();

revoke execute on function public.creator_invite_existing_accounts(text[]) from public, anon, authenticated;
revoke execute on function public.creator_invite_stamp(uuid, boolean, boolean) from public, anon, authenticated;
revoke execute on function public.creator_invite_link_signup(text, uuid) from public, anon, authenticated;
revoke execute on function public.creator_invite_reconcile_links() from public, anon, authenticated;
revoke execute on function public.creator_invite_scrub_deleted_member() from public, anon, authenticated;
grant execute on function public.creator_invite_existing_accounts(text[]) to service_role;
grant execute on function public.creator_invite_stamp(uuid, boolean, boolean) to service_role;
grant execute on function public.creator_invite_link_signup(text, uuid) to service_role;
grant execute on function public.creator_invite_reconcile_links() to service_role;
