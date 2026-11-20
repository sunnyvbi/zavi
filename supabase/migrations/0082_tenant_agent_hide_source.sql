
do $$
declare n int;
begin
  select count(*) into n from tenant_agent_kill_switch;
  raise notice '0082: tenant_agent_kill_switch existing rows = % (expected 0 pre-launch; all backfill to source=tenant)', n;
end $$;

alter table tenant_agent_kill_switch
  add column source text not null default 'tenant'
  check (source in ('tenant','staff'));

create or replace function set_kill_switch(
  p_tenant_id uuid,
  p_agent_slug text,
  p_kill boolean,
  p_reason text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_source text;
begin
  if not exists (
    select 1 from tenant_users
    where tenant_id = p_tenant_id and user_id = auth.uid()
  ) then
    raise exception 'not a member of tenant %', p_tenant_id
      using errcode = '42501';
  end if;

  select source into v_source
  from tenant_agent_kill_switch
  where tenant_id = p_tenant_id and agent_slug = p_agent_slug;

  if p_kill then
    if v_source = 'staff' then
      return;
    elsif v_source = 'tenant' then
      update tenant_agent_kill_switch
        set killed_at = now(), killed_by = auth.uid(), reason = p_reason
        where tenant_id = p_tenant_id and agent_slug = p_agent_slug;
    else
      insert into tenant_agent_kill_switch
        (tenant_id, agent_slug, killed_by, reason, source)
        values (p_tenant_id, p_agent_slug, auth.uid(), p_reason, 'tenant');
    end if;
  else
    if v_source = 'staff' then
      raise exception 'agent hidden by Praxis — contact support to re-enable'
        using errcode = '42501';
    end if;
    delete from tenant_agent_kill_switch
      where tenant_id = p_tenant_id and agent_slug = p_agent_slug
        and source = 'tenant';
  end if;
end $$;
revoke all on function set_kill_switch(uuid, text, boolean, text) from public;
grant execute on function set_kill_switch(uuid, text, boolean, text) to authenticated;

create or replace function staff_set_tenant_agent_hidden(
  p_tenant_id uuid,
  p_agent_slug text,
  p_hide boolean,
  p_reason text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_hide then
    insert into tenant_agent_kill_switch
      (tenant_id, agent_slug, killed_by, reason, source)
      values (p_tenant_id, p_agent_slug, null, p_reason, 'staff')
    on conflict (tenant_id, agent_slug) do update
      set killed_at = now(), reason = excluded.reason, source = 'staff';
  else
    delete from tenant_agent_kill_switch
      where tenant_id = p_tenant_id and agent_slug = p_agent_slug
        and source = 'staff';
  end if;
end $$;
revoke all on function staff_set_tenant_agent_hidden(uuid, text, boolean, text) from public;
grant execute on function staff_set_tenant_agent_hidden(uuid, text, boolean, text) to service_role;
