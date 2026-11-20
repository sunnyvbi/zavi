
alter table decision_classes
  add column if not exists single_open_per_target boolean not null default false;
alter table decision_classes
  add column if not exists target_key_paths text[];

comment on column decision_classes.single_open_per_target is
  'Move E5: when true, emit_decision supersedes an older open proposed row for the same (tenant, class, derived target_key) instead of inserting a fresh card. Registry lever — flip per class to opt a reversible class into idempotent per-target dedup.';
comment on column decision_classes.target_key_paths is
  'Move E5: ordered top-level body keys whose values compose the stable target key (chr(31)-joined). The FIRST key is the required discriminator; if it is absent in a body the target is NULL and dedup is skipped. Only consulted when single_open_per_target = true.';

create or replace function decision_target_key(p_body jsonb, p_paths text[])
returns text
language sql
immutable
set search_path = public as $$
  select case
    when p_paths is null or array_length(p_paths, 1) is null then null
    when nullif(p_body ->> p_paths[1], '') is null then null
    else (
      select string_agg(coalesce(p_body ->> k, ''), chr(31) order by ord)
      from unnest(p_paths) with ordinality as t(k, ord)
    )
  end
$$;

create or replace function emit_decision(
  p_tenant_id uuid,
  p_agent_run_id uuid,
  p_decision_class text,
  p_body jsonb,
  p_autonomy_override decision_autonomy default null
) returns uuid
language plpgsql security definer set search_path = public as $$
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

update decision_classes
   set single_open_per_target = true,
       target_key_paths = array['project_key', 'summary']
 where slug = 'operator.file-jira-issue';
update decision_classes
   set single_open_per_target = true,
       target_key_paths = array['team_id', 'title']
 where slug = 'operator.file-linear-issue';

with ranked as (
  select
    d.id,
    decision_target_key(
      d.body,
      (select target_key_paths from decision_classes c where c.slug = d.decision_class)
    ) as target,
    row_number() over (
      partition by d.tenant_id, d.decision_class,
        decision_target_key(
          d.body,
          (select target_key_paths from decision_classes c where c.slug = d.decision_class)
        )
      order by d.emitted_at desc, d.id desc
    ) as rn,
    first_value(d.id) over (
      partition by d.tenant_id, d.decision_class,
        decision_target_key(
          d.body,
          (select target_key_paths from decision_classes c where c.slug = d.decision_class)
        )
      order by d.emitted_at desc, d.id desc
    ) as keep_id
  from decisions d
  where d.status = 'proposed'
    and d.superseded_at is null
    and d.decision_class in ('operator.file-jira-issue', 'operator.file-linear-issue')
)
update decisions d
   set status = 'superseded',
       superseded_at = now(),
       superseded_by = r.keep_id
  from ranked r
 where d.id = r.id
   and r.rn > 1
   and r.target is not null;
