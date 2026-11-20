
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
    'growth_lever_signal'
  ));

insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values
  (
    'growth-orchestrator.reallocate-budget',
    'growth agent proposes a cross-channel budget reallocation bet. Proposal only — operator approves in /approvals; nothing auto-executes. Body: Tier-1 bet envelope with source_signals[].',
    'approval',
    null
  ),
  (
    'growth-orchestrator.lifecycle-draft',
    'growth agent proposes a lifecycle email/sequence draft (markdown bet parsed by post-run — NOT a callable write tool). Operator approves in /approvals before any send.',
    'approval',
    null
  ),
  (
    'growth-orchestrator.social-draft',
    'growth agent proposes a social post draft (markdown bet parsed by post-run — NOT a callable write tool). Operator approves in /approvals before any publish.',
    'approval',
    null
  )
on conflict (slug) do nothing;
