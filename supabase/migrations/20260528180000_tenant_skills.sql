
create table tenant_skills (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_slug text not null,
  source_note_id uuid references memory_note(id),
  source_note_ids text[],
  provenance jsonb,
  skill_name text not null,
  emitted_tool_name text,
  skill_spec jsonb,
  spec_version int,
  granted_tool_names text[],
  provenance_agent_def_hash text,
  status text not null
    check (status in ('candidate', 'staged', 'approved', 'rejected', 'quarantined'))
    default 'candidate',
  founder_blessed boolean not null default false,
  faithfulness_clean boolean not null default false,
  csat_signal numeric,
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index tenant_skills_approved_emitted_uq
  on tenant_skills (tenant_id, agent_slug, emitted_tool_name)
  where status = 'approved';

create index tenant_skills_by_tenant_agent_status
  on tenant_skills (tenant_id, agent_slug, status, created_at desc);

alter table tenant_skills enable row level security;

create policy tenant_skills_member_select on tenant_skills
  for select using (
    exists (select 1 from tenant_users tu
              where tu.user_id = auth.uid()
                and tu.tenant_id = tenant_skills.tenant_id)
  );

create or replace function tenant_skills_assert_source_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_note_type text;
  v_agent_slug text;
begin
  if new.source_note_id is null then
    return new;
  end if;

  select tenant_id, note_type, agent_slug
    into v_tenant_id, v_note_type, v_agent_slug
    from memory_note
    where id = new.source_note_id;

  if not found then
    raise exception
      'tenant_skills: source_note_id % does not exist', new.source_note_id;
  end if;

  if v_tenant_id is distinct from new.tenant_id then
    raise exception
      'tenant_skills: source_note_id % belongs to tenant % but the skill is for tenant % (cross-tenant provenance link rejected)',
      new.source_note_id, v_tenant_id, new.tenant_id;
  end if;

  if v_note_type is distinct from 'agent_experience' then
    raise exception
      'tenant_skills: source_note_id % is note_type % but must be agent_experience',
      new.source_note_id, coalesce(v_note_type, '<null>');
  end if;

  if v_agent_slug is distinct from new.agent_slug then
    raise exception
      'tenant_skills: source_note_id % is for agent % but the skill is for agent % (wrong-agent provenance link rejected)',
      new.source_note_id, coalesce(v_agent_slug, '<null>'), new.agent_slug;
  end if;

  return new;
end;
$$;

create trigger tenant_skills_assert_source_note_trg
  before insert or update on tenant_skills
  for each row execute function tenant_skills_assert_source_note();
