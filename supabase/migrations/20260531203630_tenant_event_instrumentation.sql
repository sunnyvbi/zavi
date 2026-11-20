
create table if not exists tenant_events (
  id          bigint      generated always as identity primary key,
  tenant_id   uuid        not null,
  event_name  text        not null check (char_length(event_name) between 1 and 120),
  distinct_id text,
  properties  jsonb       not null default '{}'::jsonb,
  source      text        not null default 'server'
              check (source in ('web', 'server', 'sdk')),
  occurred_at timestamptz not null default now(),
  ingested_at timestamptz not null default now()
);

create index if not exists tenant_events_tenant_event_occurred_idx
  on tenant_events (tenant_id, event_name, occurred_at desc);

alter table tenant_events enable row level security;
drop policy if exists tenant_events_select on tenant_events;
create policy tenant_events_select on tenant_events
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = tenant_events.tenant_id)
  );

create table if not exists tenant_ingest_keys (
  id         uuid        primary key default gen_random_uuid(),
  tenant_id  uuid        not null,
  key_hash   text        not null unique,
  label      text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists tenant_ingest_keys_tenant_idx
  on tenant_ingest_keys (tenant_id);

alter table tenant_ingest_keys enable row level security;
drop policy if exists tenant_ingest_keys_select on tenant_ingest_keys;
create policy tenant_ingest_keys_select on tenant_ingest_keys
  for select using (
    exists (select 1 from tenant_users
            where user_id = auth.uid() and tenant_id = tenant_ingest_keys.tenant_id)
  );

create or replace function ingest_tenant_event(
  p_tenant_id   uuid,
  p_event_name  text,
  p_distinct_id text default null,
  p_properties  jsonb default '{}'::jsonb,
  p_occurred_at timestamptz default null,
  p_source      text default 'server'
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if p_tenant_id is null or p_event_name is null then
    raise exception 'ingest_tenant_event: null tenant_id or event_name' using errcode = '22023';
  end if;
  if char_length(p_event_name) < 1 or char_length(p_event_name) > 120 then
    raise exception 'ingest_tenant_event: event_name length out of range' using errcode = '22023';
  end if;
  if p_source not in ('web', 'server', 'sdk') then
    raise exception 'ingest_tenant_event: invalid source %', p_source using errcode = '22023';
  end if;

  insert into tenant_events (tenant_id, event_name, distinct_id, properties, source, occurred_at)
  values (
    p_tenant_id,
    p_event_name,
    p_distinct_id,
    coalesce(p_properties, '{}'::jsonb),
    p_source,
    coalesce(p_occurred_at, now())
  )
  returning id into v_id;

  return v_id;
end $$;
revoke all on function ingest_tenant_event(uuid, text, text, jsonb, timestamptz, text) from public;
grant execute on function ingest_tenant_event(uuid, text, text, jsonb, timestamptz, text) to service_role;

create or replace function resolve_tenant_ingest_key(
  p_key_hash text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  if p_key_hash is null then
    raise exception 'resolve_tenant_ingest_key: null key_hash' using errcode = '22023';
  end if;
  select tenant_id into v_tenant
    from tenant_ingest_keys
   where key_hash = p_key_hash and revoked_at is null;
  return v_tenant;
end $$;
revoke all on function resolve_tenant_ingest_key(text) from public;
grant execute on function resolve_tenant_ingest_key(text) to service_role;

create or replace function mint_tenant_ingest_key(
  p_tenant_id uuid,
  p_key_hash  text,
  p_label     text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_tenant_id is null or p_key_hash is null then
    raise exception 'mint_tenant_ingest_key: null argument' using errcode = '22023';
  end if;
  insert into tenant_ingest_keys (tenant_id, key_hash, label)
  values (p_tenant_id, p_key_hash, p_label)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function mint_tenant_ingest_key(uuid, text, text) from public;
grant execute on function mint_tenant_ingest_key(uuid, text, text) to service_role;

create or replace function get_native_funnel(
  p_tenant_id uuid,
  p_steps     text[],
  p_window    interval default interval '30 days'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_since        timestamptz;
  v_total_events bigint;
  v_step         text;
  v_count        bigint;
  v_first_count  bigint := null;
  v_steps        jsonb := '[]'::jsonb;
begin
  if p_tenant_id is null then
    raise exception 'get_native_funnel: null tenant_id' using errcode = '22023';
  end if;
  if p_steps is null or array_length(p_steps, 1) is null then
    raise exception 'get_native_funnel: at least one step is required' using errcode = '22023';
  end if;
  if array_length(p_steps, 1) > 12 then
    raise exception 'get_native_funnel: too many steps (max 12)' using errcode = '22023';
  end if;

  v_since := now() - coalesce(p_window, interval '30 days');

  select count(*) into v_total_events
    from tenant_events
   where tenant_id = p_tenant_id
     and occurred_at >= v_since;

  if v_total_events = 0 then
    return jsonb_build_object(
      'has_data', false,
      'tenant_id', p_tenant_id,
      'window', p_window::text,
      'steps', '[]'::jsonb
    );
  end if;

  foreach v_step in array p_steps loop
    select count(distinct distinct_id) into v_count
      from tenant_events
     where tenant_id = p_tenant_id
       and event_name = v_step
       and occurred_at >= v_since
       and distinct_id is not null;

    if v_first_count is null then
      v_first_count := v_count;
    end if;

    v_steps := v_steps || jsonb_build_object(
      'event', v_step,
      'count', v_count,
      'conversion_from_top',
        case when v_first_count is null or v_first_count = 0 then null
             else round((v_count::numeric / v_first_count::numeric), 4) end
    );
  end loop;

  return jsonb_build_object(
    'has_data', true,
    'tenant_id', p_tenant_id,
    'window', p_window::text,
    'total_events_in_window', v_total_events,
    'steps', v_steps
  );
end $$;
revoke all on function get_native_funnel(uuid, text[], interval) from public;
grant execute on function get_native_funnel(uuid, text[], interval) to service_role;
