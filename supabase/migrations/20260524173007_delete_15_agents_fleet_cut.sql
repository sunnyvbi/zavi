
update system_config
set blob = jsonb_set(blob, '{disabled_agent_slugs}', '[
  "advisor","cohort-analytics","content-product","customer-support-inbox",
  "seo-technical","social-organic"
]'::jsonb),
    updated_at = now()
where id = 1;

delete from tenant_agent_schedules
where agent_slug in (
  'agent-coach','competitor-intel','daily-brief','fleet-auditor',
  'hiring-partner','lifecycle-crm','listing-quality','payouts-recon',
  'pr-reviewer','qa-engineer-weekly','smoke-echo','supply-demand-balancer',
  'supply-onboarding','support-helper','task-filer','trust-safety'
);

delete from tenant_agent_kill_switch
where agent_slug in (
  'agent-coach','competitor-intel','daily-brief','fleet-auditor',
  'hiring-partner','lifecycle-crm','listing-quality','payouts-recon',
  'pr-reviewer','qa-engineer-weekly','smoke-echo','supply-demand-balancer',
  'supply-onboarding','support-helper','task-filer','trust-safety'
);

delete from decision_classes
where slug in (
  'pr-reviewer.post-review','pr-reviewer.merge-pr','pr-reviewer.request-changes',
  'supply-onboarding.action','listing-quality.action','payouts-recon.notify',
  'trust-safety.action','hiring-partner.application-finalized',
  'lifecycle-crm.draft-sequence','task-filer.file-jira-issue',
  'task-filer.file-linear-issue','support-helper.post-reply',
  'competitor-intel.brief','fleet-auditor.weekly-digest',
  'daily-brief.send','agent-coach.proposed-rule','proposed_rule',
  'supply-demand-balancer.action'
);

drop table if exists public.application_messages cascade;
drop table if exists public.applications cascade;
drop table if exists public.roles cascade;

drop table if exists public.tenant_brief_dispatches cascade;

alter table public.tenants drop column if exists notification_email;
alter table public.tenants drop column if exists digest_frequency;

