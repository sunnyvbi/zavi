
alter table public.social_publish_attempts
  drop constraint if exists social_publish_attempts_status_check;

alter table public.social_publish_attempts
  add constraint social_publish_attempts_status_check
  check (status in ('claimed', 'sending', 'succeeded', 'failed', 'unknown'));

create or replace function public.social_publish_begin_send(
  p_post_id uuid,
  p_idempotency_key text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_changed integer;
begin
  update public.social_publish_attempts
     set status = 'sending'
   where post_id = p_post_id
     and idempotency_key = p_idempotency_key
     and status = 'claimed';

  get diagnostics v_changed = row_count;
  return v_changed = 1;
end;
$$;

revoke all on function public.social_publish_begin_send(uuid, text) from public, anon, authenticated;
grant execute on function public.social_publish_begin_send(uuid, text) to service_role;
