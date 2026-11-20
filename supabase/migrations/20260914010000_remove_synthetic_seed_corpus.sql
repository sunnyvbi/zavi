
begin;

delete from agent_feedback af
where af.target_type = 'agent_run'
  and exists (
    select 1
    from agent_runs ar
    where ar.id = af.target_id
      and ar.agent_definition_hash = 'seed-synthetic'
  );

delete from agent_runs
where agent_definition_hash = 'seed-synthetic';

commit;
