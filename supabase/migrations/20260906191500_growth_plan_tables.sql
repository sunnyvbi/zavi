
begin;

create table if not exists growth_plan (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete cascade,
  objective             text not null,
  target_metric         text,
  constraint_statement  text,
  constraint_confidence text
                          check (constraint_confidence is null
                                 or constraint_confidence in ('low','medium','high')),
  status                text not null default 'live'
                          check (status in ('draft','live','superseded')),
  version               int  not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index if not exists growth_plan_one_live_per_tenant
  on growth_plan (tenant_id) where status = 'live';

create index if not exists growth_plan_tenant_status_idx
  on growth_plan (tenant_id, status, created_at desc);

comment on column growth_plan.constraint_confidence is
  'How strongly the constraint is believed, NOT how strongly it is asserted. Deliberately three coarse buckets: a diagnosis drawn from an empty room ("0 channels have ever run") is honestly low, and rendering it as anything else is the failure mode this column exists to prevent.';

create table if not exists growth_plan_bets (
  id              uuid primary key default gen_random_uuid(),
  plan_id         uuid not null references growth_plan(id) on delete cascade,
  tenant_id       uuid not null references tenants(id) on delete cascade,
  channel_slug    text,
  intent          text not null,
  expected_effect text,
  falsifier       text not null,
  status          text not null default 'proposed'
                    check (status in ('proposed','accepted','rejected','superseded','done')),
  rejected_reason text,
  priority        int not null default 50,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists growth_plan_bets_plan_idx
  on growth_plan_bets (plan_id, status, priority desc);
create index if not exists growth_plan_bets_tenant_idx
  on growth_plan_bets (tenant_id, status);

comment on column growth_plan_bets.falsifier is
  'What we would have to observe to call this bet wrong. NOT NULL at the database because a bet without one cannot be honestly claimed as a cause later, and an optional column is one every writer skips.';

create table if not exists growth_plan_changes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  plan_id     uuid references growth_plan(id) on delete cascade,
  entity      text not null check (entity in ('plan','bet','goal')),
  entity_id   uuid,
  field       text not null,
  old_value   text,
  new_value   text,
  actor_kind  text not null check (actor_kind in ('founder','agent','system')),
  actor_ref   text,
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists growth_plan_changes_tenant_idx
  on growth_plan_changes (tenant_id, created_at desc);
create index if not exists growth_plan_changes_entity_idx
  on growth_plan_changes (entity, entity_id, created_at desc);

alter table growth_plan         enable row level security;
alter table growth_plan_bets    enable row level security;
alter table growth_plan_changes enable row level security;

drop policy if exists growth_plan_select on growth_plan;
create policy growth_plan_select on growth_plan
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = growth_plan.tenant_id)
  );

drop policy if exists growth_plan_bets_select on growth_plan_bets;
create policy growth_plan_bets_select on growth_plan_bets
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = growth_plan_bets.tenant_id)
  );

drop policy if exists growth_plan_changes_select on growth_plan_changes;
create policy growth_plan_changes_select on growth_plan_changes
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = growth_plan_changes.tenant_id)
  );

alter table autopilot_goals
  add column if not exists falsifier          text,
  add column if not exists status_changed_by  text,
  add column if not exists status_changed_at  timestamptz;

comment on column autopilot_goals.falsifier is
  'What we would have to observe to call this goal wrong or no longer worth chasing. Nullable because the four live rows predate it; every goal written from Slice 2 onward sets it.';
comment on column autopilot_goals.status_changed_by is
  'Who last moved status, scoped like growth_plan_changes.actor_ref: a user id, an agent slug, or a worker name. NULL means the status predates this column, NOT that nobody did it.';

