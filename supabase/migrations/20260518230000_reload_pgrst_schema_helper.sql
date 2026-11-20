
create or replace function reload_pgrst_schema()
returns text
language plpgsql
security definer
set search_path = public
as $fn$
begin
  notify pgrst, 'reload schema';
  return 'reload signal sent';
end;
$fn$;

revoke all on function reload_pgrst_schema() from public, anon, authenticated;
grant execute on function reload_pgrst_schema() to service_role;

comment on function reload_pgrst_schema() is 'Force PostgREST in-memory schema cache reload. Call after every supabase db push. Service-role only. See apps/backend/scripts/reload-pgrst-schema.sh for runbook.';
