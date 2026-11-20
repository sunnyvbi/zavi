create or replace function resolve_decision_actors(
  p_tenant_id uuid,
  p_user_ids uuid[]
) returns table(user_id uuid, label text)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not exists (
    select 1 from tenant_users tu
    where tu.user_id = auth.uid() and tu.tenant_id = p_tenant_id
  ) then
    return;
  end if;

  return query
  select u.id as user_id,
    case
      when exists (
        select 1 from tenant_users m
        where m.user_id = u.id and m.tenant_id = p_tenant_id
      ) then coalesce(
        (select tm.display_name
           from team_members tm
          where tm.tenant_id = p_tenant_id
            and lower(tm.primary_email) = lower(u.email)
            and tm.status = 'active'
          limit 1),
        u.email
      )
      else 'Zavi staff'
    end as label
  from auth.users u
  where u.id = any(p_user_ids);
end $$;

revoke all on function resolve_decision_actors(uuid, uuid[]) from public, anon;
grant execute on function resolve_decision_actors(uuid, uuid[]) to authenticated, service_role;
