
drop policy if exists "auth_admin_read_profiles_for_token_hook" on public.profiles;
create policy "auth_admin_read_profiles_for_token_hook"
  on public.profiles
  as permissive
  for select
  to supabase_auth_admin
  using (true);
