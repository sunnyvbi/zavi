
create type decision_autonomy as enum ('auto', 'approval', 'forbidden');

create table decision_classes (
  slug text primary key,
  description text not null default '',
  default_autonomy decision_autonomy not null default 'approval',
  dispatch_handler text,
  created_at timestamptz default now()
);

create table tenant_decision_class_overrides (
  tenant_id uuid not null references tenants(id) on delete cascade,
  decision_class text not null references decision_classes(slug) on delete cascade,
  autonomy decision_autonomy not null,
  updated_by uuid references auth.users(id),
  updated_at timestamptz default now(),
  primary key (tenant_id, decision_class)
);

alter table decision_classes enable row level security;
alter table tenant_decision_class_overrides enable row level security;

create policy decision_classes_authed_select on decision_classes
  for select to authenticated using (true);

create policy tenant_overrides_member_select on tenant_decision_class_overrides
  for select using (
    exists (
      select 1 from tenant_users tu
      where tu.user_id = auth.uid() and tu.tenant_id = tenant_decision_class_overrides.tenant_id
    )
  );

alter table decisions add column if not exists autonomy_at_emit decision_autonomy;
alter table decisions add column if not exists handler text;
alter table decisions add column if not exists approved_by uuid references auth.users(id);
alter table decisions add column if not exists approved_at timestamptz;
alter table decisions add column if not exists dispatched_at timestamptz;
alter table decisions add column if not exists dispatch_error text;

create or replace function effective_autonomy(
  p_tenant_id uuid,
  p_decision_class text
) returns decision_autonomy
language plpgsql security definer set search_path = public stable as $$
declare v_override decision_autonomy; v_default decision_autonomy;
begin
  select autonomy into v_override
  from tenant_decision_class_overrides
  where tenant_id = p_tenant_id and decision_class = p_decision_class;
  if v_override is not null then
    return v_override;
  end if;
  select default_autonomy into v_default
  from decision_classes where slug = p_decision_class;
  return coalesce(v_default, 'approval'::decision_autonomy);
end $$;
revoke all on function effective_autonomy(uuid, text) from public;
grant execute on function effective_autonomy(uuid, text) to authenticated, service_role;

create or replace function emit_decision(
  p_tenant_id uuid,
  p_agent_run_id uuid,
  p_decision_class text,
  p_body jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_autonomy decision_autonomy; v_handler text; v_status text;
begin
  v_autonomy := effective_autonomy(p_tenant_id, p_decision_class);
  select dispatch_handler into v_handler
  from decision_classes where slug = p_decision_class;

  if v_autonomy = 'forbidden' then
    v_status := 'rejected';
  elsif v_autonomy = 'auto' then
    v_status := 'proposed';
  else
    v_status := 'proposed';
  end if;

  insert into decisions (
    tenant_id, agent_run_id, decision_class, body, status,
    autonomy_at_emit, handler
  ) values (
    p_tenant_id, p_agent_run_id, p_decision_class, p_body, v_status,
    v_autonomy, v_handler
  ) returning id into v_id;

  return v_id;
end $$;
revoke all on function emit_decision(uuid, uuid, text, jsonb) from public;
grant execute on function emit_decision(uuid, uuid, text, jsonb) to service_role;

create or replace function approve_decision(p_decision_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_status text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select tenant_id, status into v_tenant, v_status
  from decisions where id = p_decision_id;
  if v_tenant is null then
    raise exception 'decision % not found', p_decision_id using errcode = '42704';
  end if;
  if v_status != 'proposed' then
    raise exception 'decision % is in status % (must be proposed)', p_decision_id, v_status using errcode = '22023';
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = auth.uid() and tenant_id = v_tenant
  ) then
    raise exception 'not a member of tenant %', v_tenant using errcode = '42501';
  end if;
  update decisions
  set status = 'approved', approved_by = auth.uid(), approved_at = now()
  where id = p_decision_id;
end $$;
revoke all on function approve_decision(uuid) from public;
grant execute on function approve_decision(uuid) to authenticated;

create or replace function reject_decision(p_decision_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_status text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select tenant_id, status into v_tenant, v_status
  from decisions where id = p_decision_id;
  if v_tenant is null then
    raise exception 'decision % not found', p_decision_id using errcode = '42704';
  end if;
  if v_status != 'proposed' then
    raise exception 'decision % is in status % (must be proposed)', p_decision_id, v_status using errcode = '22023';
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = auth.uid() and tenant_id = v_tenant
  ) then
    raise exception 'not a member of tenant %', v_tenant using errcode = '42501';
  end if;
  update decisions
  set status = 'rejected', approved_by = auth.uid(), approved_at = now()
  where id = p_decision_id;
end $$;
revoke all on function reject_decision(uuid) from public;
grant execute on function reject_decision(uuid) to authenticated;

create or replace function set_tenant_autonomy(
  p_tenant_id uuid,
  p_decision_class text,
  p_autonomy decision_autonomy
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if not exists (
    select 1 from tenant_users
    where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
  end if;
  insert into tenant_decision_class_overrides (
    tenant_id, decision_class, autonomy, updated_by
  ) values (
    p_tenant_id, p_decision_class, p_autonomy, auth.uid()
  )
  on conflict (tenant_id, decision_class)
  do update set autonomy = excluded.autonomy, updated_by = excluded.updated_by, updated_at = now();
end $$;
revoke all on function set_tenant_autonomy(uuid, text, decision_autonomy) from public;
grant execute on function set_tenant_autonomy(uuid, text, decision_autonomy) to authenticated;

insert into decision_classes (slug, description, default_autonomy, dispatch_handler) values
  ('send_email', 'Send a transactional or marketing email', 'approval', 'gmail.send'),
  ('post_slack_message', 'Post a message to a Slack channel or DM', 'approval', 'slack.post_message'),
  ('refund_stripe', 'Issue a Stripe refund for a charge', 'approval', 'stripe.refund'),
  ('ban_user', 'Ban a user from the marketplace', 'forbidden', 'tenant.ban_user'),
  ('tag_ticket', 'Tag a support ticket with a category', 'auto', 'support.tag_ticket'),
  ('create_jira_issue', 'Open a Jira issue', 'approval', 'jira.create_issue'),
  ('chief-of-staff.daily-digest', 'Render the daily digest (no side effect)', 'auto', null)
on conflict (slug) do nothing;
