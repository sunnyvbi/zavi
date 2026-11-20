
create or replace view home_suggestions as
select
  af.id as feedback_id,
  af.tenant_id,
  af.target_type,
  af.target_id,
  af.agent_slug,
  af.comment as suggestion_text,
  af.created_at,
  af.created_by
from agent_feedback af
where
  af.comment is not null
  and length(af.comment) > 0
  and not exists (
    select 1 from improvement_attempt ia
    where ia.target_agent_slug = af.agent_slug
      and ia.tenant_id = af.tenant_id
      and ia.outcome = 'accepted'
      and ia.created_at > af.created_at
  )
order by af.created_at desc;

comment on view home_suggestions is
  'Open agent_feedback rows for the Home tab bottom-stripe. '
  'Pre-launch: empty until rule editor ships in Phase 3.';
