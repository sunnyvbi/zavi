
update system_config
set blob = jsonb_set(blob, '{disabled_agent_slugs}', '[
  "advisor","agent-coach","cohort-analytics","competitor-intel",
  "content-product","customer-support-inbox","daily-brief","fleet-auditor",
  "hiring-partner","lifecycle-crm","pr-reviewer","seo-technical",
  "smoke-echo","social-organic","supply-demand-balancer","support-helper",
  "task-filer"
]'::jsonb),
    updated_at = now(),
    updated_by = null
where id = 1;
