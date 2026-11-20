
do $$
declare n int;
begin
  select count(*) into n from tenant_agent_kill_switch;
  raise notice '0085: tenant_agent_kill_switch existing rows = % (backfilling to override_state=hidden)', n;
end $$;

alter table tenant_agent_kill_switch
  add column override_state text not null default 'hidden'
  check (override_state in ('hidden', 'visible'));

create index if not exists tenant_agent_kill_switch_visible_idx
  on tenant_agent_kill_switch (tenant_id)
  where override_state = 'visible';

drop function if exists set_kill_switch(uuid, text, boolean, text);
drop function if exists staff_set_tenant_agent_hidden(uuid, text, boolean, text);

create or replace function set_kill_switch(
  p_tenant_id uuid,
  p_agent_slug text,
  p_kill boolean,
  p_reason text default null,
  p_override_state text default 'hidden',
  p_always_on_slugs text[] default array[]::text[]
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_source text;
begin
  if not (p_override_state in ('hidden', 'visible')) then
    raise exception 'invalid override_state: %', p_override_state
      using errcode = '22023';
  end if;

  if not exists (
    select 1 from tenant_users
    where tenant_id = p_tenant_id and user_id = auth.uid()
  ) then
    raise exception 'not a member of tenant %', p_tenant_id
      using errcode = '42501';
  end if;

  if p_agent_slug = ANY(p_always_on_slugs) then
    if p_kill and p_override_state = 'hidden' then
      raise exception 'agent % is always_on (locked visible); cannot hide', p_agent_slug
        using errcode = '42501';
    end if;
    if not p_kill then
      delete from tenant_agent_kill_switch
        where tenant_id = p_tenant_id and agent_slug = p_agent_slug
          and source = 'tenant';
      return;
    end if;
    return;
  end if;

  select source into v_source
  from tenant_agent_kill_switch
  where tenant_id = p_tenant_id and agent_slug = p_agent_slug;

  if p_kill then
    if v_source = 'staff' then
      return;
    elsif v_source = 'tenant' then
      update tenant_agent_kill_switch
        set killed_at = now(),
            killed_by = auth.uid(),
            reason = p_reason,
            override_state = p_override_state
        where tenant_id = p_tenant_id and agent_slug = p_agent_slug;
    else
      insert into tenant_agent_kill_switch
        (tenant_id, agent_slug, killed_by, reason, source, override_state)
        values (p_tenant_id, p_agent_slug, auth.uid(), p_reason, 'tenant', p_override_state);
    end if;
  else
    if v_source = 'staff' then
      raise exception 'agent locked by Praxis — contact support to re-enable'
        using errcode = '42501';
    end if;
    delete from tenant_agent_kill_switch
      where tenant_id = p_tenant_id and agent_slug = p_agent_slug
        and source = 'tenant';
  end if;
end $$;
revoke all on function set_kill_switch(uuid, text, boolean, text, text, text[]) from public;
grant execute on function set_kill_switch(uuid, text, boolean, text, text, text[]) to authenticated;

create or replace function staff_set_tenant_agent_hidden(
  p_tenant_id uuid,
  p_agent_slug text,
  p_hide boolean,
  p_reason text default null,
  p_override_state text default 'hidden',
  p_always_on_slugs text[] default array[]::text[]
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (p_override_state in ('hidden', 'visible')) then
    raise exception 'invalid override_state: %', p_override_state
      using errcode = '22023';
  end if;

  if p_agent_slug = ANY(p_always_on_slugs) then
    if p_hide and p_override_state = 'hidden' then
      raise exception 'agent % is always_on (locked visible); cannot hide', p_agent_slug
        using errcode = '42501';
    end if;
    if not p_hide then
      delete from tenant_agent_kill_switch
        where tenant_id = p_tenant_id and agent_slug = p_agent_slug
          and source = 'staff';
    end if;
    return;
  end if;

  if p_hide then
    insert into tenant_agent_kill_switch
      (tenant_id, agent_slug, killed_by, reason, source, override_state)
      values (p_tenant_id, p_agent_slug, null, p_reason, 'staff', p_override_state)
    on conflict (tenant_id, agent_slug) do update
      set killed_at = now(),
          reason = excluded.reason,
          source = 'staff',
          override_state = excluded.override_state;
  else
    delete from tenant_agent_kill_switch
      where tenant_id = p_tenant_id and agent_slug = p_agent_slug
        and source = 'staff';
  end if;
end $$;
revoke all on function staff_set_tenant_agent_hidden(uuid, text, boolean, text, text, text[]) from public;
grant execute on function staff_set_tenant_agent_hidden(uuid, text, boolean, text, text, text[]) to service_role;
