
begin;

alter table connector_metadata
  add column if not exists repo_default_branch_source jsonb not null default '{}'::jsonb;

create or replace function set_github_repo_default_branch_if_not_operator(
  p_tenant_id        uuid,
  p_repo_full_name   text,
  p_default_branch   text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null or p_repo_full_name is null or p_default_branch is null then
    raise exception 'set_github_repo_default_branch_if_not_operator: null arg' using errcode = '22023';
  end if;
  if length(p_repo_full_name) = 0 or length(p_default_branch) = 0 then
    raise exception 'set_github_repo_default_branch_if_not_operator: empty arg' using errcode = '22023';
  end if;

  update connector_metadata
  set repo_default_branches =
        coalesce(repo_default_branches, '{}'::jsonb)
        || jsonb_build_object(p_repo_full_name, p_default_branch),
      repo_default_branch_source =
        coalesce(repo_default_branch_source, '{}'::jsonb)
        || jsonb_build_object(p_repo_full_name, 'github')
  where tenant_id = p_tenant_id
    and slug = 'github'
    and coalesce(repo_default_branch_source ->> p_repo_full_name, 'github') is distinct from 'operator';
end $$;

revoke all on function set_github_repo_default_branch_if_not_operator(uuid, text, text) from public;
grant execute on function set_github_repo_default_branch_if_not_operator(uuid, text, text) to service_role;

create or replace function set_github_repo_operator_branch(
  p_tenant_id        uuid,
  p_repo_full_name   text,
  p_branch           text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_tenant_id is null or p_repo_full_name is null or p_branch is null then
    raise exception 'set_github_repo_operator_branch: null arg' using errcode = '22023';
  end if;
  if length(p_repo_full_name) = 0 or length(p_branch) = 0 or p_branch like '-%'
     or p_branch !~ '^[A-Za-z0-9._/-]+$' then
    raise exception 'set_github_repo_operator_branch: unsafe/empty arg' using errcode = '22023';
  end if;

  update connector_metadata
  set repo_default_branches =
        coalesce(repo_default_branches, '{}'::jsonb)
        || jsonb_build_object(p_repo_full_name, p_branch),
      repo_default_branch_source =
        coalesce(repo_default_branch_source, '{}'::jsonb)
        || jsonb_build_object(p_repo_full_name, 'operator')
  where tenant_id = p_tenant_id and slug = 'github';
end $$;

revoke all on function set_github_repo_operator_branch(uuid, text, text) from public;
grant execute on function set_github_repo_operator_branch(uuid, text, text) to service_role;

create or replace function set_github_repo_base_branch(
  p_tenant_id        uuid,
  p_repo_full_name   text,
  p_branch           text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prev    text;
  v_updated integer;
  v_actor   uuid := auth.uid();
begin
  perform _assert_tenant_admin(p_tenant_id);

  if p_repo_full_name is null or length(p_repo_full_name) = 0 then
    raise exception 'set_github_repo_base_branch: repo_full_name required' using errcode = '22023';
  end if;
  if p_branch is null or length(p_branch) = 0 or p_branch like '-%'
     or p_branch !~ '^[A-Za-z0-9._/-]+$' then
    raise exception 'set_github_repo_base_branch: unsafe branch name' using errcode = '22023';
  end if;

  select repo_default_branches ->> p_repo_full_name
    into v_prev
    from connector_metadata
    where tenant_id = p_tenant_id and slug = 'github';

  update connector_metadata
  set repo_default_branches =
        coalesce(repo_default_branches, '{}'::jsonb)
        || jsonb_build_object(p_repo_full_name, p_branch),
      repo_default_branch_source =
        coalesce(repo_default_branch_source, '{}'::jsonb)
        || jsonb_build_object(p_repo_full_name, 'operator')
  where tenant_id = p_tenant_id
    and slug = 'github'
    and repo_full_names is not null
    and p_repo_full_name = any(repo_full_names);

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'set_github_repo_base_branch: repo not in connected repo_full_names (or github not connected)'
      using errcode = '23514';
  end if;

  insert into tenant_config_audit
    (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
  values
    (p_tenant_id, v_actor, 'set', 'github.repo_base_branch', v_prev, p_branch,
     jsonb_build_object('repo', p_repo_full_name));
end $$;

revoke all on function set_github_repo_base_branch(uuid, text, text) from public;
grant execute on function set_github_repo_base_branch(uuid, text, text) to authenticated;

commit;
