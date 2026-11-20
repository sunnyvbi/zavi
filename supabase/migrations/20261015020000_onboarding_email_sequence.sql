
create table if not exists public.onboarding_email_sequence (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  user_id         uuid not null,
  unsub_token     uuid not null unique default gen_random_uuid(),
  started_at      timestamptz not null default now(),
  last_step       integer not null default 0 check (last_step between 0 and 99),
  last_sent_at    timestamptz,
  next_due_at     timestamptz default now(),
  status          text not null default 'active'
                    check (status in ('active', 'completed', 'unsubscribed', 'stopped')),
  unsubscribed_at timestamptz,
  unsubscribe_source text check (unsubscribe_source is null or unsubscribe_source in ('link', 'one_click')),
  last_error      text check (last_error is null or length(last_error) <= 300),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, user_id)
);

comment on table public.onboarding_email_sequence is
  'Progress through the onboarding email sequence, one row per (workspace, recipient). No email address stored. RLS default-deny, service_role only.';

create index if not exists onboarding_email_sequence_due_idx
  on public.onboarding_email_sequence (next_due_at)
  where status = 'active';
create index if not exists onboarding_email_sequence_user_idx
  on public.onboarding_email_sequence (user_id);

alter table public.onboarding_email_sequence enable row level security;
revoke all on public.onboarding_email_sequence from public, anon, authenticated;
grant select, insert, update, delete on public.onboarding_email_sequence to service_role;

create or replace function public.onboarding_email_claim(
  p_id uuid,
  p_step integer,
  p_next_due timestamptz
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  update public.onboarding_email_sequence s
     set last_step    = p_step,
         last_sent_at = now(),
         next_due_at  = p_next_due,
         status       = case when p_next_due is null then 'completed' else 'active' end,
         last_error   = null,
         updated_at   = now()
   where s.id = p_id
     and s.status = 'active'
     and s.last_step < p_step
     and s.next_due_at is not null
     and s.next_due_at <= now()
     and not exists (
       select 1 from public.onboarding_email_sequence u
        where u.user_id = s.user_id and u.status = 'unsubscribed'
     )
  returning s.id into v_id;
  return v_id is not null;
end;
$$;

create or replace function public.onboarding_email_release(
  p_id uuid,
  p_step integer,
  p_prev_step integer,
  p_prev_sent_at timestamptz,
  p_error text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  update public.onboarding_email_sequence s
     set last_step    = p_prev_step,
         last_sent_at = p_prev_sent_at,
         next_due_at  = now() + interval '1 hour',
         status       = 'active',
         last_error   = left(coalesce(p_error, 'send failed'), 300),
         updated_at   = now()
   where s.id = p_id
     and s.last_step = p_step
     and s.status in ('active', 'completed')
  returning s.id into v_id;
  return v_id is not null;
end;
$$;

create or replace function public.onboarding_email_unsubscribe(
  p_token uuid,
  p_source text default 'link'
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid;
begin
  select user_id into v_user from public.onboarding_email_sequence where unsub_token = p_token;
  if v_user is null then
    return false;
  end if;
  update public.onboarding_email_sequence s
     set status             = 'unsubscribed',
         next_due_at        = null,
         unsubscribed_at    = coalesce(s.unsubscribed_at, now()),
         unsubscribe_source = coalesce(s.unsubscribe_source, case when p_source = 'one_click' then 'one_click' else 'link' end),
         updated_at         = now()
   where s.user_id = v_user
     and s.status <> 'unsubscribed';
  return true;
end;
$$;

revoke execute on function public.onboarding_email_claim(uuid, integer, timestamptz) from public, anon, authenticated;
revoke execute on function public.onboarding_email_release(uuid, integer, integer, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.onboarding_email_unsubscribe(uuid, text) from public, anon, authenticated;
grant execute on function public.onboarding_email_claim(uuid, integer, timestamptz) to service_role;
grant execute on function public.onboarding_email_release(uuid, integer, integer, timestamptz, text) to service_role;
grant execute on function public.onboarding_email_unsubscribe(uuid, text) to service_role;
