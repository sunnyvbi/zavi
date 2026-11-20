
alter table tenant_agent_provider_overrides
  drop constraint if exists tenant_agent_provider_overrides_provider_check;
alter table tenant_agent_provider_overrides
  add constraint tenant_agent_provider_overrides_provider_check
  check (provider in ('anthropic', 'openai', 'bedrock'));

create or replace function set_tenant_agent_provider(
  p_tenant_id  uuid,
  p_agent_slug text,
  p_provider   text,
  p_model      text,
  p_note       text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_provider not in ('anthropic', 'openai', 'bedrock') then
    raise exception 'invalid provider %, must be anthropic|openai|bedrock', p_provider
      using errcode = '22023';
  end if;
  if p_model is null or length(btrim(p_model)) = 0 then
    raise exception 'model is required' using errcode = '22023';
  end if;
  if p_provider <> 'anthropic' and p_model ~* '^claude[-_]' then
    raise exception 'provider=% but model % is a Claude model', p_provider, p_model
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
