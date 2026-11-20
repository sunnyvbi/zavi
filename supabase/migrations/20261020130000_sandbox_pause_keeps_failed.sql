
create or replace function mark_sandbox_paused(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.tenant_sandbox
  set status = 'paused', updated_at = now()
  where id = p_id
    and status not in ('failed', 'destroyed');
end $$;
revoke all on function mark_sandbox_paused(uuid)
  from public, anon, authenticated;
grant execute on function mark_sandbox_paused(uuid) to service_role;

create or replace function retire_sandbox_box(
  p_e2b_sandbox_id text,
  p_error text
) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_count integer;
begin
  update public.tenant_sandbox
  set status     = 'failed',
      last_error = left(coalesce(p_error, ''), 1000),
      updated_at = now()
  where e2b_sandbox_id = p_e2b_sandbox_id
    and status <> 'destroyed';
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function retire_sandbox_box(text, text)
  from public, anon, authenticated;
grant execute on function retire_sandbox_box(text, text) to service_role;
