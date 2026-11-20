
begin;

with orphaned as (
  select
    cm.tenant_id,
    cm.default_repo_full_name as prev_default
  from connector_metadata cm
  where cm.slug = 'github'
    and cm.default_repo_full_name is not null
    and cm.selected_repo_ids is not null
    and coalesce(
      cm.repo_ids[array_position(cm.repo_full_names, cm.default_repo_full_name)]
        = any(cm.selected_repo_ids),
      false
    ) = false
),
cleared as (
  update connector_metadata cm
    set default_repo_full_name = null
    from orphaned o
    where cm.tenant_id = o.tenant_id
      and cm.slug = 'github'
    returning cm.tenant_id, o.prev_default
)
insert into tenant_config_audit
  (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
select
  c.tenant_id,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'clear',
  'github.default_repo',
  c.prev_default,
  null,
  jsonb_build_object('source', 'migration_20260829080000',
                     'reason', 'default_repo_not_in_selected_repos')
from cleared c;

create or replace function connector_metadata_github_default_reachable_tg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp as $$
declare
  v_pos int;
  v_id  bigint;
begin
  if new.slug is distinct from 'github' then
    return new;
  end if;

  if new.default_repo_full_name is null or new.selected_repo_ids is null then
    return new;
  end if;

  v_pos := array_position(coalesce(new.repo_full_names, array[]::text[]),
                          new.default_repo_full_name);
  if v_pos is not null
     and new.repo_ids is not null
     and array_length(new.repo_ids, 1) >= v_pos then
    v_id := new.repo_ids[v_pos];
    if v_id = any(new.selected_repo_ids) then
      return new;
    end if;
  end if;

  insert into tenant_config_audit
    (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
  values
    (new.tenant_id,
     coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid),
     'clear',
     'github.default_repo',
     new.default_repo_full_name,
     null,
     jsonb_build_object('source', 'trigger_' || lower(tg_op),
                        'reason', 'default_repo_not_in_selected_repos'));

  new.default_repo_full_name := null;
  return new;
end $$;

revoke all on function connector_metadata_github_default_reachable_tg() from public;

drop trigger if exists connector_metadata_github_default_reachable
  on connector_metadata;
create trigger connector_metadata_github_default_reachable
  before insert or update on connector_metadata
  for each row
  execute function connector_metadata_github_default_reachable_tg();

create or replace function set_github_default_repo(
  p_tenant_id        uuid,
  p_repo_full_name   text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prev       text;
  v_updated    integer;
  v_actor      uuid := auth.uid();
  v_names      text[];
  v_ids        bigint[];
  v_selected   bigint[];
  v_pos        int;
begin
  perform _assert_tenant_admin(p_tenant_id);

  if p_repo_full_name is null or length(p_repo_full_name) = 0 then
    raise exception 'set_github_default_repo: repo_full_name required'
      using errcode = '22023';
  end if;

  select default_repo_full_name, repo_full_names, repo_ids, selected_repo_ids
    into v_prev, v_names, v_ids, v_selected
    from connector_metadata
    where tenant_id = p_tenant_id and slug = 'github';

  if v_selected is not null then
    v_pos := array_position(coalesce(v_names, array[]::text[]), p_repo_full_name);
    if v_pos is null
       or v_ids is null
       or array_length(v_ids, 1) < v_pos
       or not (v_ids[v_pos] = any(v_selected)) then
      raise exception 'set_github_default_repo: % is not in the tenant''s selected repositories', p_repo_full_name
        using errcode = '23514';
    end if;
  end if;

  update connector_metadata
    set default_repo_full_name = p_repo_full_name
    where tenant_id = p_tenant_id
      and slug      = 'github'
      and repo_full_names is not null
      and p_repo_full_name = any(repo_full_names);

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'set_github_default_repo: repo_full_name not in connected repo_full_names (or github not connected)'
      using errcode = '23514';
  end if;

  insert into tenant_config_audit
    (tenant_id, actor_user_id, action, target, prev_value, next_value)
  values
    (p_tenant_id, v_actor, 'set', 'github.default_repo', v_prev, p_repo_full_name);
end $$;

revoke all on function set_github_default_repo(uuid, text) from public;
grant execute on function set_github_default_repo(uuid, text) to authenticated;

commit;
