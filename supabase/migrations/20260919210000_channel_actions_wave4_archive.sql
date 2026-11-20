

begin;

update decisions d
   set status = 'archived', archived_at = now()
 where d.status = 'proposed'
   and d.decision_class = 'channel.recipe_step'
   and exists (
     select 1 from agent_runs r
      where r.id = d.agent_run_id
        and r.tenant_id = d.tenant_id
        and r.channel_slug = 'influencer'
   );

commit;