create or replace function log_growth_plan_change(
  p_tenant_id  uuid,
  p_plan_id    uuid,
  p_entity     text,
  p_entity_id  uuid,
  p_field      text,
  p_old_value  text,
  p_new_value  text,
  p_actor_kind text,
  p_actor_ref  text,
  p_note       text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  insert into growth_plan_changes (
    tenant_id, plan_id, entity, entity_id, field,
    old_value, new_value, actor_kind, actor_ref, note
  ) values (
    p_tenant_id, p_plan_id, p_entity, p_entity_id, p_field,
    p_old_value, p_new_value, p_actor_kind, p_actor_ref, p_note
  ) returning id into v_id;
  return v_id;
end $$;

create or replace function set_growth_plan(
  p_tenant_id             uuid,
  p_objective             text,
  p_target_metric         text,
  p_constraint_statement  text,
  p_constraint_confidence text,
  p_actor_kind            text,
  p_actor_ref             text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id      uuid;
  v_prev    growth_plan%rowtype;
  v_version int := 1;
begin
  select * into v_prev from growth_plan
    where tenant_id = p_tenant_id and status = 'live'
    limit 1;

  if found then
    v_version := v_prev.version + 1;
    update growth_plan
      set status = 'superseded', updated_at = now()
      where id = v_prev.id;
  end if;

  insert into growth_plan (
    tenant_id, objective, target_metric,
    constraint_statement, constraint_confidence, status, version
  ) values (
    p_tenant_id, p_objective, p_target_metric,
    p_constraint_statement, p_constraint_confidence, 'live', v_version
  ) returning id into v_id;

  if v_prev.objective is distinct from p_objective then
    perform log_growth_plan_change(
      p_tenant_id, v_id, 'plan', v_id, 'objective',
      v_prev.objective, p_objective, p_actor_kind, p_actor_ref, null
    );
  end if;

  if v_prev.constraint_statement is distinct from p_constraint_statement then
    perform log_growth_plan_change(
      p_tenant_id, v_id, 'plan', v_id, 'constraint_statement',
      v_prev.constraint_statement, p_constraint_statement,
      p_actor_kind, p_actor_ref, null
    );
  end if;

  return v_id;
end $$;

create or replace function set_growth_plan_bet(
  p_tenant_id       uuid,
  p_plan_id         uuid,
  p_bet_id          uuid,
  p_channel_slug    text,
  p_intent          text,
  p_expected_effect text,
  p_falsifier       text,
  p_status          text,
  p_rejected_reason text,
  p_priority        int,
  p_actor_kind      text,
  p_actor_ref       text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id             uuid;
  v_prev_st        text;
  v_prev_reason    text;
  v_prev_priority  int;
begin
  if p_bet_id is null then
    if not exists (
      select 1 from growth_plan
      where id = p_plan_id and tenant_id = p_tenant_id
    ) then
      return null;
    end if;

    insert into growth_plan_bets (
      plan_id, tenant_id, channel_slug, intent, expected_effect,
      falsifier, status, rejected_reason, priority
    ) values (
      p_plan_id, p_tenant_id, p_channel_slug, p_intent, p_expected_effect,
      p_falsifier, coalesce(p_status, 'proposed'), p_rejected_reason,
      coalesce(p_priority, 50)
    ) returning id into v_id;

    perform log_growth_plan_change(
      p_tenant_id, p_plan_id, 'bet', v_id, 'created',
      null, p_intent, p_actor_kind, p_actor_ref, null
    );
    return v_id;
  end if;

  select status, rejected_reason, priority
    into v_prev_st, v_prev_reason, v_prev_priority
    from growth_plan_bets
    where id = p_bet_id and tenant_id = p_tenant_id;
  if not found then
    return null;
  end if;

  update growth_plan_bets
    set status          = coalesce(p_status, status),
        rejected_reason = coalesce(p_rejected_reason, rejected_reason),
        priority        = coalesce(p_priority, priority),
        updated_at      = now()
    where id = p_bet_id and tenant_id = p_tenant_id;

  if p_status is not null and p_status is distinct from v_prev_st then
    perform log_growth_plan_change(
      p_tenant_id, p_plan_id, 'bet', p_bet_id, 'status',
      v_prev_st, p_status, p_actor_kind, p_actor_ref, p_rejected_reason
    );
  end if;

  if p_rejected_reason is not null
     and p_rejected_reason is distinct from v_prev_reason then
    perform log_growth_plan_change(
      p_tenant_id, p_plan_id, 'bet', p_bet_id, 'rejected_reason',
      v_prev_reason, p_rejected_reason, p_actor_kind, p_actor_ref, null
    );
  end if;

  if p_priority is not null and p_priority is distinct from v_prev_priority then
    perform log_growth_plan_change(
      p_tenant_id, p_plan_id, 'bet', p_bet_id, 'priority',
      v_prev_priority::text, p_priority::text, p_actor_kind, p_actor_ref, null
    );
  end if;

  return p_bet_id;
end $$;

revoke all on function log_growth_plan_change(uuid, uuid, text, uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function set_growth_plan(uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function set_growth_plan_bet(uuid, uuid, uuid, text, text, text, text, text, text, int, text, text) from public, anon, authenticated;

grant execute on function log_growth_plan_change(uuid, uuid, text, uuid, text, text, text, text, text, text) to service_role;
grant execute on function set_growth_plan(uuid, text, text, text, text, text, text) to service_role;
grant execute on function set_growth_plan_bet(uuid, uuid, uuid, text, text, text, text, text, text, int, text, text) to service_role;

commit;
