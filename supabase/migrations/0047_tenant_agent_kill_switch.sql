
create table tenant_agent_kill_switch (
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_slug text not null,
  killed_at timestamptz not null default now(),
  killed_by uuid references auth.users(id),
  reason text,
  primary key (tenant_id, agent_slug)
);

alter table tenant_agent_kill_switch enable row level security;

create policy tenant_agent_kill_switch_member_select on tenant_agent_kill_switch
  for select to authenticated using (
    exists (
      select 1 from tenant_users
      where tenant_users.tenant_id = tenant_agent_kill_switch.tenant_id
        and tenant_users.user_id = auth.uid()
    )
  );

revoke insert, update, delete on tenant_agent_kill_switch from authenticated, anon;
grant select on tenant_agent_kill_switch to authenticated;
grant all on tenant_agent_kill_switch to service_role;

create or replace function set_kill_switch(
  p_tenant_id uuid,
  p_agent_slug text,
  p_kill boolean,
  p_reason text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from tenant_users
    where tenant_id = p_tenant_id and user_id = auth.uid()
  ) then
    raise exception 'not a member of tenant %', p_tenant_id
      using errcode = '42501';
  end if;

  if p_kill then
    insert into tenant_agent_kill_switch (tenant_id, agent_slug, killed_by, reason)
    values (p_tenant_id, p_agent_slug, auth.uid(), p_reason)
    on conflict (tenant_id, agent_slug) do update
      set killed_at = now(),
          killed_by = excluded.killed_by,
          reason = excluded.reason;
  else
    delete from tenant_agent_kill_switch
     where tenant_id = p_tenant_id and agent_slug = p_agent_slug;
  end if;
end $$;
revoke all on function set_kill_switch(uuid, text, boolean, text) from public;
grant execute on function set_kill_switch(uuid, text, boolean, text) to authenticated;

create or replace function emit_decision(
  p_tenant_id uuid,
  p_agent_run_id uuid,
  p_decision_class text,
  p_body jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_autonomy decision_autonomy;
  v_handler text;
  v_status text;
  v_class_exists boolean;
  v_killed boolean;
  v_agent_slug text;
begin
  select exists(select 1 from decision_classes where slug = p_decision_class) into v_class_exists;
  if not v_class_exists then
    raise exception 'unknown decision_class: %', p_decision_class
      using errcode = '23514';
  end if;

  if p_agent_run_id is not null then
    select agent_slug into v_agent_slug from agent_runs where id = p_agent_run_id;
    if v_agent_slug is not null then
      select exists(
        select 1 from tenant_agent_kill_switch
         where tenant_id = p_tenant_id and agent_slug = v_agent_slug
      ) into v_killed;
      if v_killed then
        insert into decisions (
          tenant_id, agent_run_id, decision_class, body, status,
          autonomy_at_emit, handler, dispatch_error
        ) values (
          p_tenant_id, p_agent_run_id, p_decision_class, p_body, 'rejected',
          'forbidden', null, 'kill_switch'
        ) returning id into v_id;
        return v_id;
      end if;
    end if;
  end if;

  v_autonomy := effective_autonomy(p_tenant_id, p_decision_class);
  select dispatch_handler into v_handler
  from decision_classes where slug = p_decision_class;

  if v_autonomy = 'forbidden' then
    v_status := 'rejected';
  elsif v_autonomy = 'auto' then
    v_status := 'proposed';
  else
    v_status := 'proposed';
  end if;

  insert into decisions (
    tenant_id, agent_run_id, decision_class, body, status,
    autonomy_at_emit, handler
  ) values (
    p_tenant_id, p_agent_run_id, p_decision_class, p_body, v_status,
    v_autonomy, v_handler
  ) returning id into v_id;

  return v_id;
end $$;
revoke all on function emit_decision(uuid, uuid, text, jsonb) from public;
grant execute on function emit_decision(uuid, uuid, text, jsonb) to service_role;
