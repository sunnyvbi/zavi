

create table roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  slug text not null,
  title text not null,
  jd text not null default '',
  approved_questions jsonb not null default '[]'::jsonb,
  draft_questions jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'live', 'closed')),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (tenant_id, slug)
);

create table applications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  role_id uuid not null references roles(id) on delete cascade,
  candidate_email text,
  candidate_name text,
  resume_storage_path text,
  resume_text text,
  scorecard jsonb,
  must_ask_answers jsonb default '{}'::jsonb,
  comp_expectation text,
  work_auth text,
  earliest_start text,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'abandoned')),
  agent_state text not null default 'idle' check (agent_state in ('idle', 'running')),
  rank_score numeric,
  operator_decision text check (operator_decision in ('advanced', 'rejected', 'hired', 'declined')),
  candidate_token_hash text not null,
  agent_run_id uuid,
  created_at timestamptz not null default now(),
  finalized_at timestamptz
);

create table application_messages (
  id bigserial primary key,
  application_id uuid not null references applications(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  role text not null check (role in ('agent', 'candidate', 'system')),
  content text not null,
  question_id text,
  created_at timestamptz not null default now()
);

alter table roles enable row level security;
alter table applications enable row level security;
alter table application_messages enable row level security;

create policy roles_member_select on roles
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = roles.tenant_id
    )
  );

create policy applications_member_select on applications
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = applications.tenant_id
    )
  );

create policy application_messages_member_select on application_messages
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = application_messages.tenant_id
    )
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'resumes',
  'resumes',
  false,
  10485760,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "resumes_bucket_deny_anon_select" on storage.objects
  for select to anon
  using (bucket_id = 'resumes' and false);

create policy "resumes_bucket_deny_anon_insert" on storage.objects
  for insert to anon
  with check (bucket_id = 'resumes' and false);

create policy "resumes_bucket_deny_authenticated_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'resumes' and false);

create policy "resumes_bucket_deny_authenticated_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'resumes' and false);

create or replace function get_public_role(p_operator_slug text, p_role_slug text)
returns table(role_id uuid, tenant_id uuid, title text, jd text, approved_questions jsonb)
language plpgsql security definer set search_path = public stable as $$
begin
  return query
  select r.id, r.tenant_id, r.title, r.jd, r.approved_questions
  from roles r
  join tenants t on t.id = r.tenant_id
  where t.slug = p_operator_slug and r.slug = p_role_slug and r.status = 'live'
  limit 1;
end $$;
revoke all on function get_public_role(text, text) from public;
grant execute on function get_public_role(text, text) to anon, authenticated, service_role;

