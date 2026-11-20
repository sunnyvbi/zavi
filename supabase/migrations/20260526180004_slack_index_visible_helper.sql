
create or replace function slack_index_visible(p_tenant uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select not exists (
    select 1 from tenant_slack_index_state
    where tenant_id = p_tenant
      and disabled_at is not null
  );
$$;

revoke all on function slack_index_visible(uuid) from public, anon;
grant execute on function slack_index_visible(uuid) to authenticated, service_role;

create policy slack_message_index_member_select on slack_message_index
  for select using (
    slack_index_visible(slack_message_index.tenant_id)
    and exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid()
        and tu.tenant_id = slack_message_index.tenant_id
    )
  );
