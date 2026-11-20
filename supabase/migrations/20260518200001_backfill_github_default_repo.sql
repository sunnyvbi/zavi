
begin;

with updated as (
  update connector_metadata
    set default_repo_full_name = repo_full_names[1]
    where slug = 'github'
      and default_repo_full_name is null
      and repo_full_names is not null
      and array_length(repo_full_names, 1) = 1
  returning tenant_id, default_repo_full_name
)
insert into tenant_config_audit
  (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
select
  tenant_id,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'set',
  'github.default_repo',
  null,
  default_repo_full_name,
  jsonb_build_object('source', 'backfill_20260518200001')
from updated;

commit;
