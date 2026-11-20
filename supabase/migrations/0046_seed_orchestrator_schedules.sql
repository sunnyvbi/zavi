
insert into tenant_agent_schedules (tenant_id, agent_slug, cron_expression, enabled)
select id, 'product-pm', '0 9 * * *', true from tenants
on conflict (tenant_id, agent_slug) do nothing;

insert into tenant_agent_schedules (tenant_id, agent_slug, cron_expression, enabled)
select id, 'fleet-auditor', '0 10 * * 1', true from tenants
on conflict (tenant_id, agent_slug) do nothing;
