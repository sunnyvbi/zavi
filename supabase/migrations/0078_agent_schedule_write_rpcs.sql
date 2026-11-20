
create or replace function upsert_agent_schedule(
  p_tenant_id uuid,
  p_agent_slug text,
  p_cron_expression text,
  p_enabled boolean
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from tenant_users
    where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
  end if;

  if p_agent_slug is null or length(trim(p_agent_slug)) = 0 then
    raise exception 'agent_slug required' using errcode = '22023';
  end if;

  if p_cron_expression !~ '^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$'
     or p_cron_expression ~ '[^0-9*,/ -]' then
    raise exception 'invalid cron_expression %', p_cron_expression
      using errcode = '22023';
  end if;

  insert into tenant_agent_schedules
    (tenant_id, agent_slug, cron_expression, enabled)
  values
    (p_tenant_id, p_agent_slug, trim(p_cron_expression), coalesce(p_enabled, true))
  on conflict (tenant_id, agent_slug) do update
    set cron_expression = excluded.cron_expression,
        enabled = excluded.enabled;
end $$;

create or replace function delete_agent_schedule(
  p_tenant_id uuid,
  p_agent_slug text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from tenant_users
    where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
  end if;
  delete from tenant_agent_schedules
   where tenant_id = p_tenant_id and agent_slug = p_agent_slug;
end $$;

revoke all on function upsert_agent_schedule(uuid, text, text, boolean) from public;
grant execute on function upsert_agent_schedule(uuid, text, text, boolean) to authenticated;
revoke all on function delete_agent_schedule(uuid, text) from public;
grant execute on function delete_agent_schedule(uuid, text) to authenticated;
