
begin;

delete from tenant_agent_kill_switch where source = 'tenant';

drop function if exists set_kill_switch(uuid, text, boolean, text);
drop function if exists set_kill_switch(uuid, text, boolean, text, text, text[]);

commit;
