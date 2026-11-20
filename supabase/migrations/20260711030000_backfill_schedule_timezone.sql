
update tenant_agent_schedules s
   set timezone = t.timezone
  from tenants t
 where s.tenant_id = t.id
   and s.timezone is null
   and t.timezone is not null;
