
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

revoke execute on function public.onboarding_email_claim(uuid, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.onboarding_email_claim(uuid, integer, timestamptz) to service_role;
