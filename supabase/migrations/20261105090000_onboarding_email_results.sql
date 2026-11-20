
alter table public.onboarding_email_sequence
  add column if not exists sent_steps    integer[] not null default '{}',
  add column if not exists skipped_steps integer[] not null default '{}',
  add column if not exists channel_order integer[],
  add column if not exists wait_since    timestamptz,
  add column if not exists digest_until  timestamptz;

comment on column public.onboarding_email_sequence.sent_steps is
  'Email numbers already sent (or counted as sent). The claim refuses a step in here.';
comment on column public.onboarding_email_sequence.skipped_steps is
  'Email numbers deliberately not sent (the day-1 email not chosen, a channel the workspace already used).';
comment on column public.onboarding_email_sequence.channel_order is
  'The order of the four channel emails (3, 4, 6, 7), decided once when the first one is due.';
comment on column public.onboarding_email_sequence.wait_since is
  'When the sender first deferred the current email for a still-running onboarding run (24h cap).';
comment on column public.onboarding_email_sequence.digest_until is
  'People enrolled before the digest existed: the digest may still go until this time.';

update public.onboarding_email_sequence s
   set sent_steps = array(
         select x from unnest(array[1, 2, 3, 4, 6, 7, 8, 9]) as x
          where x <= s.last_step
          order by x
       )
 where s.sent_steps = '{}';

update public.onboarding_email_sequence
   set digest_until = now() + interval '14 days',
       updated_at   = now()
 where status in ('active', 'completed');

update public.onboarding_email_sequence
   set status      = 'active',
       next_due_at = now(),
       updated_at  = now()
 where status = 'completed';

create unique index if not exists onboarding_email_sequence_one_live_per_person
  on public.onboarding_email_sequence (user_id)
  where status in ('active', 'completed');

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
         sent_steps   = case when p_step = any(s.sent_steps) then s.sent_steps else s.sent_steps || p_step end,
         last_error   = null,
         updated_at   = now()
   where s.id = p_id
     and s.status = 'active'
     and s.last_step < p_step
     and not (p_step = any(s.sent_steps))
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

create or replace function public.onboarding_email_claim_step(
  p_id uuid,
  p_step integer,
  p_also integer[],
  p_skip integer[],
  p_next_due timestamptz,
  p_channel_order integer[]
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_step is null or p_step < 1 or p_step > 99 then
    return false;
  end if;
  update public.onboarding_email_sequence s
     set last_step     = p_step,
         last_sent_at  = now(),
         next_due_at   = p_next_due,
         status        = case when p_next_due is null then 'completed' else 'active' end,
         sent_steps    = array(
                           select distinct x from unnest(s.sent_steps || p_step || coalesce(p_also, '{}'::integer[])) as x
                            order by x
                         ),
         skipped_steps = array(
                           select distinct x from unnest(s.skipped_steps || coalesce(p_skip, '{}'::integer[])) as x
                            order by x
                         ),
         channel_order = coalesce(s.channel_order, p_channel_order),
         wait_since    = null,
         last_error    = null,
         updated_at    = now()
   where s.id = p_id
     and s.status = 'active'
     and not (p_step = any(s.sent_steps))
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

create or replace function public.onboarding_email_release_step(
  p_id uuid,
  p_step integer,
  p_also integer[],
  p_skip integer[],
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
     set last_step     = p_prev_step,
         last_sent_at  = p_prev_sent_at,
         next_due_at   = now() + interval '1 hour',
         status        = 'active',
         sent_steps    = array(
                           select x from unnest(s.sent_steps) as x
                            where x <> p_step and not (x = any(coalesce(p_also, '{}'::integer[])))
                            order by x
                         ),
         skipped_steps = array(
                           select x from unnest(s.skipped_steps) as x
                            where not (x = any(coalesce(p_skip, '{}'::integer[])))
                            order by x
                         ),
         last_error    = left(coalesce(p_error, 'send failed'), 300),
         updated_at    = now()
   where s.id = p_id
     and s.last_step = p_step
     and p_step = any(s.sent_steps)
     and s.status in ('active', 'completed')
  returning s.id into v_id;
  return v_id is not null;
end;
$$;

revoke execute on function public.onboarding_email_claim(uuid, integer, timestamptz) from public, anon, authenticated;
revoke execute on function public.onboarding_email_release(uuid, integer, integer, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.onboarding_email_claim_step(uuid, integer, integer[], integer[], timestamptz, integer[]) from public, anon, authenticated;
revoke execute on function public.onboarding_email_release_step(uuid, integer, integer[], integer[], integer, timestamptz, text) from public, anon, authenticated;
grant execute on function public.onboarding_email_claim(uuid, integer, timestamptz) to service_role;
grant execute on function public.onboarding_email_release(uuid, integer, integer, timestamptz, text) to service_role;
grant execute on function public.onboarding_email_claim_step(uuid, integer, integer[], integer[], timestamptz, integer[]) to service_role;
grant execute on function public.onboarding_email_release_step(uuid, integer, integer[], integer[], integer, timestamptz, text) to service_role;
