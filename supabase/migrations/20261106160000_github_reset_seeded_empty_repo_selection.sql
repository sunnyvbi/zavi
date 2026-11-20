update public.connector_metadata c
   set selected_repo_ids = null
 where c.slug = 'github'
   and c.selected_repo_ids = '{}'::bigint[]
   and not exists (
     select 1
       from public.tenant_config_audit a
      where a.tenant_id = c.tenant_id
        and a.target = 'github.selected_repos'
        and a.action = 'set'
        and a.created_at >= c.connected_at
   );
