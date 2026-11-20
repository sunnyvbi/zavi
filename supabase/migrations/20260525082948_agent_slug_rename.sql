
begin;

update agent_runs set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update agent_runs set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update agent_runs set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update agent_runs set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update agent_runs set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update agent_runs set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';

update agent_threads set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update agent_threads set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update agent_threads set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update agent_threads set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update agent_threads set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update agent_threads set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';

update agent_feedback set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update agent_feedback set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update agent_feedback set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update agent_feedback set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update agent_feedback set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update agent_feedback set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';

update agent_engagement_signals set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update agent_engagement_signals set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update agent_engagement_signals set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update agent_engagement_signals set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update agent_engagement_signals set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update agent_engagement_signals set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';

update agent_prediction_signals set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update agent_prediction_signals set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update agent_prediction_signals set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update agent_prediction_signals set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update agent_prediction_signals set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update agent_prediction_signals set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';

update tenant_agents set slug = 'pm'                   where slug = 'product-pm';
update tenant_agents set slug = 'engineer'             where slug = 'cto-engineer';
update tenant_agents set slug = 'qa'                   where slug = 'qa-engineer';
update tenant_agents set slug = 'growth-lead'          where slug = 'growth-orchestrator';
update tenant_agents set slug = 'performance-marketer' where slug = 'ads-manager';
update tenant_agents set slug = 'support-lead'         where slug = 'ops-frontline';

update tenant_agent_schedules set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update tenant_agent_schedules set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update tenant_agent_schedules set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update tenant_agent_schedules set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update tenant_agent_schedules set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update tenant_agent_schedules set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';

update tenant_agent_kill_switch set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update tenant_agent_kill_switch set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update tenant_agent_kill_switch set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update tenant_agent_kill_switch set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update tenant_agent_kill_switch set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update tenant_agent_kill_switch set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';

update tenant_member_agents set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update tenant_member_agents set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update tenant_member_agents set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update tenant_member_agents set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update tenant_member_agents set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update tenant_member_agents set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';

update tenant_agent_email_identity set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update tenant_agent_email_identity set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update tenant_agent_email_identity set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update tenant_agent_email_identity set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update tenant_agent_email_identity set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update tenant_agent_email_identity set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';

update enqueue_rejections set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update enqueue_rejections set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update enqueue_rejections set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update enqueue_rejections set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update enqueue_rejections set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update enqueue_rejections set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';

update agent_setup_state set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update agent_setup_state set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update agent_setup_state set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update agent_setup_state set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update agent_setup_state set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update agent_setup_state set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';

update agent_seen_marker set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update agent_seen_marker set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update agent_seen_marker set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update agent_seen_marker set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update agent_seen_marker set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update agent_seen_marker set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';

update agent_work_items set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update agent_work_items set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update agent_work_items set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update agent_work_items set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update agent_work_items set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update agent_work_items set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';

update memory_signal set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update memory_signal set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update memory_signal set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update memory_signal set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update memory_signal set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update memory_signal set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';

update memory_note set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update memory_note set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update memory_note set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update memory_note set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update memory_note set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update memory_note set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';

update memory_recall_golden set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update memory_recall_golden set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update memory_recall_golden set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update memory_recall_golden set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update memory_recall_golden set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update memory_recall_golden set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';

update dispatch_history set source_agent_slug = 'pm'                   where source_agent_slug = 'product-pm';
update dispatch_history set source_agent_slug = 'engineer'             where source_agent_slug = 'cto-engineer';
update dispatch_history set source_agent_slug = 'qa'                   where source_agent_slug = 'qa-engineer';
update dispatch_history set source_agent_slug = 'growth-lead'          where source_agent_slug = 'growth-orchestrator';
update dispatch_history set source_agent_slug = 'performance-marketer' where source_agent_slug = 'ads-manager';
update dispatch_history set source_agent_slug = 'support-lead'         where source_agent_slug = 'ops-frontline';
update dispatch_history set target_agent_slug = 'pm'                   where target_agent_slug = 'product-pm';
update dispatch_history set target_agent_slug = 'engineer'             where target_agent_slug = 'cto-engineer';
update dispatch_history set target_agent_slug = 'qa'                   where target_agent_slug = 'qa-engineer';
update dispatch_history set target_agent_slug = 'growth-lead'          where target_agent_slug = 'growth-orchestrator';
update dispatch_history set target_agent_slug = 'performance-marketer' where target_agent_slug = 'ads-manager';
update dispatch_history set target_agent_slug = 'support-lead'         where target_agent_slug = 'ops-frontline';

update global_agent_rules set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update global_agent_rules set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update global_agent_rules set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update global_agent_rules set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update global_agent_rules set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update global_agent_rules set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';

