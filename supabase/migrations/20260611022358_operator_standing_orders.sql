

drop function if exists upsert_agent_schedule(uuid, text, text, boolean);

create or replace function upsert_agent_schedule(
  p_tenant_id uuid,
  p_agent_slug text,
  p_cron_expression text,
  p_enabled boolean,
  p_payload_template jsonb default null
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

  if p_payload_template is not null then
    if jsonb_typeof(p_payload_template) <> 'object' then
      raise exception 'payload_template must be a JSON object'
        using errcode = '22023';
    end if;
    if length(p_payload_template::text) > 8000 then
      raise exception 'payload_template too large' using errcode = '22023';
    end if;
  end if;

  insert into tenant_agent_schedules
    (tenant_id, agent_slug, cron_expression, enabled, payload_template)
  values
    (p_tenant_id, p_agent_slug, trim(p_cron_expression), coalesce(p_enabled, true),
     coalesce(p_payload_template, '{}'::jsonb))
  on conflict (tenant_id, agent_slug) do update
    set cron_expression = excluded.cron_expression,
        enabled = excluded.enabled,
        payload_template = coalesce(p_payload_template, tenant_agent_schedules.payload_template);
end $$;

revoke all on function upsert_agent_schedule(uuid, text, text, boolean, jsonb) from public;
grant execute on function upsert_agent_schedule(uuid, text, text, boolean, jsonb) to authenticated;

insert into decision_classes (slug, description, default_autonomy, dispatch_handler) values
  (
    'operator.create-standing-order',
    'Create or replace the operator agent''s scheduled standing-order brief (approval-gated)',
    'approval',
    'praxis.create_standing_order'
  )
on conflict (slug) do nothing;
