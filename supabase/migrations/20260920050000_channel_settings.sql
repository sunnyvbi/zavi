
begin;

create table channel_settings (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  channel_slug text not null,
  field_id     text not null check (field_id ~ '^[a-z][a-z0-9_]{0,63}$'),
  item         text not null check (char_length(btrim(item)) between 1 and 300),
  item_type    text null check (item_type is null or char_length(btrim(item_type)) between 1 and 40),
  status       text null
    check (status is null or status in ('suggested', 'tracking', 'paused', 'dismissed')),
  position     int  null check (position is null or position >= 0),
  note         text null check (note is null or char_length(btrim(note)) <= 300),
  origin       text null check (origin is null or origin in ('suggested', 'custom')),
  detail       text null check (detail is null or char_length(btrim(detail)) between 1 and 200),
  updated_at   timestamptz not null default now(),
  updated_by   uuid null,
  unique (tenant_id, channel_slug, field_id, item),
  foreign key (tenant_id, channel_slug)
    references tenant_channels (tenant_id, channel_slug) on delete cascade
);

alter table channel_settings enable row level security;
revoke all on table channel_settings from anon, authenticated;
grant all on table channel_settings to service_role;

create or replace function get_channel_settings(
  p_tenant_id   uuid,
  p_channel_slug text
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_out jsonb;
begin
  if p_tenant_id is null or nullif(btrim(p_channel_slug), '') is null then
    raise exception 'get_channel_settings: tenant and channel_slug are required'
      using errcode = 'P0001';
  end if;

  select coalesce(jsonb_object_agg(f.field_id, f.items), '{}'::jsonb)
    into v_out
  from (
    select s.field_id,
           jsonb_agg(
             jsonb_build_object(
               'id', s.id,
               'item', s.item,
               'item_type', s.item_type,
               'status', s.status,
               'position', s.position,
               'note', s.note,
               'origin', s.origin,
               'detail', s.detail
             )
             order by s.position nulls last, s.item
           ) as items
      from channel_settings s
     where s.tenant_id = p_tenant_id
       and s.channel_slug = p_channel_slug
     group by s.field_id
  ) f;

  return jsonb_build_object('fields', v_out);
end $$;

create or replace function set_channel_settings(
  p_tenant_id     uuid,
  p_channel_slug  text,
  p_field_id      text,
  p_items         jsonb,
  p_actor_user_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_e        jsonb;
  v_ord      bigint;
  v_item     text;
  v_type     text;
  v_status   text;
  v_pos      int;
  v_note     text;
  v_origin   text;
  v_detail   text;
  v_keep     text[] := array[]::text[];
  v_dropped  int := 0;
  v_deleted  int := 0;
  v_written  int := 0;
begin
  if p_tenant_id is null then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if nullif(btrim(p_channel_slug), '') is null then
    return jsonb_build_object('ok', false, 'code', 'channel_slug_required');
  end if;
  if p_field_id is null or p_field_id !~ '^[a-z][a-z0-9_]{0,63}$' then
    return jsonb_build_object('ok', false, 'code', 'bad_field_id');
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' then
    return jsonb_build_object('ok', false, 'code', 'items_must_be_array');
  end if;

  if not exists (
    select 1 from tenant_channels tc
     where tc.tenant_id = p_tenant_id and tc.channel_slug = p_channel_slug
  ) then
    return jsonb_build_object('ok', false, 'code', 'unknown_channel');
  end if;

  if p_actor_user_id is not null and not exists (
    select 1 from tenant_users tu
     where tu.tenant_id = p_tenant_id and tu.user_id = p_actor_user_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  if jsonb_typeof(p_items) = 'array' then
    for v_e, v_ord in select e, o from jsonb_array_elements(p_items) with ordinality as t(e, o)
    loop
      exit when v_ord > 200;
      if jsonb_typeof(v_e) = 'object' then
        v_status := nullif(btrim(coalesce(v_e->>'status', '')), '');
        if v_status is not null
           and v_status not in ('suggested', 'tracking', 'paused', 'dismissed') then
          return jsonb_build_object(
            'ok', false, 'code', 'invalid_status',
            'value', v_status,
            'item', left(btrim(coalesce(v_e->>'item', '')), 300));
        end if;
        v_origin := nullif(btrim(coalesce(v_e->>'origin', '')), '');
        if v_origin is not null and v_origin not in ('suggested', 'custom') then
          return jsonb_build_object(
            'ok', false, 'code', 'invalid_origin',
            'value', v_origin,
            'item', left(btrim(coalesce(v_e->>'item', '')), 300));
        end if;
      end if;
    end loop;
  end if;

  for v_e, v_ord in select e, o from jsonb_array_elements(p_items) with ordinality as t(e, o)
  loop
    if v_ord > 200 then
      v_dropped := v_dropped + 1;
      continue;
    end if;

    if jsonb_typeof(v_e) = 'string' then
      v_item := btrim(v_e #>> '{}');
      v_type := null; v_status := null; v_pos := null;
      v_note := null; v_origin := null; v_detail := null;
    elsif jsonb_typeof(v_e) = 'object' then
      v_item := btrim(coalesce(v_e->>'item', ''));
      v_type := left(nullif(btrim(coalesce(v_e->>'item_type', '')), ''), 40);
      v_status := nullif(btrim(coalesce(v_e->>'status', '')), '');
      v_origin := nullif(btrim(coalesce(v_e->>'origin', '')), '');
      v_pos := case when jsonb_typeof(v_e->'position') = 'number'
                     and (v_e->>'position')::numeric >= 0
                    then (v_e->>'position')::numeric::int end;
      v_note := left(nullif(btrim(coalesce(v_e->>'note', '')), ''), 300);
      v_detail := left(nullif(btrim(coalesce(v_e->>'detail', '')), ''), 200);
    else
      v_dropped := v_dropped + 1;
      continue;
    end if;

    if v_item = '' or char_length(v_item) > 300 then
      v_dropped := v_dropped + 1;
      continue;
    end if;
    if v_item = any (v_keep) then
      v_dropped := v_dropped + 1;
      continue;
    end if;
    v_keep := v_keep || v_item;

    insert into channel_settings
      (tenant_id, channel_slug, field_id, item, item_type, status, position,
       note, origin, detail, updated_at, updated_by)
    values
      (p_tenant_id, p_channel_slug, p_field_id, v_item, v_type, v_status,
       coalesce(v_pos, (v_ord - 1)::int), v_note, v_origin, v_detail,
       now(), p_actor_user_id)
    on conflict (tenant_id, channel_slug, field_id, item) do update
      set item_type  = excluded.item_type,
          status     = excluded.status,
          position   = excluded.position,
          note       = excluded.note,
          origin     = excluded.origin,
          detail     = excluded.detail,
          updated_at = now(),
          updated_by = excluded.updated_by;
    v_written := v_written + 1;
  end loop;

  delete from channel_settings s
   where s.tenant_id = p_tenant_id
     and s.channel_slug = p_channel_slug
     and s.field_id = p_field_id
     and not (s.item = any (v_keep));
  get diagnostics v_deleted = row_count;

  return jsonb_build_object(
    'ok', true,
    'written', v_written,
    'deleted', v_deleted,
    'dropped', v_dropped,
    'fields', (get_channel_settings(p_tenant_id, p_channel_slug) -> 'fields')
  );
end $$;

revoke all on function get_channel_settings(uuid, text)
  from public, anon, authenticated;
grant execute on function get_channel_settings(uuid, text) to service_role;

revoke all on function set_channel_settings(uuid, text, text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function set_channel_settings(uuid, text, text, jsonb, uuid) to service_role;

commit;

do $$
begin
  raise notice '20260920050000: channel_settings (row-per-item, id-preserving, no PostgREST path)';
end $$;
