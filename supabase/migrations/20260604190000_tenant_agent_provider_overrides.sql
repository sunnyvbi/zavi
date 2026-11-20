
create table if not exists tenant_agent_provider_overrides (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  agent_slug  text not null,
  provider    text not null check (provider in ('anthropic', 'openai')),
  model       text not null check (length(btrim(model)) > 0),
  note        text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id),
  primary key (tenant_id, agent_slug)
);

alter table tenant_agent_provider_overrides enable row level security;

drop policy if exists tapo_member_select on tenant_agent_provider_overrides;
create policy tapo_member_select on tenant_agent_provider_overrides
  for select to authenticated using (
    exists (
      select 1 from tenant_users
      where tenant_users.tenant_id = tenant_agent_provider_overrides.tenant_id
        and tenant_users.user_id = auth.uid()
    )
  );

revoke insert, update, delete on tenant_agent_provider_overrides from authenticated, anon;
grant select on tenant_agent_provider_overrides to authenticated;
grant all on tenant_agent_provider_overrides to service_role;

create or replace function set_tenant_agent_provider(
  p_tenant_id  uuid,
  p_agent_slug text,
  p_provider   text,
  p_model      text,
  p_note       text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_provider not in ('anthropic', 'openai') then
    raise exception 'invalid provider %, must be anthropic|openai', p_provider
      using errcode = '22023';
  end if;
  if p_model is null or length(btrim(p_model)) = 0 then
    raise exception 'model is required' using errcode = '22023';
  end if;
  if p_provider = 'openai' and p_model ~* '^claude[-_]' then
    raise exception 'provider=openai but model % is a Claude model', p_model
      using errcode = '22023';
  end if;

  insert into tenant_agent_provider_overrides
    (tenant_id, agent_slug, provider, model, note, updated_at)
  values (p_tenant_id, p_agent_slug, p_provider, p_model, p_note, now())
  on conflict (tenant_id, agent_slug) do update
    set provider = excluded.provider,
        model = excluded.model,
        note = excluded.note,
        updated_at = now();
end $$;

revoke all on function set_tenant_agent_provider(uuid, text, text, text, text) from public, authenticated, anon;
grant execute on function set_tenant_agent_provider(uuid, text, text, text, text) to service_role;

create or replace function clear_tenant_agent_provider(
  p_tenant_id  uuid,
  p_agent_slug text
) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from tenant_agent_provider_overrides
   where tenant_id = p_tenant_id and agent_slug = p_agent_slug;
end $$;

revoke all on function clear_tenant_agent_provider(uuid, text) from public, authenticated, anon;
grant execute on function clear_tenant_agent_provider(uuid, text) to service_role;
