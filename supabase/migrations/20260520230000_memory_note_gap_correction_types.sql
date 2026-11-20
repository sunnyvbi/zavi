
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
    'correction'
  ));