update connector_ticket_ledger set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update connector_ticket_ledger set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update connector_ticket_ledger set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update connector_ticket_ledger set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update connector_ticket_ledger set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update connector_ticket_ledger set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';

update voice_sessions set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update voice_sessions set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update voice_sessions set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update voice_sessions set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update voice_sessions set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update voice_sessions set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';
update voice_session_costs set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update voice_session_costs set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update voice_session_costs set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update voice_session_costs set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update voice_session_costs set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update voice_session_costs set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';

update thread_event set agent_slug = 'pm'                   where agent_slug = 'product-pm';
update thread_event set agent_slug = 'engineer'             where agent_slug = 'cto-engineer';
update thread_event set agent_slug = 'qa'                   where agent_slug = 'qa-engineer';
update thread_event set agent_slug = 'growth-lead'          where agent_slug = 'growth-orchestrator';
update thread_event set agent_slug = 'performance-marketer' where agent_slug = 'ads-manager';
update thread_event set agent_slug = 'support-lead'         where agent_slug = 'ops-frontline';

insert into decision_classes (slug, description, default_autonomy, dispatch_handler, severity)
select 'engineer.ship-pr', description, default_autonomy, dispatch_handler, severity from decision_classes where slug = 'cto-engineer.ship-pr'
on conflict (slug) do update set description = excluded.description, default_autonomy = excluded.default_autonomy, dispatch_handler = excluded.dispatch_handler, severity = excluded.severity;

insert into decision_classes (slug, description, default_autonomy, dispatch_handler, severity)
select 'qa.weekly-digest', description, default_autonomy, dispatch_handler, severity from decision_classes where slug = 'qa-engineer.weekly-digest'
on conflict (slug) do update set description = excluded.description, default_autonomy = excluded.default_autonomy, dispatch_handler = excluded.dispatch_handler, severity = excluded.severity;

insert into decision_classes (slug, description, default_autonomy, dispatch_handler, severity)
select 'qa.file-bug', description, default_autonomy, dispatch_handler, severity from decision_classes where slug = 'qa-engineer.file-bug'
on conflict (slug) do update set description = excluded.description, default_autonomy = excluded.default_autonomy, dispatch_handler = excluded.dispatch_handler, severity = excluded.severity;

insert into decision_classes (slug, description, default_autonomy, dispatch_handler, severity)
select 'performance-marketer.weekly-plan', description, default_autonomy, dispatch_handler, severity from decision_classes where slug = 'ads-manager.weekly-plan'
on conflict (slug) do update set description = excluded.description, default_autonomy = excluded.default_autonomy, dispatch_handler = excluded.dispatch_handler, severity = excluded.severity;

insert into decision_classes (slug, description, default_autonomy, dispatch_handler, severity)
select 'growth-lead.reallocate-budget', description, default_autonomy, dispatch_handler, severity from decision_classes where slug = 'growth-orchestrator.reallocate-budget'
on conflict (slug) do update set description = excluded.description, default_autonomy = excluded.default_autonomy, dispatch_handler = excluded.dispatch_handler, severity = excluded.severity;

insert into decision_classes (slug, description, default_autonomy, dispatch_handler, severity)
select 'growth-lead.lifecycle-draft', description, default_autonomy, dispatch_handler, severity from decision_classes where slug = 'growth-orchestrator.lifecycle-draft'
on conflict (slug) do update set description = excluded.description, default_autonomy = excluded.default_autonomy, dispatch_handler = excluded.dispatch_handler, severity = excluded.severity;

insert into decision_classes (slug, description, default_autonomy, dispatch_handler, severity)
select 'growth-lead.social-draft', description, default_autonomy, dispatch_handler, severity from decision_classes where slug = 'growth-orchestrator.social-draft'
on conflict (slug) do update set description = excluded.description, default_autonomy = excluded.default_autonomy, dispatch_handler = excluded.dispatch_handler, severity = excluded.severity;

update decisions set decision_class = 'engineer.ship-pr'              where decision_class = 'cto-engineer.ship-pr';
update decisions set decision_class = 'qa.weekly-digest'              where decision_class = 'qa-engineer.weekly-digest';
update decisions set decision_class = 'qa.file-bug'                   where decision_class = 'qa-engineer.file-bug';
update decisions set decision_class = 'performance-marketer.weekly-plan' where decision_class = 'ads-manager.weekly-plan';
update decisions set decision_class = 'growth-lead.reallocate-budget'    where decision_class = 'growth-orchestrator.reallocate-budget';
update decisions set decision_class = 'growth-lead.lifecycle-draft'      where decision_class = 'growth-orchestrator.lifecycle-draft';
update decisions set decision_class = 'growth-lead.social-draft'         where decision_class = 'growth-orchestrator.social-draft';

