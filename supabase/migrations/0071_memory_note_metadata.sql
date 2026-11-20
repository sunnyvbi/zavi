

alter table memory_note add column metadata jsonb not null default '{}'::jsonb;

drop function if exists memory_note_upsert_anchor(uuid, text, text, text, text);

create or replace function memory_note_upsert_anchor(
  p_tenant_id uuid,
  p_slug text,
  p_title text,
  p_body_markdown text,
  p_source text,
  p_metadata jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is not null then
    if not exists (
      select 1 from tenant_users where user_id = auth.uid() and tenant_id = p_tenant_id
    ) then
      raise exception 'not a member of tenant %', p_tenant_id using errcode = '42501';
    end if;
  end if;

  if p_slug is null or p_slug = '' then
    raise exception 'slug required for anchor upsert' using errcode = '22023';
  end if;

  insert into memory_note (tenant_id, slug, title, body_markdown, source, note_type, metadata)
  values (p_tenant_id, p_slug, coalesce(p_title, p_slug || '.md'),
          coalesce(p_body_markdown, ''), coalesce(p_source, 'human'), 'anchor',
          coalesce(p_metadata, '{}'::jsonb))
  on conflict (tenant_id, slug) where slug is not null and superseded_by is null
  do update set
    body_markdown = excluded.body_markdown,
    title = excluded.title,
    metadata = case
      when excluded.metadata = '{}'::jsonb and memory_note.metadata <> '{}'::jsonb
        then memory_note.metadata
      else excluded.metadata
    end,
    source = excluded.source,
    updated_at = now()
  returning id into v_id;

  delete from memory_chunk where note_id = v_id;

  return v_id;
end $$;
revoke all on function memory_note_upsert_anchor(uuid, text, text, text, text, jsonb) from public;
grant execute on function memory_note_upsert_anchor(uuid, text, text, text, text, jsonb) to authenticated, service_role;

create or replace function memory_note_upsert_anchor(
  p_tenant_id uuid,
  p_slug text,
  p_title text,
  p_body_markdown text,
  p_source text
) returns uuid
language sql security definer set search_path = public as $$
  select memory_note_upsert_anchor(p_tenant_id, p_slug, p_title, p_body_markdown, p_source, '{}'::jsonb);
$$;
revoke all on function memory_note_upsert_anchor(uuid, text, text, text, text) from public;
grant execute on function memory_note_upsert_anchor(uuid, text, text, text, text) to authenticated, service_role;
