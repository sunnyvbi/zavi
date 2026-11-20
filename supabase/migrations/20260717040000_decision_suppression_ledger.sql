
create table if not exists decision_suppressions (
  tenant_id       uuid not null references tenants(id) on delete cascade,
  decision_class  text not null,
  suppression_key text not null,
  decision_id     uuid references decisions(id) on delete set null,
  suppressed_by   uuid,
  source          text not null,
  created_at      timestamptz not null default now(),
  hit_count       int not null default 0,
  last_hit_at     timestamptz,
  primary key (tenant_id, decision_class, suppression_key)
);

comment on table decision_suppressions is
  'Durable memory of a human "no". emit_decision consults this BEFORE inserting a proposed row; a hit returns the suppressing decision id instead of re-asking. Keyed (tenant, class, suppression_key) where suppression_key = coalesce(target_key, content fingerprint). Ravi 2026-07-16: an explicit human no suppresses permanently, criticals included.';
comment on column decision_suppressions.hit_count is
  'How many times a re-emit was suppressed by this row — i.e. how many times the agent would have nagged.';
comment on column decision_suppressions.source is
  'What created the suppression: reject | dismiss (human authority, suppresses criticals too) | expire (machine timeout; criticals never reach here — auto-expire holds them) | backfill.';

alter table decision_suppressions enable row level security;

drop policy if exists decision_suppressions_select_own on decision_suppressions;
create policy decision_suppressions_select_own on decision_suppressions
  for select using (
    exists (
      select 1 from public.tenant_users tu
       where tu.tenant_id = decision_suppressions.tenant_id
         and tu.user_id = auth.uid()
    )
  );

create or replace function decision_suppression_key(p_body jsonb, p_paths text[])
returns text
language sql
immutable
set search_path = public as $$
  select coalesce(
    decision_target_key(p_body, p_paths),
    decision_content_fingerprint(p_body)
  )
$$;

create or replace function emit_decision(
  p_tenant_id uuid,
  p_agent_run_id uuid,
  p_decision_class text,
  p_body jsonb,
  p_autonomy_override decision_autonomy default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_autonomy decision_autonomy;
  v_handler text;
  v_status text;
  v_class_exists boolean;
  v_killed boolean;
  v_agent_slug text;
  v_target text;
  v_fingerprint text;
  v_is_meta_ads boolean;
  v_single_open boolean;
  v_target_paths text[];
  v_supp_key text;
  v_supp_decision uuid;
begin
  select exists(select 1 from decision_classes where slug = p_decision_class) into v_class_exists;
  if not v_class_exists then
    raise exception 'unknown decision_class: %', p_decision_class
      using errcode = '23514';
  end if;

  if p_agent_run_id is not null then
    select agent_slug into v_agent_slug from agent_runs where id = p_agent_run_id;
    if v_agent_slug is not null then
      select exists(
        select 1 from tenant_agent_kill_switch
         where tenant_id = p_tenant_id and agent_slug = v_agent_slug
           and override_state = 'hidden'
      ) into v_killed;
      if v_killed then
        insert into decisions (
          tenant_id, agent_run_id, decision_class, body, status,
          autonomy_at_emit, handler, dispatch_error
        ) values (
          p_tenant_id, p_agent_run_id, p_decision_class, p_body, 'rejected',
          'forbidden', null, 'kill_switch'
        ) returning id into v_id;
        return v_id;
      end if;
    end if;
  end if;

  v_autonomy := effective_autonomy(p_tenant_id, p_decision_class);

  if p_autonomy_override is not null
     and p_decision_class = 'engineer.ship-pr'
     and v_autonomy = 'auto'
     and p_autonomy_override = 'approval'
  then
    v_autonomy := 'approval';
  end if;

  select dispatch_handler, single_open_per_target, target_key_paths
    into v_handler, v_single_open, v_target_paths
  from decision_classes where slug = p_decision_class;

  if v_autonomy = 'forbidden' then
    v_status := 'rejected';
  elsif v_autonomy = 'auto' then
    v_status := 'proposed';
  else
    v_status := 'proposed';
  end if;

  v_is_meta_ads := p_decision_class like 'meta_ads.%';

  if v_status = 'proposed' and not v_is_meta_ads then
    v_fingerprint := decision_content_fingerprint(p_body);
    perform pg_advisory_xact_lock(
      hashtextextended(
        p_tenant_id::text || '|' || p_decision_class || '|' || v_fingerprint
          || '|' || v_autonomy::text,
        0
      )
    );
    select d.id into v_id
      from decisions d
     where d.tenant_id = p_tenant_id
       and d.decision_class = p_decision_class
       and d.status = 'proposed'
       and d.superseded_at is null
       and d.autonomy_at_emit = v_autonomy
       and d.handler is not distinct from v_handler
       and decision_content_fingerprint(d.body) = v_fingerprint
     order by d.emitted_at asc, d.id asc
     limit 1;
    if v_id is not null then
      return v_id;
    end if;
  end if;

  if v_status = 'proposed' then
    v_supp_key := decision_suppression_key(p_body, v_target_paths);
    if v_supp_key is not null then
      update decision_suppressions s
         set hit_count = s.hit_count + 1,
             last_hit_at = now()
       where s.tenant_id = p_tenant_id
         and s.decision_class = p_decision_class
         and s.suppression_key = v_supp_key
      returning s.decision_id into v_supp_decision;
      if v_supp_decision is not null then
        return v_supp_decision;
      end if;
    end if;
  end if;

  insert into decisions (
    tenant_id, agent_run_id, decision_class, body, status,
    autonomy_at_emit, handler
  ) values (
    p_tenant_id, p_agent_run_id, p_decision_class, p_body, v_status,
    v_autonomy, v_handler
  ) returning id into v_id;

  if v_status = 'proposed' and v_is_meta_ads then
    v_target := coalesce(
      p_body->>'object_id',
      p_body->>'ad_set_id',
      (p_body->>'campaign_id') || '|' || coalesce(p_body->>'name', '')
    );
    if v_target is not null then
      update decisions d
         set status = 'superseded',
             superseded_at = now(),
             superseded_by = v_id
       where d.tenant_id = p_tenant_id
         and d.decision_class = p_decision_class
         and d.status = 'proposed'
         and d.id <> v_id
         and coalesce(
               d.body->>'object_id',
               d.body->>'ad_set_id',
               (d.body->>'campaign_id') || '|' || coalesce(d.body->>'name', '')
             ) = v_target;
    end if;
  end if;

  if v_status = 'proposed' and not v_is_meta_ads and coalesce(v_single_open, false) then
    v_target := decision_target_key(p_body, v_target_paths);
    if v_target is not null then
      update decisions d
         set status = 'superseded',
             superseded_at = now(),
             superseded_by = v_id
       where d.tenant_id = p_tenant_id
         and d.decision_class = p_decision_class
         and d.status = 'proposed'
         and d.superseded_at is null
         and d.id <> v_id
         and decision_target_key(d.body, v_target_paths) = v_target;
    end if;
  end if;

  return v_id;
end $$;
revoke all on function emit_decision(uuid, uuid, text, jsonb, decision_autonomy) from public;
grant execute on function emit_decision(uuid, uuid, text, jsonb, decision_autonomy) to service_role;
revoke all on function decision_suppression_key(jsonb, text[]) from public;
grant execute on function decision_suppression_key(jsonb, text[]) to service_role;
