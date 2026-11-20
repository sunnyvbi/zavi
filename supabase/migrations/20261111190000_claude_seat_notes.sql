
create table if not exists public.agent_auth_seat_note (
  seat        text        primary key check (seat ~ '^seat_[0-9a-f]{12}$'),
  note        text        not null check (btrim(note) <> '' and char_length(note) <= 280),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  text
);

comment on table public.agent_auth_seat_note is
  'Staff note per Claude subscription seat (salted seat label, never a token). Platform credential metadata, NOT tenant data. Written only by apply_secret_list_edit; read via globalClient() (scope "global" in services/tenant-client.ts).';

alter table public.agent_auth_seat_note enable row level security;
revoke all on table public.agent_auth_seat_note from public, anon, authenticated;

create or replace function public.apply_secret_list_edit(
  p_key                 text,
  p_expected_updated_at text,
  p_value               text,
  p_description         text,
  p_note_upserts        jsonb,
  p_note_deletes        text[],
  p_actor               text
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_current  timestamptz;
  v_found    boolean;
  v_tokens   text[];
  v_item     jsonb;
  v_note     text;
  v_now      timestamptz := clock_timestamp();
begin
  if p_key is distinct from 'anthropic_oauth_token_pool' then
    raise exception 'apply_secret_list_edit: % is not a credential list', p_key using errcode = '22023';
  end if;
  if p_value is null or p_value ~ '[[:space:]]' then
    raise exception 'apply_secret_list_edit: value must be a comma list without whitespace' using errcode = '22023';
  end if;
  if p_note_upserts is not null and jsonb_typeof(p_note_upserts) <> 'array' then
    raise exception 'apply_secret_list_edit: note upserts must be an array' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('app_setting:' || p_key));

  select updated_at into v_current from app_setting where key = p_key for update;
  v_found := found;

  if (p_expected_updated_at is null and v_found)
     or (p_expected_updated_at is not null and (not v_found or v_current <> p_expected_updated_at::timestamptz)) then
    raise exception 'stale_revision';
  end if;

  v_tokens := array(select t from unnest(string_to_array(p_value, ',')) t where t <> '');

  for v_item in select * from jsonb_array_elements(coalesce(p_note_upserts, '[]'::jsonb)) loop
    v_note := v_item->>'note';
    if v_note is null or exists (select 1 from unnest(v_tokens) t where position(t in v_note) > 0) then
      raise exception 'note_contains_credential' using errcode = '22023';
    end if;
  end loop;

  insert into app_setting (key, value, value_type, description, updated_by, updated_at)
  values (p_key, to_jsonb(p_value), 'string', coalesce(p_description, ''), p_actor, v_now)
  on conflict (key) do update
    set value = excluded.value,
        value_type = excluded.value_type,
        description = excluded.description,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

  if p_note_deletes is not null and cardinality(p_note_deletes) > 0 then
    delete from agent_auth_seat_note where seat = any(p_note_deletes);
  end if;

  insert into agent_auth_seat_note (seat, note, updated_by, updated_at)
  select e->>'seat', e->>'note', p_actor, v_now
  from jsonb_array_elements(coalesce(p_note_upserts, '[]'::jsonb)) e
  on conflict (seat) do update
    set note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at;

  return v_now::text;
end;
$$;

revoke all on function public.apply_secret_list_edit(text, text, text, text, jsonb, text[], text) from public, anon, authenticated;
grant execute on function public.apply_secret_list_edit(text, text, text, text, jsonb, text[], text) to service_role;