update tenant_decision_class_overrides set decision_class = 'engineer.ship-pr'              where decision_class = 'cto-engineer.ship-pr';
update tenant_decision_class_overrides set decision_class = 'qa.weekly-digest'              where decision_class = 'qa-engineer.weekly-digest';
update tenant_decision_class_overrides set decision_class = 'qa.file-bug'                   where decision_class = 'qa-engineer.file-bug';
update tenant_decision_class_overrides set decision_class = 'performance-marketer.weekly-plan' where decision_class = 'ads-manager.weekly-plan';
update tenant_decision_class_overrides set decision_class = 'growth-lead.reallocate-budget'    where decision_class = 'growth-orchestrator.reallocate-budget';
update tenant_decision_class_overrides set decision_class = 'growth-lead.lifecycle-draft'      where decision_class = 'growth-orchestrator.lifecycle-draft';
update tenant_decision_class_overrides set decision_class = 'growth-lead.social-draft'         where decision_class = 'growth-orchestrator.social-draft';

delete from decision_classes where slug in (
  'cto-engineer.ship-pr',
  'qa-engineer.weekly-digest',
  'qa-engineer.file-bug',
  'ads-manager.weekly-plan',
  'growth-orchestrator.reallocate-budget',
  'growth-orchestrator.lifecycle-draft',
  'growth-orchestrator.social-draft'
);

create or replace function public.schema_invariants_ok()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    exists (
      select 1
      from pg_constraint
      where conname = 'memory_note_note_type_check'
        and pg_get_constraintdef(oid) like '%growth_lever_signal%'
    )
    and (
      select count(*) = 3
      from decision_classes
      where slug in (
        'growth-lead.reallocate-budget',
        'growth-lead.lifecycle-draft',
        'growth-lead.social-draft'
      )
    );
$$;

update system_config
set blob = jsonb_set(blob, '{disabled_agent_slugs}',
  coalesce(
    (select jsonb_agg(
      case s.value
        when 'product-pm'           then 'pm'
        when 'cto-engineer'         then 'engineer'
        when 'qa-engineer'          then 'qa'
        when 'growth-orchestrator'  then 'growth-lead'
        when 'ads-manager'          then 'performance-marketer'
        when 'ops-frontline'        then 'support-lead'
        else s.value
      end
    ) from jsonb_array_elements_text(blob->'disabled_agent_slugs') as s(value)),
    '[]'::jsonb
  ))
where blob ? 'disabled_agent_slugs';

update system_config
set blob = jsonb_set(blob, '{enabled_agent_slugs}',
  coalesce(
    (select jsonb_agg(
      case s.value
        when 'product-pm'           then 'pm'
        when 'cto-engineer'         then 'engineer'
        when 'qa-engineer'          then 'qa'
        when 'growth-orchestrator'  then 'growth-lead'
        when 'ads-manager'          then 'performance-marketer'
        when 'ops-frontline'        then 'support-lead'
        else s.value
      end
    ) from jsonb_array_elements_text(blob->'enabled_agent_slugs') as s(value)),
    '[]'::jsonb
  ))
where blob ? 'enabled_agent_slugs';

update system_config
set blob = jsonb_set(blob, '{marketplace_visible_slugs}',
  coalesce(
    (select jsonb_agg(
      case s.value
        when 'product-pm'           then 'pm'
        when 'cto-engineer'         then 'engineer'
        when 'qa-engineer'          then 'qa'
        when 'growth-orchestrator'  then 'growth-lead'
        when 'ads-manager'          then 'performance-marketer'
        when 'ops-frontline'        then 'support-lead'
        else s.value
      end
    ) from jsonb_array_elements_text(blob->'marketplace_visible_slugs') as s(value)),
    '[]'::jsonb
  ))
where blob ? 'marketplace_visible_slugs';

update system_config
set blob = jsonb_set(blob, '{disabled_voice_agent_slugs}',
  coalesce(
    (select jsonb_agg(
      case s.value
        when 'product-pm'           then 'pm'
        when 'cto-engineer'         then 'engineer'
        when 'qa-engineer'          then 'qa'
        when 'growth-orchestrator'  then 'growth-lead'
        when 'ads-manager'          then 'performance-marketer'
        when 'ops-frontline'        then 'support-lead'
        else s.value
      end
    ) from jsonb_array_elements_text(blob->'disabled_voice_agent_slugs') as s(value)),
    '[]'::jsonb
  ))
where blob ? 'disabled_voice_agent_slugs';

commit;

