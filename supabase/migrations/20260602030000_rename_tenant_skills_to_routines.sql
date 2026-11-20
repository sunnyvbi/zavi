
begin;

alter table tenant_skills rename to tenant_routines;
alter table tenant_routines rename column skill_name to routine_name;
alter table tenant_routines rename column skill_spec to routine_spec;

alter index tenant_skills_approved_emitted_uq   rename to tenant_routines_approved_emitted_uq;
alter index tenant_skills_by_tenant_agent_status rename to tenant_routines_by_tenant_agent_status;

alter policy tenant_skills_member_select on tenant_routines rename to tenant_routines_member_select;

alter trigger tenant_skills_assert_source_note_trg on tenant_routines
  rename to tenant_routines_assert_source_note_trg;
alter function tenant_skills_assert_source_note() rename to tenant_routines_assert_source_note;

create view tenant_skills with (security_invoker = true) as
  select
    id,
    tenant_id,
    agent_slug,
    source_note_id,
    source_note_ids,
    provenance,
    routine_name        as skill_name,
    emitted_tool_name,
    routine_spec        as skill_spec,
    spec_version,
    granted_tool_names,
    provenance_agent_def_hash,
    status,
    founder_blessed,
    faithfulness_clean,
    csat_signal,
    decided_by,
    decided_at,
    created_at
  from tenant_routines;

comment on view tenant_skills is
  'TRANSITIONAL compat shim for the skill->routine rename (migration 20260602030000). '
  'Aliases tenant_routines + routine_name/routine_spec back to the old tenant_skills/'
  'skill_name/skill_spec names so pre-deploy code resolves during the rollout window. '
  'DROP in the next migration once all references use tenant_routines.';

commit;
