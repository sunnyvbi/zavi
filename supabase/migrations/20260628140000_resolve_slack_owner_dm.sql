
create or replace function resolve_slack_owner_dm(p_tenant_id uuid)
returns table (slack_user_id text, team_id text)
language sql
security definer
set search_path = public
as $$
  select tmi.external_id as slack_user_id, tmi.team_id
  from tenant_users tu
  join auth.users u on u.id = tu.user_id
  join team_members tm
    on lower(tm.primary_email) = lower(u.email)
   and tm.tenant_id = tu.tenant_id
   and tm.status = 'active'
  join team_member_identities tmi
    on tmi.member_id = tm.id
   and tmi.tenant_id = tu.tenant_id
   and tmi.provider = 'slack'
  where tu.tenant_id = p_tenant_id
    and tu.role = 'owner'
    and tmi.external_id is not null
    and tmi.external_id <> ''
  order by tmi.team_id nulls last
  limit 1;
$$;

revoke all on function resolve_slack_owner_dm(uuid) from public, authenticated, anon;
grant execute on function resolve_slack_owner_dm(uuid) to service_role;
