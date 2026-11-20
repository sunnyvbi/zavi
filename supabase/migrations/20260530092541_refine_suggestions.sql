
begin;

create table if not exists refine_suggestions (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  conductor_run_id  uuid references conductor_runs(id) on delete set null,
  suggestion        text not null,
  evidence          jsonb not null default '{}'::jsonb,
  status            text not null default 'pending'
                      check (status in ('pending','dismissed','accepted')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists refine_suggestions_tenant_status_idx
  on refine_suggestions (tenant_id, status, created_at desc);

create index if not exists refine_suggestions_conductor_run_idx
  on refine_suggestions (conductor_run_id)
  where conductor_run_id is not null;

alter table refine_suggestions enable row level security;
drop policy if exists refine_suggestions_select on refine_suggestions;
create policy refine_suggestions_select on refine_suggestions
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = refine_suggestions.tenant_id)
  );

create or replace function set_refine_suggestion_status(
  p_tenant_id     uuid,
  p_suggestion_id uuid,
  p_new_status    text
) returns text
language plpgsql security definer set search_path = public as $$
declare v_current text;
begin
  if p_tenant_id is null or p_suggestion_id is null or p_new_status is null then
    raise exception 'set_refine_suggestion_status: tenant_id/suggestion_id/new_status required'
      using errcode = '22023';
  end if;
  if p_new_status not in ('accepted','dismissed') then
    raise exception 'set_refine_suggestion_status: new_status must be accepted or dismissed (got %)', p_new_status
      using errcode = '22023';
  end if;

  select status into v_current
  from refine_suggestions
  where id = p_suggestion_id and tenant_id = p_tenant_id
  for update;

  if v_current is null then
    return null;
  end if;

  if v_current in ('accepted','dismissed') then
    return v_current;
  end if;

  update refine_suggestions
     set status     = p_new_status,
         updated_at = now()
   where id = p_suggestion_id and tenant_id = p_tenant_id;

  return p_new_status;
end $$;

revoke all on function set_refine_suggestion_status(uuid, uuid, text) from public;
grant execute on function set_refine_suggestion_status(uuid, uuid, text) to service_role;

commit;
