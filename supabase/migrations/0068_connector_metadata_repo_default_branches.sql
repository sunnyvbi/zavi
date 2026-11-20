
begin;

alter table connector_metadata
  add column if not exists repo_default_branches jsonb not null default '{}'::jsonb;

create or replace function set_github_repo_default_branch(
  p_tenant_id        uuid,
  p_repo_full_name   text,
  p_default_branch   text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_tenant_id is null or p_repo_full_name is null or p_default_branch is null then
    raise exception 'set_github_repo_default_branch: null arg' using errcode = '22023';
  end if;
  if length(p_repo_full_name) = 0 or length(p_default_branch) = 0 then
    raise exception 'set_github_repo_default_branch: empty arg' using errcode = '22023';
  end if;

  update connector_metadata
  set repo_default_branches =
    coalesce(repo_default_branches, '{}'::jsonb)
    || jsonb_build_object(p_repo_full_name, p_default_branch)
  where tenant_id = p_tenant_id and slug = 'github';
end $$;

revoke all on function set_github_repo_default_branch(uuid, text, text) from public;
grant execute on function set_github_repo_default_branch(uuid, text, text) to service_role;

commit;
