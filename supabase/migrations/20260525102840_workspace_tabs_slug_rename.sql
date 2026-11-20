
begin;

update workspace_tabs_session
set tabs = (
  select coalesce(jsonb_agg(
    case
      when t->>'kind' = 'agent' and t->'payload'->>'slug' = 'product-pm'
        then jsonb_set(jsonb_set(t, '{payload,slug}', '"pm"'), '{title}', '"pm"')
      when t->>'kind' = 'agent' and t->'payload'->>'slug' = 'cto-engineer'
        then jsonb_set(jsonb_set(t, '{payload,slug}', '"engineer"'), '{title}', '"engineer"')
      when t->>'kind' = 'agent' and t->'payload'->>'slug' = 'qa-engineer'
        then jsonb_set(jsonb_set(t, '{payload,slug}', '"qa"'), '{title}', '"qa"')
      when t->>'kind' = 'agent' and t->'payload'->>'slug' = 'growth-orchestrator'
        then jsonb_set(jsonb_set(t, '{payload,slug}', '"growth-lead"'), '{title}', '"growth-lead"')
      when t->>'kind' = 'agent' and t->'payload'->>'slug' = 'ads-manager'
        then jsonb_set(jsonb_set(t, '{payload,slug}', '"performance-marketer"'), '{title}', '"performance-marketer"')
      when t->>'kind' = 'agent' and t->'payload'->>'slug' = 'ops-frontline'
        then jsonb_set(jsonb_set(t, '{payload,slug}', '"support-lead"'), '{title}', '"support-lead"')
      else t
    end
  ), '[]'::jsonb)
  from jsonb_array_elements(tabs) as t
)
where tabs is not null
  and exists (
    select 1 from jsonb_array_elements(tabs) t
    where t->>'kind' = 'agent'
      and t->'payload'->>'slug' in (
        'product-pm','cto-engineer','qa-engineer',
        'growth-orchestrator','ads-manager','ops-frontline'
      )
  );

commit;

