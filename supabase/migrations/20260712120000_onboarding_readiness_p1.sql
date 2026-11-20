
alter table memory_note drop constraint if exists memory_note_source_check;
alter table memory_note add constraint memory_note_source_check check (
  source in (
    'human','agent_run','slack_distill','email_distill','operator_feedback',
    'praxis_staff','auto_distill_chat','auto_distill_agent_run','auto_distill_slack',
    'dream_cycle_merge','agent_write','gap_distill','episode_distill',
    'external_learning_distill','meeting_distill','memory_card_distill',
    'agent_discovery_verified','agent_discovery_inferred'
  )
);

create table if not exists tenant_readiness (
  tenant_id         uuid primary key references tenants(id) on delete cascade,
  score             int not null default 0,
  dimensions        jsonb not null default '{}'::jsonb,
  computed_at       timestamptz not null default now(),
  last_discovery_at timestamptz
);

alter table tenant_readiness enable row level security;

drop policy if exists tenant_readiness_select on tenant_readiness;
create policy tenant_readiness_select on tenant_readiness
  for select to authenticated using (
    tenant_id in (select tenant_id from tenant_users where user_id = auth.uid())
  );

create or replace function compute_tenant_readiness(p_tenant_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shape text; v_url jsonb;
  v_brain int := 0; v_url_pts int := 0; v_conn int := 0;
  v_goal int := 0; v_deliv int := 0; v_founder int := 0;
  v_matched int := 0;
  v_req text[]; v_reqcount int; v_metreq int := 0; v_cats text[];
  v_dcount int; v_m7 int; v_m21 int; v_mever int;
  v_last_disc timestamptz;
  v_score int; v_dims jsonb;
begin
  if p_tenant_id is null then
    raise exception 'p_tenant_id required' using errcode = '22023';
  end if;

  select company_shape, product_url into v_shape, v_url from tenants where id = p_tenant_id;
  if not found then
    raise exception 'tenant % not found', p_tenant_id using errcode = 'P0002';
  end if;

  select count(*) into v_matched
  from memory_note n
  where n.tenant_id = p_tenant_id
    and n.note_type = 'anchor'
    and n.superseded_by is null
    and n.slug in ('company','ops','policies','disputes','support')
    and n.source in ('human','agent_discovery_verified','praxis_staff')
    and length(btrim(n.body_markdown)) > 40
    and left(n.body_markdown, 150) !~*
        '(set this up|we haven''t (written|finalized|published|defined)|operator to (define|fill|set|confirm)|to be confirmed)';
  v_brain := round(20.0 * least(v_matched, 5) / 5.0);

  if v_url is not null and exists (
    select 1 from jsonb_each_text(v_url) e(k, v)
    where e.k in ('marketing','api') and btrim(e.v) <> '' and left(e.v, 8) = 'https://'
  ) then v_url_pts := 10; end if;

  v_req := case coalesce(v_shape, 'other')
             when 'services' then array['comms','data']
             else array['payments','data','comms'] end;
  v_reqcount := array_length(v_req, 1);
  select coalesce(array_agg(distinct cat) filter (where cat is not null), array[]::text[])
    into v_cats
  from (
    select case s.server_id
             when 'stripe'      then 'payments'
             when 'mongo'       then 'data'
             when 'operator_db' then 'data'
             when 'operator-db' then 'data'
             when 'slack'       then 'comms'
             when 'gmail'       then 'comms'
             else null
           end as cat
    from tenant_mcp_servers s
    where s.tenant_id = p_tenant_id and s.enabled
  ) q;
  select count(*) into v_metreq from unnest(v_req) r where r = any(v_cats);
  v_conn := round(30.0 * v_metreq / greatest(v_reqcount, 1));

  if exists (select 1 from autopilot_goals g
             where g.tenant_id = p_tenant_id and g.status = 'active' and g.measurement_mode = 'auto') then
    v_goal := 15;
  elsif exists (select 1 from autopilot_goals g
                where g.tenant_id = p_tenant_id and g.status = 'active') then
    v_goal := 7;
  end if;

  select count(*) into v_dcount from agent_runs r
  where r.tenant_id = p_tenant_id
    and r.status = 'success' and coalesce(r.parse_ok, false)
    and coalesce(r.finished_at, r.enqueued_at) >= now() - interval '30 days';
  v_deliv := case when v_dcount >= 3 then 15 when v_dcount >= 1 then 8 else 0 end;

  select
    count(*) filter (where created_at >= now() - interval '7 days'),
    count(*) filter (where created_at >= now() - interval '21 days'),
    count(*)
  into v_m7, v_m21, v_mever
  from agent_thread_messages m
  where m.tenant_id = p_tenant_id and m.sender_role = 'user';
  v_founder := case when v_m7 > 0 then 10 when v_m21 > 0 then 6 when v_mever > 0 then 3 else 0 end;

  v_score := v_brain + v_url_pts + v_conn + v_goal + v_deliv + v_founder;
  v_dims := jsonb_build_object(
    'verified_brain',   v_brain,
    'product_url',      v_url_pts,
    'connectors',       v_conn,
    'goal_measurable',  v_goal,
    'deliverable',      v_deliv,
    'founder_engaged',  v_founder,
    'brain_anchors_matched', v_matched,
    'connectors_required',   to_jsonb(v_req),
    'connectors_met',        v_metreq
  );

  select max(created_at) into v_last_disc from memory_note
  where tenant_id = p_tenant_id
    and source in ('agent_discovery_verified','agent_discovery_inferred');

  insert into tenant_readiness (tenant_id, score, dimensions, computed_at, last_discovery_at)
  values (p_tenant_id, v_score, v_dims, now(), v_last_disc)
  on conflict (tenant_id) do update
    set score = excluded.score, dimensions = excluded.dimensions, computed_at = now(),
        last_discovery_at = coalesce(excluded.last_discovery_at, tenant_readiness.last_discovery_at);

  return v_score;
end $$;

revoke execute on function compute_tenant_readiness(uuid) from public, anon, authenticated;
grant execute on function compute_tenant_readiness(uuid) to service_role;

create or replace function set_tenant_product_url_system(p_tenant_id uuid, p_product_url jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_prev jsonb; v_key text; v_val text; v_host text;
begin
  if p_tenant_id is null then raise exception 'p_tenant_id required' using errcode = '22023'; end if;
  if p_product_url is null then raise exception 'product_url required (pass {} to clear)' using errcode = '22023'; end if;
  if jsonb_typeof(p_product_url) <> 'object' then raise exception 'product_url must be an object' using errcode = '22023'; end if;

  for v_key in select jsonb_object_keys(p_product_url) loop
    if v_key not in ('marketing', 'api') then
      raise exception 'unknown product_url key %', v_key using errcode = '22023';
    end if;
  end loop;

  foreach v_key in array array['marketing','api'] loop
    if p_product_url ? v_key and jsonb_typeof(p_product_url -> v_key) <> 'null' then
      if jsonb_typeof(p_product_url -> v_key) <> 'string' then
        raise exception 'product_url.% must be a string URL', v_key using errcode = '22023';
      end if;
      v_val := p_product_url ->> v_key;
      if v_val !~ '^https://' then
        raise exception 'product_url.% must be an https:// URL', v_key using errcode = '22023';
      end if;
      if length(v_val) > 2048 then
        raise exception 'product_url.% URL too long (max 2048)', v_key using errcode = '22023';
      end if;
      v_host := lower(split_part(regexp_replace(v_val, '^https://', ''), '/', 1));
      v_host := split_part(split_part(v_host, '?', 1), '#', 1);
      if position('@' in v_host) > 0 then v_host := regexp_replace(v_host, '^.*@', ''); end if;
      if v_host ~ '^\[' then
        v_host := regexp_replace(v_host, '^\[([^\]]*)\].*$', '\1');
      else
        v_host := split_part(v_host, ':', 1);
      end if;
      if v_host = '' then
        raise exception 'product_url.% has no host', v_key using errcode = '22023';
      end if;
      if v_host = 'localhost'
         or v_host like '127.%' or v_host like '10.%' or v_host like '192.168.%'
         or v_host like '169.254.%' or v_host = '169.254.169.254'
         or v_host ~ '^172\.(1[6-9]|2[0-9]|3[0-1])\.' or v_host = '0.0.0.0'
         or v_host = '::1' or v_host = '::'
         or v_host = '0:0:0:0:0:0:0:1' or v_host = '0:0:0:0:0:0:0:0'
         or v_host ~ '^f[cd][0-9a-f]{2}:' or v_host ~ '^fe[89ab][0-9a-f]:' then
        raise exception 'product_url.% resolves to a private/loopback host', v_key using errcode = '22023';
      end if;
    end if;
  end loop;

  select product_url into v_prev from tenants where id = p_tenant_id;
  if not found then raise exception 'tenant % not found', p_tenant_id using errcode = 'P0002'; end if;

  update tenants set product_url = p_product_url where id = p_tenant_id;

  insert into tenant_config_audit (tenant_id, actor_user_id, action, target, prev_value, next_value)
  values (p_tenant_id, null, 'set-system', 'tenant.product_url', v_prev::text, p_product_url::text);
end $$;

revoke execute on function set_tenant_product_url_system(uuid, jsonb) from public, anon, authenticated;
grant execute on function set_tenant_product_url_system(uuid, jsonb) to service_role;
