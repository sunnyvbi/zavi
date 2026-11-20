
begin;

alter table memory_note drop constraint if exists memory_note_note_type_check;

alter table memory_note add constraint memory_note_note_type_check
  check (note_type in (
    'operator_preference',
    'agent_feedback',
    'tenant_project',
    'tenant_reference',
    'untyped',
    'anchor',
    'pattern',
    'growth_cross_bet',
    'growth_priorities',
    'growth_attribution_snapshot',
    'ads_channel_perf',
    'social_approved_drafts',
    'growth_funnel_diagnosis',
    'growth_lever_signal',
    'knowledge_gap',
    'correction',
    'agent_experience',
    'learning',
    'skill',
    'agent_procedural',
    'growth_strategy'
  ));

create or replace function _reserve_estimate_for(p_slug text)
returns int language sql immutable as $$
  select case p_slug
    when 'engineer'             then 2000
    when 'product-builder'      then 2400
    when 'fundraising'          then 500
    when 'growth-lead'          then 320
    when 'research'             then 320
    when 'advisor'              then 320
    when 'cgo'                  then 320
    when 'browser-operator'     then 240
    when 'performance-marketer' then 160
    when 'operator'             then 160
    when 'pm'                   then 160
    when 'support-lead'         then 160
    when 'dispute-response'     then 160
    when 'chief-of-staff'       then 160
    when 'qa'                   then 160
    else 340
  end;
$$;

commit;
