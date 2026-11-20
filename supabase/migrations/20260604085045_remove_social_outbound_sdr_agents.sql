
begin;

update system_config
set blob = (
  select jsonb_object_agg(
    key,
    case
      when key in (
        'disabled_agent_slugs','enabled_agent_slugs',
        'marketplace_visible_slugs','disabled_voice_agent_slugs',
        'structured_output_disabled_agents'
      ) and jsonb_typeof(value) = 'array'
      then coalesce(
        (select jsonb_agg(elem)
           from jsonb_array_elements_text(value) as elem
          where elem not in ('social','outbound-sdr')),
        '[]'::jsonb
      )
      else value
    end
  )
  from jsonb_each(blob)
),
    updated_at = now()
where id = 1;

delete from tenant_agent_schedules
where agent_slug in ('social','outbound-sdr');

delete from tenant_agent_kill_switch
where agent_slug in ('social','outbound-sdr');

delete from tenant_decision_class_overrides
where decision_class in ('social.publish','outbound.send');

commit;
