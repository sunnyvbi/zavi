
insert into tenant_agent_schedules (tenant_id, agent_slug, cron_expression, enabled, payload_template)
select c.tenant_id, c.agent_slug, c.cron_expression, c.enabled, c.payload_template
from (
  values
    ('73db45ff-457e-4541-bc8f-bdb625390204'::uuid, 'chief-of-staff', '0 9 * * 1-5', true, '{}'::jsonb),
    ('5f05d826-7793-45d1-88f9-c5c5bb3f0347'::uuid, 'chief-of-staff', '0 9 * * 1-5', true, '{}'::jsonb)
) as c(tenant_id, agent_slug, cron_expression, enabled, payload_template)
where exists (select 1 from tenants t where t.id = c.tenant_id)
on conflict (tenant_id, agent_slug) do nothing;
