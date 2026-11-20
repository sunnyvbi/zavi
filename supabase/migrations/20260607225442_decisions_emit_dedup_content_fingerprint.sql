
create or replace function decision_content_fingerprint(p_body jsonb)
returns text
language sql
immutable
set search_path = public as $$
  select md5(
    coalesce(
      (
        coalesce(p_body, '{}'::jsonb)
          - 'source_run_id'
          - 'source_signals'
          - 'emitted_at'
          - 'confidence'
          - 'brain_citations'
          - 'decision_evidence'
      )::text,
      ''
    )
  );
$$;

create or replace function emit_decision(
  p_tenant_id uuid,
  p_agent_run_id uuid,
  p_decision_class text,
  p_body jsonb
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
  select dispatch_handler into v_handler
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

  return v_id;
end $$;
revoke all on function emit_decision(uuid, uuid, text, jsonb) from public;
grant execute on function emit_decision(uuid, uuid, text, jsonb) to service_role;
