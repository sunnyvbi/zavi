

alter table agent_feedback
  add column kind text not null default 'note'
    check (kind in ('rule', 'note'));

alter table agent_feedback
  add column state text not null default 'open'
    check (state in ('open', 'acknowledged', 'applied'));

alter table agent_feedback
  add column scope jsonb;

alter table agent_feedback alter column target_type drop not null;
alter table agent_feedback alter column target_id drop not null;

alter table agent_feedback drop constraint agent_feedback_target_type_check;
alter table agent_feedback add constraint agent_feedback_target_type_check
  check (
    target_type is null
    or target_type in ('agent_run', 'decision')
  );

drop index agent_feedback_unique_per_user_target;
create unique index agent_feedback_unique_per_user_target
  on agent_feedback (tenant_id, target_type, target_id, created_by)
  where target_id is not null;

create index if not exists agent_feedback_tenant_agent_kind_state
  on agent_feedback (tenant_id, agent_slug, kind, state, created_at desc);

create or replace function add_agent_rule(
  p_agent_slug text,
  p_body text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_id uuid;
begin
  if v_user_id is null then
    raise exception 'unauthenticated';
  end if;
  if p_agent_slug is null or length(p_agent_slug) = 0 then
    raise exception 'agent_slug required';
  end if;
  if p_body is null or length(p_body) = 0 then
    raise exception 'body required';
  end if;
  if length(p_body) > 500 then
    raise exception 'rule body too long (≤500 chars)';
  end if;

  select tu.tenant_id into v_tenant_id
  from tenant_users tu
  where tu.user_id = v_user_id
  limit 1;
  if v_tenant_id is null then
    raise exception 'unauthorized';
  end if;

  insert into agent_feedback (
    tenant_id, target_type, target_id, agent_slug, rating, comment,
    created_by, kind, state, scope
  ) values (
    v_tenant_id, null, null, p_agent_slug, null, p_body,
    v_user_id, 'rule', 'open', null
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function add_agent_rule(text, text) from public;
grant execute on function add_agent_rule(text, text) to authenticated;

comment on function add_agent_rule(text, text) is
  'Append a rule to the Feedback tab for an agent. Notes-only in v1 — runner does NOT read these (T-4 cross-model). UI labels rules as captured-for-human-reference.';

create or replace function add_agent_note(
  p_agent_slug text,
  p_body text,
  p_scope jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
  v_id uuid;
begin
  if v_user_id is null then
    raise exception 'unauthenticated';
  end if;
  if p_agent_slug is null or length(p_agent_slug) = 0 then
    raise exception 'agent_slug required';
  end if;
  if p_body is null or length(p_body) = 0 then
    raise exception 'body required';
  end if;
  if length(p_body) > 4000 then
    raise exception 'note body too long (≤4000 chars)';
  end if;

  select tu.tenant_id into v_tenant_id
  from tenant_users tu
  where tu.user_id = v_user_id
  limit 1;
  if v_tenant_id is null then
    raise exception 'unauthorized';
  end if;

  insert into agent_feedback (
    tenant_id, target_type, target_id, agent_slug, rating, comment,
    created_by, kind, state, scope
  ) values (
    v_tenant_id, null, null, p_agent_slug, null, p_body,
    v_user_id, 'note', 'open', p_scope
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function add_agent_note(text, text, jsonb) from public;
grant execute on function add_agent_note(text, text, jsonb) to authenticated;

comment on function add_agent_note(text, text, jsonb) is
  'Append a free-text note to the Feedback tab for an agent. Surfaced to Ravi/CoS for human curation in v1. v1.5 will wire an ack worker that rewrites tenant_agents.body_markdown.';

create or replace function list_agent_feedback(
  p_agent_slug text
)
returns table (
  id uuid,
  kind text,
  state text,
  scope jsonb,
  rating smallint,
  comment text,
  target_type text,
  target_id uuid,
  created_by uuid,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_tenant_id uuid;
begin
  if v_user_id is null then
    raise exception 'unauthenticated';
  end if;
  if p_agent_slug is null or length(p_agent_slug) = 0 then
    raise exception 'agent_slug required';
  end if;

  select tu.tenant_id into v_tenant_id
  from tenant_users tu
  where tu.user_id = v_user_id
  limit 1;
  if v_tenant_id is null then
    raise exception 'unauthorized';
  end if;

  return query
  select
    af.id,
    af.kind,
    af.state,
    af.scope,
    af.rating,
    af.comment,
    af.target_type,
    af.target_id,
    af.created_by,
    af.created_at
  from agent_feedback af
  where af.tenant_id = v_tenant_id
    and af.agent_slug = p_agent_slug
  order by af.created_at desc;
end;
$$;

revoke all on function list_agent_feedback(text) from public;
grant execute on function list_agent_feedback(text) to authenticated;

comment on function list_agent_feedback(text) is
  'Return all feedback rows (ratings + rules + notes) for an agent, tenant-scoped, newest first. Drives the Feedback tab list + badge count.';
