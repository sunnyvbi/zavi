
begin;

create or replace function connector_metadata_github_default_reachable_tg()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp as $$
declare
  v_reachable text[];
  v_pick      text;
  v_reason    text;
begin
  if new.slug is distinct from 'github' then
    return new;
  end if;

  select coalesce(array_agg(n.full_name order by n.ord), array[]::text[])
    into v_reachable
    from unnest(coalesce(new.repo_full_names, array[]::text[]))
           with ordinality as n(full_name, ord)
   where new.selected_repo_ids is null
      or coalesce(new.repo_ids[n.ord] = any(new.selected_repo_ids), false);

  if new.default_repo_full_name is not null
     and new.default_repo_full_name = any(v_reachable) then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.default_repo_full_name is not null
     and old.default_repo_full_name = any(v_reachable) then
    v_pick := old.default_repo_full_name;
    v_reason := 'default_repo_cannot_be_cleared';
  elsif array_length(v_reachable, 1) >= 1 then
    v_pick := v_reachable[1];
    v_reason := case when new.default_repo_full_name is null
                     then 'default_repo_missing'
                     else 'default_repo_not_reachable' end;
  else
    v_pick := null;
    v_reason := 'no_reachable_repo';
  end if;

  if v_pick is distinct from
     (case when tg_op = 'UPDATE' then old.default_repo_full_name end) then
    insert into tenant_config_audit
      (tenant_id, actor_user_id, action, target, prev_value, next_value, meta)
    values
      (new.tenant_id,
       coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid),
       case when v_pick is null then 'clear' else 'set' end,
       'github.default_repo',
       case when tg_op = 'UPDATE' then old.default_repo_full_name end,
       v_pick,
       jsonb_build_object('source', 'trigger_' || lower(tg_op),
                          'reason', v_reason));
  end if;

  new.default_repo_full_name := v_pick;
  return new;
end $$;

revoke all on function connector_metadata_github_default_reachable_tg() from public, anon, authenticated;

update connector_metadata
   set default_repo_full_name = default_repo_full_name
 where slug = 'github'
   and default_repo_full_name is null
   and coalesce(array_length(repo_full_names, 1), 0) > 0;

commit;