create or replace function start_application(
  p_role_id uuid,
  p_candidate_email text,
  p_resume_storage_path text,
  p_resume_text text,
  p_token_hash text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_app_id uuid;
  v_tenant_id uuid;
begin
  select tenant_id into v_tenant_id from roles where id = p_role_id and status = 'live';
  if v_tenant_id is null then
    raise exception 'role_not_found_or_not_live';
  end if;

  select id into v_app_id from applications
  where role_id = p_role_id and lower(candidate_email) = lower(p_candidate_email)
  limit 1;
  if v_app_id is not null then
    update applications set
      candidate_token_hash = p_token_hash,
      resume_storage_path = p_resume_storage_path,
      resume_text = p_resume_text,
      status = 'in_progress',
      agent_state = 'idle',
      finalized_at = null,
      scorecard = null,
      must_ask_answers = '{}'::jsonb,
      comp_expectation = null,
      work_auth = null,
      earliest_start = null,
      rank_score = null,
      operator_decision = null
    where id = v_app_id;
    return v_app_id;
  end if;

  insert into applications (
    tenant_id, role_id, candidate_email, resume_storage_path, resume_text, candidate_token_hash
  ) values (
    v_tenant_id, p_role_id, p_candidate_email, p_resume_storage_path, p_resume_text, p_token_hash
  ) returning id into v_app_id;

  return v_app_id;
end $$;
revoke all on function start_application(uuid, text, text, text, text) from public;
grant execute on function start_application(uuid, text, text, text, text) to service_role;

create or replace function try_acquire_agent_state(p_application_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_acquired boolean;
begin
  update applications set agent_state = 'running'
  where id = p_application_id and agent_state = 'idle';
  v_acquired := found;
  return v_acquired;
end $$;
revoke all on function try_acquire_agent_state(uuid) from public;
grant execute on function try_acquire_agent_state(uuid) to service_role;

create or replace function release_agent_state(p_application_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update applications set agent_state = 'idle' where id = p_application_id;
end $$;
revoke all on function release_agent_state(uuid) from public;
grant execute on function release_agent_state(uuid) to service_role;

create or replace function append_application_message(
  p_application_id uuid,
  p_role text,
  p_content text,
  p_question_id text
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_tenant_id uuid;
  v_msg_id bigint;
begin
  select tenant_id into v_tenant_id from applications where id = p_application_id;
  if v_tenant_id is null then
    raise exception 'application_not_found';
  end if;

  insert into application_messages (application_id, tenant_id, role, content, question_id)
  values (p_application_id, v_tenant_id, p_role, p_content, p_question_id)
  returning id into v_msg_id;

  return v_msg_id;
end $$;
revoke all on function append_application_message(uuid, text, text, text) from public;
grant execute on function append_application_message(uuid, text, text, text) to service_role;

create or replace function finalize_application(
  p_application_id uuid,
  p_scorecard jsonb,
  p_must_ask_answers jsonb,
  p_comp_expectation text,
  p_work_auth text,
  p_earliest_start text,
  p_rank_score numeric
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update applications set
    scorecard = p_scorecard,
    must_ask_answers = p_must_ask_answers,
    comp_expectation = p_comp_expectation,
    work_auth = p_work_auth,
    earliest_start = p_earliest_start,
    rank_score = p_rank_score,
    status = 'completed',
    finalized_at = now()
  where id = p_application_id;

  if not found then
    raise exception 'application_not_found';
  end if;
end $$;
revoke all on function finalize_application(uuid, jsonb, jsonb, text, text, text, numeric) from public;
grant execute on function finalize_application(uuid, jsonb, jsonb, text, text, text, numeric) to service_role;

create or replace function delete_application(p_application_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from applications where id = p_application_id;
end $$;
revoke all on function delete_application(uuid) from public;
grant execute on function delete_application(uuid) to service_role;

create or replace function publish_role(p_role_id uuid, p_approved_questions jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update roles set
    approved_questions = p_approved_questions,
    status = 'live',
    published_at = now()
  where id = p_role_id;

  if not found then
    raise exception 'role_not_found';
  end if;
end $$;
revoke all on function publish_role(uuid, jsonb) from public;
grant execute on function publish_role(uuid, jsonb) to service_role;

create or replace function set_operator_decision(p_application_id uuid, p_decision text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant_id uuid;
  v_status text;
  v_current_decision text;
begin
  select tenant_id, status, operator_decision
    into v_tenant_id, v_status, v_current_decision
    from applications where id = p_application_id;
  if v_tenant_id is null then
    raise exception 'application_not_found';
  end if;

  if v_status <> 'completed' then
    raise exception 'application_not_finalized';
  end if;

  if v_current_decision in ('hired', 'declined') then
    raise exception 'decision_already_finalized';
  end if;

  if not exists (
    select 1 from tenant_users tu
    where tu.user_id = auth.uid() and tu.tenant_id = v_tenant_id
  ) then
    raise exception 'not_a_member';
  end if;

  if p_decision not in ('advanced', 'rejected', 'hired', 'declined') then
    raise exception 'invalid_decision';
  end if;

  update applications set operator_decision = p_decision where id = p_application_id;
end $$;
revoke all on function set_operator_decision(uuid, text) from public;
grant execute on function set_operator_decision(uuid, text) to authenticated;

insert into decision_classes (slug, description, default_autonomy, dispatch_handler)
values
  (
    'hiring-partner.ask-question',
    'hiring-partner asks the candidate an approved question. Side-effect-free; no dispatch handler.',
    'auto',
    null
  ),
  (
    'hiring-partner.follow-up',
    'hiring-partner asks a bounded clarifying follow-up to a previously-asked approved question.',
    'auto',
    null
  ),
  (
    'hiring-partner.finalize-application',
    'hiring-partner finalizes the conversation and emits an application_finalized envelope.',
    'auto',
    'hiring.finalize_application'
  ),
  ('hiring-partner.publish-role',
    'hiring-partner publishes a role to a public URL. Operator must approve the exact question set.',
    'approval',
    'hiring.publish_role'
  )
on conflict (slug) do nothing;

alter publication supabase_realtime add table application_messages;
