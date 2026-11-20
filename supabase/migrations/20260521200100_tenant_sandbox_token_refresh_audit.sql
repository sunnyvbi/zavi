
alter table public.tenant_sandbox
  add column if not exists last_token_refresh_at timestamptz;

create or replace function mark_sandbox_token_refreshed(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.tenant_sandbox
     set last_token_refresh_at = now(), updated_at = now()
   where id = p_id;
end $$;

revoke all on function mark_sandbox_token_refreshed(uuid) from public;
grant execute on function mark_sandbox_token_refreshed(uuid) to service_role;
